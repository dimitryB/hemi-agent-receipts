import type { NextFunction, Request, RequestHandler, Response } from "express";
import { isAddress, type Address, type Hex } from "viem";
import { HTTPFacilitatorClient, type FacilitatorClient, type HTTPTransportContext, type RoutesConfig } from "@x402/core/server";
import {
  SettleError,
  type AssetAmount,
  type Network,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
  type SupportedResponse,
  type VerifyResponse,
} from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddlewareFromHTTPServer, x402HTTPResourceServer, x402ResourceServer } from "@x402/express";
import { nonceSpend, paymentNonceUsed, withTimeout, type ChainContext } from "./chain.js";
import type { Config, PaymentAsset } from "./config.js";
import { errorText, type Logger } from "./log.js";
import { SETTLEMENT_HOLD_MS } from "./store.js";
import type { ReceiptMode, ReceiptRow, Store } from "./store.js";

/**
 * x402 paywall for POST /attest and POST /attest/direct, wired like x402facilitator's seller
 * (x402facilitator/seller/server.ts): @x402/express + x402ResourceServer +
 * HTTPFacilitatorClient + ExactEvmScheme, with an explicit AssetAmount price because Hemi
 * is not in the SDK's default asset table.
 *
 * Ordering (read from @x402/express 2.29.0, `paymentMiddlewareFromHTTPServer`): for the
 * exact scheme's default "authorization" flow the middleware VERIFIES the payment, then
 * runs the route handler with the response BUFFERED, then SETTLES, and only then releases
 * the buffered response. If settlement fails the buffered body is discarded and the client
 * gets a 402; if the handler answers ≥ 400 the payment is never settled. So the handler runs
 * before the money moves. The handler therefore stores the receipt as `unpaid` (never
 * batched), and the `onAfterSettle` hook below promotes it to `queued` once the facilitator
 * reports success. A refused settle leaves it `unpaid`; a retry with a valid payment re-runs
 * the handler on the same row and is promoted by its own settlement. A settle whose outcome is
 * not known holds the row instead (settlementRefused below), so a retry cannot pay twice, and
 * when the hold runs out the chain decides (settleEndedHold below). The nonce and the chain's
 * head are recorded before settling begins, so a kill mid-settlement leaves them too.
 *
 * Price discovery never depends on the facilitator: the 402 challenge is built from
 * configuration (FallbackFacilitatorClient below). Only a request that carries a payment
 * needs the facilitator, and gets 503 payment_unavailable while it is unreachable.
 */
export const RECEIPT_RUN_ID_HEADER = "x-receipt-run-id";
export const RECEIPT_LEAF_HEADER = "x-receipt-leaf";

export function networkOf(config: Config): Network {
  return `eip155:${config.chainId}` as Network;
}

/** Explicit price: the asset, the amount in base units, and how the asset is transferred. */
export function priceFor(asset: PaymentAsset, amount: string): AssetAmount {
  if (asset.transferMethod === "permit2") return { asset: asset.address, amount, extra: { assetTransferMethod: "permit2" } };
  if (!asset.eip712) throw new Error(`payment asset ${asset.address} uses EIP-3009 but has no EIP-712 name/version`);
  return { asset: asset.address, amount, extra: { assetTransferMethod: "eip3009", name: asset.eip712.name, version: asset.eip712.version } };
}

export function paymentRoutes(config: Config): RoutesConfig {
  const network = networkOf(config);
  const asset = config.paymentAsset!;
  const payTo = config.payTo!;
  return {
    "POST /attest": {
      accepts: [{ scheme: "exact", network, payTo, price: priceFor(asset, config.priceBatch) }],
      description: "Anchor one agent receipt on Hemi in the next Merkle batch",
      mimeType: "application/json",
    },
    "POST /attest/direct": {
      accepts: [{ scheme: "exact", network, payTo, price: priceFor(asset, config.priceDirect) }],
      description: "Service signature and calldata to anchor one agent receipt on Hemi directly",
      mimeType: "application/json",
    },
  };
}

