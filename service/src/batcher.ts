import { encodeFunctionData, keccak256, type Hex } from "viem";
import { batchAttestationTypedData, buildMerkleTree, receiptRegistryAbi, type StatusInfo } from "@hemi-receipts/sdk";
import {
  batchAttestedIn,
  batchIdOfRoot,
  broadcast,
  findAnchorTx,
  readBatch,
  receiptOrNull,
  revertOf,
  signedByServiceKey,
  suggestFees,
  type ChainContext,
  type Fees,
} from "./chain.js";
import type { Config } from "./config.js";
import { errorText, type Logger } from "./log.js";
import type { Anchoring, BatchRow, Store } from "./store.js";

/**
 * Test hooks: throw from one to simulate a crash at that point. Never set in production.
 */
export interface BatcherFaults {
  /** After the signed raw tx and its hash are persisted, before eth_sendRawTransaction. */
  beforeBroadcast?(batch: BatchRow): void | Promise<void>;
  /** After eth_sendRawTransaction returned (or failed), before anything else is recorded. */
  afterBroadcast?(batch: BatchRow): void | Promise<void>;
}

/** Re-sign when fewer than this many seconds of the signature's validity remain (capped at TTL/4). */
const DEADLINE_MARGIN_SECONDS = 300;
/** The registry refuses deadlines more than an hour ahead of the including block. */
const MAX_DEADLINE_WINDOW_SECONDS = 3600;
/** nonce-too-low answers tolerated (receipt lag on load-balanced RPCs) before a fresh nonce. */
const NONCE_TOO_LOW_TOLERANCE = 3;

/**
 * Closes batches and anchors them with `attestBatch`, one transaction in flight at a time.
 *
 * Batch state machine (batches.state), persisted before every side effect:
 *
 *   (queued receipts) --close--> signed --persist raw tx + hash--> sent --receipt--> mined
 *                                  ^                                 |
 *                                  +-- reverted / nonce taken / deadline passed / stuck
 *
 * - close: one DB transaction assigns the receipts, stores every Merkle proof, the root and
 *   the service's BatchAttestation signature.
 * - signed -> sent: the raw tx is signed, its hash computed and stored, THEN broadcast. A
 *   crash or a lost answer ("was my tx sent?") is resolved by looking the hash up.
 * - Before every send the registry is asked `batchIdOfRoot(root)`; non-zero (or a
 *   `RootAlreadyAttested` revert) is success, and the batch id is read from chain. A root can
 *   be anchored once, so no path can anchor the same receipts twice.
 * - A replacement (deadline passed, or stuck) reuses the same nonce with fees bumped ≥ 12.5 %,
 *   so a stuck transaction is replaced rather than leaving a nonce gap.
 */
export class Batcher {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private failures = 0;
  lastError: string | undefined;

  constructor(
    private readonly deps: { store: Store; chain: ChainContext; config: Config; log: Logger; faults?: BatcherFaults },
  ) {}

  private get idleMs(): number {
    return Math.max(20, Math.min(1000, Math.floor(this.deps.config.batchMaxWaitMs / 4)));
  }

  /** How often an in-flight transaction is looked up. */
  private get sentPollMs(): number {
    return Math.max(50, Math.min(this.deps.config.pollIntervalMs, 4000));
  }

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

  /** Called when a receipt is queued, so a full batch closes without waiting for the tick. */
  nudge(): void {
    this.wake?.();
  }

  private async run(): Promise<void> {
    while (this.running) {
      let again = false;
      try {
        again = await this.tick();
        this.failures = 0;
        this.lastError = undefined;
      } catch (error) {
        this.failures++;
        this.lastError = errorText(error);
        this.deps.log.warn("batcher: tick failed; backing off", { error: this.lastError, failures: this.failures });
      }
      if (!this.running) break;
      const delay = this.failures > 0 ? Math.min(60_000, 500 * 2 ** Math.min(this.failures, 7)) : again ? 0 : this.idleMs;
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

  /** One step. Returns true when it made progress and should run again immediately. */
  async tick(): Promise<boolean> {
    const now = Date.now();
    const active = await this.deps.store.activeBatch();
    if (active) {
      if (active.next_attempt_at > now) return false;
      try {
        return await this.process(active);
      } catch (error) {
        const attempts = active.attempts + 1;
        const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempts - 1, 6));
        await this.deps.store.updateBatch(active.id, { attempts, next_attempt_at: Date.now() + delay, last_error: errorText(error) }, Date.now());
        this.deps.log.warn("batcher: batch step failed; will retry", { batch: active.id, state: active.state, attempts, retryInMs: delay, error: errorText(error) });
        return false;
      }
    }
    return this.maybeClose(now);
  }

