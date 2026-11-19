import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL_KEYS, ROLE, anchorBatch, deployRegistry, makeManifest, mine, signManifest, startAnvil, type Anvil } from "@hemi-receipts/e2e/lib";
import { chainFor, DEPLOYMENTS, type ReceiptFile } from "@hemi-receipts/sdk";
import { cli, REPO, tempDir } from "./helpers.js";

const CHAIN_ID = 743_111;
let anvil: Anvil;
let registry: Address;
let files: ReceiptFile[];
const dir = tempDir();
const write = (name: string, value: unknown) => {
  const path = join(dir.path, name);
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
};

before(async () => {
  anvil = await startAnvil({ chainId: CHAIN_ID });
  const client = createPublicClient({ chain: chainFor(CHAIN_ID, [anvil.url]), transport: http(anvil.url) }) as PublicClient;
  ({ registry } = await deployRegistry({
    rpcUrl: anvil.url,
    chainId: CHAIN_ID,
    deployerKey: ANVIL_KEYS[ROLE.owner]!,
    owner: privateKeyToAccount(ANVIL_KEYS[ROLE.owner]!).address,
    serviceSigner: privateKeyToAccount(ANVIL_KEYS[ROLE.service]!).address,
  }));
  const items = await Promise.all([1, 2, 3].map(() => signManifest({ manifest: makeManifest(), chainId: CHAIN_ID, registry })));
  // The fourth says it paid with a transaction that does not exist.
  const madeUp = { asset: `eip155:${CHAIN_ID}/erc20:0xd47971c7f5b1067d25cd45d30b2c9eb60de96443`, amount: "1000", txHash: `0x${"5a".repeat(32)}` as const };
  items.push(await signManifest({ manifest: makeManifest({ spend: [madeUp] }), chainId: CHAIN_ID, registry }));
  files = (await anchorBatch({ client, registry, serviceKey: ANVIL_KEYS[ROLE.service]!, items })).files;
});

after(async () => {
  await anvil?.stop();
  dir.cleanup();
});