/**
 * Whether a settlement failure proves that nothing moved. Only a facilitator that answered with a
 * refusal does. A timeout, a dropped connection or an HTTP error without a verdict can come after
 * the transfer reached the chain, and so can these answers: `unexpected_*` is a send no node
 * answered for, and `invalid_transaction_state` a transaction that mined (x402facilitator README,
 * "Ambiguous broadcast"). The status code cannot tell them apart: the SDK reports every
 * `success: false` as a SettleError with status 500.
 */
export function settlementRefused(error: unknown): boolean {
  if (!(error instanceof SettleError)) return false;
  const reason = error.errorReason ?? "";
  if (reason === "" || reason === "Settlement failed") return false; // the SDK's words for "no reason given"
  return reason !== "settlement_pending" && reason !== "invalid_transaction_state" && !reason.startsWith("unexpected_");
}

/**
 * Who is paying, and with which authorization: what an operator looks for on chain, and what
 * decides a hold. Read from the payload field of the transfer method this service asks for,
 * which is the one the facilitator settles. A payload carrying the other method's field as
 * well is `ambiguous`: which nonce would be spent depends on the facilitator, so settling it
 * is refused.
 */
function authorizationOf(payment: { readonly payload: unknown }, transferMethod: PaymentAsset["transferMethod"] | undefined): Pick<PaymentRecord, "payer" | "nonce" | "transferMethod" | "deadline"> & { ambiguous?: true } {
  const p = (payment.payload ?? {}) as {
    authorization?: { from?: Address; nonce?: string; validBefore?: string };
    permit2Authorization?: { from?: Address; nonce?: string; deadline?: string };
  };
  const method = transferMethod ?? (p.authorization ? "eip3009" : "permit2");
  const signed = method === "eip3009" ? p.authorization : p.permit2Authorization;
  const deadline = method === "eip3009" ? p.authorization?.validBefore : p.permit2Authorization?.deadline;
  return {
    ...(typeof signed?.from === "string" ? { payer: signed.from } : {}),
    ...(typeof signed?.nonce === "string" ? { nonce: signed.nonce } : {}),
    ...(signed ? { transferMethod: method } : {}),
    ...(typeof deadline === "string" ? { deadline } : {}),
    ...(p.authorization && p.permit2Authorization ? { ambiguous: true as const } : {}),
  };
}

/** The record's part of an authorization: without the `ambiguous` flag, which only decides refusal. */
function authorizationRecord({ ambiguous: _ambiguous, ...record }: ReturnType<typeof authorizationOf>): Pick<PaymentRecord, "payer" | "nonce" | "transferMethod" | "deadline"> {
  return record;
}

const UINT256_MAX = (1n << 256n) - 1n;

/**
 * A nonce as the contract that checks it reads it, so that every spelling of one authorization
 * gives one key. EIP-3009 nonces are bytes32: exactly 32 bytes of hex, any case (a shorter
 * value's padding depends on the encoder, so it is not accepted). Permit2 nonces are uint256:
 * "42", "042" and "0x2a" are the same nonce, written "42". Undefined for anything else.
 */
export function canonicalNonce(transferMethod: string | undefined, nonce: string | undefined): string | undefined {
  if (typeof nonce !== "string") return undefined;
  if (transferMethod === "eip3009") return /^0x[0-9a-fA-F]{64}$/.test(nonce) ? nonce.toLowerCase() : undefined;
  if (transferMethod !== "permit2" || !/^(0x[0-9a-fA-F]{1,64}|[0-9]{1,80})$/.test(nonce)) return undefined;
  const value = BigInt(nonce);
  return value <= UINT256_MAX ? value.toString(10) : undefined;
}

/**
 * One signed authorization, whatever receipt it is offered for and however its fields are
 * spelled: transfer method, token, payer and canonical nonce. A payment without all four, or
 * with a nonce no contract would accept, cannot be told apart from another, so it has no key.
 */
export function paymentKey(p: { transferMethod?: string; asset?: string; payer?: string; nonce?: string }): string | undefined {
  const nonce = canonicalNonce(p.transferMethod, p.nonce);
  if (!nonce || !p.asset || !p.payer || !isAddress(p.asset, { strict: false }) || !isAddress(p.payer, { strict: false })) return undefined;
  return `${p.transferMethod}:${p.asset.toLowerCase()}:${p.payer.toLowerCase()}:${nonce}`;
}

