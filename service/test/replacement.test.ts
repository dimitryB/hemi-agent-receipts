import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { receiptRegistryAbi } from "@hemi-receipts/sdk";
import { mine } from "@hemi-receipts/e2e/lib";
import type { RunningService, ServiceOptions } from "../src/service.js";
import type { BatchRow } from "../src/store.js";
import { accounts, batchCount, get, makeManifest, post, setupChain, signed, startTestService, tempDbPath, testEnv, waitFor, type TestChain } from "./helpers.js";

async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** One anvil + service per scenario; automine off so transactions wait until the test mines. */
async function scenario(overrides: Record<string, string>, options: ServiceOptions = {}) {
  const chain = await setupChain();
  await rpc(chain.anvil.url, "evm_setAutomine", [false]);
  const db = tempDbPath();
  const service = await startTestService(testEnv(chain, db.path, { BATCH_MAX_SIZE: "1", BATCH_MAX_WAIT_SECONDS: "3600", STUCK_TX_SECONDS: "3600", ...overrides }), options);
  const body = await signed(chain, makeManifest());
  assert.equal((await post(`${service.url}/attest`, { manifest: body.manifest, agentSignature: body.agentSignature })).status, 202);
  if (options.loops === false) {
    await service.batcher.tick(); // close
    await service.batcher.tick(); // send
  }
  const sent = await waitFor("batch sent", async () => {
    const batch = await service.store.getBatch(1);
    return batch?.state === "sent" ? batch : undefined;
  });
  return {
    chain,
    service,
    body,
    sent,
    batch: () => service.store.getBatch(1) as Promise<BatchRow>,
    async stop() {
      await service.stop();
      await chain.stop();
      db.cleanup();
    },
  };
}

async function nonces(chain: TestChain) {
  const latest = await chain.client.getTransactionCount({ address: accounts.relayer.address, blockTag: "latest" });
  const pending = await chain.client.getTransactionCount({ address: accounts.relayer.address, blockTag: "pending" });
  return { latest, pending };
}

/** Drive a due batch without sleeps or a concurrently running batcher loop. */
async function step(service: RunningService): Promise<BatchRow> {
  await service.store.updateBatch(1, { next_attempt_at: 0 }, Date.now());
  await service.batcher.tick();
  return (await service.store.getBatch(1))!;
}

