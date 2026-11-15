import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createWalletClient, http } from "viem";
import { chainFor, receiptRegistryAbi } from "@hemi-receipts/sdk";
import { mine } from "@hemi-receipts/e2e/lib";
import type { RunningService } from "../src/service.js";
import { accounts, get, makeManifest, post, relayerTxCount, setupChain, signed, startTestService, tempDbPath, testEnv, waitFor, type TestChain } from "./helpers.js";

describe("direct path: POST /attest/direct", () => {
  let chain: TestChain;
  let service: RunningService;
  let db: ReturnType<typeof tempDbPath>;

  before(async () => {
    chain = await setupChain();
    db = tempDbPath();
    service = await startTestService(testEnv(chain, db.path, { HEMI_CONFIRMATIONS: "2" }));
  });

  after(async () => {
    await service?.stop();
    await chain?.stop();
    db?.cleanup();
  });

  it("returns ready-to-send calldata; the caller's own tx is detected and the receipt gets its anchor", async () => {
    const body = await signed(chain, makeManifest());
    const res = await post(`${service.url}/attest/direct`, { manifest: body.manifest, agentSignature: body.agentSignature });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    const out = res.body;
    assert.deepEqual(out.receipt, body.receipt);
    assert.equal(out.agentSignature, body.agentSignature);
    assert.equal(out.registry.toLowerCase(), chain.registry.toLowerCase());
    assert.equal(out.to.toLowerCase(), chain.registry.toLowerCase());
    assert.equal(out.chainId, chain.anvil.chainId);
    assert.ok(out.deadline > Date.now() / 1000 && out.deadline <= Date.now() / 1000 + 3600);
    assert.match(out.serviceSignature, /^0x[0-9a-f]{130}$/);

    // Pending until the caller sends it; the service sends nothing itself.
    assert.equal((await get(out.receiptUrl)).body.anchor, null);

    // An identical resubmission returns the same signature, free.
    const replay = await post(`${service.url}/attest/direct`, { manifest: body.manifest, agentSignature: body.agentSignature });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.serviceSignature, out.serviceSignature);
    assert.equal(replay.body.data, out.data);

    // The same receipt cannot also be queued for a batch.
    const batch = await post(`${service.url}/attest`, { manifest: body.manifest, agentSignature: body.agentSignature });
    assert.equal(batch.status, 409);
    assert.equal(batch.body.error, "run_id_conflict");

    const wallet = createWalletClient({ account: accounts.stranger, chain: chainFor(chain.anvil.chainId, [chain.anvil.url]), transport: http(chain.anvil.url) });
    const txHash = await wallet.sendTransaction({ to: out.to, data: out.data });
    const mined = await chain.client.waitForTransactionReceipt({ hash: txHash, pollingInterval: 50 });
    assert.equal(mined.status, "success");

    const file = await waitFor("direct anchor detected", async () => {
      const r = await get(out.receiptUrl);
      return r.body.anchor ? r.body : undefined;
    });
    assert.equal(file.anchor.mode, "direct");
    assert.deepEqual(file.anchor.proof, []);
    assert.equal(file.anchor.txHash, txHash);
    assert.equal(file.anchor.blockNumber, Number(mined.blockNumber));
    const onchainId = await chain.client.readContract({ address: chain.registry, abi: receiptRegistryAbi, functionName: "batchIdOfRun", args: [body.receipt.runId] });
    assert.equal(file.anchor.batchId, Number(onchainId));
    const verified = await chain.client.readContract({
      address: chain.registry,
      abi: receiptRegistryAbi,
      functionName: "verifyReceipt",
      args: [onchainId, body.receipt, []],
    });
    assert.equal(verified, true);
    assert.equal(await relayerTxCount(chain), 0, "the relayer sent nothing on the direct path");

    // Past HEMI_CONFIRMATIONS and past anvil's "safe" head (latest − 32).
    await mine(chain.anvil.url, 40);
    await waitFor("direct receipt hemi-confirmed", async () => (await get(out.receiptUrl)).body.status.stage === "hemi-confirmed");
  });
});