  /** Closes a batch at BATCH_MAX_SIZE receipts, or when the oldest has waited BATCH_MAX_WAIT_SECONDS. */
  private async maybeClose(now: number): Promise<boolean> {
    const { store, chain, config, log } = this.deps;
    const head = await store.queueHead();
    if (!head) return false;
    if (Number(head.n) < config.batchMaxSize && Number(head.oldest) > now - config.batchMaxWaitMs) return false;

    const receipts = await store.queuedReceipts(head.schema_version, config.batchMaxSize);
    if (receipts.length === 0) return false;
    const tree = buildMerkleTree(receipts.map((r) => r.leaf));
    const deadline = Math.floor(now / 1000) + config.signatureTtlSeconds;
    const serviceSignature = await chain.service.signTypedData(
      batchAttestationTypedData({ root: tree.root, count: receipts.length, schemaVersion: head.schema_version, deadline: BigInt(deadline) }, chain.domain),
    );
    const batch = await store.createBatch(
      {
        root: tree.root,
        count: receipts.length,
        schemaVersion: head.schema_version,
        deadline,
        serviceSignature,
        proofs: receipts.map((r) => ({ runId: r.run_id, proof: tree.proof(r.leaf) })),
      },
      now,
    );
    log.info("batcher: closed batch", { batch: batch.id, root: batch.root, count: batch.count, schemaVersion: batch.schema_version });
    return true;
  }

  private async process(batch: BatchRow): Promise<boolean> {
    if (batch.state === "signed") return this.send(batch);
    if (batch.state === "sent") return this.followUp(batch);
    return false;
  }

  private async resign(batch: BatchRow, chainNow: number): Promise<{ deadline: number; signature: Hex }> {
    const { chain, store } = this.deps;
    const deadline = chainNow + this.deps.config.signatureTtlSeconds;
    const signature = await chain.service.signTypedData(
      batchAttestationTypedData({ root: batch.root, count: batch.count, schemaVersion: batch.schema_version, deadline: BigInt(deadline) }, chain.domain),
    );
    await store.updateBatch(batch.id, { deadline, service_signature: signature }, Date.now());
    this.deps.log.info("batcher: re-signed batch with a new deadline", { batch: batch.id, deadline });
    return { deadline, signature };
  }