describe("batcher replacement paths", () => {
  const cleanups: (() => Promise<void>)[] = [];
  after(async () => {
    for (const cleanup of cleanups) await cleanup();
  });

  it("deadline passes unmined: re-signs the same root and replaces the tx with the same nonce; anchors once", { timeout: 60_000 }, async () => {
    const s = await scenario({ SIGNATURE_TTL_SECONDS: "10" });
    cleanups.push(() => s.stop());
    const replaced = await waitFor("replacement after the deadline", async () => {
      const batch = await s.batch();
      return JSON.parse(batch.tx_hashes_json).length === 2 ? batch : undefined;
    }, 30_000, 200);
    assert.equal(replaced.root, s.sent.root, "same root");
    assert.equal(replaced.nonce, s.sent.nonce, "same nonce");
    assert.ok(replaced.deadline! > s.sent.deadline!, "new deadline");
    assert.notEqual(replaced.service_signature, s.sent.service_signature);
    assert.ok(BigInt(replaced.max_priority_fee_per_gas!) > BigInt(s.sent.max_priority_fee_per_gas!), "fees bumped");
    assert.deepEqual(await nonces(s.chain), { latest: 0, pending: 1 }, "one pending tx: the replacement took the old one's place");

    await mine(s.chain.anvil.url, 1);
    const file = await waitFor("anchored", async () => (await get(`${s.service.url}/receipts/${s.body.receipt.runId}`)).body.anchor);
    assert.equal(file.txHash, replaced.tx_hash, "the replacement is what mined");
    assert.equal(await batchCount(s.chain), 1n);
    assert.deepEqual(await nonces(s.chain), { latest: 1, pending: 1 }, "no stuck nonce");
  });

  it("mined after its deadline (reverted): re-signs and sends with a fresh nonce; anchors once", { timeout: 60_000 }, async () => {
    const s = await scenario({ SIGNATURE_TTL_SECONDS: "60" });
    cleanups.push(() => s.stop());
    await rpc(s.chain.anvil.url, "evm_increaseTime", [7200]);
    await rpc(s.chain.anvil.url, "evm_mine");
    const reverted = await s.chain.client.getTransactionReceipt({ hash: s.sent.tx_hash as Hex });
    assert.equal(reverted.status, "reverted", "the first tx was mined too late and reverted");
    await rpc(s.chain.anvil.url, "evm_setAutomine", [true]);

    const file = await waitFor("anchored", async () => (await get(`${s.service.url}/receipts/${s.body.receipt.runId}`)).body.anchor, 30_000);
    const batch = await s.batch();
    assert.equal(JSON.parse(batch.tx_hashes_json).length, 2);
    assert.equal(file.txHash, batch.tx_hash);
    assert.notEqual(file.txHash, s.sent.tx_hash);
    assert.equal(batch.nonce, 1, "a fresh nonce after the revert spent nonce 0");
    assert.equal(await batchCount(s.chain), 1n);
    assert.deepEqual(await nonces(s.chain), { latest: 2, pending: 2 });
    const ok = await s.chain.client.readContract({
      address: s.chain.registry,
      abi: receiptRegistryAbi,
      functionName: "verifyReceipt",
      args: [BigInt(file.batchId), s.body.receipt, file.proof],
    });
    assert.equal(ok, true);
  });

  it("stuck while blocks are produced: replaced with higher fees and the same nonce", { timeout: 60_000 }, async () => {
    const s = await scenario({ STUCK_TX_SECONDS: "1" });
    cleanups.push(() => s.stop());
    // Price our pending tx out: blocks keep coming, none can include it.
    await rpc(s.chain.anvil.url, "anvil_setNextBlockBaseFeePerGas", [`0x${(30n * 10n ** 9n).toString(16)}`]);
    await mine(s.chain.anvil.url, 3);
    assert.equal((await nonces(s.chain)).latest, 0, "not mined after three blocks");
    await assert.rejects(s.chain.client.getTransactionReceipt({ hash: s.sent.tx_hash as Hex }), "no receipt for the priced-out tx");

    const replaced = await waitFor("stuck replacement", async () => {
      const batch = await s.batch();
      return JSON.parse(batch.tx_hashes_json).length >= 2 ? batch : undefined;
    }, 30_000, 200);
    assert.equal(replaced.nonce, 0);
    assert.ok(BigInt(replaced.max_fee_per_gas!) > 30n * 10n ** 9n, "outbids the new base fee");
    await mine(s.chain.anvil.url, 1);
    const file = await waitFor("anchored", async () => (await get(`${s.service.url}/receipts/${s.body.receipt.runId}`)).body.anchor);
    assert.equal(file.txHash, (await s.batch()).tx_hash);
    assert.equal(await batchCount(s.chain), 1n);
    assert.deepEqual(await nonces(s.chain), { latest: 1, pending: 1 });
  });

  it("an old nonce's revert leaves the pending retry and its fee-replacement state intact", { timeout: 30_000 }, async () => {
    const s = await scenario({ SIGNATURE_TTL_SECONDS: "60", STUCK_TX_SECONDS: "1" }, { loops: false });
    cleanups.push(() => s.stop());
    await rpc(s.chain.anvil.url, "evm_increaseTime", [7200]);
    await mine(s.chain.anvil.url);
    assert.equal((await s.chain.client.getTransactionReceipt({ hash: s.sent.tx_hash! })).status, "reverted");
    await step(s.service); // reset after nonce 0 reverted
    const retry = await step(s.service); // nonce 1, still pending
    assert.equal(retry.nonce, 1);
    for (let i = 0; i < 2; i++) {
      const pending = await step(s.service);
      assert.equal(pending.state, "sent");
      assert.equal(pending.nonce, retry.nonce);
      assert.equal(pending.raw_tx, retry.raw_tx);
      assert.equal(pending.max_fee_per_gas, retry.max_fee_per_gas);
      assert.equal(pending.max_priority_fee_per_gas, retry.max_priority_fee_per_gas);
      assert.equal(pending.tx_hashes_json, retry.tx_hashes_json);
    }

    // A genuine stuck retry must still be replaced using nonce 1 and higher fees.
    await rpc(s.chain.anvil.url, "anvil_setNextBlockBaseFeePerGas", [`0x${(30n * 10n ** 9n).toString(16)}`]);
    await mine(s.chain.anvil.url, 3);
    await s.service.store.updateBatch(1, { sent_at: Date.now() - s.service.config.stuckTxMs - 1 }, Date.now());
    const replacing = await step(s.service);
    assert.equal(replacing.state, "signed");
    assert.equal(replacing.nonce, 1);
    const replaced = await step(s.service);
    assert.equal(replaced.nonce, 1);
    assert.ok(BigInt(replaced.max_fee_per_gas!) > BigInt(retry.max_fee_per_gas!));
    assert.ok(BigInt(replaced.max_priority_fee_per_gas!) > BigInt(retry.max_priority_fee_per_gas!));
    await mine(s.chain.anvil.url);
    assert.equal((await step(s.service)).state, "mined");
    assert.equal(await batchCount(s.chain), 1n);
    assert.deepEqual(await nonces(s.chain), { latest: 2, pending: 2 });
  });

  it("a superseded hash that reverts at the active nonce still triggers a fresh nonce", { timeout: 30_000 }, async () => {
    let holdBroadcast = false;
    const s = await scenario({ SIGNATURE_TTL_SECONDS: "60" }, {
      loops: false,
      faults: { beforeBroadcast() { if (holdBroadcast) throw new Error("test: replacement persisted but not broadcast"); } },
    });
    cleanups.push(() => s.stop());
    // Price the original out so estimation can simulate the replacement without
    // including the original first, then stop before broadcasting the replacement.
    await rpc(s.chain.anvil.url, "anvil_setNextBlockBaseFeePerGas", [`0x${(30n * 10n ** 9n).toString(16)}`]);
    await mine(s.chain.anvil.url, 3);
    await s.service.store.updateBatch(1, { deadline: Math.floor(Date.now() / 1000) - 1 }, Date.now());
    await step(s.service);
    holdBroadcast = true;
    const replacement = await step(s.service);
    assert.equal(replacement.state, "sent");
    assert.notEqual(replacement.tx_hash, s.sent.tx_hash);
    assert.equal(replacement.nonce, s.sent.nonce);
    await rpc(s.chain.anvil.url, "anvil_setNextBlockBaseFeePerGas", ["0x0"]);
    await rpc(s.chain.anvil.url, "evm_increaseTime", [7200]);
    // Re-submit the original bytes in case the local node evicted the priced-out tx.
    await rpc(s.chain.anvil.url, "eth_sendRawTransaction", [s.sent.raw_tx]).catch((error: unknown) => {
      if (!(error instanceof Error) || !/already known/i.test(error.message)) throw error;
    });
    await mine(s.chain.anvil.url);
    assert.equal((await s.chain.client.getTransactionReceipt({ hash: s.sent.tx_hash! })).status, "reverted");
    const reset = await step(s.service);
    assert.equal(reset.state, "signed");
    assert.equal(reset.nonce, null);
    holdBroadcast = false;
    assert.equal((await step(s.service)).nonce, 1);
    await mine(s.chain.anvil.url);
    assert.equal((await step(s.service)).state, "mined");
    assert.equal(await batchCount(s.chain), 1n);
  });
});