/**
 * Whether this run id owns the payment's authorization, claiming it if no run id has yet (a
 * record written before migration 0004 added claims). Undefined for a record with no
 * authorization at all.
 * `owner: null` is a record whose authorization cannot be keyed (a nonce no contract accepts):
 * nothing can tie a transfer to it, so it is never credited.
 */
export async function ownsPayment(store: Store, runId: Hex, payment: Pick<PaymentRecord, "transferMethod" | "asset" | "payer" | "nonce">, now: number): Promise<{ owns: boolean; owner: Hex | null } | undefined> {
  if (payment.nonce === undefined && payment.payer === undefined) return undefined;
  const key = paymentKey(payment);
  if (!key) return { owns: false, owner: null };
  const owner = await store.claimPayment(key, runId, now);
  return { owns: owner.toLowerCase() === runId.toLowerCase(), owner };
}

/** What `payment_json` keeps while a row is unpaid. `settling` is written before the facilitator is asked. */
export interface PaymentRecord {
  status?: string;
  transaction?: Hex;
  payer?: Address;
  nonce?: string;
  transferMethod?: PaymentAsset["transferMethod"];
  /** Unix seconds as signed: after this the authorization cannot move money. */
  deadline?: string;
  asset?: Address;
  amount?: string;
  /** The chain's head when settling began, as a decimal string: the money cannot have moved before it. Absent if it could not be read. */
  settleBlock?: string;
  /** When settling began (ms). Unlike `at`, never rewritten: a restart or a later answer moves `at`. */
  settleStartedAt?: number;
  at?: number;
}

export function paymentOf(row: ReceiptRow): PaymentRecord | undefined {
  return row.payment_json ? (JSON.parse(row.payment_json) as PaymentRecord) : undefined;
}

/** Payment states that may have moved money: until the hold ends, nobody pays for this receipt again. */
export const HELD_PAYMENTS = new Set(["settlement_pending", "settlement_unknown"]);

/** Whether this row's hold has run out with the payment still undecided. A `settling` row is one whose hooks never ran. */
export function holdEnded(row: ReceiptRow, now: number): boolean {
  const payment = paymentOf(row);
  if (!payment?.status || !(HELD_PAYMENTS.has(payment.status) || payment.status === "settling")) return false;
  return now - (payment.at ?? 0) >= SETTLEMENT_HOLD_MS;
}

/** A request waits this long for the chain to decide. On a timeout it keeps holding, and the buyer retries. */
const NONCE_READ_TIMEOUT_MS = 15_000;

/** How long settling waits to record the chain's head before going ahead without it. */
const SETTLE_BLOCK_TIMEOUT_MS = 2_000;

/** Blocks scanned before the recorded head, for an RPC that lagged when settling began. */
const SCAN_MARGIN_BLOCKS = 100n;

/** The most blocks one decision scans. A hold decided this late stays held, and the log says so. */
export const MAX_SCAN_BLOCKS = 50_000n;

/**
 * The blocks a payment can have landed in, or a cancel of it. Hemi, like every chain this runs on,
 * gives each block a later second than the one before, so N seconds hold at most N blocks.
 *
 * From: the head recorded when settling began. Without one, a block that many seconds back from
 * the head, which is at or before the block of that moment.
 * To: the head now, or, with a recorded head and a deadline, that block plus the seconds from its
 * timestamp to the deadline, after which the authorization cannot move money.
 * Both ends get a margin for an RPC that lagged.
 */
async function scanRange(chain: ChainContext, payment: PaymentRecord): Promise<{ fromBlock: bigint; toBlock: bigint }> {
  const head = await chain.client.getBlock({ blockTag: "latest" });
  let lower: bigint;
  let toBlock = head.number;
  if (payment.settleBlock !== undefined) {
    lower = BigInt(payment.settleBlock);
    if (payment.deadline !== undefined && lower <= head.number) {
      const recorded = await chain.client.getBlock({ blockNumber: lower });
      const deadline = BigInt(payment.deadline);
      const last = lower + (deadline > recorded.timestamp ? deadline - recorded.timestamp : 0n) + SCAN_MARGIN_BLOCKS;
      if (last < toBlock) toBlock = last;
    }
  } else {
    const startedAt = BigInt(Math.floor((payment.settleStartedAt ?? payment.at ?? 0) / 1000));
    lower = head.number - (head.timestamp > startedAt ? head.timestamp - startedAt : 0n);
  }
  const fromBlock = lower > SCAN_MARGIN_BLOCKS ? lower - SCAN_MARGIN_BLOCKS : 0n;
  return { fromBlock, toBlock };
}

