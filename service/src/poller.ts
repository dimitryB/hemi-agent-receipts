import { erc20Abi, isAddressEqual, parseEventLogs, type Address } from "viem";
import { HEMI_NETWORKS, resolveStatus, STAGES, unavailableFinality, type FinalityReader, type ReceiptStage, type StatusInfo } from "@hemi-receipts/sdk";
import { notCheckedYet } from "./finality.js";
import { batchIdOfRun, findAnchorTx, readBatch, receiptOrNull, type ChainContext } from "./chain.js";
import type { Config } from "./config.js";
import { errorText, type Logger } from "./log.js";
import { paymentOf, settleEndedHold } from "./payments.js";
import { SETTLEMENT_HOLD_MS } from "./store.js";
import type { BatchRow, ReceiptRow, Store } from "./store.js";

/** Rank on the ladder; `voided` is terminal and outranks everything. */
export function stageRank(stage: ReceiptStage): number {
  return stage === "voided" ? STAGES.length : STAGES.indexOf(stage);
}

/** How long after its deadline a direct-path signature is still looked for on chain. */
const DIRECT_GRACE_SECONDS = 300;

/**
 * Moves mined batches along the status ladder and finds direct-path transactions.
 *
 * Per tick: one eth_blockNumber shared by everything, then for each due batch (at most
 * POLL_MAX_BATCHES_PER_TICK) `resolveStatus` (getBlock + the finality reader) and
 * `getBatch` (void check). RPC use grows with batches, never with receipts: a batch of 64
 * receipts costs the same as a batch of one. Young batches are checked every
 * POLL_INTERVAL_SECONDS; once confirmed, the interval grows with age up to
 * POLL_MAX_INTERVAL_SECONDS. btc-final and voided batches are no longer checked.
 */
export class StatusPoller {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private failures = 0;
  lastError: string | undefined;
  /** Latest block seen by the poller, shared with /health. */
  latest: { block: bigint; at: number } | undefined;
  /** Consecutive ticks whose safe-head read failed. */
  private safeFailures = 0;

