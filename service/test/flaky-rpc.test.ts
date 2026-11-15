import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { leafHash, receiptRegistryAbi, verifyMerkleProof } from "@hemi-receipts/sdk";
import { DEFAULT_MODES, mine, startFlakyRpc, type FlakyRpc } from "@hemi-receipts/e2e/lib";
import type { RunningService } from "../src/service.js";
import { accounts, batchCount, get, makeManifest, post, relayerTxCount, setupChain, signed, startTestService, tempDbPath, testEnv, waitFor, type TestChain } from "./helpers.js";

describe("batcher and poller through a flaky RPC (30 % failures, drop-response included)", () => {
  let chain: TestChain;
  let flaky: FlakyRpc;
  let service: RunningService;
  let db: ReturnType<typeof tempDbPath>;

  before(async () => {
    chain = await setupChain();
    flaky = await startFlakyRpc({
      upstream: chain.anvil.url,
      failureRate: 0.3,
      modes: [...DEFAULT_MODES, "drop-response", "drop-response"],
      stallMs: 300,
      seed: 7,
    });
    db = tempDbPath();
    service = await startTestService(
      testEnv(chain, db.path, {
        HEMI_RPC_URLS: flaky.url,
        BATCH_MAX_SIZE: "3",
        BATCH_MAX_WAIT_SECONDS: "0.5",
        HEMI_CONFIRMATIONS: "2",
        RPC_RETRY_COUNT: "8",
        RPC_TIMEOUT_MS: "2000",
      }),
    );
  });

  after(async () => {
    await service?.stop();
    await flaky?.stop();
    await chain?.stop();
    db?.cleanup();
  });

  it("anchors every receipt exactly once, reaches hemi-confirmed, and leaves no stuck nonce", { timeout: 120_000 }, async () => {
    const bodies = await Promise.all(Array.from({ length: 8 }, () => signed(chain, makeManifest())));
    for (const body of bodies) {
      const res = await post(`${service.url}/attest`, { manifest: body.manifest, agentSignature: body.agentSignature });
      assert.equal(res.status, 202, JSON.stringify(res.body));
    }

    const files = await waitFor(
      "every receipt anchored",
      async () => {
        const results = await Promise.all(bodies.map((b) => get(`${service.url}/receipts/${b.receipt.runId}`)));
        return results.every((r) => r.body.anchor) ? results.map((r) => r.body) : undefined;
      },
      90_000,
      250,
    );

    // No double anchoring: one on-chain batch per local batch, and one tx per batch.
    const batchIds = [...new Set(files.map((f) => f.anchor.batchId as number))].sort();
    const onchainBatches = await batchCount(chain);
    assert.equal(Number(onchainBatches), batchIds.length, "every on-chain batch is one of ours, none twice");
    assert.ok(batchIds.length >= 3, `8 receipts at BATCH_MAX_SIZE 3 need at least 3 batches (got ${batchIds.length})`);
    for (const file of files) {
      assert.ok(verifyMerkleProof(leafHash(file.receipt), file.anchor.proof, file.anchor.root));
      const ok = await chain.client.readContract({
        address: chain.registry,
        abi: receiptRegistryAbi,
        functionName: "verifyReceipt",
        args: [BigInt(file.anchor.batchId), file.receipt, file.anchor.proof],
      });
      assert.equal(ok, true);
    }

    // No stuck nonce: everything the relayer signed has been mined, nothing is queued behind a gap.
    const latest = await chain.client.getTransactionCount({ address: accounts.relayer.address, blockTag: "latest" });
    const pending = await chain.client.getTransactionCount({ address: accounts.relayer.address, blockTag: "pending" });
    assert.equal(pending, latest, "no pending relayer transactions");
    assert.equal(await relayerTxCount(chain), batchIds.length, "one relayer transaction per batch");

    // Past HEMI_CONFIRMATIONS and past anvil's "safe" head (latest − 32).
    await mine(chain.anvil.url, 40);
    await waitFor(
      "every receipt hemi-confirmed",
      async () => {
        const results = await Promise.all(bodies.map((b) => get(`${service.url}/receipts/${b.receipt.runId}`)));
        return results.every((r) => r.body.status.stage === "hemi-confirmed");
      },
      60_000,
      250,
    );

    const injected = Object.values(flaky.stats.injected).reduce((a, b) => a + (b ?? 0), 0);
    assert.ok(injected > 10, `the proxy injected failures (${JSON.stringify(flaky.stats.injected)})`);
    assert.ok((flaky.stats.injected["drop-response"] ?? 0) > 0, "drop-response was exercised");
  });
});

/**
 * The "was my tx sent?" case, deterministically: a proxy that forwards every
 * eth_sendRawTransaction to the node and then drops the connection, so the batcher never
 * receives an answer to any broadcast (retries included).
 */
describe("every eth_sendRawTransaction answer is lost (drop-response)", () => {
  let chain: TestChain;
  let proxy: { url: string; drops: number; stop(): Promise<void> };
  let service: RunningService;
  let db: ReturnType<typeof tempDbPath>;

  before(async () => {
    chain = await setupChain();
    const { createServer } = await import("node:http");
    let drops = 0;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      const upstream = await fetch(chain.anvil.url, { method: "POST", headers: { "content-type": "application/json" }, body });
      const text = await upstream.text();
      if (body.includes('"eth_sendRawTransaction"')) {
        drops++;
        req.socket.destroy();
        return;
      }
      res.writeHead(upstream.status, { "content-type": "application/json" }).end(text);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    proxy = {
      url: `http://127.0.0.1:${port}`,
      get drops() {
        return drops;
      },
      stop: async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
    db = tempDbPath();
    service = await startTestService(testEnv(chain, db.path, { HEMI_RPC_URLS: proxy.url, BATCH_MAX_SIZE: "2", RPC_RETRY_COUNT: "2" }));
  });

  after(async () => {
    await service?.stop();
    await proxy?.stop();
    await chain?.stop();
    db?.cleanup();
  });

  it("finds the tx by its persisted hash and anchors once, without re-signing", { timeout: 60_000 }, async () => {
    const bodies = await Promise.all([0, 1].map(() => signed(chain, makeManifest())));
    for (const body of bodies) {
      assert.equal((await post(`${service.url}/attest`, { manifest: body.manifest, agentSignature: body.agentSignature })).status, 202);
    }
    const files = await waitFor("anchored despite lost answers", async () => {
      const results = await Promise.all(bodies.map((b) => get(`${service.url}/receipts/${b.receipt.runId}`)));
      return results.every((r) => r.body.anchor) ? results.map((r) => r.body) : undefined;
    }, 45_000, 200);
    assert.ok(proxy.drops >= 1, "broadcast answers were dropped");
    assert.equal(await relayerTxCount(chain), 1, "exactly one transaction");
    assert.equal(await batchCount(chain), 1n);
    const batch = await service.store.getBatch(1);
    assert.equal(JSON.parse(batch!.tx_hashes_json).length, 1, "the original signed tx, never replaced");
    assert.equal(files[0].anchor.txHash, batch!.tx_hash);
  });
});