/**
 * Decides a payment whose hold has run out, from the chain.
 *
 * Its nonce unused, with the authorization expired: it can never land, so a retry may pay. Unused
 * but still inside its deadline: the hold stays, because it can land after this read.
 *
 * Its nonce used: that alone does not show money moved, because a payer can spend its own nonce
 * with a cancel. So the logs decide (nonceSpend). The payer's cancel releases the row and a retry
 * pays. A `Transfer` to PAY_TO in a transaction whose decoded call settled exactly this
 * authorization marks it paid, `via: "transfer"`. Neither found keeps the hold and logs an error
 * with the payer and nonce: the RPC may have missed logs, and a later read decides.
 *
 * A failed or slow read says nothing, and keeps the hold. A row without an authorization on
 * record has no nonce to read. Settling writes one first, so such a row comes from an older
 * version: it is released, and logged.
 */
export async function settleEndedHold(deps: { chain: ChainContext; config: Config; store: Store; log: Logger }, row: ReceiptRow, now: number): Promise<"paid" | "released" | "held"> {
  const { chain, config, store, log } = deps;
  const { run_id: runId, leaf } = row;
  const payment = paymentOf(row)!;
  const { payer, nonce, asset } = payment;
  const transferMethod = payment.transferMethod ?? config.paymentAsset?.transferMethod;
  const release = (extra: Record<string, unknown> = {}) => store.endHold(runId, leaf, row.payment_json!, { ...payment, ...extra, status: "settlement_abandoned", checkedAt: now }, now);
  if (!payer || !nonce || !asset || !transferMethod || !config.payTo) {
    log.error("x402: a hold ran out with no authorization on record; a retry may pay, and that is a second charge if the first payment landed", { runId, tx: payment.transaction });
    await release();
    return "released";
  }

  // Its authorization may pay for another receipt (records written before migration 0004 added
  // claims can share one): then the transfer that settled it is that receipt's, never this one's.
  const claim = await ownsPayment(store, runId, { transferMethod, asset, payer, nonce }, now);
  if (claim && claim.owner === null) {
    log.error("x402: a held payment's nonce is not one its contract would accept, so no transfer can be tied to it; still holding the receipt", { runId, payer, nonce });
    return "held";
  }
  if (claim && !claim.owns) {
    log.error("x402: a held payment's authorization pays for another receipt; this one is released unpaid", { runId, owner: claim.owner, payer, nonce });
    await release({ reason: "payment_claimed_by_another_receipt", owner: claim.owner });
    return "released";
  }

  const signedPayment = { transferMethod, asset, payer, nonce };
  const amount = BigInt(payment.amount ?? (row.mode === "batch" ? config.priceBatch : config.priceDirect));
  let decision: { used: false } | { used: true; spend: Awaited<ReturnType<typeof nonceSpend>>; range: { fromBlock: bigint; toBlock: bigint } } | { used: true; tooWide: { fromBlock: bigint; toBlock: bigint } };
  try {
    decision = await withTimeout(
      (async () => {
        if (!(await paymentNonceUsed(chain, signedPayment))) return { used: false as const };
        const range = await scanRange(chain, payment);
        if (range.toBlock - range.fromBlock > MAX_SCAN_BLOCKS) return { used: true as const, tooWide: range };
        return { used: true as const, spend: await nonceSpend(chain, { ...signedPayment, payTo: config.payTo!, amount }, range), range };
      })(),
      NONCE_READ_TIMEOUT_MS,
    );
  } catch (error) {
    log.warn("x402: could not read a held payment's nonce on chain; still holding the receipt", { runId, payer, nonce, error: errorText(error) });
    return "held";
  }

  if (!decision.used) {
    if (payment.deadline !== undefined && BigInt(payment.deadline) * 1000n >= BigInt(now)) {
      log.warn("x402: a held payment's nonce is unused, but its authorization can still land; still holding the receipt", { runId, payer, nonce, deadline: payment.deadline });
      return "held";
    }
    await release();
    log.info("x402: a held payment's nonce is unused and its authorization has expired; a retry may pay", { runId, payer, nonce, tx: payment.transaction });
    return "released";
  }
  if ("tooWide" in decision) {
    log.error("x402: a held payment's nonce is used, but the blocks to search for its transfer are too many; still holding the receipt", {
      runId, payer, nonce, fromBlock: decision.tooWide.fromBlock, toBlock: decision.tooWide.toBlock,
    });
    return "held";
  }
  const { spend, range } = decision;
  if (spend.by === "transfer") {
    await store.markPaid(runId, leaf, { ...payment, status: "settled", reconciled: true, via: "transfer", transferTx: spend.transaction, checkedAt: now }, now);
    log.info("x402: a held payment reached PAY_TO; receipt accepted without a second charge", { runId, payer, nonce, tx: spend.transaction });
    return "paid";
  }
  if (spend.by === "cancel") {
    await release({ cancelTx: spend.transaction });
    log.warn("x402: the payer cancelled a held payment's authorization; nothing was paid, and a retry pays", { runId, payer, nonce, tx: spend.transaction });
    return "released";
  }
  log.error("x402: a held payment's nonce is used, but neither a transfer to PAY_TO carrying it nor a cancel was found; still holding the receipt", {
    runId, payer, nonce, amount, fromBlock: range.fromBlock, toBlock: range.toBlock,
  });
  return "held";
}

