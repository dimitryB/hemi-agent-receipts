import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTestClient, createWalletClient, http, type Abi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { chainFor } from "@hemi-receipts/sdk";
import { ANVIL_KEYS, ROLE } from "@hemi-receipts/e2e/lib";
import type { RunningService } from "../src/service.js";
import { accounts, batchCount, get, makeManifest, post, relayerTxCount, setupChain, signed, startTestService, tempDbPath, testEnv, waitFor, type TestChain } from "./helpers.js";

/** The test-only EIP-1271 wallet from the contracts workspace (compiled by `npm test -w contracts`). */
const MOCK_WALLET_ARTIFACT = new URL("../../contracts/artifacts/contracts/mocks/ERC1271WalletMock.sol/ERC1271WalletMock.json", import.meta.url);

describe("POST /attest validation and idempotency", () => {
  let chain: TestChain;
  let service: RunningService;
  let db: ReturnType<typeof tempDbPath>;

  before(async () => {
    chain = await setupChain();
    db = tempDbPath();
    // BATCH_MAX_WAIT long enough that nothing closes until the test says so.
    service = await startTestService(testEnv(chain, db.path, { BATCH_MAX_WAIT_SECONDS: "0.5" }));
  });

  after(async () => {
    await service?.stop();
    await chain?.stop();
    db?.cleanup();
  });

  it("accepts a new receipt with 202, then answers an identical resubmission with 200 and the stored receipt, with no second tx", async () => {
    const body = await signed(chain, makeManifest());
    const first = await post(`${service.url}/attest`, { manifest: body.manifest, agentSignature: body.agentSignature });
    assert.equal(first.status, 202);
    assert.equal(first.body.runId, body.receipt.runId);
    assert.equal(first.body.status, "pending");
    assert.equal(first.body.receiptUrl, `${service.url}/receipts/${body.receipt.runId}`);

    const anchored = await waitFor("anchoring", async () => {
      const r = await get(first.body.receiptUrl);
      return r.body.anchor ? r.body : undefined;
    });
    const txsAfterFirst = await relayerTxCount(chain);
    assert.equal(txsAfterFirst, 1);

    const again = await post(`${service.url}/attest`, { manifest: body.manifest, agentSignature: body.agentSignature });
    assert.equal(again.status, 200);
    assert.equal(again.body.format, "hemi-agent-receipt");
    assert.deepEqual(again.body.receipt, anchored.receipt);
    assert.deepEqual(again.body.anchor, anchored.anchor);

    // Same receipt sent as the five fields only (no manifest): also a replay.
    const fieldsOnly = await post(`${service.url}/attest`, { receipt: body.receipt, agentSignature: body.agentSignature });
    assert.equal(fieldsOnly.status, 200);

    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(await relayerTxCount(chain), txsAfterFirst, "a replay must not send another transaction");
    assert.equal(await batchCount(chain), 1n);
  });

  it("lets any origin read receipts, batches and health (the viewer), but not the paid POST routes", async () => {
    const body = await signed(chain, makeManifest());
    const posted = await fetch(`${service.url}/attest`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://viewer.example" },
      body: JSON.stringify({ manifest: body.manifest, agentSignature: body.agentSignature }),
    });
    assert.equal(posted.status, 202);
    assert.equal(posted.headers.get("access-control-allow-origin"), null, "POST /attest is not cross-origin readable");
    for (const path of [`/receipts/${body.receipt.runId}`, "/health"]) {
      const res = await fetch(`${service.url}${path}`, { headers: { origin: "http://viewer.example" } });
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get("access-control-allow-origin"), "*", path);
    }
  });

  it("refuses a different manifest under the same runId with 409 run_id_conflict", async () => {
    const original = await signed(chain, makeManifest());
    assert.equal((await post(`${service.url}/attest`, { manifest: original.manifest, agentSignature: original.agentSignature })).status, 202);
    const other = await signed(chain, makeManifest({ runId: original.manifest.runId, model: "another-model" }));
    const conflict = await post(`${service.url}/attest`, { manifest: other.manifest, agentSignature: other.agentSignature });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, "run_id_conflict");
  });

  it("rejects an invalid manifest with 400 invalid_manifest", async () => {
    const manifest = { ...makeManifest(), endedAt: 1, startedAt: 2, extra: true };
    const res = await post(`${service.url}/attest`, { manifest, agentSignature: `0x${"11".repeat(65)}` });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "invalid_manifest");
    assert.ok(res.body.errors.some((e: string) => e.includes("extra")));
  });

  it("rejects a bad agent signature with 400 invalid_agent_signature", async () => {
    const manifest = makeManifest();
    const bySomeoneElse = await signed(chain, manifest, ANVIL_KEYS[ROLE.stranger]!);
    const res = await post(`${service.url}/attest`, { manifest, agentSignature: bySomeoneElse.agentSignature });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "invalid_agent_signature");

    const garbage = await post(`${service.url}/attest`, { manifest, agentSignature: "0x1234" });
    assert.equal(garbage.status, 400);
    assert.equal(garbage.body.error, "invalid_agent_signature");
    assert.equal((await get(`${service.url}/receipts/${manifest.runId}`)).status, 404);
  });

  it("checks an account that has code only through EIP-1271, as the registry does (EIP-7702)", async () => {
    // Fresh keys, so what the service remembers about the shared accounts' code is untouched.
    const plainKey = generatePrivateKey();
    const plain = privateKeyToAccount(plainKey);
    const walletKey = generatePrivateKey();
    const asWallet = privateKeyToAccount(walletKey);
    const viemChain = chainFor(chain.anvil.chainId, [chain.anvil.url]);
    const testClient = createTestClient({ mode: "anvil", chain: viemChain, transport: http(chain.anvil.url) });

    // `plain` gets code that answers nothing. The chain would now refuse its own ECDSA signature, so the service does too.
    await testClient.setCode({ address: plain.address, bytecode: "0x00" });
    const manifest = makeManifest({ agent: plain.address.toLowerCase() as Address });
    const byItself = await signed(chain, manifest, plainKey);
    const rejected = await post(`${service.url}/attest`, { manifest, agentSignature: byItself.agentSignature });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error, "invalid_agent_signature");
    assert.match(rejected.body.message, /has code/);

    // Its principal, an EOA, can still sign for it.
    const byPrincipal = await signed(chain, manifest, ANVIL_KEYS[ROLE.principal]!);
    const accepted = await post(`${service.url}/attest`, { manifest, agentSignature: byPrincipal.agentSignature });
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));

    // `asWallet` gets the runtime code of an EIP-1271 wallet whose signer is its own key, like a
    // delegated EOA that answers isValidSignature: the same ECDSA bytes pass, through EIP-1271.
    const artifact = JSON.parse(readFileSync(MOCK_WALLET_ARTIFACT, "utf8")) as { abi: Abi; bytecode: Hex };
    const deployer = createWalletClient({ account: accounts.owner, chain: viemChain, transport: http(chain.anvil.url) });
    const deployHash = await deployer.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [asWallet.address] });
    const { contractAddress } = await chain.client.waitForTransactionReceipt({ hash: deployHash, pollingInterval: 50 });
    const runtime = await chain.client.getCode({ address: contractAddress! });
    await testClient.setCode({ address: asWallet.address, bytecode: runtime! });
    const manifest2 = makeManifest({ agent: asWallet.address.toLowerCase() as Address });
    const byWallet = await signed(chain, manifest2, walletKey);
    const viaWallet = await post(`${service.url}/attest`, { manifest: manifest2, agentSignature: byWallet.agentSignature });
    assert.equal(viaWallet.status, 202, JSON.stringify(viaWallet.body));
  });

  it("accepts the principal's signature, and a receipt sent without its manifest", async () => {
    const byPrincipal = await signed(chain, makeManifest(), ANVIL_KEYS[ROLE.principal]!);
    const res = await post(`${service.url}/attest`, { receipt: byPrincipal.receipt, agentSignature: byPrincipal.agentSignature });
    assert.equal(res.status, 202);
    const stored = await get(res.body.receiptUrl);
    assert.equal(stored.status, 200);
    assert.equal(stored.body.manifest, undefined, "no manifest is stored unless asked");
  });

  it("refuses a receipt that disagrees with its manifest", async () => {
    const body = await signed(chain, makeManifest());
    const res = await post(`${service.url}/attest`, {
      manifest: body.manifest,
      receipt: { ...body.receipt, manifestHash: `0x${"ab".repeat(32)}` },
      agentSignature: body.agentSignature,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "manifest_receipt_mismatch");
  });

  it("stores the manifest only when asked, and returns it in the receipt file", async () => {
    const body = await signed(chain, makeManifest({ tags: ["café"] }));
    const res = await post(`${service.url}/attest`, { manifest: body.manifest, agentSignature: body.agentSignature, store: true });
    assert.equal(res.status, 202);
    const file = await get(res.body.receiptUrl);
    assert.deepEqual(file.body.manifest, JSON.parse(JSON.stringify(body.manifest)));
  });

  it("answers malformed and oversized bodies with JSON errors", async () => {
    const bad = await fetch(`${service.url}/attest`, { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { error: string }).error, "invalid_json");
    const big = await post(`${service.url}/attest`, { manifest: { model: "x".repeat(1_300_000) }, agentSignature: "0x00" });
    assert.equal(big.status, 413);
    assert.equal((await get(`${service.url}/receipts/0x1234`)).status, 400);
    assert.equal((await get(`${service.url}/receipts/0x${"77".repeat(32)}`)).status, 404);
  });
});
