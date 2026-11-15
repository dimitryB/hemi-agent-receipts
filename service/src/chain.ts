import {
  BaseError,
  ContractFunctionRevertedError,
  getAbiItem,
  hexToBigInt,
  isAddressEqual,
  numberToHex,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PERMIT2_ADDRESS } from "@x402/evm";
import { createHemiPublicClient, EIP712_DOMAIN_NAME, EIP712_DOMAIN_VERSION, receiptRegistryAbi, registryDomain, type RegistryDomain } from "@hemi-receipts/sdk";
import type { Config, PaymentAsset } from "./config.js";
import { errorText, type Logger } from "./log.js";

/**
 * Everything that touches the chain. Every call goes through the SDK's Hemi client
 * (fallback across RPC URLs, backoff retries on transient errors, token-bucket rate limit).
 */
export interface ChainContext {
  client: PublicClient;
  chainId: number;
  registry: Address;
  domain: RegistryDomain;
  /** Signs BatchAttestation and ServiceAttestation envelopes. */
  service: PrivateKeyAccount;
  /** Pays gas for attestBatch. Must not be used by anything else (the batcher owns its nonces). */
  relayer: PrivateKeyAccount;
}

export function createChainContext(config: Config): ChainContext {
  return {
    client: createHemiPublicClient({
      chainId: config.chainId,
      rpcUrls: config.rpcUrls,
      requestsPerSecond: config.rpc.requestsPerSecond,
      burst: config.rpc.burst,
      timeoutMs: config.rpc.timeoutMs,
      retryCount: config.rpc.retryCount,
      retryDelayMs: config.rpc.retryDelayMs,
    }),
    chainId: config.chainId,
    registry: config.registry,
    domain: registryDomain(config.chainId, config.registry),
    service: privateKeyToAccount(config.servicePrivateKey),
    relayer: privateKeyToAccount(config.relayerPrivateKey),
  };
}

export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupError";
  }
}

/**
 * Refuses to start against the wrong chain or a registry that would reject the service's
 * signatures, and says exactly which check failed.
 */
export async function startupChecks(ctx: ChainContext, config: Config, log: Logger): Promise<{ latestBlock: bigint }> {
  const rpcChainId = await ctx.client.getChainId();
  if (rpcChainId !== ctx.chainId) {
    throw new StartupError(
      `chain id mismatch: the RPC (${config.rpcUrls.join(", ")}) reports chain ${rpcChainId}, but CHAIN_ID is ${ctx.chainId}`,
    );
  }
  const code = await ctx.client.getCode({ address: ctx.registry });
  if (!code || code === "0x") {
    throw new StartupError(`no contract at REGISTRY_ADDRESS ${ctx.registry} on chain ${ctx.chainId}`);
  }
  const signer = await ctx.client.readContract({ address: ctx.registry, abi: receiptRegistryAbi, functionName: "serviceSigner" });
  if (!isAddressEqual(signer, ctx.service.address)) {
    throw new StartupError(
      `serviceSigner mismatch: the registry's serviceSigner() is ${signer}, but SERVICE_PRIVATE_KEY is the key of ${ctx.service.address}`,
    );
  }
  try {
    const [, name, version, chainId, verifyingContract] = await ctx.client.readContract({
      address: ctx.registry,
      abi: receiptRegistryAbi,
      functionName: "eip712Domain",
    });
    if (
      name !== EIP712_DOMAIN_NAME ||
      version !== EIP712_DOMAIN_VERSION ||
      chainId !== BigInt(ctx.chainId) ||
      !isAddressEqual(verifyingContract, ctx.registry)
    ) {
      throw new StartupError(
        `EIP-712 domain mismatch: the registry reports (${name}, ${version}, ${chainId}, ${verifyingContract}), expected (${EIP712_DOMAIN_NAME}, ${EIP712_DOMAIN_VERSION}, ${ctx.chainId}, ${ctx.registry})`,
      );
    }
  } catch (error) {
    if (error instanceof StartupError) throw error;
    log.warn("could not read eip712Domain() from the registry; skipping the domain check", { error: errorText(error) });
  }
  const balance = await ctx.client.getBalance({ address: ctx.relayer.address });
  if (balance === 0n) log.warn("the relayer has no ETH for gas; batches will wait until it is funded", { relayer: ctx.relayer.address });
  const latestBlock = await ctx.client.getBlockNumber();
  return { latestBlock };
}