function receiptIdsFrom(transportContext: unknown): { runId: Hex; leaf: Hex } | undefined {
  const headers = (transportContext as HTTPTransportContext | undefined)?.responseHeaders;
  if (!headers) return undefined;
  const find = (name: string) => Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  const runId = find(RECEIPT_RUN_ID_HEADER);
  const leaf = find(RECEIPT_LEAF_HEADER);
  return runId && leaf ? { runId: runId as Hex, leaf: leaf as Hex } : undefined;
}

/**
 * The facilitator client the resource server sees. verify and settle go to the real
 * facilitator. /supported falls back to the one kind this service sells
 * ({ x402Version: 2, scheme: "exact", network }) when the facilitator cannot be reached, so
 * the 402 challenge can always be built. For ExactEvmScheme that is lossless: its
 * enhancePaymentRequirements ignores the supported kind and the facilitator's extensions,
 * so the requirements are byte-identical to the ones built from a live /supported.
 *
 * It also tracks reachability (any successful call counts), which the middleware uses to
 * answer 503 to a paid request instead of letting it fail inside verify.
 */
export class FallbackFacilitatorClient implements FacilitatorClient {
  private readonly real: HTTPFacilitatorClient;
  /** Same facilitator, short timeout: reachability probes must not hang a request. */
  private readonly probe: HTTPFacilitatorClient;
  private lastOk = 0;
  private lastFailure = 0;
  /** The transaction of a settlement_pending answer. The SDK retries once, and if that fails its error does not carry it. */
  private readonly pendingTx = new WeakMap<object, string>();
  /** The facilitator answered /supported without our network/scheme. */
  incapable = false;

  constructor(
    url: string,
    private readonly network: Network,
    private readonly log: Logger,
  ) {
    this.real = new HTTPFacilitatorClient({ url });
    this.probe = new HTTPFacilitatorClient({ url, timeoutMs: 5_000 });
  }

