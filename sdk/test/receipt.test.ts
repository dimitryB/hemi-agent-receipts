import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createWalletClient, encodeAbiParameters, hashTypedData, http, keccak256, recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL_KEYS, ROLE, startAnvil, type Anvil } from "@hemi-receipts/e2e/lib";
import {
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  leafHash,
  receiptDigest,
  receiptFromManifest,
  receiptTypedData,
  recoverReceiptSigner,
  registryDomain,
  serializeReceiptTypedData,
  signReceipt,
  type ManifestV1,
} from "../src/index.js";

const fixture: ManifestV1 = JSON.parse(readFileSync(new URL("../../examples/manifests/fixture-v1.json", import.meta.url), "utf8"));
const agent = privateKeyToAccount(ANVIL_KEYS[ROLE.agent]!);
const principal = privateKeyToAccount(ANVIL_KEYS[ROLE.principal]!);
const stranger = privateKeyToAccount(ANVIL_KEYS[ROLE.stranger]!);
const registry = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const domain = registryDomain(743_111, registry);
const manifest: ManifestV1 = { ...fixture, agent: agent.address.toLowerCase() as Hex, principal: principal.address.toLowerCase() as Hex };
const receipt = receiptFromManifest(manifest);

let anvil: Anvil;
before(async () => {
  anvil = await startAnvil({ chainId: 743_111 });
});
after(async () => {
  await anvil?.stop();
});

test("receiptFromManifest carries the on-chain fields", () => {
  assert.deepEqual(Object.keys(receipt).sort(), ["agent", "manifestHash", "principal", "runId", "schemaVersion"]);
  assert.equal(receipt.runId, manifest.runId);
  assert.equal(receipt.schemaVersion, 1);
});

test("leafHash = keccak256(abi.encode(runId, manifestHash, agent, principal))", () => {
  const expected = keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "address" }], [receipt.runId, receipt.manifestHash, receipt.agent, receipt.principal]),
  );
  assert.equal(leafHash(receipt), expected);
});

test("sign/recover round trip by the agent and by the principal", async () => {
  for (const account of [agent, principal]) {
    const signature = await signReceipt(account, receipt, domain);
    assert.match(signature, /^0x[0-9a-f]{130}$/);
    assert.equal(await recoverReceiptSigner(receipt, signature, domain), account.address);
  }
});

test("a WalletClient with an account signs the same bytes as the LocalAccount", async () => {
  const wallet = createWalletClient({ account: agent, transport: http(anvil.url) });
  assert.equal(await signReceipt(wallet, receipt, domain), await signReceipt(agent, receipt, domain));
});

test("the signature is bound to the domain and every field", async () => {
  const signature = await signReceipt(agent, receipt, domain);
  assert.notEqual(await recoverReceiptSigner(receipt, signature, registryDomain(43_111, registry)), agent.address, "other chain");
  assert.notEqual(await recoverReceiptSigner(receipt, signature, registryDomain(743_111, `0x${"1".repeat(40)}`)), agent.address, "other registry");
  for (const patch of [
    { runId: `0x${"ab".repeat(32)}` as Hex },
    { manifestHash: `0x${"cd".repeat(32)}` as Hex },
    { agent: stranger.address },
    { principal: stranger.address },
    { schemaVersion: 2 },
  ]) {
    assert.notEqual(await recoverReceiptSigner({ ...receipt, ...patch }, signature, domain), agent.address, JSON.stringify(patch));
  }
  const strangerSig = await signReceipt(stranger, receipt, domain);
  assert.equal(await recoverReceiptSigner(receipt, strangerSig, domain), stranger.address);
});

test("receiptDigest is the full EIP-712 digest (0x1901 ‖ domainSeparator ‖ structHash)", () => {
  assert.equal(receiptDigest(receipt, domain), hashTypedData(receiptTypedData(receipt, domain)));
  assert.equal(domain.name, EIP712_DOMAIN_NAME);
  assert.equal(domain.version, EIP712_DOMAIN_VERSION);
});

test("serializeReceiptTypedData declares EIP712Domain with all four fields", () => {
  const json = JSON.parse(serializeReceiptTypedData(receipt, domain));
  assert.deepEqual(json.types.EIP712Domain, [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ]);
  assert.equal(json.domain.name, "HemiAgentReceipts");
  assert.equal(json.domain.version, "1");
  assert.equal(String(json.domain.chainId), "743111");
  assert.equal(json.domain.verifyingContract.toLowerCase(), registry);
  assert.equal(json.primaryType, "Receipt");
  assert.equal(json.message.runId, receipt.runId);
  assert.equal(String(json.message.schemaVersion), "1");
});

test("eth_signTypedData_v4 over the serialized JSON yields a signature that recovers to the agent", async () => {
  // anvil signs for its unlocked dev accounts, the way a browser wallet would.
  const res = await fetch(anvil.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_signTypedData_v4", params: [agent.address, serializeReceiptTypedData(receipt, domain)] }),
  });
  const { result, error } = (await res.json()) as { result?: Hex; error?: unknown };
  assert.ok(result, `eth_signTypedData_v4 failed: ${JSON.stringify(error)}`);
  assert.equal(await recoverReceiptSigner(receipt, result, domain), agent.address);
  assert.equal(result, await signReceipt(agent, receipt, domain));
  // viem recovers the same way from the parsed JSON (domain.chainId as a string).
  const parsed = JSON.parse(serializeReceiptTypedData(receipt, domain));
  assert.equal(await recoverTypedDataAddress({ ...parsed, signature: result }), agent.address);
});

test("only canonical ECDSA signatures are accepted, matching ReceiptRegistry (65 bytes, v 27/28, low s)", async () => {
  const { isCanonicalEcdsaSignature, SECP256K1_HALF_N } = await import("../src/index.js");
  const sig = await signReceipt(agent, receipt, domain);
  assert.equal(isCanonicalEcdsaSignature(sig), true);
  assert.equal((await recoverReceiptSigner(receipt, sig, domain)).toLowerCase(), agent.address.toLowerCase());

  const r = sig.slice(2, 66);
  const s = BigInt(`0x${sig.slice(66, 130)}`);
  const v = parseInt(sig.slice(130, 132), 16);
  const n = SECP256K1_HALF_N * 2n + 1n;
  // The same signature with s' = n − s and the other v recovers to the same key in lenient
  // libraries, but OpenZeppelin (and so the registry) rejects it as malleable.
  const highS = `0x${r}${(n - s).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}` as Hex;
  assert.equal(await recoverTypedDataAddress({ ...receiptTypedData(receipt, domain), signature: highS }).then((a) => a.toLowerCase()), agent.address.toLowerCase(), "viem accepts the high-s twin");
  assert.equal(isCanonicalEcdsaSignature(highS), false);
  await assert.rejects(recoverReceiptSigner(receipt, highS, domain), /canonical/);

  const yParity = `0x${sig.slice(2, 130)}${(v - 27).toString(16).padStart(2, "0")}` as Hex;
  assert.equal(isCanonicalEcdsaSignature(yParity), false, "v of 0 or 1 is rejected");
  assert.equal(isCanonicalEcdsaSignature(`0x${sig.slice(2, 130)}` as Hex), false, "64 bytes (EIP-2098) is rejected");
});
