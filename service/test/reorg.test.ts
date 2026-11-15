import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { resolveStatus } from "@hemi-receipts/sdk";
import { mine } from "@hemi-receipts/e2e/lib";
import type { RunningService } from "../src/service.js";
import { batchCount, get, makeManifest, post, relayerTxCount, setupChain, signed, startTestService, tempDbPath, testEnv, waitFor, type TestChain } from "./helpers.js";

async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** Does this SDK's resolveStatus report a non-canonical anchoring block as "pending"? */
async function sdkDetectsReorgs(chain: TestChain): Promise<boolean> {
  const input = { client: chain.client, blockNumber: 1n, confirmations: 1, anchorBlockHash: `0x${"00".repeat(32)}` as Hex };
  const status = await resolveStatus(input as Parameters<typeof resolveStatus>[0]);
  return (status.stage as string) === "pending";
}

describe("reorg: the anchoring block is dropped", () => {
  let chain: TestChain;
  let service: RunningService;
  let db: ReturnType<typeof tempDbPath>;
  let detects = false;

  before(async () => {
    chain = await setupChain();
    detects = await sdkDetectsReorgs(chain);
    db = tempDbPath();
    service = await startTestService(testEnv(chain, db.path, { BATCH_MAX_SIZE: "1", HEMI_CONFIRMATIONS: "2" }));
  });

  after(async () => {
    await service?.stop();
    await chain?.stop();
    db?.cleanup();
  });

  async function anchorThenReorg() {
    const batchesBefore = await batchCount(chain);
    const txsBefore = await relayerTxCount(chain);
    const snapshot = await rpc(chain.anvil.url, "evm_snapshot");
    const body = await signed(chain, makeManifest());
    assert.equal((await post(`${service.url}/attest`, { manifest: body.manifest, agentSignature: body.agentSignature })).status, 202);
    const first = await waitFor("anchored", async () => (await get(`${service.url}/receipts/${body.receipt.runId}`)).body.anchor);
    const batch = (await service.store.getBatchByRoot(first.root))!;
    assert.match(batch.block_hash!, /^0x[0-9a-f]{64}$/, "the anchoring block hash is stored");
    // Drop the block that carried the tx, and build a different chain of the same height.
    assert.equal(await rpc(chain.anvil.url, "evm_revert", [snapshot]), true);
    await mine(chain.anvil.url, 3);
    assert.equal(await batchCount(chain), batchesBefore, "the anchor is gone from the canonical chain");
    return { body, first, batch, batchesBefore, txsBefore };
  }

  it("a reorged-out batch goes back to the batcher and is anchored again, once", { timeout: 60_000 }, async () => {
    const { body, first, batch, batchesBefore, txsBefore } = await anchorThenReorg();
    if (!detects) {
      // This SDK cannot see the reorg; do what the poller does when it does.
      await service.store.reopenBatch(batch, Date.now());
    }
    const again = await waitFor(
      "re-anchored on the new chain",
      async () => {
        const r = await get(`${service.url}/receipts/${body.receipt.runId}`);
        return r.body.anchor && r.body.anchor.blockNumber !== first.blockNumber ? r.body.anchor : undefined;
      },
      45_000,
      200,
    );
    assert.equal(again.root, first.root, "same root");
    assert.equal(again.txHash, first.txHash, "the same signed tx, re-broadcast");
    assert.equal(await batchCount(chain), batchesBefore + 1n, "anchored once on the canonical chain");
    assert.equal(await relayerTxCount(chain), txsBefore + 1);
    const reopened = (await service.store.getBatchByRoot(first.root))!;
    assert.notEqual(reopened.block_hash, batch.block_hash);
  });

  it("the poller detects the reorg through resolveStatus(anchorBlockHash)", { timeout: 60_000 }, async (t) => {
    if (!detects) {
      t.skip("this SDK build's resolveStatus has no anchorBlockHash reorg check yet");
      return;
    }
    const { body, first, batchesBefore, txsBefore } = await anchorThenReorg();
    await waitFor(
      "detected and re-anchored",
      async () => {
        const r = await get(`${service.url}/receipts/${body.receipt.runId}`);
        return r.body.anchor && r.body.anchor.blockNumber !== first.blockNumber;
      },
      45_000,
      200,
    );
    assert.equal(await batchCount(chain), batchesBefore + 1n);
    assert.equal(await relayerTxCount(chain), txsBefore + 1, "re-broadcast, not re-signed");
  });
});