  get staticSupported(): SupportedResponse {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: this.network }], extensions: [], signers: {} };
  }

  private ok(): void {
    this.lastOk = Date.now();
  }

  private failed(error: unknown): void {
    if (this.lastFailure <= this.lastOk) this.log.warn("x402: facilitator unreachable", { error: errorText(error) });
    this.lastFailure = Date.now();
  }

  /** Real /supported; records reachability and whether our kind is listed. Throws if unreachable. */
  async probeSupported(): Promise<SupportedResponse> {
    try {
      const supported = await this.probe.getSupported();
      this.ok();
      const listed = supported.kinds.some((k) => k.x402Version === 2 && k.scheme === "exact" && k.network === this.network);
      if (!listed && !this.incapable) this.log.error("x402: the facilitator does not list exact on this network; paid requests will fail", { network: this.network });
      this.incapable = !listed;
      return supported;
    } catch (error) {
      this.failed(error);
      throw error;
    }
  }

  async getSupported(): Promise<SupportedResponse> {
    try {
      return await this.probeSupported();
    } catch {
      return this.staticSupported;
    }
  }

  /** True if the facilitator answered within `freshMs`, else probes it now. */
  async reachable(freshMs = 30_000): Promise<boolean> {
    if (Date.now() - this.lastOk < freshMs && this.lastOk >= this.lastFailure) return true;
    try {
      await this.probeSupported();
      return true;
    } catch {
      return false;
    }
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    try {
      const result = await this.real.verify(payload, requirements);
      this.ok();
      return result;
    } catch (error) {
      if (!(error as { statusCode?: number }).statusCode) this.failed(error);
      throw error;
    }
  }

  pendingTxOf(payload: object): string | undefined {
    return this.pendingTx.get(payload);
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    try {
      const result = await this.real.settle(payload, requirements);
      this.ok();
      if (result.errorReason === "settlement_pending" && result.transaction) this.pendingTx.set(payload, result.transaction);
      return result;
    } catch (error) {
      if (!(error as { statusCode?: number }).statusCode) this.failed(error);
      throw error;
    }
  }
}

export interface Paywall {
  middleware: RequestHandler;
  /**
   * Resolves once no paid request is in flight, from its arrival through verify, the handler and
   * the settlement, whether or not its buyer is still connected. Call after stop(): paid requests
   * that arrive later are refused before verify, so none can start once this has resolved.
   */
  settled(): Promise<void>;
  /** Loads the payment kinds (from the facilitator, or from configuration if it is down). */
  ready(): Promise<void>;
  facilitator: FallbackFacilitatorClient;
  stop(): void;
}

