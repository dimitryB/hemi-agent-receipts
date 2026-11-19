/**
 * verify() against anvil and a deployed ReceiptRegistry, directly and through a flaky RPC.
 * verify never talks to the receipts service; no service runs in this file.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, custom, http, numberToHex, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ANVIL_KEYS,
  REPO_ROOT,
  ROLE,
  anchorBatch,
  anchorDirect,
  deployRegistry,
  makeManifest,
  mine,
  signManifest,
  startAnvil,
  startFlakyRpc,
  voidBatch,
  type Anvil,
  type FlakyRpc,
} from "@hemi-receipts/e2e/lib";
import { chainFor, createHemiPublicClient, hashManifest, receiptFromManifest, signReceipt, registryDomain, unavailableFinality, verify, VERIFY_CHECKS, type ManifestV1, type ReceiptFile, type VerifyResult } from "../src/index.js";

const CHAIN_ID = 743_111; // a Hemi chain id, so the domain and network lookups are realistic
const owner = privateKeyToAccount(ANVIL_KEYS[ROLE.owner]!);
const service = privateKeyToAccount(ANVIL_KEYS[ROLE.service]!);

let anvil: Anvil;
let client: PublicClient;
let registry: Address;
let otherRegistry: Address;
/** Three receipts in batch A, two in batch B, one direct, one in a batch that gets voided. */
let batchA: ReceiptFile[];
let batchB: ReceiptFile[];
let direct: ReceiptFile;
let voided: ReceiptFile;

const clone = <T>(v: T): T => structuredClone(v);
const fast = { requestsPerSecond: 500, burst: 100, retryDelayMs: 20, retryCount: 8, timeoutMs: 5_000 };

function expectValid(result: VerifyResult) {
  assert.deepEqual(result.reasons, []);
  assert.equal(result.valid, true);
  assert.equal(result.authentic, true);
  // makeManifest's only spend is in "usd", which no chain can confirm: the spend check is skipped.
  for (const check of VERIFY_CHECKS) assert.equal(result.checks[check], check === "spend" ? result.checks.spend : "pass", `check ${check}`);
  assert.notEqual(result.checks.spend, "fail");
}

function expectInvalid(result: VerifyResult, check: string, code: string, reason: RegExp) {
  assert.equal(result.valid, false);
  assert.equal(result.checks[check as keyof VerifyResult["checks"]], "fail", `check ${check} should fail; checks: ${JSON.stringify(result.checks)}`);
  const problem = result.problems.find((p) => p.check === check && p.code === code);
  assert.ok(problem, `expected problem ${check}/${code}; got ${JSON.stringify(result.problems)}`);
  assert.match(problem.message, reason);
  assert.ok(result.reasons.includes(problem.message));
  assert.equal(result.incomplete, false);
}

before(async () => {
  anvil = await startAnvil({ chainId: CHAIN_ID });
  client = createPublicClient({ chain: chainFor(CHAIN_ID, [anvil.url]), transport: http(anvil.url) }) as PublicClient;
  const deploy = (deployerKey: Hex) =>
    deployRegistry({ rpcUrl: anvil.url, chainId: CHAIN_ID, deployerKey, owner: owner.address, serviceSigner: service.address });
  registry = (await deploy(ANVIL_KEYS[ROLE.owner]!)).registry;
  otherRegistry = (await deploy(ANVIL_KEYS[ROLE.stranger]!)).registry;

  const sign = (signerKey?: Hex) => signManifest({ manifest: makeManifest(), chainId: CHAIN_ID, registry, signerKey });
  const common = { client, registry, serviceKey: ANVIL_KEYS[ROLE.service]! };
  batchA = (await anchorBatch({ ...common, items: [await sign(), await sign(ANVIL_KEYS[ROLE.principal]!), await sign()] })).files;
  batchB = (await anchorBatch({ ...common, items: [await sign(), await sign()] })).files;
  direct = (await anchorDirect({ ...common, item: await sign() })).files[0]!;
  const toVoid = await anchorBatch({ ...common, items: [await sign(), await sign()] });
  voided = toVoid.files[0]!;
  await voidBatch({ client, registry, batchId: toVoid.batchId, root: toVoid.root, reason: "test incident" });
});

after(async () => {
  await anvil?.stop();
});

