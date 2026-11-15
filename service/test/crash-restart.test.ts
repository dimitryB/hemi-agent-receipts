import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { SqliteD1 } from "../src/db.js";
import { Store } from "../src/store.js";
import { batchCount, get, makeManifest, post, relayerTxCount, setupChain, signed, startCrashingChild, startTestService, tempDbPath, testEnv, waitFor, type TestChain } from "./helpers.js";

async function batchState(dbPath: string) {
  const db = new SqliteD1(dbPath);
  try {
    const store = new Store(db);
    return await store.getBatch(1);
  } finally {
    db.close();
  }
}

for (const crashAt of ["beforeBroadcast", "afterBroadcast"] as const) {
  describe(`crash/restart: SIGKILL ${crashAt === "beforeBroadcast" ? "after the signed tx is persisted, before it is sent" : "after the tx is sent, before it is recorded as mined"}`, () => {
    let chain: TestChain;
    let db: ReturnType<typeof tempDbPath>;
    let stopService: (() => Promise<void>) | undefined;
    let killChild: (() => void) | undefined;

    before(async () => {
      chain = await setupChain();
      db = tempDbPath();
    });

    after(async () => {
      killChild?.();
      await stopService?.();
      await chain?.stop();
      db?.cleanup();
    });

    it("completes the batch exactly once after restart", { timeout: 60_000 }, async () => {
      const env = testEnv(chain, db.path, { BATCH_MAX_SIZE: "2", BATCH_MAX_WAIT_SECONDS: "3600" });
      const child = await startCrashingChild(env, crashAt);
      killChild = child.kill;
      const bodies = await Promise.all([0, 1].map(() => signed(chain, makeManifest())));
      for (const body of bodies) {
        assert.equal((await post(`${child.url}/attest`, { manifest: body.manifest, agentSignature: body.agentSignature })).status, 202);
      }
      const [, signal] = await child.exited;
      assert.equal(signal, "SIGKILL", "the child died at the fault point");

      // What the crash left behind: a 'sent' batch whose hash is on disk.
      const crashed = await batchState(db.path);
      assert.equal(crashed?.state, "sent");
      assert.match(crashed!.tx_hash!, /^0x[0-9a-f]{64}$/);
      assert.ok(crashed!.raw_tx);
      if (crashAt === "beforeBroadcast") {
        assert.equal(await relayerTxCount(chain), 0, "nothing was broadcast before the crash");
      } else {
        // anvil answers the broadcast just before its automined block lands; wait for it.
        const mined = await chain.client.waitForTransactionReceipt({ hash: crashed!.tx_hash as Hex, pollingInterval: 50, timeout: 10_000 });
        assert.equal(mined.status, "success", "the tx was broadcast and mined before the crash");
        assert.equal(await relayerTxCount(chain), 1);
      }

      const service = await startTestService(env);
      stopService = () => service.stop();
      const files = await waitFor("both receipts anchored after restart", async () => {
        const results = await Promise.all(bodies.map((b) => get(`${service.url}/receipts/${b.receipt.runId}`)));
        return results.every((r) => r.body.anchor) ? results.map((r) => r.body) : undefined;
      });
      assert.equal(await batchCount(chain), 1n, "anchored once");
      assert.equal(await relayerTxCount(chain), 1, "one transaction in total");
      for (const file of files) assert.equal(file.anchor.txHash, crashed!.tx_hash as Hex, "the persisted tx is the one that mined");
      const recovered = await batchState(db.path);
      assert.equal(recovered?.state, "mined");
      assert.equal(JSON.parse(recovered!.tx_hashes_json).length, 1, "no replacement was needed");
    });
  });
}