export function createPaywall(deps: { config: Config; store: Store; log: Logger; chain: ChainContext; onPaid?: (mode: ReceiptMode) => void }): Paywall {
  const { config, store, log, chain } = deps;
  const network = networkOf(config);
  const facilitator = new FallbackFacilitatorClient(config.facilitatorUrl, network, log);
  // Paid requests from arrival to response, and settlements. A stop waits for both to reach zero:
  // counting settlements alone misses a request still verifying when the stop begins.
  let inFlight = 0;
  let settling = 0;
  /** What onBeforeSettle recorded for each payment, so a failure's record keeps it. */
  const settleStarts = new WeakMap<object, Pick<PaymentRecord, "settleBlock" | "settleStartedAt">>();
  const waiting: (() => void)[] = [];
  const drained = () => {
    if (inFlight === 0 && settling === 0) for (const resolve of waiting.splice(0)) resolve();
  };
  const settleDone = () => {
    settling--;
    drained();
  };
  const resourceServer = new x402ResourceServer(facilitator)
    .onAfterVerify(async ({ result, requirements }) => {
      if (!result.isValid) log.info("x402: payment rejected at verify", { reason: result.invalidReason, amount: requirements.amount });
    })
    .onVerifyFailure(async ({ error }) => {
      log.warn("x402: verify failed", { error: errorText(error) });
    })
    .onBeforeSettle(async ({ paymentPayload, requirements, transportContext }) => {
      settling++;
      const ids = receiptIdsFrom(transportContext);
      try {
        if (!ids) throw new Error("could not tell which receipt it is for");
        // One authorization pays for one receipt. The first run id to settle it claims it; offered
        // for any other run id it is refused before the facilitator is asked, so the transfer it
        // makes can only ever be credited to the receipt that claimed it.
        const authorization = authorizationOf(paymentPayload, config.paymentAsset?.transferMethod);
        const key = authorization.ambiguous ? undefined : paymentKey({ ...authorization, asset: requirements.asset as Address });
        if (!key) {
          log.warn("x402: refused a payment whose authorization cannot be keyed", { runId: ids.runId, payer: authorization.payer, nonce: authorization.nonce, ambiguous: authorization.ambiguous ?? false });
          await store.releaseSettleLease(ids.runId, ids.leaf, Date.now()).catch(() => undefined);
          settleDone();
          return { abort: true, reason: "invalid_payment_authorization", message: "the payment's authorization has no valid payer and nonce for this service's transfer method; nothing was charged" };
        }
        const owner = await store.claimPayment(key, ids.runId, Date.now());
        if (owner.toLowerCase() !== ids.runId.toLowerCase()) {
          log.warn("x402: refused a payment authorization that already pays for another receipt", { runId: ids.runId, owner, payer: authorization.payer, nonce: authorization.nonce });
          await store.releaseSettleLease(ids.runId, ids.leaf, Date.now()).catch(() => undefined);
          settleDone();
          return { abort: true, reason: "payment_reused", message: `this payment authorization already pays for run ${owner}; sign a new payment for this receipt` };
        }
        // Where the chain stands before the money can move: the search for this payment starts here
        // if its outcome is ever unknown. Best effort, so a slow RPC does not refuse the payment.
        const settleBlock = await withTimeout(chain.client.getBlockNumber({ cacheTime: 0 }), SETTLE_BLOCK_TIMEOUT_MS).then(String, () => undefined);
        const now = Date.now();
        const started = { ...(settleBlock ? { settleBlock } : {}), settleStartedAt: now };
        settleStarts.set(paymentPayload, started);
        // From here on the money may move, and a kill leaves only what is on disk.
        await store.notePayment(ids.runId, ids.leaf, { status: "settling", ...authorizationRecord(authorization), amount: requirements.amount, asset: requirements.asset, ...started, at: now }, now, now + SETTLEMENT_HOLD_MS);
        return undefined;
      } catch (error) {
        // Nothing has moved yet, so refusing costs the buyer one retry. Settling without a record could cost a second charge.
        log.error("x402: could not record a payment before settling it; refusing to settle", { runId: ids?.runId, error: errorText(error) });
        if (ids) await store.releaseSettleLease(ids.runId, ids.leaf, Date.now()).catch(() => undefined);
        settleDone();
        return { abort: true, reason: "payment_not_recorded", message: "the service could not record this payment before settling it; nothing was charged, retry shortly" };
      }
    })
    .onAfterSettle(async ({ result, requirements, transportContext }) => {
      try {
        const ids = receiptIdsFrom(transportContext);
        if (!ids) {
          log.error("x402: settled a payment but could not tell which receipt it was for", { tx: result.transaction });
          return;
        }
        const now = Date.now();
        const payment = {
          status: "settled",
          network: result.network,
          payer: result.payer,
          transaction: result.transaction,
          asset: requirements.asset,
          amount: requirements.amount,
          payTo: requirements.payTo,
          at: now,
        };
        // A local SQLite write; retried in case of a transient lock.
        let promoted = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            promoted = await store.markPaid(ids.runId, ids.leaf, payment, now);
            break;
          } catch (error) {
            if (attempt === 2) log.error("x402: payment settled but the receipt could not be marked paid", { runId: ids.runId, tx: result.transaction, error: errorText(error) });
          }
        }
        log.info("x402: payment settled", { runId: ids.runId, tx: result.transaction, payer: result.payer, amount: requirements.amount, promoted });
        const row = promoted ? await store.getReceipt(ids.runId) : null;
        if (row) deps.onPaid?.(row.mode);
      } finally {
        settleDone();
      }
    })
    .onSettleFailure(async ({ error, paymentPayload, requirements, transportContext }) => {
      try {
        const ids = receiptIdsFrom(transportContext);
        const settleError = error instanceof SettleError ? error : undefined;
        const reason = settleError?.errorReason;
        const tx = settleError?.transaction || facilitator.pendingTxOf(paymentPayload) || undefined;
        log.warn("x402: settlement failed; the receipt stays unpaid", { runId: ids?.runId, reason, tx, error: errorText(error) });
        if (!ids) return;
        const now = Date.now();
        const facts = { network: settleError?.network, ...authorizationRecord(authorizationOf(paymentPayload, config.paymentAsset?.transferMethod)), amount: requirements.amount, asset: requirements.asset, ...settleStarts.get(paymentPayload), reason, at: now };
        // A failure that names a transaction can be answered by the chain, whatever it says: keep
        // the tx so the poller can reconcile it, and hold the row so a retry is not charged twice
        // meanwhile. A tx that reverted is released on the poller's next look.
        if (tx) {
          await store.notePayment(ids.runId, ids.leaf, { status: "settlement_pending", transaction: tx, ...facts }, now, now + SETTLEMENT_HOLD_MS);
          return;
        }
        // Nothing moved: release the settlement lease so a retry with a valid payment is served at once.
        if (settlementRefused(error)) {
          await store.releaseSettleLease(ids.runId, ids.leaf, now);
          return;
        }
        // The money may have moved and there is no tx to look up. Hold the row: when the hold runs
        // out the nonce decides. The log line is what an operator has to find the payment by.
        log.error("x402: settlement outcome unknown; holding the receipt so a retry is not charged twice", { runId: ids.runId, payer: facts.payer, nonce: facts.nonce, amount: facts.amount, reason, error: errorText(error) });
        await store.notePayment(ids.runId, ids.leaf, { status: "settlement_unknown", ...facts }, now, now + SETTLEMENT_HOLD_MS);
      } finally {
        settleDone();
      }
    });
  resourceServer.register(network, new ExactEvmScheme());

  const httpServer = new x402HTTPResourceServer(resourceServer, paymentRoutes(config));
  // syncFacilitatorOnStart=false: initialization is ours (below), so a misconfiguration gives
  // a 503 on paid routes instead of the SDK's background process.exit(1).
  const inner = paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false);

  let initialized = false;
  let pending: Promise<void> | null = null;
  let probeTimer: NodeJS.Timeout | undefined;
  let stopped = false;

  /** Keeps asking the real /supported in the background until it answers (5 s, doubling to 60 s). */
  const watch = (delayMs: number) => {
    if (stopped) return;
    probeTimer = setTimeout(() => {
      facilitator
        .probeSupported()
        .then(() => log.info("x402: facilitator reachable", { facilitator: config.facilitatorUrl, network }))
        .catch(() => watch(Math.min(60_000, delayMs * 2)));
    }, delayMs);
    probeTimer.unref();
  };

  const ready = (): Promise<void> => {
    if (initialized) return Promise.resolve();
    pending ??= httpServer
      .initialize()
      .then(async () => {
        initialized = true;
        if (await facilitator.reachable(60_000)) {
          log.info("x402: facilitator ready", { facilitator: config.facilitatorUrl, network });
        } else {
          log.warn("x402: facilitator unreachable at startup; 402 challenges come from configuration, paid requests answer 503 until it is reachable", {
            facilitator: config.facilitatorUrl,
          });
          watch(5_000);
        }
      })
      .catch((error: unknown) => {
        pending = null;
        throw error;
      });
    return pending;
  };

  const serve = async (req: Request, res: Response, next: NextFunction, carriesPayment: boolean): Promise<void> => {
    try {
      await ready();
    } catch (error) {
      log.error("x402: payment routes misconfigured", { error: errorText(error) });
      res.status(503).json({ error: "payment_unavailable", message: "payments are misconfigured on this service" });
      return;
    }
    // A request carrying a payment needs verify and settle: refuse it up front, before the
    // buyer's authorization is spent on nothing, if the facilitator cannot be reached.
    if (carriesPayment && (facilitator.incapable || !(await facilitator.reachable()))) {
      res.setHeader("Retry-After", "30");
      res.status(503).json({ error: "payment_unavailable", message: "the payment facilitator is unavailable; retry shortly with the same payment" });
      return;
    }
    // Resolves once the response is written, after the settlement (@x402/express buffers it).
    await inner(req, res, next);
  };

  const middleware: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
    const carriesPayment = Boolean(req.header("payment-signature") || req.header("x-payment"));
    if (!carriesPayment) return serve(req, res, next, false);
    // A stop waits for the paid requests already here. One arriving after it began (on a kept-alive
    // connection) is refused before verify, so nothing of it is settled.
    if (stopped) {
      res.setHeader("Retry-After", "30");
      res.status(503).json({ error: "service_stopping", message: "the service is stopping; retry shortly with the same payment" });
      return;
    }
    inFlight++;
    try {
      await serve(req, res, next, true);
    } finally {
      inFlight--;
      drained();
    }
  };
  return {
    middleware,
    ready,
    facilitator,
    settled: () => (inFlight === 0 && settling === 0 ? Promise.resolve() : new Promise<void>((resolve) => waiting.push(resolve))),
    stop() {
      stopped = true;
      clearTimeout(probeTimer);
    },
  };
}