/** The registry's custom error, if `error` is (or wraps) a decoded revert. */
export function revertOf(error: unknown): { name: string; args: readonly unknown[] } | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  if (!reverted?.data?.errorName) return undefined;
  return { name: reverted.data.errorName, args: reverted.data.args ?? [] };
}

/** What happened to an eth_sendRawTransaction, as far as the node told us. */
export type BroadcastOutcome = "accepted" | "known" | "nonce_too_low" | "underpriced" | "insufficient_funds" | "error";

export function classifySendError(error: unknown): BroadcastOutcome {
  const text = [
    (error as { details?: string })?.details,
    (error as { shortMessage?: string })?.shortMessage,
    (error as Error)?.message,
  ]
    .filter(Boolean)
    .join(" | ");
  if (/already known|already imported|known transaction|alreadyknown|already exists/i.test(text)) return "known";
  if (/nonce too low|nonce is too low|noncetoolow|oldnonce|invalid nonce/i.test(text)) return "nonce_too_low";
  if (/underpriced|fee too low|replacement/i.test(text)) return "underpriced";
  if (/insufficient funds/i.test(text)) return "insufficient_funds";
  return "error";
}

/**
 * Sends a signed raw transaction. Safe to repeat: the same bytes have the same hash, and a
 * node answers "already known" or "nonce too low" to a repeat. A network error here is
 * ambiguous (the tx may have been sent; see e2e/lib startFlakyRpc "drop-response"), so the
 * caller must already have persisted the hash and must look it up rather than re-sign.
 */
export async function broadcast(ctx: ChainContext, raw: Hex): Promise<{ outcome: BroadcastOutcome; error?: unknown }> {
  try {
    await ctx.client.request({ method: "eth_sendRawTransaction", params: [raw] });
    return { outcome: "accepted" };
  } catch (error) {
    return { outcome: classifySendError(error), error };
  }
}

/** Hemi testnet's sequencer never mines a tip below the node's suggestion (x402facilitator D-018). */
export const MIN_PRIORITY_FEE = 1_000_000n;

export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** Replacements never bid more than this multiple of the current suggestion. */
export const REPLACEMENT_FEE_CAP = 10n;

/**
 * EIP-1559 fees: priority = max(eth_maxPriorityFeePerGas, 1,000,000 wei); max = 2 × base +
 * priority. A replacement of `previous` bumps both by at least 12.5 % (nodes require 10 %);
 * `withinCap` is false once that would exceed REPLACEMENT_FEE_CAP × the fresh suggestion, so
 * a long outage cannot ratchet fees up without bound.
 */
export async function suggestFees(ctx: ChainContext, baseFeePerGas: bigint, previous?: Fees): Promise<Fees & { withinCap: boolean }> {
  let priority = 0n;
  try {
    priority = hexToBigInt(await ctx.client.request({ method: "eth_maxPriorityFeePerGas" }));
  } catch {
    priority = 0n;
  }
  if (priority < MIN_PRIORITY_FEE) priority = MIN_PRIORITY_FEE;
  let maxFee = baseFeePerGas * 2n + priority;
  const cap = { maxFeePerGas: maxFee * REPLACEMENT_FEE_CAP, maxPriorityFeePerGas: priority * REPLACEMENT_FEE_CAP };
  if (previous) {
    const bump = (value: bigint) => (value * 1125n) / 1000n + 1n;
    if (priority < bump(previous.maxPriorityFeePerGas)) priority = bump(previous.maxPriorityFeePerGas);
    if (maxFee < bump(previous.maxFeePerGas)) maxFee = bump(previous.maxFeePerGas);
  }
  if (maxFee < priority) maxFee = priority;
  const withinCap = maxFee <= cap.maxFeePerGas && priority <= cap.maxPriorityFeePerGas;
  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority, withinCap };
}

/** null when the node does not know the transaction (yet). */
export async function receiptOrNull(ctx: ChainContext, hash: Hex): Promise<TransactionReceipt | null> {
  try {
    return await ctx.client.getTransactionReceipt({ hash });
  } catch (error) {
    if (error instanceof BaseError && error.walk((e) => (e as Error).name === "TransactionReceiptNotFoundError")) return null;
    throw error;
  }
}