  /** signed → sent. Checks the chain first, simulates, then persists the raw tx before broadcasting. */
  private async send(batch: BatchRow): Promise<boolean> {
    const { chain, store, log, faults } = this.deps;
    const { client } = chain;

    const anchored = await batchIdOfRoot(chain, batch.root);
    if (anchored !== 0n) {
      await this.adopt(batch, anchored);
      return true;
    }

    const block = await client.getBlock({ blockTag: "latest" });
    // The next block's timestamp is at least the latest one's, and on a live chain about
    // wall-clock time; taking the max keeps a stalled chain from looking like the past.
    const chainNow = Math.max(Number(block.timestamp), Math.floor(Date.now() / 1000));

    // A replacement keeps the nonce and must outbid the pending tx; never beyond the cap.
    const previous: Fees | undefined =
      batch.nonce !== null && batch.max_fee_per_gas && batch.max_priority_fee_per_gas
        ? { maxFeePerGas: BigInt(batch.max_fee_per_gas), maxPriorityFeePerGas: BigInt(batch.max_priority_fee_per_gas) }
        : undefined;
    const fees = await suggestFees(chain, block.baseFeePerGas ?? 0n, previous);
    if (!fees.withinCap && previous && batch.raw_tx) {
      await store.updateBatch(
        batch.id,
        { state: "sent", next_attempt_at: Date.now() + this.sentPollMs * 10, last_error: "replacement fee cap reached; waiting for the pending tx" },
        Date.now(),
      );
      log.warn("batcher: not replacing the pending tx: fees would exceed the cap", { batch: batch.id, tx: batch.tx_hash, maxFeePerGas: fees.maxFeePerGas });
      return false;
    }

    const margin = Math.min(DEADLINE_MARGIN_SECONDS, Math.floor(this.deps.config.signatureTtlSeconds / 4));
    let deadline = batch.deadline;
    let signature = batch.service_signature;
    if (
      deadline === null ||
      signature === null ||
      deadline < chainNow + margin ||
      deadline > Number(block.timestamp) + MAX_DEADLINE_WINDOW_SECONDS - 60 ||
      // Made by a key that is no longer the service's (the signer was rotated): the registry refuses it.
      !(await signedByServiceKey(chain, batchAttestationTypedData({ root: batch.root, count: batch.count, schemaVersion: batch.schema_version, deadline: BigInt(deadline) }, chain.domain), signature))
    ) {
      ({ deadline, signature } = await this.resign(batch, chainNow));
    }

    const args = [batch.root, batch.count, batch.schema_version, BigInt(deadline), signature] as const;
    let gas: bigint;
    try {
      gas = await client.estimateContractGas({
        address: chain.registry,
        abi: receiptRegistryAbi,
        functionName: "attestBatch",
        args,
        account: chain.relayer.address,
      });
    } catch (error) {
      const revert = revertOf(error);
      if (revert?.name === "RootAlreadyAttested") {
        await this.adopt(batch, revert.args[1] as bigint);
        return true;
      }
      if (revert?.name === "ExpiredSignature" || revert?.name === "DeadlineTooDistant") {
        await this.resign(batch, Number(block.timestamp));
      }
      if (revert?.name === "InvalidServiceSignature") {
        // Signed by this service's key just now, so the registry's signer is another key: rotated
        // while this process runs. Nothing this key signs will anchor; say so plainly.
        const onchain = await client.readContract({ address: chain.registry, abi: receiptRegistryAbi, functionName: "serviceSigner" }).catch(() => undefined);
        log.error("batcher: the registry refuses this service's signature; restart with the registry's serviceSigner key", { batch: batch.id, registrySigner: onchain, serviceKey: chain.service.address });
      }
      if (revert) throw new Error(`attestBatch would revert with ${revert.name}(${revert.args.map(String).join(", ")})`);
      throw error;
    }

    const nonce = batch.nonce ?? (await client.getTransactionCount({ address: chain.relayer.address, blockTag: "pending" }));
    const raw = await chain.relayer.signTransaction({
      type: "eip1559",
      chainId: chain.chainId,
      nonce,
      to: chain.registry,
      data: encodeFunctionData({ abi: receiptRegistryAbi, functionName: "attestBatch", args }),
      gas: (gas * 13n) / 10n + 20_000n,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      value: 0n,
    });
    const hash = keccak256(raw);
    const hashes = [...(JSON.parse(batch.tx_hashes_json) as Hex[]), hash];
    const now = Date.now();
    // Persisted BEFORE the broadcast: whatever happens next, the hash can be looked up.
    await store.updateBatch(
      batch.id,
      {
        state: "sent",
        nonce,
        raw_tx: raw,
        tx_hash: hash,
        tx_hashes_json: JSON.stringify(hashes),
        max_fee_per_gas: fees.maxFeePerGas.toString(),
        max_priority_fee_per_gas: fees.maxPriorityFeePerGas.toString(),
        sent_at: now,
        sent_block: Number(block.number),
        attempts: 0,
        next_attempt_at: now + this.sentPollMs,
        last_error: null,
      },
      now,
    );
    log.info(previous ? "batcher: replacing attestBatch tx (same nonce, higher fees)" : "batcher: sending attestBatch", {
      batch: batch.id,
      tx: hash,
      nonce,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      maxFeePerGas: fees.maxFeePerGas,
    });

    await faults?.beforeBroadcast?.(batch);
    const { outcome, error } = await broadcast(chain, raw);
    await faults?.afterBroadcast?.(batch);
    if (outcome === "insufficient_funds") throw new Error(`relayer ${chain.relayer.address} cannot pay for gas: ${errorText(error)}`);
    if (outcome !== "accepted" && outcome !== "known") {
      // Ambiguous or refused: the follow-up looks the hash(es) up and decides.
      log.info("batcher: broadcast answer was not a plain accept; will look the tx up", { batch: batch.id, tx: hash, outcome, error: error ? errorText(error) : undefined });
      await store.updateBatch(batch.id, { next_attempt_at: Date.now() }, Date.now());
    }
    return false;
  }

