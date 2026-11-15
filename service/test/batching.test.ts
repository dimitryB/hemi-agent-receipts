import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEventLogs, type Hex } from "viem";
import { leafHash, receiptRegistryAbi, verifyMerkleProof } from "@hemi-receipts/sdk";
import { mine } from "@hemi-receipts/e2e/lib";
import type { RunningService } from "../src/service.js";
import { batchCount, get, makeManifest, post, relayerTxCount, setupChain, signed, startTestService, tempDbPath, testEnv, waitFor, type TestChain } from "./helpers.js";

describe("batching: three receipts in one window", () => {
  let chain: TestChain;
  let service: RunningService;
  let db: ReturnType<typeof tempDbPath>;

  before(async () => {
    chain = await setupChain();
    db = tempDbPath();
    service = await startTestService(testEnv(chain, db.path, { BATCH_MAX_WAIT_SECONDS: "1.5", HEMI_CONFIRMATIONS: "3" }));
  });

  after(async () => {
    await service?.stop();
    await chain?.stop();
    db?.cleanup();
  });

  it("anchors all three with exactly one BatchAttested tx; every proof verifies on chain; stages go hemi-included then hemi-confirmed", async () => {
    const bodies = await Promise.all([0, 1, 2].map(() => signed(chain, makeManifest())));
    for (const body of bodies) {
      const res = await post(`${service.url}/attest`, { manifest: body.manifest, agentSignature: body.agentSignature });
      assert.equal(res.status, 202);
    }

    const files = await waitFor("all three anchored", async () => {
      const results = await Promise.all(bodies.map((b) => get(`${service.url}/receipts/${b.receipt.runId}`)));
      return results.every((r) => r.body.anchor) ? results.map((r) => r.body) : undefined;
    });

    assert.equal(await relayerTxCount(chain), 1, "one transaction");
    assert.equal(await batchCount(chain), 1n, "one batch on chain");
    const txHash = files[0].anchor.txHash as Hex;
    for (const file of files) {
      assert.equal(file.anchor.mode, "batch");
      assert.equal(file.anchor.txHash, txHash);
      assert.equal(file.anchor.batchId, 1);
    }
    // Three sorted leaves: two pair up (proof of 2), the odd one is carried up (proof of 1).
    assert.deepEqual(files.map((f) => f.anchor.proof.length).sort(), [1, 2, 2]);
    const receipt = await chain.client.getTransactionReceipt({ hash: txHash });
    const events = parseEventLogs({ abi: receiptRegistryAbi, eventName: "BatchAttested", logs: receipt.logs });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.args.count, 3);
    assert.equal(events[0]!.args.root, files[0].anchor.root);

    for (const file of files) {
      assert.ok(verifyMerkleProof(leafHash(file.receipt), file.anchor.proof, file.anchor.root));
      const onchain = await chain.client.readContract({
        address: chain.registry,
        abi: receiptRegistryAbi,
        functionName: "verifyReceipt",
        args: [BigInt(file.anchor.batchId), file.receipt, file.anchor.proof],
      });
      assert.equal(onchain, true, "verifyReceipt on chain");
    }

    const included = await waitFor("hemi-included with block data", async () => {
      const r = await get(`${service.url}/receipts/${bodies[0]!.receipt.runId}`);
      return r.body.status.stage === "hemi-included" && r.body.status.hemi ? r.body.status : undefined;
    });
    assert.equal(included.hemi.requiredConfirmations, 3);
    assert.equal(included.hemi.blockNumber, files[0].anchor.blockNumber);

    // Past HEMI_CONFIRMATIONS and past anvil's "safe" head (latest − 32).
    await mine(chain.anvil.url, 40);
    for (const body of bodies) {
      const confirmed = await waitFor("hemi-confirmed", async () => {
        const r = await get(`${service.url}/receipts/${body.receipt.runId}`);
        return r.body.status.stage === "hemi-confirmed" ? r.body.status : undefined;
      });
      assert.ok(confirmed.hemi.confirmations >= 3);
      assert.equal(confirmed.btc.source, "unavailable");
    }

    const batch = await get(`${service.url}/batches/1`);
    assert.equal(batch.status, 200);
    assert.equal(batch.body.count, 3);
    assert.equal(batch.body.stage, "hemi-confirmed");
    assert.equal(batch.body.runIds.length, 3);

    const health = await get(`${service.url}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.pending, 0);
    assert.equal(health.body.lastBatch.batchId, 1);
    assert.equal(health.body.rpc.ok, true);
  });
});

describe("batching: BATCH_MAX_SIZE closes a batch early", () => {
  let chain: TestChain;
  let service: RunningService;
  let db: ReturnType<typeof tempDbPath>;

  before(async () => {
    chain = await setupChain();
    db = tempDbPath();
    service = await startTestService(testEnv(chain, db.path, { BATCH_MAX_SIZE: "2", BATCH_MAX_WAIT_SECONDS: "3600" }));
  });

  after(async () => {
    await service?.stop();
    await chain?.stop();
    db?.cleanup();
  });

  it("closes as soon as two receipts are queued, and leaves the third waiting", async () => {
    const bodies = await Promise.all([0, 1, 2].map(() => signed(chain, makeManifest())));
    const started = Date.now();
    for (const body of bodies.slice(0, 2)) {
      assert.equal((await post(`${service.url}/attest`, { manifest: body.manifest, agentSignature: body.agentSignature })).status, 202);
    }
    await waitFor("the first two anchored", async () => {
      const results = await Promise.all(bodies.slice(0, 2).map((b) => get(`${service.url}/receipts/${b.receipt.runId}`)));
      return results.every((r) => r.body.anchor);
    }, 15_000);
    assert.ok(Date.now() - started < 15_000, "closed long before BATCH_MAX_WAIT_SECONDS");

    assert.equal((await post(`${service.url}/attest`, { manifest: bodies[2]!.manifest, agentSignature: bodies[2]!.agentSignature })).status, 202);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const third = await get(`${service.url}/receipts/${bodies[2]!.receipt.runId}`);
    assert.equal(third.body.anchor, null);
    assert.equal(third.body.status.stage, "pending");
    assert.equal(await batchCount(chain), 1n);
    const health = await get(`${service.url}/health`);
    assert.equal(health.body.pending, 1);
  });
});
