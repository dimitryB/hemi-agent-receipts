import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BtcFinality, FinalityReader } from "@hemi-receipts/sdk";
import { mine } from "@hemi-receipts/e2e/lib";
import type { RunningService } from "../src/service.js";
import type { BatchRow } from "../src/store.js";
import { get, makeManifest, post, setupChain, signed, startTestService, tempDbPath, testEnv, waitFor, type TestChain } from "./helpers.js";

describe("Bitcoin stages: read only for confirmed batches, never after btc-final", () => {
  let chain: TestChain;
  let service: RunningService;
  let db: ReturnType<typeof tempDbPath>;
  const reads: bigint[] = [];
  let answer: BtcFinality = { source: "unavailable", detail: "test: nothing yet" };
  const reader: FinalityReader = {
    async read({ blockNumber }) {
      reads.push(blockNumber);
      return answer;
    },
  };

  before(async () => {
    chain = await setupChain();
    db = tempDbPath();
    service = await startTestService(testEnv(chain, db.path, { BATCH_MAX_SIZE: "1", HEMI_CONFIRMATIONS: "3" }), { finality: reader });
  });

  after(async () => {
    await service?.stop();
    await chain?.stop();
    db?.cleanup();
  });

  it("walks hemi-included → hemi-confirmed → btc-published → btc-final, reading Bitcoin only from hemi-confirmed on", { timeout: 60_000 }, async () => {
    const body = await signed(chain, makeManifest());
    const accepted = await post(`${service.url}/attest`, { manifest: body.manifest, agentSignature: body.agentSignature });
    assert.equal(accepted.status, 202);
    const url = accepted.body.receiptUrl as string;
    const stage = async () => (await get(url)).body.status.stage as string;

    await waitFor("hemi-included", async () => (await get(url)).body.status.hemi);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(await stage(), "hemi-included");
    assert.equal(reads.length, 0, "no Bitcoin reads before hemi-confirmed");

    await mine(chain.anvil.url, 40);
    await waitFor("hemi-confirmed", async () => (await stage()) === "hemi-confirmed");
    await waitFor("a Bitcoin read for the confirmed batch", async () => reads.length > 0);

    answer = { source: "bitcoin", publishedAtBtcHeight: 900_000, btcConfirmations: 2 };
    await waitFor("btc-published", async () => (await stage()) === "btc-published", 30_000);
    answer = { source: "bitcoin", publishedAtBtcHeight: 900_000, btcConfirmations: 9 };
    const final = await waitFor("btc-final", async () => {
      const r = await get(url);
      return r.body.status.stage === "btc-final" ? r.body.status : undefined;
    }, 30_000);
    assert.equal(final.btc.btcConfirmations, 9);

    const readsAtFinal = reads.length;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(reads.length, readsAtFinal, "a btc-final batch is no longer checked");

    // A later estimate-free "unavailable" answer could never move it back: it is not asked again.
    answer = { source: "unavailable" };
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await stage(), "btc-final");
    const health = await get(`${service.url}/health`);
    assert.equal(health.body.finality, "provided by the caller");
  });
});

it("withdraws a provisional Bitcoin publication without reopening the Hemi anchor, then recovers", { timeout: 30_000 }, async () => {
  const chain = await setupChain();
  const db = tempDbPath();
  let service: RunningService | undefined;
  let answer: BtcFinality | Error = { source: "bitcoin", publishedAtBtcHeight: 900_000, btcConfirmations: 2 };
  const reader: FinalityReader = {
    async read() {
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  try {
    service = await startTestService(testEnv(chain, db.path, { BATCH_MAX_SIZE: "1" }), { loops: false, finality: reader });
    const body = await signed(chain, makeManifest());
    const accepted = await post(`${service.url}/attest`, { manifest: body.manifest, agentSignature: body.agentSignature });
    assert.equal(accepted.status, 202);
    await service.batcher.tick(); // close
    await service.batcher.tick(); // send
    await mine(chain.anvil.url, 40);
    await service.store.updateBatch(1, { next_attempt_at: 0 }, Date.now());
    await service.batcher.tick(); // mined
    assert.equal((await service.store.getBatch(1))!.state, "mined");
    const poll = async () => {
      await service!.store.rescheduleBatch(1, 0, Date.now());
      await service!.poller.tick();
      return (await get(accepted.body.receiptUrl)).body;
    };
    assert.equal((await poll()).status.stage, "hemi-confirmed");
    const published = await poll();
    assert.equal(published.status.stage, "btc-published");

    for (const withdrawn of [
      { source: "estimate", detail: "publication reorged out; PoP is still live" } as const,
      { source: "unavailable", detail: "publication reorged out; no PoP activity" } as const,
      new Error("Esplora unavailable"),
    ]) {
      answer = withdrawn;
      const current = await poll();
      assert.equal(current.status.stage, "hemi-confirmed");
      assert.equal(current.status.btc.publishedAtBtcHeight, undefined, "do not retain the old publication evidence");
      assert.deepEqual(current.anchor, published.anchor, "the Hemi anchor has not changed");
      const batch: BatchRow = (await service.store.getBatch(1))!;
      assert.equal(batch.state, "mined");
      assert.equal(batch.stage, "hemi-confirmed");
      assert.ok(batch.next_check_at! > Date.now() - 1000, "keep polling for a new publication");

      answer = { source: "bitcoin", publishedAtBtcHeight: 900_010, btcConfirmations: 1 };
      const recovered = await poll();
      assert.equal(recovered.status.stage, "btc-published");
      assert.equal(recovered.status.btc.publishedAtBtcHeight, 900_010);
    }
    answer = { source: "bitcoin", publishedAtBtcHeight: 900_010, btcConfirmations: 9 };
    assert.equal((await poll()).status.stage, "btc-final");
    assert.equal((await service.store.getBatch(1))!.next_check_at, null);
  } finally {
    await service?.stop();
    await chain.stop();
    db.cleanup();
  }
});