  /** sent → mined, or back to signed when the tx can no longer succeed. */
  private async followUp(batch: BatchRow): Promise<boolean> {
    const { chain, store, log, config } = this.deps;
    const now = Date.now();
    const hashes = (JSON.parse(batch.tx_hashes_json) as Hex[]).slice().reverse();
    for (const hash of hashes) {
      const receipt = await receiptOrNull(chain, hash);
      if (!receipt) continue;
      if (receipt.status === "success") {
        const event = batchAttestedIn(chain, receipt);
        if (!event) throw new Error(`tx ${hash} succeeded but emitted no BatchAttested event`);
        if (event.root.toLowerCase() !== batch.root) throw new Error(`tx ${hash} anchored root ${event.root}, expected ${batch.root}`);
        await this.markMined(batch, { onchainBatchId: Number(event.batchId), blockNumber: Number(receipt.blockNumber), blockHash: receipt.blockHash, txHash: hash });
        return true;
      }
      // History spans multiple nonces. A revert from an earlier nonce must not
      // discard a newer pending retry. Same-nonce replacements still count, even
      // if a superseded hash is the one that mined. Keep old successes recoverable.
      const transaction = await chain.client.getTransaction({ hash });
      if (transaction.nonce !== batch.nonce) continue;

      // The active nonce is spent. Anchored by something else, or try again.
      const anchored = await batchIdOfRoot(chain, batch.root);
      if (anchored !== 0n) {
        await this.adopt(batch, anchored);
        return true;
      }
      log.warn("batcher: attestBatch reverted; re-sending with a fresh nonce", { batch: batch.id, tx: hash });
      await this.resetToSigned(batch, { freshNonce: true, error: `tx ${hash} reverted` });
      return false;
    }

    if (batch.deadline !== null && Math.floor(now / 1000) > batch.deadline) {
      log.info("batcher: attestBatch not mined before its deadline; re-signing and replacing it (same nonce)", { batch: batch.id, tx: batch.tx_hash });
      await this.resetToSigned(batch, { freshNonce: false, error: "deadline passed unmined" });
      return true;
    }
    if (batch.sent_at !== null && now - batch.sent_at >= config.stuckTxMs) {
      // Only a chain that keeps producing blocks without our tx means "stuck"; a stalled
      // chain is waited out, not outbid.
      const latest = await chain.client.getBlockNumber();
      if (batch.sent_block === null || latest > BigInt(batch.sent_block) + 2n) {
        log.info("batcher: attestBatch pending too long while blocks are produced; replacing it with higher fees (same nonce)", {
          batch: batch.id,
          tx: batch.tx_hash,
          sentBlock: batch.sent_block,
          latest,
        });
        await this.resetToSigned(batch, { freshNonce: false, error: "pending too long" });
        return true;
      }
    }

    // Not mined yet. Make sure the node has it: the first broadcast may never have arrived.
    const { outcome, error } = await broadcast(chain, batch.raw_tx!);
    if (outcome === "nonce_too_low") {
      const anchored = await batchIdOfRoot(chain, batch.root);
      if (anchored !== 0n) {
        await this.adopt(batch, anchored);
        return true;
      }
      const attempts = batch.attempts + 1;
      if (attempts >= NONCE_TOO_LOW_TOLERANCE) {
        log.warn("batcher: the relayer nonce was used by a tx this batch does not know; re-sending with a fresh nonce", { batch: batch.id, nonce: batch.nonce });
        await this.resetToSigned(batch, { freshNonce: true, error: "nonce used elsewhere" });
        return false;
      }
      await store.updateBatch(batch.id, { attempts, next_attempt_at: now + this.sentPollMs, last_error: "nonce too low; waiting for the receipt" }, now);
      return false;
    }
    if (outcome === "insufficient_funds") throw new Error(`relayer ${chain.relayer.address} cannot pay for gas: ${errorText(error)}`);
    await store.updateBatch(batch.id, { next_attempt_at: now + this.sentPollMs }, now);
    return false;
  }

  private async resetToSigned(batch: BatchRow, options: { freshNonce: boolean; error: string }): Promise<void> {
    const now = Date.now();
    await this.deps.store.updateBatch(
      batch.id,
      options.freshNonce
        ? { state: "signed", nonce: null, raw_tx: null, max_fee_per_gas: null, max_priority_fee_per_gas: null, attempts: 0, next_attempt_at: now, last_error: options.error }
        : { state: "signed", attempts: 0, next_attempt_at: now, last_error: options.error },
      now,
    );
  }

  /** The root is anchored on chain (by our earlier tx or otherwise): read the anchor back. */
  private async adopt(batch: BatchRow, onchainBatchId: bigint): Promise<void> {
    const { chain, log } = this.deps;
    const onchain = await readBatch(chain, onchainBatchId);
    if (onchain.root.toLowerCase() !== batch.root) {
      throw new Error(`registry batch ${onchainBatchId} has root ${onchain.root}, expected ${batch.root}`);
    }
    if (onchain.count !== batch.count) {
      log.warn("batcher: anchored batch has a different count than recorded", { batch: batch.id, onchainCount: onchain.count, count: batch.count });
    }
    const found = await findAnchorTx(chain, onchainBatchId, onchain.blockNumber);
    if (!found) throw new Error(`BatchAttested(${onchainBatchId}) not found in block ${onchain.blockNumber} yet`);
    log.info("batcher: root already anchored on chain; adopting it", { batch: batch.id, onchainBatchId, tx: found.txHash });
    await this.markMined(batch, { onchainBatchId: Number(onchainBatchId), blockNumber: Number(onchain.blockNumber), ...found });
  }

  private async markMined(batch: BatchRow, anchor: Anchoring): Promise<void> {
    const now = Date.now();
    const status: StatusInfo = {
      stage: "hemi-included",
      estimated: false,
      checkedAt: Math.floor(now / 1000),
      notes: ["anchoring transaction mined; confirmations are checked by the status poller"],
    };
    await this.deps.store.markBatchMined(batch.id, anchor, status, now);
    this.deps.log.info("batcher: batch anchored", { batch: batch.id, onchainBatchId: anchor.onchainBatchId, block: anchor.blockNumber, tx: anchor.txHash, count: batch.count });
  }
}
