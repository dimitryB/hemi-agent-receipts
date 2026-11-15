import { createWalletClient, custom, parseEventLogs, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  batchAttestationTypedData,
  buildMerkleTree,
  contentHash,
  leafHash,
  newRunId,
  normalizeManifest,
  receiptDigest,
  receiptFromManifest,
  receiptRegistryAbi,
  registryDomain,
  serviceAttestationTypedData,
  signReceipt,
  type ManifestV1,
  type ReceiptFields,
  type ReceiptFile,
  pollTransactionReceipt,
} from "@hemi-receipts/sdk";
import { ANVIL_KEYS, ROLE } from "./anvil.js";

/**
 * Test helpers that do what the service does on chain: build a Merkle tree, sign the
 * BatchAttestation (or ServiceAttestation) with the service key, send the transaction, and
 * hand back ReceiptFiles with anchors. Local chains only.
 */

/** Hemi testnet never mines tips below the node's suggestion (0.001 gwei); never go under it. */
export const MIN_PRIORITY_FEE_WEI = 1_000_000n;

export interface SignedReceipt {
  receipt: ReceiptFields;
  agentSignature: Hex;
  /** Copied into the ReceiptFile when present. */
  manifest?: ManifestV1;
}

export interface AnchorResult {
  batchId: number;
  root: Hex;
  txHash: Hex;
  blockNumber: number;
  files: ReceiptFile[];
}

export interface AnchorInput {
  client: PublicClient;
  registry: Address;
  /** Signs the BatchAttestation / ServiceAttestation. Must be the registry's serviceSigner. */
  serviceKey: Hex;
  /** Sends the transaction (pays gas). Defaults to the relayer anvil key. */
  senderKey?: Hex;
  /** Seconds after the latest block's timestamp. Default 1,800 (the contract allows up to 3,600). */
  deadlineIn?: number;
  /** Set to override the computed deadline entirely (e.g. to test expiry). */
  deadline?: bigint;
}

/** A valid v1 manifest for tests: agent = anvil key 3, principal = anvil key 4, random runId. */
export function makeManifest(overrides: Partial<ManifestV1> = {}): ManifestV1 {
  const now = Math.floor(Date.now() / 1000);
  return normalizeManifest({
    receiptVersion: 1,
    runId: newRunId(),
    agent: privateKeyToAccount(ANVIL_KEYS[ROLE.agent]!).address,
    principal: privateKeyToAccount(ANVIL_KEYS[ROLE.principal]!).address,
    startedAt: now - 60,
    endedAt: now,
    model: "claude-fable-5-1",
    promptHash: contentHash("Summarize today's Hemi PoP activity."),
    outputHash: contentHash("PoP miners published 412 keystones."),
    toolCalls: [{ name: "web_search", argsHash: contentHash({ q: "hemi pop" }), resultHash: contentHash("…"), at: now - 30 }],
    spend: [{ asset: "usd", amount: "0.0042" }],
    ...overrides,
  });
}

/** Signs a manifest's Receipt with `signerKey` (default: the agent key) for the given registry. */
export async function signManifest(input: {
  manifest: ManifestV1;
  chainId: number;
  registry: Address;
  signerKey?: Hex;
}): Promise<SignedReceipt & { manifest: ManifestV1 }> {
  const receipt = receiptFromManifest(input.manifest);
  const account = privateKeyToAccount(input.signerKey ?? ANVIL_KEYS[ROLE.agent]!);
  const agentSignature = await signReceipt(account, receipt, registryDomain(input.chainId, input.registry));
  return { manifest: input.manifest, receipt, agentSignature };
}

