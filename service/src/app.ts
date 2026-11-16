import express, { type ErrorRequestHandler, type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { receiptDigest, receiptRegistryAbi, serviceAttestationTypedData, type ReceiptFields } from "@hemi-receipts/sdk";
import { signedByServiceKey, withTimeout, type ChainContext, type RegistryGate } from "./chain.js";
import type { Config } from "./config.js";
import { HttpError, parseAttestBody, verifyAgentSignature, type AttestInput, type CodeCache, type Limiter } from "./input.js";
import { errorText, type Logger } from "./log.js";
import { HELD_PAYMENTS, holdEnded, paymentOf, RECEIPT_LEAF_HEADER, RECEIPT_RUN_ID_HEADER, settleEndedHold, type Paywall } from "./payments.js";
import { receiptFile } from "./receipt-file.js";
import { SETTLEMENT_HOLD_MS } from "./store.js";
import type { BatchRow, NewReceipt, ReceiptMode, ReceiptRow, Store } from "./store.js";

export interface AppDeps {
  config: Config;
  store: Store;
  chain: ChainContext;
  log: Logger;
  gate: RegistryGate;
  limiter: Limiter;
  /** Which agent and principal accounts have code; see verifyAgentSignature. */
  codes: CodeCache;
  /** Absent when DEV_FREE=1. */
  paywall?: Paywall;
  batcher?: { nudge(): void; lastError?: string | undefined };
  poller?: { latest?: { block: bigint; at: number } | undefined; lastError?: string | undefined };
  /** How Bitcoin stages are read, for /health. */
  finalitySource?: string;
}

/** Re-issue a direct-path signature on replay when less than this remains. */
const DIRECT_REFRESH_MARGIN_SECONDS = 300;
const BYTES32_ANY = /^0x[0-9a-fA-F]{64}$/;

/** 409 while another request's payment for this receipt is settling (its lease is held). */
function paymentInFlight(runId: Hex): HttpError {
  return new HttpError(409, "payment_pending", "another request is paying for this receipt right now; retry shortly without paying again", { runId });
}

/**
 * 409 while a payment for another submission under this run id is settling. Once it is refused,
 * nobody paid, so the run id is free again: a corrected manifest is served at once.
 */
function otherPaymentInFlight(runId: Hex): HttpError {
  return new HttpError(409, "run_id_conflict", "another submission for this run id is being paid for right now; retry shortly", { runId });
}

function fieldsOf(row: ReceiptRow): ReceiptFields {
  return { runId: row.run_id, manifestHash: row.manifest_hash, agent: row.agent, principal: row.principal, schemaVersion: row.schema_version };
}

function batchView(batch: BatchRow, runIds: Hex[]) {
  return {
    id: batch.id,
    mode: batch.mode,
    batchId: batch.onchain_batch_id,
    root: batch.root,
    count: batch.count,
    schemaVersion: batch.schema_version,
    state: batch.state,
    stage: batch.stage,
    status: batch.status_json ? JSON.parse(batch.status_json) : null,
    txHash: batch.tx_hash,
    blockNumber: batch.block_number,
    deadline: batch.deadline,
    createdAt: new Date(batch.created_at).toISOString(),
    minedAt: batch.mined_at ? new Date(batch.mined_at).toISOString() : null,
    lastError: batch.last_error,
    runIds,
  };
}

export function createApp(deps: AppDeps): Express {
  const { config, store, chain, log, gate, limiter, codes, paywall } = deps;
  const app = express();
  app.disable("x-powered-by");
  const json = express.json({ limit: "1.2mb" });

  const baseUrl = (req: Request) => config.publicBaseUrl ?? `${req.protocol}://${req.get("host")}`;
  const receiptUrl = (req: Request, runId: Hex) => `${baseUrl(req)}/receipts/${runId}`;

  async function receiptResponse(row: ReceiptRow) {
    const batch = row.batch_local_id !== null ? await store.getBatch(row.batch_local_id) : null;
    return receiptFile(row, batch, config.chainId, config.registry);
  }

  async function signDirect(receipt: ReceiptFields): Promise<{ signature: Hex; deadline: number }> {
    const deadline = Math.floor(Date.now() / 1000) + config.signatureTtlSeconds;
    const digest = receiptDigest(receipt, chain.domain);
    const signature = await chain.service.signTypedData(serviceAttestationTypedData(digest, BigInt(deadline), chain.domain));
    return { signature, deadline };
  }

  function directBody(row: ReceiptRow, req: Request) {
    const receipt = fieldsOf(row);
    const deadline = row.direct_deadline!;
    const serviceSignature = row.direct_service_signature!;
    return {
      receipt,
      agentSignature: row.agent_signature,
      deadline,
      serviceSignature,
      registry: config.registry,
      chainId: config.chainId,
      to: config.registry,
      data: encodeFunctionData({
        abi: receiptRegistryAbi,
        functionName: "attest",
        args: [receipt, row.agent_signature, BigInt(deadline), serviceSignature],
      }),
      receiptUrl: receiptUrl(req, row.run_id),
    };
  }

  /** Validation and the idempotency lookup, BEFORE the paywall: nobody pays for a rejected request or a replay. */
  const precheck =
    (mode: ReceiptMode): RequestHandler =>
    async (req: Request, res: Response, next: NextFunction) => {
      const input = parseAttestBody(req.body, { storeMaxBytes: config.storeManifestsMaxBytes });
      const { runId } = input.receipt;
      const now = Date.now();
      let existing = await store.getReceipt(runId);

      // A hold can only wait. Once it has run out the chain decides, before anyone pays again.
      if (existing?.state === "unpaid" && holdEnded(existing, now)) {
        const outcome = await settleEndedHold({ chain, config, store, log }, existing, now);
        if (outcome === "held") {
          res.setHeader("Retry-After", "60");
          throw new HttpError(409, "payment_pending", "an earlier payment for this run id cannot be ruled out yet; retry later instead of paying again", {
            runId,
            transaction: paymentOf(existing)?.transaction,
          });
        }
        if (outcome === "paid" && existing.mode === "batch") deps.batcher?.nudge();
        existing = await store.getReceipt(runId);
      }

      if (existing && existing.state !== "unpaid") {
        if (existing.leaf !== input.leaf) {
          throw new HttpError(409, "run_id_conflict", "this run id is already registered for a different receipt (manifest hash, agent or principal differ)", { runId });
        }
        if (existing.mode !== mode) {
          throw new HttpError(409, "run_id_conflict", `this receipt was already submitted for ${existing.mode} anchoring`, { runId, mode: existing.mode });
        }
        if (input.agentSignature !== existing.agent_signature) await verifyAgentSignature(chain, input, limiter, codes);
        if (input.store && input.manifestCanonical && !existing.manifest_json) await store.attachManifest(runId, input.manifestCanonical, now);
        let row = (await store.getReceipt(runId))!;
        if (mode === "batch") {
          res.status(200).json(await receiptResponse(row));
          return;
        }
        const expiring = (row.direct_deadline ?? 0) < Math.floor(now / 1000) + DIRECT_REFRESH_MARGIN_SECONDS;
        // A signature made by a key that is no longer the service's (the signer was rotated) would revert.
        const staleKey =
          !expiring &&
          row.direct_service_signature !== null &&
          !(await signedByServiceKey(chain, serviceAttestationTypedData(receiptDigest(fieldsOf(row), chain.domain), BigInt(row.direct_deadline!), chain.domain), row.direct_service_signature as Hex));
        if (row.state !== "anchored" && (expiring || staleKey)) {
          const { signature, deadline } = await signDirect(fieldsOf(row));
          await store.setDirectSignature(runId, signature, deadline, now);
          row = (await store.getReceipt(runId))!;
          log.info(staleKey ? "direct: re-issued a service signature made by a rotated-out key (no charge)" : "direct: re-issued an expired service signature (no charge)", { runId });
        }
        res.status(200).json({ ...directBody(row, req), status: (await receiptResponse(row)).status });
        return;
      }

      if (existing && existing.state === "unpaid") {
        const payment = paymentOf(existing);
        if (HELD_PAYMENTS.has(payment?.status ?? "") && now - (payment?.at ?? 0) < SETTLEMENT_HOLD_MS) {
          res.setHeader("Retry-After", "60");
          throw new HttpError(409, "payment_pending", "an earlier payment for this run id may still be settling; retry later instead of paying again", {
            runId,
            transaction: payment?.transaction,
          });
        }
        if ((existing.settle_lease_until ?? 0) > now) {
          res.setHeader("Retry-After", "30");
          throw existing.leaf === input.leaf ? paymentInFlight(runId) : otherPaymentInFlight(runId);
        }
      }

      await verifyAgentSignature(chain, input, limiter, codes);
      const [paused, enabled] = await Promise.all([gate.paused(), gate.schemaVersionEnabled(input.receipt.schemaVersion)]);
      if (paused === true) throw new HttpError(503, "registry_paused", "the registry is paused; anchoring is suspended");
      if (enabled === false) {
        throw new HttpError(400, "schema_version_disabled", `schema version ${input.receipt.schemaVersion} is disabled on the registry`);
      }
      res.locals.input = input;
      next();
    };

  /**
   * Runs after the paywall verified the payment and BEFORE it settles (see payments.ts):
   * stores the receipt `unpaid`; the settle hook promotes it. Under DEV_FREE it is stored paid.
   */
  const handle =
    (mode: ReceiptMode): RequestHandler =>
    async (req: Request, res: Response) => {
      const input = res.locals.input as AttestInput;
      const { runId } = input.receipt;
      const now = Date.now();
      const free = !paywall;
      const direct = mode === "direct" ? await signDirect(input.receipt) : undefined;
      const record: NewReceipt = {
        runId,
        leaf: input.leaf,
        manifestHash: input.receipt.manifestHash,
        agent: input.receipt.agent,
        principal: input.receipt.principal,
        schemaVersion: input.receipt.schemaVersion,
        agentSignature: input.agentSignature,
        mode,
        state: free ? (mode === "batch" ? "queued" : "direct_signed") : "unpaid",
        manifestJson: input.store && input.manifestCanonical ? input.manifestCanonical : null,
        directServiceSignature: direct?.signature ?? null,
        directDeadline: direct?.deadline ?? null,
        // The settle hooks end this lease as soon as the outcome is known. It only runs its course
        // if the process dies in between, when the money may have moved: hence a full hold.
        settleLeaseUntil: free ? null : now + SETTLEMENT_HOLD_MS,
      };

      // The INSERT (or the rewrite of an unpaid row) is the exclusive claim on settling this
      // receipt: of two requests that both passed the precheck before either stored anything,
      // exactly one gets it. The other answers ≥ 400 and its payment is never settled.
      const { inserted, row: stored } = await store.insertReceipt(record, now);
      if (!inserted) {
        if (stored.state === "unpaid") {
          if (!(await store.rewriteUnpaid({ runId, leaf: stored.leaf }, record, now))) {
            // A concurrent request's payment is settling, or has just become a hold (the lease covers both).
            res.setHeader("Retry-After", "30");
            throw stored.leaf === input.leaf ? paymentInFlight(runId) : otherPaymentInFlight(runId);
          }
          if (free) await store.markPaid(runId, input.leaf, { status: "free" }, now);
        } else if (stored.leaf !== input.leaf || stored.mode !== mode) {
          throw new HttpError(409, "run_id_conflict", "this run id is already registered for a different receipt", { runId });
        } else if (!free) {
          // Accepted by a concurrent request a moment ago. Answer ≥ 400 so THIS payment is not settled.
          throw new HttpError(409, "already_submitted", "this receipt was accepted moments ago by another request; fetch it from receiptUrl", {
            runId,
            receiptUrl: receiptUrl(req, runId),
          });
        }
      }

      res.setHeader(RECEIPT_RUN_ID_HEADER, runId);
      res.setHeader(RECEIPT_LEAF_HEADER, input.leaf);
      if (free && mode === "batch") deps.batcher?.nudge();
      if (mode === "batch") {
        res.status(202).json({ runId, status: "pending", receiptUrl: receiptUrl(req, runId), leaf: input.leaf });
        return;
      }
      // 202 like the batch path: accepted and countersigned; anchoring completes when the caller's tx is mined.
      const row = (await store.getReceipt(runId))!;
      res.status(202).json(directBody(row, req));
    };

  const paid: RequestHandler = paywall ? paywall.middleware : (_req, _res, next) => next();

  app.post("/attest", json, precheck("batch"), paid, handle("batch"));
  app.post("/attest/direct", json, precheck("direct"), paid, handle("direct"));

  // Read-only routes serve public data (anyone with a runId can fetch it), so any origin may
  // read them, e.g. the receipt viewer (viewer/). The paid POST routes get no CORS headers.
  const publicRead: RequestHandler = (_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    next();
  };
  app.use(["/receipts", "/batches", "/health"], publicRead);

  app.get("/receipts/:runId", async (req: Request, res: Response) => {
    const runId = String(req.params.runId);
    if (!BYTES32_ANY.test(runId)) throw new HttpError(400, "invalid_run_id", "runId must be 0x-prefixed 32-byte hex");
    const row = await store.getReceipt(runId.toLowerCase() as Hex);
    if (!row || row.state === "unpaid") throw new HttpError(404, "not_found", "no accepted receipt with this run id");
    res.json(await receiptResponse(row));
  });

  app.get("/batches/:id", async (req: Request, res: Response) => {
    const raw = String(req.params.id);
    if (!/^[1-9][0-9]{0,15}$/.test(raw)) throw new HttpError(400, "invalid_batch_id", "batch id must be a positive integer (the service's local batch id)");
    const batch = await store.getBatch(Number(raw));
    if (!batch) throw new HttpError(404, "not_found", "no batch with this id");
    res.json(batchView(batch, await store.runIdsOfBatch(batch.id)));
  });

  let rpcCache: { ok: boolean; latestBlock: number | null; at: number } | undefined;
  async function rpcHealth(): Promise<{ ok: boolean; latestBlock: number | null }> {
    const now = Date.now();
    const seen = deps.poller?.latest;
    if (seen && now - seen.at < Math.max(60_000, 3 * config.pollIntervalMs)) return { ok: true, latestBlock: Number(seen.block) };
    if (rpcCache && now - rpcCache.at < 10_000) return { ok: rpcCache.ok, latestBlock: rpcCache.latestBlock };
    try {
      const block = await withTimeout(chain.client.getBlockNumber(), 3_000);
      rpcCache = { ok: true, latestBlock: Number(block), at: now };
    } catch {
      rpcCache = { ok: false, latestBlock: rpcCache?.latestBlock ?? null, at: now };
    }
    return { ok: rpcCache.ok, latestBlock: rpcCache.latestBlock };
  }

  app.get("/health", async (_req: Request, res: Response) => {
    let counts: Awaited<ReturnType<Store["counts"]>>;
    let last: BatchRow | null;
    try {
      counts = await store.counts();
      last = await store.lastMinedBatch();
    } catch (error) {
      res.status(503).json({ ok: false, error: "database_unavailable", message: errorText(error) });
      return;
    }
    const rpc = await rpcHealth();
    res.json({
      ok: rpc.ok,
      chainId: config.chainId,
      registry: config.registry,
      serviceSigner: chain.service.address as Address,
      relayer: chain.relayer.address as Address,
      devFree: config.devFree,
      pending: counts.queued + counts.batched + counts.direct_signed,
      queue: { queued: counts.queued, batched: counts.batched, directAwaitingTx: counts.direct_signed, anchored: counts.anchored },
      lastBatch: last
        ? {
            id: last.id,
            batchId: last.onchain_batch_id,
            mode: last.mode,
            root: last.root,
            count: last.count,
            txHash: last.tx_hash,
            blockNumber: last.block_number,
            stage: last.stage,
            minedAt: last.mined_at ? new Date(last.mined_at).toISOString() : null,
          }
        : null,
      rpc,
      finality: deps.finalitySource ?? null,
      batcher: { lastError: deps.batcher?.lastError ?? null },
      poller: { lastError: deps.poller?.lastError ?? null },
    });
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "not_found", message: "no such route" });
  });

  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.code, message: error.message, ...(error.details ?? {}) });
      return;
    }
    const type = (error as { type?: string }).type;
    if (type === "entity.too.large") {
      res.status(413).json({ error: "payload_too_large", message: "request body exceeds 1.2 MB" });
      return;
    }
    if (type === "entity.parse.failed") {
      res.status(400).json({ error: "invalid_json", message: "request body is not valid JSON" });
      return;
    }
    log.error("http: unhandled error", { error: errorText(error) });
    if (!res.headersSent) res.status(500).json({ error: "internal_error", message: "the service could not complete this request" });
  };
  app.use(onError);
  return app;
}