test("a valid receipt: exit 0 and every check listed", async () => {
  const path = write("valid.json", files[0]);
  const r = await cli(["verify", path, "--rpc", anvil.url, "--registry", registry]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  for (const check of ["file", "registry", "chainId", "manifest", "agentSignature", "anchor", "merkleProof", "batch", "onchainProof", "anchorTx", "status"]) {
    assert.match(r.stdout, new RegExp(`^  pass  ${check}\\b`, "m"));
  }
  assert.match(r.stdout, /^  skip  spend\b/m, "its only spend is in usd, which no chain can confirm");
  assert.match(r.stdout, /^  spend\[0\] unchecked: 0\.0042 usd: no transaction named$/m);
  assert.match(r.stdout, /registry 0x[0-9a-fA-F]{40} \(--registry\)/);
  assert.match(r.stdout, /signed by the agent 0x90f79bf6eb2c4f870365e785982e1f101e93b906 \(ECDSA\)/);
  assert.match(r.stdout, /^VALID: in batch \d+, anchored by tx 0x[0-9a-f]{64}/m);
  assert.match(r.stdout, /stage hemi-included, 1 Hemi confirmations/);
});

test("--confirmations, --json, the Bitcoin finality line, and --no-btc", async () => {
  const path = write("valid2.json", files[1]);
  await mine(anvil.url, 40); // past anvil's safe head (latest − 32): chain id 743111 uses the safe-head rule
  const r = await cli(["verify", path, "--rpc", anvil.url, "--registry", registry, "--confirmations", "1", "--json"]);
  assert.equal(r.code, 0);
  const result = JSON.parse(r.stdout);
  assert.equal(result.valid, true);
  assert.equal(result.status.stage, "hemi-confirmed");
  assert.deepEqual(result.rpcUrls, [anvil.url]);
  assert.equal(result.batchTx, files[1]!.anchor!.txHash);
  assert.equal(result.status.btc.source, "unavailable");
  const text = await cli(["verify", path, "--rpc", anvil.url, "--registry", registry, "--confirmations", "1"]);
  assert.match(text.stdout, /^  stage hemi-confirmed, \d+ Hemi confirmations, safe head \d+$/m);
  assert.match(text.stdout, /^  bitcoin unavailable: no PoP activity: no PoP payout in \d+ keystone blocks? sampled over the last /m);
  const off = await cli(["verify", path, "--rpc", anvil.url, "--registry", registry, "--no-btc"]);
  assert.equal(off.code, 0);
  assert.match(off.stdout, /^  bitcoin unavailable: no Bitcoin finality source configured$/m);
  assert.equal((await cli(["verify", path, "--rpc", anvil.url, "--registry", registry, "--btc-scan", "x"])).code, 2);
});

test("a tampered receipt: exit 1 with the reason", async () => {
  const tampered = structuredClone(files[0]!);
  tampered.manifest!.endedAt += 1;
  const r = await cli(["verify", write("tampered.json", tampered), "--rpc", anvil.url, "--registry", registry]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^  fail  manifest/m);
  assert.match(r.stdout, /^INVALID$/m);
  assert.match(r.stdout, /^  - manifest hash mismatch: the file's manifest hashes to 0x[0-9a-f]{64}, receipt says 0x[0-9a-f]{64}$/m);
});

test("a genuine receipt that names a payment the chain does not have: exit 1, and the verdict says the receipt itself holds", async () => {
  const r = await cli(["verify", write("made-up-spend.json", files[3]), "--rpc", anvil.url, "--registry", registry]);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  for (const check of ["manifest", "agentSignature", "batch", "onchainProof", "anchorTx"]) assert.match(r.stdout, new RegExp(`^  pass  ${check}\\b`, "m"));
  assert.match(r.stdout, /^  fail  spend/m);
  assert.match(r.stdout, /^  spend\[0\] contradicted: 1000 eip155:743111\/erc20:0xd479\w+: there is no transaction 0x(5a){32} on chain 743111$/m);
  assert.match(r.stdout, /^INVALID: the receipt is genuine and anchored, but the chain contradicts what its manifest says was spent$/m);
  const json = JSON.parse((await cli(["verify", write("made-up-spend2.json", files[3]), "--rpc", anvil.url, "--registry", registry, "--json"])).stdout);
  assert.equal(json.valid, false);
  assert.equal(json.authentic, true);
  assert.equal(json.spend[0].outcome, "contradicted");
});

test("--manifest checks a separate manifest file", async () => {
  const { manifest, ...bare } = structuredClone(files[2]!);
  const barePath = write("bare.json", bare);
  const ok = await cli(["verify", barePath, "--rpc", anvil.url, "--registry", registry, "--manifest", write("m.json", manifest)]);
  assert.equal(ok.code, 0, ok.stdout);
  const skipped = await cli(["verify", barePath, "--rpc", anvil.url, "--registry", registry]);
  assert.equal(skipped.code, 0);
  assert.match(skipped.stdout, /^  skip  manifest/m);
  const wrong = await cli(["verify", barePath, "--rpc", anvil.url, "--registry", registry, "--manifest", write("m2.json", files[0]!.manifest)]);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stdout, /manifest hash mismatch: the manifest you supplied hashes to/);
});

test("the default registry comes from the SDK's deployments, never from the file", async () => {
  assert.ok(DEPLOYMENTS[CHAIN_ID], "testnet has a known deployment");
  const r = await cli(["verify", write("default.json", files[0]), "--rpc", anvil.url]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, new RegExp(`registry ${DEPLOYMENTS[CHAIN_ID]!.registry} \\(known deployment on chain ${CHAIN_ID}\\)`));
  assert.match(r.stdout, new RegExp(`receipt file names registry ${registry.toLowerCase()}, but you are verifying against registry ${DEPLOYMENTS[CHAIN_ID]!.registry.toLowerCase()}`));
});

test("usage errors exit 2: no known deployment, no default RPC, bad flags, unreadable file", async () => {
  const local = { ...files[0]!, chainId: 31_337 };
  const noRegistry = await cli(["verify", write("local.json", local), "--rpc", anvil.url]);
  assert.equal(noRegistry.code, 2);
  assert.match(noRegistry.stderr, /no known ReceiptRegistry deployment for chain 31337; pass --registry/);
  const noRpc = await cli(["verify", write("local2.json", local), "--registry", registry]);
  assert.equal(noRpc.code, 2);
  assert.match(noRpc.stderr, /no default RPC for chain 31337; pass --rpc URL/);
  assert.equal((await cli(["verify", write("v.json", files[0]), "--registry", "0x12", "--rpc", anvil.url])).code, 2);
  assert.equal((await cli(["verify", join(dir.path, "missing.json")])).code, 2);
  assert.equal((await cli(["verify"])).code, 2);
  const notJson = join(dir.path, "nj.json");
  writeFileSync(notJson, "{");
  assert.equal((await cli(["verify", notJson, "--registry", registry, "--rpc", anvil.url])).code, 2);
});

test("JSON that is not a receipt object is invalid with a reason, not a crash", async () => {
  for (const [name, value] of [["null", null], ["array", []], ["number", 7]] as const) {
    const r = await cli(["verify", write(`${name}.json`, value), "--registry", registry, "--rpc", anvil.url]);
    assert.equal(r.code, 1, `${name}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /^INVALID$/m, name);
    assert.match(r.stdout, /^  fail  file/m, name);
    assert.doesNotMatch(r.stderr, /TypeError/, name);
  }
});

test("an RPC that cannot be reached: exit 2 (undetermined), not 'invalid'", async () => {
  const r = await cli(["verify", write("down.json", files[0]), "--rpc", "http://127.0.0.1:1", "--registry", registry]);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /^UNDETERMINED: the chain could not be read$/m);
  assert.match(r.stdout, /eth_chainId: RPC failed after retries/);
});

test("a receipt already proven wrong stays invalid with the RPC down: exit 1, not 2", async () => {
  const tampered = structuredClone(files[0]) as typeof files[0];
  tampered.manifest!.model += "X";
  const r = await cli(["verify", write("down-tampered.json", tampered), "--rpc", "http://127.0.0.1:1", "--registry", registry]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^INVALID$/m);
});

function runBin(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(REPO, "cli/src/index.ts"), ...args], { cwd: REPO, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("the receipts bin sets the process exit code: 0 valid, 1 invalid, 2 usage", async () => {
  const valid = await runBin(["verify", write("bin-valid.json", files[0]), "--rpc", anvil.url, "--registry", registry]);
  assert.equal(valid.code, 0, valid.stderr);
  assert.match(valid.stdout, /^VALID/m);
  const forged = structuredClone(files[0]!);
  forged.agentSignature = `0x${"22".repeat(65)}`;
  const invalid = await runBin(["verify", write("bin-invalid.json", forged), "--rpc", anvil.url, "--registry", registry]);
  assert.equal(invalid.code, 1);
  const usage = await runBin(["verify"]);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /give exactly one receipt file/);
});