/** The BatchAttested event emitted by the registry in `receipt`, if any. */
export function batchAttestedIn(ctx: ChainContext, receipt: TransactionReceipt): { batchId: bigint; root: Hex } | undefined {
  const logs = parseEventLogs({ abi: receiptRegistryAbi, eventName: "BatchAttested", logs: receipt.logs }).filter((log) =>
    isAddressEqual(log.address, ctx.registry),
  );
  const log = logs[0];
  return log ? { batchId: log.args.batchId, root: log.args.root } : undefined;
}

export async function readBatch(ctx: ChainContext, batchId: bigint) {
  return ctx.client.readContract({ address: ctx.registry, abi: receiptRegistryAbi, functionName: "getBatch", args: [batchId] });
}

export async function batchIdOfRoot(ctx: ChainContext, root: Hex): Promise<bigint> {
  return ctx.client.readContract({ address: ctx.registry, abi: receiptRegistryAbi, functionName: "batchIdOfRoot", args: [root] });
}

export async function batchIdOfRun(ctx: ChainContext, runId: Hex): Promise<bigint> {
  return ctx.client.readContract({ address: ctx.registry, abi: receiptRegistryAbi, functionName: "batchIdOfRun", args: [runId] });
}

const authorizationStateAbi = parseAbi(["function authorizationState(address authorizer, bytes32 nonce) view returns (bool)"]);
const nonceBitmapAbi = parseAbi(["function nonceBitmap(address owner, uint256 wordPos) view returns (uint256)"]);

/** One signed x402 payment, as far as the chain can tell whether it was spent. */
export interface SignedPayment {
  transferMethod: PaymentAsset["transferMethod"];
  asset: Address;
  payer: Address;
  nonce: string;
}

/**
 * Whether a payment's nonce is spent. The token answers for EIP-3009. Permit2 keeps one bit per
 * nonce: word `nonce >> 8`, bit `nonce & 0xff`. A nonce is spent by the payment, and also by a
 * payer who cancels it, which reads the same. Throws when the read fails.
 */
export async function paymentNonceUsed(ctx: ChainContext, payment: SignedPayment): Promise<boolean> {
  if (payment.transferMethod === "eip3009") {
    return ctx.client.readContract({ address: payment.asset, abi: authorizationStateAbi, functionName: "authorizationState", args: [payment.payer, payment.nonce as Hex] });
  }
  const nonce = BigInt(payment.nonce);
  const word = await ctx.client.readContract({ address: PERMIT2_ADDRESS, abi: nonceBitmapAbi, functionName: "nonceBitmap", args: [payment.payer, nonce >> 8n] });
  return ((word >> (nonce & 0xffn)) & 1n) === 1n;
}

const transferEvent = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"])[0];
const authorizationCanceledEvent = parseAbi(["event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)"])[0];
const unorderedNonceInvalidationEvent = parseAbi(["event UnorderedNonceInvalidation(address indexed owner, uint256 word, uint256 mask)"])[0];

/** eth_getLogs ranges are split into pieces this long. Both Hemi RPCs served 20,000 blocks on 2026-11-09. */
export const LOG_CHUNK_BLOCKS = 5_000n;

/** What the chain shows about a used nonce, read from logs between two blocks. */
export type NonceSpend =
  | { by: "transfer"; transaction: Hex; block: bigint }
  | { by: "cancel"; transaction: Hex; block: bigint }
  | { by: "unknown" };

/**
 * Where a used nonce went, read from logs.
 *
 * A cancel is the payer's own `AuthorizationCanceled(payer, nonce)` on an EIP-3009 token, or an
 * `UnorderedNonceInvalidation(payer, word, mask)` on Permit2 whose mask has this nonce's bit. Both
 * contracts emit one on every cancel. A cancel decides, even next to a transfer: an honest buyer
 * never cancels, and Permit2 lets a nonce be "cancelled" after it paid, so a cancel is how a buyer
 * would dress one payment up as two.
 *
 * Otherwise a spend is a `Transfer(payer, payTo, ≥ amount)` on the asset whose transaction carries
 * the nonce in its input. The nonce is 32 random bytes, so only the transaction that used this
 * authorization contains it, however the facilitator wraps the call.
 *
 * Neither is "unknown": logs the RPC did not return, or a spend this service cannot read. Throws
 * when a read fails.
 */