describe("verify against anvil", () => {
  test("a real batched receipt is valid (signed by the agent)", async () => {
    const result = await verify(batchA[0], { registry, rpcUrl: anvil.url, clientOptions: fast });
    expectValid(result);
    assert.equal(result.batchTx, batchA[0]!.anchor!.txHash);
    assert.equal(result.status?.stage, "hemi-included");
    assert.equal(result.status?.hemi?.blockNumber, batchA[0]!.anchor!.blockNumber);
    assert.deepEqual(result.signer, { address: batchA[0]!.receipt.agent, role: "agent", method: "ecdsa" });
  });

  test("a receipt signed by the principal is valid", async () => {
    const result = await verify(batchA[1], { registry, rpcUrl: anvil.url, clientOptions: fast });
    expectValid(result);
    assert.equal(result.signer?.role, "principal");
  });

  test("a direct receipt is valid", async () => {
    assert.equal(direct.anchor?.mode, "direct");
    assert.deepEqual(direct.anchor?.proof, []);
    expectValid(await verify(direct, { registry, rpcUrl: anvil.url, clientOptions: fast }));
  });

  test("valid without a manifest (the manifest check is skipped), and with the manifest passed separately", async () => {
    const { manifest, ...bare } = clone(batchA[2]!);
    const noManifest = await verify(bare, { registry, rpcUrl: anvil.url, clientOptions: fast });
    assert.equal(noManifest.valid, true);
    assert.equal(noManifest.checks.manifest, "skip");
    expectValid(await verify(bare, { registry, rpcUrl: anvil.url, manifest, clientOptions: fast }));
  });

  test("the registry from the caller is compared case-insensitively; a provided client works", async () => {
    const result = await verify(batchB[0], { registry: registry.toUpperCase().replace("0X", "0x") as Address, client, chainId: CHAIN_ID });
    expectValid(result);
  });

  test("status: safe head and confirmations; the default Bitcoin finality reader for the chain", async () => {
    // chain id 743111: the safe-head rule applies (anvil's safe head is latest − 32)
    const early = await verify(batchA[0], { registry, rpcUrl: anvil.url, confirmations: 1, clientOptions: fast });
    assert.equal(early.status?.stage, "hemi-included");
    assert.ok(early.status?.notes?.some((n) => /waiting for the safe head/.test(n)));
    await mine(anvil.url, 40);
    const result = await verify(batchA[0], { registry, rpcUrl: anvil.url, confirmations: 1, clientOptions: fast });
    assert.equal(result.valid, true);
    assert.equal(result.status?.stage, "hemi-confirmed");
    assert.ok(result.status!.hemi!.safeBlock! >= batchA[0]!.anchor!.blockNumber);
    assert.equal(result.status?.estimated, false);
    // defaultFinalityReader(743111): testnet has no PoP; the liveness gate samples recent keystone blocks
    assert.equal(result.status?.btc?.source, "unavailable");
    assert.match(result.status!.btc!.detail!, /^no PoP activity: no PoP payout in \d+ keystone blocks? sampled over the last /);
    const none = await verify(batchA[0], { registry, rpcUrl: anvil.url, confirmations: 1, clientOptions: fast, finality: unavailableFinality });
    assert.equal(none.status?.btc?.detail, "no Bitcoin finality source configured");
  });

  test("(a) a manifest with ONE changed byte is invalid: manifest hash mismatch", async () => {
    const file = clone(batchA[0]!);
    const original = hashManifest(file.manifest!);
    file.manifest!.model = `${file.manifest!.model.slice(0, -1)}2`; // claude-fable-5-1 -> claude-fable-5-2
    const result = await verify(file, { registry, rpcUrl: anvil.url, clientOptions: fast });
    expectInvalid(result, "manifest", "manifest-hash-mismatch", new RegExp(`manifest hash mismatch: the file's manifest hashes to 0x[0-9a-f]{64}, receipt says ${original}`));
    assert.equal(result.checks.batch, "pass", "the on-chain part is still fine");
    assert.equal(result.reasons.length, 1);
  });

  test("(b) a proof against the wrong batch (batchId of another real batch) is invalid", async () => {
    const file = clone(batchA[0]!);
    file.anchor!.batchId = batchB[0]!.anchor!.batchId;
    const result = await verify(file, { registry, rpcUrl: anvil.url, clientOptions: fast });
    const id = file.anchor!.batchId;
    expectInvalid(result, "onchainProof", "proof-onchain-false", new RegExp(`proof does not verify against batch ${id}'s root`));
    expectInvalid(result, "batch", "batch-root-mismatch", new RegExp(`batch ${id}'s on-chain root is ${batchB[0]!.anchor!.root}, but the receipt's anchor says ${batchA[0]!.anchor!.root}`));
    assert.equal(result.status, null);

    // the forger also copies the other batch's root and tx: now the local proof fails too
    file.anchor!.root = batchB[0]!.anchor!.root;
    file.anchor!.txHash = batchB[0]!.anchor!.txHash;
    file.anchor!.blockNumber = batchB[0]!.anchor!.blockNumber;
    const again = await verify(file, { registry, rpcUrl: anvil.url, clientOptions: fast });
    expectInvalid(again, "merkleProof", "proof-local-mismatch", /proof does not verify against the anchor's root/);
    expectInvalid(again, "onchainProof", "proof-onchain-false", new RegExp(`proof does not verify against batch ${id}'s root`));
    assert.equal(again.checks.batch, "pass");
    assert.equal(again.checks.anchorTx, "pass");
  });

  test("(c) a forged agent signature is invalid", async () => {
    const file = clone(batchA[0]!);
    const stranger = privateKeyToAccount(ANVIL_KEYS[ROLE.stranger]!);
    file.agentSignature = await signReceipt(stranger, file.receipt, registryDomain(CHAIN_ID, registry));
    const result = await verify(file, { registry, rpcUrl: anvil.url, clientOptions: fast });
    expectInvalid(
      result,
      "agentSignature",
      "signature-mismatch",
      new RegExp(`agent signature recovers to ${stranger.address.toLowerCase()}, expected agent ${file.receipt.agent} or principal ${file.receipt.principal}`),
    );
    // garbage bytes
    file.agentSignature = `0x${"11".repeat(65)}`;
    expectInvalid(await verify(file, { registry, rpcUrl: anvil.url, clientOptions: fast }), "agentSignature", "signature-mismatch", /agent signature/);
  });

  test("a signature for another registry's domain is invalid", async () => {
    const file = clone(batchA[0]!);
    file.agentSignature = await signReceipt(privateKeyToAccount(ANVIL_KEYS[ROLE.agent]!), file.receipt, registryDomain(CHAIN_ID, otherRegistry));
    expectInvalid(await verify(file, { registry, rpcUrl: anvil.url, clientOptions: fast }), "agentSignature", "signature-mismatch", /recovers to 0x[0-9a-f]{40}, expected agent/);
  });

  test("wrong registry: the caller's trust root differs from the file", async () => {
    const result = await verify(batchA[0], { registry: otherRegistry, rpcUrl: anvil.url, clientOptions: fast });
    expectInvalid(result, "registry", "registry-mismatch", new RegExp(`receipt file names registry ${registry.toLowerCase()}, but you are verifying against registry ${otherRegistry.toLowerCase()}`));
    // and the file cannot make the verifier trust it: pointing the file at the other registry
    // still fails, because the signature domain and the chain reads use the caller's registry
    const file = clone(batchA[0]!);
    file.registry = otherRegistry;
    const swapped = await verify(file, { registry: otherRegistry, rpcUrl: anvil.url, clientOptions: fast });
    assert.equal(swapped.valid, false);
    assert.equal(swapped.checks.agentSignature, "fail");
    assert.equal(swapped.checks.batch, "fail");
  });

  test("wrong registry address with no contract: a clear reason", async () => {
    const nowhere = "0x000000000000000000000000000000000000dead";
    const file = { ...clone(batchA[0]!), registry: nowhere };
    const result = await verify(file, { registry: nowhere, rpcUrl: anvil.url, clientOptions: fast });
    expectInvalid(result, "batch", "registry-no-code", /no ReceiptRegistry at 0x0{36}dead on chain 743111/);
  });

  test("wrong chain: the RPC serves another chain, or the caller expects another chain", async () => {
    const file = { ...clone(batchA[0]!), chainId: 43_111 };
    const result = await verify(file, { registry, rpcUrl: anvil.url, clientOptions: fast });
    expectInvalid(result, "chainId", "chain-mismatch", /RPC serves chain 743111, but the receipt is for chain 43111/);
    assert.equal(result.checks.batch, "skip");
    const expected = await verify(batchA[0], { registry, rpcUrl: anvil.url, chainId: 43_111, clientOptions: fast });
    expectInvalid(expected, "chainId", "chain-mismatch", /receipt is for chain 743111, but you are verifying on chain 43111/);
  });

  test("a voided batch is invalid and its status is voided", async () => {
    const result = await verify(voided, { registry, rpcUrl: anvil.url, clientOptions: fast });
    expectInvalid(result, "batch", "batch-voided", new RegExp(`batch ${voided.anchor!.batchId} was voided`));
    expectInvalid(result, "onchainProof", "proof-onchain-false", /is voided/);
    assert.equal(result.status?.stage, "voided");
  });

  test("anchor null: invalid, not anchored yet, status pending", async () => {
    const file = { ...clone(batchA[0]!), anchor: null };
    const result = await verify(file, { registry, rpcUrl: anvil.url, clientOptions: fast });
    expectInvalid(result, "anchor", "not-anchored", /not anchored yet/);
    assert.equal(result.status?.stage, "pending");
    assert.equal(result.checks.batch, "skip");
    assert.equal(result.checks.agentSignature, "pass");
  });

  test("a tampered proof element is invalid", async () => {
    const file = clone(batchA[0]!);
    assert.ok(file.anchor!.proof.length > 0);
    file.anchor!.proof[0] = `0x${"00".repeat(31)}01`;
    const result = await verify(file, { registry, rpcUrl: anvil.url, clientOptions: fast });
    expectInvalid(result, "merkleProof", "proof-local-mismatch", /proof does not verify against the anchor's root/);
    expectInvalid(result, "onchainProof", "proof-onchain-false", /proof does not verify against batch \d+'s root/);
  });

  test("a wrong txHash is invalid, and the real anchoring tx is reported", async () => {
    const file = clone(batchA[0]!);
    file.anchor!.txHash = batchB[0]!.anchor!.txHash;
    const result = await verify(file, { registry, rpcUrl: anvil.url, clientOptions: fast });
    expectInvalid(result, "anchorTx", "anchor-tx-mismatch", new RegExp(`anchored by tx ${batchA[0]!.anchor!.txHash}, but the receipt's anchor says tx ${batchB[0]!.anchor!.txHash}`));
    assert.equal(result.batchTx, batchA[0]!.anchor!.txHash);
  });

  test("a wrong anchor blockNumber is invalid", async () => {
    const file = clone(batchA[0]!);
    file.anchor!.blockNumber += 1;
    expectInvalid(await verify(file, { registry, rpcUrl: anvil.url, clientOptions: fast }), "anchorTx", "anchor-block-mismatch", /but the receipt's anchor says block/);
  });

  test("a reorg while verifying (the block at the anchor's height no longer carries it) is invalid, not valid-but-pending", async () => {
    // Every read answers from the real chain except the anchoring block, whose hash comes back
    // changed: what a verifier sees mid-reorg, or from two RPCs behind one load balancer. The
    // batch, proof and log checks pass against the old view; the status check must not.
    const file = batchB[1]!;
    const atAnchor = numberToHex(BigInt(file.anchor!.blockNumber));
    const shifting = createPublicClient({
      chain: chainFor(CHAIN_ID, [anvil.url]),
      cacheTime: 0,
      transport: custom({
        async request({ method, params }: { method: string; params?: unknown[] }) {
          const result = await client.request({ method, params } as never);
          if (method === "eth_getBlockByNumber" && params?.[0] === atAnchor) return { ...(result as object), hash: `0x${"ab".repeat(32)}` };
          return result;
        },
      }),
    }) as PublicClient;
    const result = await verify(file, { registry, client: shifting, finality: unavailableFinality });
    assert.equal(result.valid, false);
    assert.equal(result.incomplete, true, "a reorg says nothing about the receipt: it is undetermined, not invalid");
    assert.equal(result.checks.status, "fail");
    const problem = result.problems.find((p) => p.check === "status" && p.code === "anchor-reorged");
    assert.match(problem?.message ?? "", /anchoring block was reorged out: block \d+ is now 0x(ab){32}, the anchor was in 0x[0-9a-f]{64}; the chain changed while verifying/);
    assert.equal(result.status?.stage, "pending");
    for (const check of ["batch", "onchainProof", "anchorTx"] as const) assert.equal(result.checks[check], "pass", `${check} passed against the old view; only status caught the reorg`);
  });

  test("a batch id that does not exist", async () => {
    const file = clone(batchA[0]!);
    file.anchor!.batchId = 999;
    expectInvalid(await verify(file, { registry, rpcUrl: anvil.url, clientOptions: fast }), "batch", "batch-unknown", /batch 999 does not exist on registry .* \(getBatch reverted: UnknownBatch\)/);
  });

  test("a receipt field changed (manifestHash and manifest swapped together) fails the signature and on-chain checks", async () => {
    const file = clone(batchA[0]!);
    file.manifest = { ...file.manifest!, model: "swapped" };
    file.receipt = receiptFromManifest(file.manifest);
    const result = await verify(file, { registry, rpcUrl: anvil.url, clientOptions: fast });
    assert.equal(result.checks.manifest, "pass");
    expectInvalid(result, "agentSignature", "signature-mismatch", /agent signature recovers to/);
    expectInvalid(result, "merkleProof", "proof-local-mismatch", /proof does not verify/);
    expectInvalid(result, "onchainProof", "proof-onchain-false", /proof does not verify/);
  });

  test("a mode/proof mismatch and a file that is not a receipt", async () => {
    const file = clone(batchA[0]!);
    file.anchor!.mode = "direct";
    const result = await verify(file, { registry, rpcUrl: anvil.url, clientOptions: fast });
    expectInvalid(result, "anchor", "anchor-invalid", /mode "direct" .* carries a \d-element proof/);
    expectInvalid(result, "batch", "batch-count-mismatch", /holds 3 receipts/);
    const junk = await verify({ format: "something-else" }, { registry, rpcUrl: anvil.url });
    expectInvalid(junk, "file", "file-shape", /format: expected "hemi-agent-receipt"/);
    for (const check of VERIFY_CHECKS.filter((c) => c !== "file")) assert.equal(junk.checks[check], "skip");
    const badManifest = clone(batchA[0]!);
    (badManifest.manifest as unknown as Record<string, unknown>).extra = 1;
    expectInvalid(await verify(badManifest, { registry, rpcUrl: anvil.url, clientOptions: fast }), "manifest", "manifest-invalid", /extra: unknown field/);
  });

  test("the registry option is required and must be an address", async () => {
    await assert.rejects(verify(batchA[0], { registry: undefined as never, rpcUrl: anvil.url }), /options.registry must be the registry address you trust/);
  });

  test("an unreachable RPC makes the result incomplete, not a false claim", async () => {
    const result = await verify(batchA[0], { registry, rpcUrl: "http://127.0.0.1:1", clientOptions: { retryCount: 1, retryDelayMs: 10, timeoutMs: 500 } });
    assert.equal(result.valid, false);
    assert.equal(result.incomplete, true);
    assert.ok(result.problems.some((p) => p.code === "rpc-error" && p.check === "chainId"));
    assert.equal(result.checks.agentSignature, "pass", "ECDSA needs no RPC");
  });

  test("a definite failure stands with the RPC down: incomplete means the receipt might still be valid", async () => {
    const file = clone(batchA[0]!);
    file.manifest!.model += "X";
    const result = await verify(file, { registry, rpcUrl: "http://127.0.0.1:1", clientOptions: { retryCount: 1, retryDelayMs: 10, timeoutMs: 500 } });
    assert.equal(result.valid, false);
    assert.equal(result.checks.manifest, "fail");
    assert.equal(result.incomplete, false);
  });
});

describe("contract-wallet signatures (EIP-1271)", () => {
  const MOCK = resolve(REPO_ROOT, "contracts/artifacts/contracts/mocks/ERC1271WalletMock.sol/ERC1271WalletMock.json");

  test("a principal that is an EIP-1271 wallet is accepted through verifyTypedData", { skip: !existsSync(MOCK) && "no ERC1271WalletMock artifact" }, async () => {
    const artifact = JSON.parse(readFileSync(MOCK, "utf8"));
    const signerKey = ANVIL_KEYS[ROLE.principal]!;
    const deployer = createWalletClient({ account: owner, chain: chainFor(CHAIN_ID, [anvil.url]), transport: http(anvil.url) });
    const hash = await deployer.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [privateKeyToAccount(signerKey).address] });
    const wallet = (await client.waitForTransactionReceipt({ hash, pollingInterval: 50 })).contractAddress!.toLowerCase() as Address;

    const manifest = makeManifest({ principal: wallet });
    const item = await signManifest({ manifest, chainId: CHAIN_ID, registry, signerKey });
    const anchored = await anchorBatch({ client, registry, serviceKey: ANVIL_KEYS[ROLE.service]!, items: [item, await signManifest({ manifest: makeManifest(), chainId: CHAIN_ID, registry })] });
    const result = await verify(anchored.files[0], { registry, rpcUrl: anvil.url, clientOptions: fast });
    expectValid(result);
    assert.deepEqual(result.signer, { address: wallet, role: "principal", method: "eip1271" });

    // the wallet switched to Reject: the same signature no longer verifies
    const setMode = await deployer.writeContract({ address: wallet, abi: artifact.abi, functionName: "setMode", args: [1] });
    await client.waitForTransactionReceipt({ hash: setMode, pollingInterval: 50 });
    const rejected = await verify(anchored.files[0], { registry, rpcUrl: anvil.url, clientOptions: fast });
    expectInvalid(rejected, "agentSignature", "signature-mismatch", new RegExp(`contract wallet ${wallet} rejected it`));
  });
});

describe("spend: what the manifest says was paid, compared with the receipt's chain", () => {
  const TOKEN_ARTIFACT = resolve(REPO_ROOT, "contracts/artifacts/contracts/mocks/ERC20Mock.sol/ERC20Mock.json");
  const skip = !existsSync(TOKEN_ARTIFACT) && "no ERC20Mock artifact (run npm run compile -w contracts)";
  const agentAccount = privateKeyToAccount(ANVIL_KEYS[ROLE.agent]!);
  const strangerAccount = privateKeyToAccount(ANVIL_KEYS[ROLE.stranger]!);
  const payee = "0x000000000000000000000000000000000000beef" as Address;
  let token: Address;
  let otherToken: Address;
  /** Real transactions: the agent pays 1000, the agent pays 999, a stranger pays 1000, a reverted one, and 5000 wei of ETH. */
  const tx = {} as Record<"agent1000" | "agent999" | "stranger1000" | "reverted" | "eth5000", Hex>;
  const asset = (t: Address) => `eip155:${CHAIN_ID}/erc20:${t}`;

  before(async () => {
    if (skip) return;
    const artifact = JSON.parse(readFileSync(TOKEN_ARTIFACT, "utf8"));
    const chain = chainFor(CHAIN_ID, [anvil.url]);
    const walletOf = (account: typeof owner) => createWalletClient({ account, chain, transport: http(anvil.url) });
    const wait = async (hash: Hex) => (await client.waitForTransactionReceipt({ hash, pollingInterval: 50 }));
    const deploy = async () => (await wait(await walletOf(owner).deployContract({ abi: artifact.abi, bytecode: artifact.bytecode }))).contractAddress!.toLowerCase() as Address;
    token = await deploy();
    otherToken = await deploy();
    for (const to of [agentAccount.address, strangerAccount.address]) await wait(await walletOf(owner).writeContract({ address: token, abi: artifact.abi, functionName: "mint", args: [to, 1_000_000n] }));
    const pay = async (account: typeof owner, amount: bigint, gas?: bigint) =>
      walletOf(account).writeContract({ address: token, abi: artifact.abi, functionName: "transfer", args: [payee, amount], ...(gas ? { gas } : {}) });
    tx.agent1000 = await pay(agentAccount, 1000n);
    tx.agent999 = await pay(agentAccount, 999n);
    tx.stranger1000 = await pay(strangerAccount, 1000n);
    tx.reverted = await pay(agentAccount, 10n ** 30n, 100_000n); // more than the balance; gas given, so it is sent and mined anyway
    tx.eth5000 = await walletOf(agentAccount).sendTransaction({ to: payee, value: 5000n });
    for (const hash of Object.values(tx)) await wait(hash);
    assert.equal((await client.getTransactionReceipt({ hash: tx.reverted })).status, "reverted");
  });

  /** A receipt whose manifest lists `spend`, signed by the agent and anchored in a batch of one. */
  const anchoredWith = async (spend: ManifestV1["spend"]) => {
    const item = await signManifest({ manifest: makeManifest({ spend }), chainId: CHAIN_ID, registry });
    return (await anchorDirect({ client, registry, serviceKey: ANVIL_KEYS[ROLE.service]!, item })).files[0]!;
  };
  const check = (file: ReceiptFile, more: Partial<Parameters<typeof verify>[1]> = {}) => verify(file, { registry, rpcUrl: anvil.url, clientOptions: fast, ...more });

  test("a payment the agent really made is confirmed, and the receipt is valid", { skip }, async () => {
    const result = await check(await anchoredWith([{ asset: asset(token), amount: "1000", txHash: tx.agent1000 }, { asset: "usd", amount: "0.5" }]));
    expectValid(result);
    assert.equal(result.checks.spend, "pass");
    assert.equal(result.spend[0]!.outcome, "confirmed");
    assert.equal(result.spend[0]!.payer, agentAccount.address.toLowerCase());
    assert.match(result.spend[0]!.detail, /from the agent/);
    assert.equal(result.spend[1]!.outcome, "unchecked", "usd is not on a chain");
  });

  test("a made-up transaction: the receipt is genuine and anchored, but invalid", { skip }, async () => {
    const madeUp = `0x${"5a".repeat(32)}` as Hex;
    const result = await check(await anchoredWith([{ asset: asset(token), amount: "1000", txHash: madeUp }]));
    expectInvalid(result, "spend", "spend-tx-missing", new RegExp(`spend\\[0\\]: there is no transaction ${madeUp} on chain ${CHAIN_ID}`));
    assert.equal(result.authentic, true);
    for (const c of VERIFY_CHECKS) if (c !== "spend") assert.equal(result.checks[c], "pass", c);
    assert.equal(result.spend[0]!.outcome, "contradicted");
  });

  test("a real transaction that moved a different amount, another token, or reverted is contradicted", { skip }, async () => {
    const wrongAmount = await check(await anchoredWith([{ asset: asset(token), amount: "1000", txHash: tx.agent999 }]));
    expectInvalid(wrongAmount, "spend", "spend-transfer-missing", /moved no 1000 of token 0x[0-9a-f]{40} \(it moved 999 of it\)/);
    const wrongToken = await check(await anchoredWith([{ asset: asset(otherToken), amount: "1000", txHash: tx.agent1000 }]));
    expectInvalid(wrongToken, "spend", "spend-transfer-missing", /it has no transfer of that token/);
    const reverted = await check(await anchoredWith([{ asset: asset(token), amount: "1000", txHash: tx.reverted }]));
    expectInvalid(reverted, "spend", "spend-tx-failed", /reverted, so it moved nothing/);
    for (const r of [wrongAmount, wrongToken, reverted]) assert.equal(r.authentic, true);
  });

  test("someone else's payment of the same amount is reported, not credited: unattributed, still valid", { skip }, async () => {
    const result = await check(await anchoredWith([{ asset: asset(token), amount: "1000", txHash: tx.stranger1000 }]));
    expectValid(result);
    assert.equal(result.spend[0]!.outcome, "unattributed");
    assert.equal(result.spend[0]!.payer, strangerAccount.address.toLowerCase());
    assert.match(result.spend[0]!.detail, /neither the agent nor the principal/);
  });

  test("native ETH: the transaction's own value from the agent is confirmed", { skip }, async () => {
    const result = await check(await anchoredWith([{ asset: `eip155:${CHAIN_ID}/slip44:60`, amount: "5000", txHash: tx.eth5000 }]));
    expectValid(result);
    assert.equal(result.spend[0]!.outcome, "confirmed");
    const other = await check(await anchoredWith([{ asset: `eip155:${CHAIN_ID}/slip44:60`, amount: "7", txHash: tx.eth5000 }]));
    expectValid(other); // ETH sent inside a contract call is invisible without a trace, so a different value is not a contradiction
    assert.equal(other.spend[0]!.outcome, "unchecked");
  });

  test("entries nothing on this chain can answer are unchecked, and the check is skipped", { skip }, async () => {
    const result = await check(await anchoredWith([
      { asset: asset(token), amount: "1000" },
      { asset: `eip155:43111/erc20:${token}`, amount: "1000", txHash: `0x${"11".repeat(32)}` },
      { asset: "usd", amount: "1", txHash: `0x${"22".repeat(32)}` },
      { asset: asset(token), amount: "0.5", txHash: tx.agent1000 },
    ]));
    expectValid(result);
    assert.equal(result.checks.spend, "skip");
    assert.deepEqual(result.spend.map((s) => s.outcome), ["unchecked", "unchecked", "unchecked", "unchecked"]);
    assert.match(result.spend[1]!.detail, /on chain 43111; only the receipt's own chain 743111 is read/);
  });

  test("a manifest that does not match the receipt is not used: no spend is checked", { skip }, async () => {
    const file = clone(await anchoredWith([{ asset: asset(token), amount: "1000", txHash: `0x${"5b".repeat(32)}` }]));
    file.manifest!.model += "X";
    const result = await check(file);
    expectInvalid(result, "manifest", "manifest-hash-mismatch", /manifest hash mismatch/);
    assert.equal(result.checks.spend, "skip");
    assert.deepEqual(result.spend, []);
    assert.equal(result.authentic, false);
  });

  test("a transaction not mined yet, or an RPC that fails on it, leaves the result undetermined", { skip }, async () => {
    const pendingHash = `0x${"5c".repeat(32)}` as Hex;
    const brokenHash = `0x${"5d".repeat(32)}` as Hex;
    const template = await client.request({ method: "eth_getTransactionByHash", params: [tx.eth5000] });
    const intercepting = createPublicClient({
      chain: chainFor(CHAIN_ID, [anvil.url]),
      transport: custom({
        async request({ method, params }) {
          const hash = (params as unknown[] | undefined)?.[0];
          if (hash === brokenHash) throw new Error("upstream down");
          if (hash === pendingHash && method === "eth_getTransactionReceipt") return null;
          if (hash === pendingHash && method === "eth_getTransactionByHash") return { ...template!, hash: pendingHash, blockHash: null, blockNumber: null, transactionIndex: null };
          return client.request({ method, params } as never);
        },
      }, { retryCount: 0 }),
    }) as PublicClient;
    const pending = await check(await anchoredWith([{ asset: asset(token), amount: "1000", txHash: pendingHash }]), { client: intercepting });
    assert.equal(pending.valid, false);
    assert.equal(pending.incomplete, true);
    assert.equal(pending.spend[0]!.outcome, "undetermined");
    assert.ok(pending.problems.some((p) => p.code === "spend-tx-pending"));
    const broken = await check(await anchoredWith([{ asset: asset(token), amount: "1000", txHash: brokenHash }]), { client: intercepting });
    assert.equal(broken.incomplete, true);
    assert.ok(broken.problems.some((p) => p.check === "spend" && p.code === "rpc-error"));
    // A contradiction elsewhere still decides: incomplete only while nothing has ruled the receipt out.
    const mixed = await check(await anchoredWith([{ asset: asset(token), amount: "1000", txHash: brokenHash }, { asset: asset(token), amount: "1000", txHash: tx.agent999 }]), { client: intercepting });
    assert.equal(mixed.incomplete, false);
    assert.equal(mixed.valid, false);
  });
});

describe("verify through a flaky RPC (failureRate 0.3, default modes)", () => {
  let flaky: FlakyRpc;
  before(async () => {
    flaky = await startFlakyRpc({ upstream: anvil.url, failureRate: 0.3, seed: 7 });
  });
  after(async () => {
    await flaky?.stop();
  });
  const opts = () => ({ registry, rpcUrl: flaky.url, clientOptions: { ...fast, retryCount: 12, retryDelayMs: 10, timeoutMs: 3_000 } });

  test("valid receipts stay valid", async () => {
    expectValid(await verify(batchA[0], opts()));
    expectValid(await verify(direct, opts()));
  });

  test("(a) one changed manifest byte", async () => {
    const file = clone(batchA[1]!);
    file.manifest!.endedAt += 1;
    expectInvalid(await verify(file, opts()), "manifest", "manifest-hash-mismatch", /manifest hash mismatch/);
  });

  test("(b) proof against the wrong batch", async () => {
    const file = clone(batchA[1]!);
    file.anchor!.batchId = batchB[0]!.anchor!.batchId;
    expectInvalid(await verify(file, opts()), "onchainProof", "proof-onchain-false", /proof does not verify against batch \d+'s root/);
  });

  test("(c) forged agent signature", async () => {
    const file = clone(batchA[1]!);
    file.agentSignature = await signReceipt(privateKeyToAccount(ANVIL_KEYS[ROLE.stranger]!), file.receipt, registryDomain(CHAIN_ID, registry));
    expectInvalid(await verify(file, opts()), "agentSignature", "signature-mismatch", /agent signature recovers to/);
  });

  test("the proxy really injected failures", () => {
    const injected = Object.values(flaky.stats.injected).reduce((a, b) => a + (b ?? 0), 0);
    assert.ok(injected >= 5, `only ${injected} failures injected in ${flaky.stats.requests} requests`);
  });
});

test("createHemiPublicClient is what verify uses by default (Hemi RPCs for a Hemi chain id)", () => {
  // No network call: building the client only resolves the RPC list.
  assert.doesNotThrow(() => createHemiPublicClient({ chainId: CHAIN_ID }));
  assert.throws(() => createHemiPublicClient({ chainId: 31_337 }), /no RPC URL for chain 31337/);
});