async function sendAndWait(
  input: AnchorInput,
  functionName: "attestBatch" | "attest",
  args: readonly unknown[],
): Promise<{ txHash: Hex; blockNumber: number; batchId: number }> {
  const { client } = input;
  const chain = client.chain ?? undefined;
  const account = privateKeyToAccount(input.senderKey ?? ANVIL_KEYS[ROLE.relayer]!);
  const wallet = createWalletClient({ account, chain, transport: custom({ request: (a) => client.request(a as never) }) });
  const block = await client.getBlock({ blockTag: "latest" });
  const suggested = await client.estimateMaxPriorityFeePerGas().catch(() => 0n);
  const priority = suggested > MIN_PRIORITY_FEE_WEI ? suggested : MIN_PRIORITY_FEE_WEI;
  const maxFeePerGas = (block.baseFeePerGas ?? 1_000_000_000n) * 2n + priority;
  const txHash = await wallet.writeContract({
    address: input.registry,
    abi: receiptRegistryAbi,
    functionName,
    args: args as never,
    chain,
    maxPriorityFeePerGas: priority,
    maxFeePerGas,
  });
  const receipt = await pollTransactionReceipt(client, txHash, { intervalMs: 100 });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${txHash}`);
  const [event] = parseEventLogs({ abi: receiptRegistryAbi, logs: receipt.logs, eventName: "BatchAttested" });
  if (!event) throw new Error(`${functionName}: no BatchAttested event in ${txHash}`);
  return { txHash, blockNumber: Number(receipt.blockNumber), batchId: Number(event.args.batchId) };
}

async function deadlineFor(input: AnchorInput): Promise<bigint> {
  if (input.deadline !== undefined) return input.deadline;
  const block = await input.client.getBlock({ blockTag: "latest" });
  return block.timestamp + BigInt(input.deadlineIn ?? 1_800);
}

function fileFor(chainId: number, registry: Address, item: SignedReceipt, anchor: ReceiptFile["anchor"]): ReceiptFile {
  const file: ReceiptFile = {
    format: "hemi-agent-receipt",
    formatVersion: 1,
    chainId,
    registry: registry.toLowerCase() as Address,
    receipt: item.receipt,
    agentSignature: item.agentSignature,
    anchor,
  };
  if (item.manifest) file.manifest = item.manifest;
  return file;
}

/** Anchors `items` as one Merkle batch through attestBatch. All must share a schemaVersion. */
export async function anchorBatch(input: AnchorInput & { items: SignedReceipt[] }): Promise<AnchorResult> {
  if (input.items.length === 0) throw new Error("anchorBatch: no receipts");
  const schemaVersion = input.items[0]!.receipt.schemaVersion;
  if (input.items.some((i) => i.receipt.schemaVersion !== schemaVersion)) throw new Error("anchorBatch: mixed schemaVersions");
  const chainId = input.client.chain?.id ?? (await input.client.getChainId());
  const leaves = input.items.map((i) => leafHash(i.receipt));
  const tree = buildMerkleTree(leaves);
  const deadline = await deadlineFor(input);
  const domain = registryDomain(chainId, input.registry);
  const service = privateKeyToAccount(input.serviceKey);
  const serviceSignature = await service.signTypedData(
    batchAttestationTypedData({ root: tree.root, count: leaves.length, schemaVersion, deadline }, domain),
  );
  const sent = await sendAndWait(input, "attestBatch", [tree.root, leaves.length, schemaVersion, deadline, serviceSignature]);
  const files = input.items.map((item, i) =>
    fileFor(chainId, input.registry, item, {
      mode: "batch",
      batchId: sent.batchId,
      root: tree.root,
      proof: tree.proof(leaves[i]!),
      txHash: sent.txHash,
      blockNumber: sent.blockNumber,
    }),
  );
  return { batchId: sent.batchId, root: tree.root, txHash: sent.txHash, blockNumber: sent.blockNumber, files };
}

/** Anchors one receipt through attest (the direct path: a batch of one, checked agent signature). */
export async function anchorDirect(input: AnchorInput & { item: SignedReceipt }): Promise<AnchorResult> {
  const chainId = input.client.chain?.id ?? (await input.client.getChainId());
  const domain = registryDomain(chainId, input.registry);
  const deadline = await deadlineFor(input);
  const digest = receiptDigest(input.item.receipt, domain);
  const service = privateKeyToAccount(input.serviceKey);
  const serviceSignature = await service.signTypedData(serviceAttestationTypedData(digest, deadline, domain));
  const sent = await sendAndWait(input, "attest", [input.item.receipt, input.item.agentSignature, deadline, serviceSignature]);
  const root = leafHash(input.item.receipt);
  const file = fileFor(chainId, input.registry, input.item, {
    mode: "direct",
    batchId: sent.batchId,
    root,
    proof: [],
    txHash: sent.txHash,
    blockNumber: sent.blockNumber,
  });
  return { batchId: sent.batchId, root, txHash: sent.txHash, blockNumber: sent.blockNumber, files: [file] };
}

/** Owner-only: voids a batch (incident response). */
export async function voidBatch(input: { client: PublicClient; registry: Address; ownerKey?: Hex; batchId: number; root: Hex; reason?: string }): Promise<Hex> {
  const { client } = input;
  const chain = client.chain ?? undefined;
  const account = privateKeyToAccount(input.ownerKey ?? ANVIL_KEYS[ROLE.owner]!);
  const wallet = createWalletClient({ account, chain, transport: custom({ request: (a) => client.request(a as never) }) });
  const hash = await wallet.writeContract({
    address: input.registry,
    abi: receiptRegistryAbi,
    functionName: "voidBatch",
    args: [BigInt(input.batchId), input.root, input.reason ?? "test"],
    chain,
    maxPriorityFeePerGas: MIN_PRIORITY_FEE_WEI,
  });
  const receipt = await pollTransactionReceipt(client, hash, { intervalMs: 100 });
  if (receipt.status !== "success") throw new Error(`voidBatch reverted: ${hash}`);
  return hash;
}