export async function nonceSpend(
  ctx: ChainContext,
  payment: SignedPayment & { payTo: Address; amount: bigint },
  range: { fromBlock: bigint; toBlock: bigint },
): Promise<NonceSpend> {
  const nonce = BigInt(payment.nonce);
  const nonceWord = numberToHex(nonce, { size: 32 });
  const chunks: { fromBlock: bigint; toBlock: bigint }[] = [];
  for (let from = range.fromBlock; from <= range.toBlock; from += LOG_CHUNK_BLOCKS) {
    chunks.push({ fromBlock: from, toBlock: from + LOG_CHUNK_BLOCKS - 1n < range.toBlock ? from + LOG_CHUNK_BLOCKS - 1n : range.toBlock });
  }

  for (const chunk of chunks) {
    const cancels =
      payment.transferMethod === "eip3009"
        ? await ctx.client.getLogs({ address: payment.asset, event: authorizationCanceledEvent, args: { authorizer: payment.payer, nonce: nonceWord }, ...chunk })
        : (await ctx.client.getLogs({ address: PERMIT2_ADDRESS, event: unorderedNonceInvalidationEvent, args: { owner: payment.payer }, ...chunk })).filter(
            (log) => log.args.word === nonce >> 8n && (((log.args.mask ?? 0n) >> (nonce & 0xffn)) & 1n) === 1n,
          );
    const cancel = cancels.find((log) => log.transactionHash && log.blockNumber !== null);
    if (cancel) return { by: "cancel", transaction: cancel.transactionHash!, block: cancel.blockNumber! };
  }

  const needle = nonceWord.slice(2).toLowerCase();
  for (const chunk of chunks) {
    const transfers = await ctx.client.getLogs({ address: payment.asset, event: transferEvent, args: { from: payment.payer, to: payment.payTo }, ...chunk });
    for (const log of transfers) {
      if (!log.transactionHash || log.blockNumber === null || (log.args.value ?? 0n) < payment.amount) continue;
      const tx = await ctx.client.getTransaction({ hash: log.transactionHash });
      if (tx.input.toLowerCase().includes(needle)) return { by: "transfer", transaction: log.transactionHash, block: log.blockNumber };
    }
  }
  return { by: "unknown" };
}

const batchAttestedEvent = getAbiItem({ abi: receiptRegistryAbi, name: "BatchAttested" });

/**
 * The tx that anchored `batchId`, found with a one-block eth_getLogs at the block the
 * registry recorded (every Hemi RPC serves one-block ranges).
 */
export async function findAnchorTx(ctx: ChainContext, batchId: bigint, blockNumber: bigint): Promise<{ txHash: Hex; blockHash: Hex } | undefined> {
  const logs = await ctx.client.getLogs({
    address: ctx.registry,
    event: batchAttestedEvent,
    args: { batchId },
    fromBlock: blockNumber,
    toBlock: blockNumber,
  });
  const log = logs[0];
  return log?.transactionHash && log.blockHash ? { txHash: log.transactionHash, blockHash: log.blockHash } : undefined;
}

/**
 * Registry facts the request path needs (paused, schema versions), cached for a minute so
 * a request never costs an RPC call. Fails open: if the RPC is down, requests are accepted
 * and the batcher sorts it out.
 */
export class RegistryGate {
  private cache = new Map<string, { value: boolean; at: number }>();
  constructor(
    private readonly ctx: ChainContext,
    private readonly ttlMs = 60_000,
  ) {}

  private async cached(key: string, read: () => Promise<boolean>): Promise<boolean | undefined> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    try {
      const value = await withTimeout(read(), 3_000);
      this.cache.set(key, { value, at: Date.now() });
      return value;
    } catch {
      return hit?.value;
    }
  }

  paused(): Promise<boolean | undefined> {
    return this.cached("paused", () =>
      this.ctx.client.readContract({ address: this.ctx.registry, abi: receiptRegistryAbi, functionName: "paused" }),
    );
  }

  schemaVersionEnabled(version: number): Promise<boolean | undefined> {
    return this.cached(`schema:${version}`, () =>
      this.ctx.client.readContract({
        address: this.ctx.registry,
        abi: receiptRegistryAbi,
        functionName: "schemaVersionEnabled",
        args: [version],
      }),
    );
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    }),
  ]);
}