  constructor(
    private readonly deps: { store: Store; chain: ChainContext; config: Config; log: Logger; finality?: FinalityReader },
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  nudge(): void {
    this.wake?.();
  }

  private async run(): Promise<void> {
    const { config, log } = this.deps;
    while (this.running) {
      try {
        await this.tick();
        this.failures = 0;
        this.lastError = undefined;
      } catch (error) {
        this.failures++;
        this.lastError = errorText(error);
        log.warn("poller: tick failed; backing off", { error: this.lastError, failures: this.failures });
      }
      if (!this.running) break;
      const delay = this.failures > 0 ? Math.min(300_000, config.pollIntervalMs * 2 ** Math.min(this.failures, 8)) : config.pollIntervalMs;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = undefined;
    }
  }

  async tick(): Promise<void> {
    const { store, chain, config } = this.deps;
    const now = Date.now();
    const due = await store.dueBatches(now, config.pollMaxBatchesPerTick);
    const direct = await store.directAwaitingTx(config.pollMaxBatchesPerTick);
    const settlements = config.devFree ? [] : await store.pendingSettlements(5);
    if (due.length === 0 && direct.length === 0 && settlements.length === 0 && this.latest && now - this.latest.at < 60_000) return;

    const latest = await chain.client.getBlockNumber();
    this.latest = { block: latest, at: now };
    const safe = due.length > 0 ? await this.safeHead() : null;
    for (const batch of due) await this.checkBatch(batch, latest, safe);
    for (const receipt of direct) await this.checkDirect(receipt);
    for (const receipt of settlements) await this.reconcileSettlement(receipt);
  }

  /**
   * Hemi's OP-stack "safe" head, once per tick, shared by every batch (the SDK's resolveStatus
   * would otherwise read it once per batch). hemi-confirmed needs the anchoring block at or
   * below it. Like the SDK, only Hemi networks have a meaningful safe head (anvil's is
   * synthetic): elsewhere this is null and the confirmation count alone applies. Stricter
   * than the SDK on failure: a failed read fails the tick, so nothing is promoted on partial
   * data; after 5 failing ticks in a row it falls back to the count, as the SDK does, so an
   * RPC without the tag cannot stall the poller.
   */
  private async safeHead(): Promise<bigint | null> {
    const { chain, log } = this.deps;
    if (!HEMI_NETWORKS[chain.chainId]) return null;
    try {
      const block = await chain.client.getBlock({ blockTag: "safe" });
      if (block.number === null) throw new Error("the safe block has no number");
      this.safeFailures = 0;
      return block.number;
    } catch (error) {
      this.safeFailures++;
      if (this.safeFailures < 5) throw error;
      if (this.safeFailures === 5) log.warn("poller: the RPC keeps failing to serve the safe head; using the confirmation count only until it does", { error: errorText(error) });
      return null;
    }
  }

  private nextCheckAt(stage: ReceiptStage, minedAt: number | null, now: number): number | null {
    const { config } = this.deps;
    if (stage === "btc-final" || stage === "voided") return null;
    if (stage === "pending" || stage === "hemi-included") return now + config.pollIntervalMs;
    const age = now - (minedAt ?? now);
    return now + Math.min(config.pollMaxIntervalMs, Math.max(config.pollIntervalMs, Math.floor(age / 10)));
  }

  private async checkBatch(batch: BatchRow, latest: bigint, safe: bigint | null): Promise<void> {
    const { chain, config, store, log } = this.deps;
    const now = Date.now();
    // Bitcoin checks cost Esplora calls: only for batches already hemi-confirmed (or
    // btc-published), once per batch per poll. The first confirmed check skips them.
    const bitcoinDue = batch.stage === "hemi-confirmed" || batch.stage === "btc-published";
    const status = await resolveStatus({
      client: chain.client,
      blockNumber: BigInt(batch.block_number!),
      confirmations: config.hemiConfirmations,
      finality: bitcoinDue ? (this.deps.finality ?? unavailableFinality) : notCheckedYet,
      latestBlock: latest,
      safeBlock: safe,
      ...(batch.block_hash ? { anchorBlockHash: batch.block_hash } : {}),
    });

    // A Hemi reorg removes the anchor itself and hands it back for anchoring.
    if (status.stage === "pending") {
      await store.reopenBatch(batch, now);
      log.warn("poller: anchoring block reorged out; batch handed back", { batch: batch.id, mode: batch.mode, block: batch.block_number, blockHash: batch.block_hash });
      return;
    }
    // After the reorg check: a reorged-out batch id may not exist any more (getBatch reverts).
    const onchain = await readBatch(chain, BigInt(batch.onchain_batch_id!));

    if (onchain.voided) {
      const voided: StatusInfo = {
        stage: "voided",
        estimated: false,
        ...(status.hemi ? { hemi: status.hemi } : {}),
        checkedAt: status.checkedAt,
        notes: ["the registry owner voided this batch; verifyReceipt returns false for it"],
      };
      await store.setBatchStatus(batch.id, voided, null, now);
      log.warn("poller: batch voided on chain", { batch: batch.id, onchainBatchId: batch.onchain_batch_id });
      return;
    }
    if (onchain.root.toLowerCase() !== batch.root) {
      log.error("poller: registry reports a different root for this batch id", { batch: batch.id, onchainBatchId: batch.onchain_batch_id, root: onchain.root });
    }

    // Keep Hemi progress through lagging RPC reads. Bitcoin publication is provisional:
    // a reorg can remove it while the Hemi anchor remains canonical. If the reader can
    // no longer confirm it (including an unavailable read), publish the current evidence.
    const publicationWithdrawn = batch.stage === "btc-published" && status.stage === "hemi-confirmed";
    if (stageRank(status.stage) < stageRank(batch.stage) && !publicationWithdrawn) {
      await store.rescheduleBatch(batch.id, this.nextCheckAt(batch.stage, batch.mined_at, now) ?? now + config.pollMaxIntervalMs, now);
      return;
    }
    await store.setBatchStatus(batch.id, status, this.nextCheckAt(status.stage, batch.mined_at, now), now);
    if (status.stage !== batch.stage) {
      log.info(publicationWithdrawn ? "poller: Bitcoin publication no longer confirmed" : "poller: batch advanced", {
        batch: batch.id, from: batch.stage, to: status.stage, confirmations: status.hemi?.confirmations,
      });
    }
  }

  /** Direct path: the caller sends `attest` itself; detect it with batchIdOfRun(runId). */
  private async checkDirect(receipt: ReceiptRow): Promise<void> {
    const { chain, store, log } = this.deps;
    const now = Date.now();
    const id = await batchIdOfRun(chain, receipt.run_id);
    if (id === 0n) {
      if (receipt.direct_deadline !== null && now / 1000 > receipt.direct_deadline + DIRECT_GRACE_SECONDS) {
        await store.markDirectExpired(receipt.run_id, now);
        log.info("poller: direct-path signature expired unused", { runId: receipt.run_id });
      } else {
        await store.touchReceipt(receipt.run_id, now);
      }
      return;
    }
    const onchain = await readBatch(chain, id);
    if (onchain.root.toLowerCase() !== receipt.leaf) {
      log.error("poller: run id anchored on chain with a different leaf", { runId: receipt.run_id, onchainBatchId: id, root: onchain.root });
      await store.touchReceipt(receipt.run_id, now);
      return;
    }
    const found = await findAnchorTx(chain, id, onchain.blockNumber);
    if (!found) {
      await store.touchReceipt(receipt.run_id, now);
      return;
    }
    const status: StatusInfo = {
      stage: "hemi-included",
      estimated: false,
      checkedAt: Math.floor(now / 1000),
      notes: ["direct attestation found on chain; confirmations are checked by the status poller"],
    };
    await store.anchorDirect(receipt, { onchainBatchId: Number(id), blockNumber: Number(onchain.blockNumber), ...found }, status, now);
    log.info("poller: direct attestation detected", { runId: receipt.run_id, onchainBatchId: id, tx: found.txHash });
  }

  /**
   * A settlement that failed naming a transaction may still mine after the request was
   * refused ("charged but not served", x402facilitator README). If its tx mined and moved
   * exactly the price to PAY_TO in the payment asset, the receipt is promoted after all. A tx
   * that never shows up is not an answer (it may have been replaced), so once the hold has run
   * out the chain decides from the payment's nonce and logs (settleEndedHold).
   */
  private async reconcileSettlement(receipt: ReceiptRow): Promise<void> {
    const { chain, store, config, log } = this.deps;
    const now = Date.now();
    const payment = paymentOf(receipt);
    if (payment?.status !== "settlement_pending" || !payment.transaction || !config.paymentAsset || !config.payTo) return;
    const tx = await receiptOrNull(chain, payment.transaction);
    if (!tx) {
      const held = now - (payment.at ?? now) <= SETTLEMENT_HOLD_MS || (await settleEndedHold({ chain, config, store, log }, receipt, now)) === "held";
      if (held) await store.touchReceipt(receipt.run_id, now);
      return;
    }
    const price = receipt.mode === "batch" ? config.priceBatch : config.priceDirect;
    const paid =
      tx.status === "success" &&
      parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: tx.logs }).some(
        (log) =>
          isAddressEqual(log.address, config.paymentAsset!.address) &&
          isAddressEqual(log.args.to as Address, config.payTo!) &&
          log.args.value === BigInt(payment.amount ?? price),
      );
    if (paid) {
      await store.markPaid(receipt.run_id, receipt.leaf, { ...payment, status: "settled", reconciled: true, checkedAt: now }, now);
      log.info("poller: late settlement found; receipt accepted", { runId: receipt.run_id, tx: payment.transaction });
    } else {
      await store.endHold(receipt.run_id, receipt.leaf, receipt.payment_json!, { ...payment, status: "settlement_failed", checkedAt: now }, now);
      log.warn("poller: pending settlement did not pay; receipt stays unpaid", { runId: receipt.run_id, tx: payment.transaction });
    }
  }
}
