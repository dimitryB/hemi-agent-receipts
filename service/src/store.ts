import type { Hex } from "viem";
import type { ReceiptStage, StatusInfo } from "@hemi-receipts/sdk";
import type { D1Database, D1PreparedStatement, D1Value } from "./db.js";

/** Persistence for receipts and batches. All SQL lives here; it runs on D1 or node:sqlite. */
export type ReceiptMode = "batch" | "direct";
/**
 * How long a settlement that may have moved the money blocks a second charge for the same
 * receipt: one answered `settlement_pending`, or one whose answer never arrived.
 */
export const SETTLEMENT_HOLD_MS = 30 * 60_000;

export type ReceiptState = "unpaid" | "queued" | "batched" | "direct_signed" | "direct_expired" | "anchored";
export type BatchState = "signed" | "sent" | "mined";

export interface ReceiptRow {
  run_id: Hex;
  leaf: Hex;
  manifest_hash: Hex;
  agent: Hex;
  principal: Hex;
  schema_version: number;
  agent_signature: Hex;
  mode: ReceiptMode;
  state: ReceiptState;
  stage: ReceiptStage;
  status_json: string | null;
  batch_local_id: number | null;
  proof_json: string | null;
  manifest_json: string | null;
  payment_json: string | null;
  /** unpaid rows: until when the request that stored it holds the settlement lease (unix ms). */
  settle_lease_until: number | null;
  direct_service_signature: Hex | null;
  direct_deadline: number | null;
  created_at: number;
  queued_at: number | null;
  updated_at: number;
}

export interface BatchRow {
  id: number;
  mode: ReceiptMode;
  root: Hex;
  count: number;
  schema_version: number;
  state: BatchState;
  deadline: number | null;
  service_signature: Hex | null;
  nonce: number | null;
  raw_tx: Hex | null;
  tx_hash: Hex | null;
  tx_hashes_json: string;
  max_fee_per_gas: string | null;
  max_priority_fee_per_gas: string | null;
  sent_at: number | null;
  sent_block: number | null;
  onchain_batch_id: number | null;
  block_number: number | null;
  block_hash: Hex | null;
  mined_at: number | null;
  stage: ReceiptStage;
  status_json: string | null;
  next_check_at: number | null;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface NewReceipt {
  runId: Hex;
  leaf: Hex;
  manifestHash: Hex;
  agent: Hex;
  principal: Hex;
  schemaVersion: number;
  agentSignature: Hex;
  mode: ReceiptMode;
  state: "unpaid" | "queued" | "direct_signed";
  manifestJson: string | null;
  directServiceSignature: Hex | null;
  directDeadline: number | null;
  /** For an unpaid row: the settlement lease held by the submitting request (unix ms); null when paid or free. */
  settleLeaseUntil: number | null;
}

export interface Anchoring {
  onchainBatchId: number;
  blockNumber: number;
  blockHash: Hex | null;
  txHash: Hex;
}

/** Columns the batcher may patch. */
const BATCH_PATCHABLE = new Set([
  "state",
  "deadline",
  "service_signature",
  "nonce",
  "raw_tx",
  "tx_hash",
  "tx_hashes_json",
  "max_fee_per_gas",
  "max_priority_fee_per_gas",
  "sent_at",
  "sent_block",
  "attempts",
  "next_attempt_at",
  "last_error",
]);
export type BatchPatch = Partial<Pick<BatchRow, "state" | "deadline" | "service_signature" | "nonce" | "raw_tx" | "tx_hash" | "tx_hashes_json" | "max_fee_per_gas" | "max_priority_fee_per_gas" | "sent_at" | "sent_block" | "attempts" | "next_attempt_at" | "last_error">>;

const RECEIPT_COLUMNS = `run_id, leaf, manifest_hash, agent, principal, schema_version, agent_signature, mode, state, stage,
  status_json, batch_local_id, proof_json, manifest_json, payment_json, settle_lease_until, direct_service_signature, direct_deadline,
  created_at, queued_at, updated_at`;

export class Store {
  constructor(readonly db: D1Database) {}

  /* --------------------------------- receipts --------------------------------- */

  getReceipt(runId: Hex): Promise<ReceiptRow | null> {
    return this.db.prepare(`SELECT ${RECEIPT_COLUMNS} FROM receipts WHERE run_id = ?`).bind(runId).first<ReceiptRow>();
  }

  /**
   * Inserts the receipt unless the run id already exists, then returns whatever row is stored
   * for it. The INSERT is the serialization point: of two concurrent requests for one run id,
   * exactly one row wins and both see it.
   */
  async insertReceipt(input: NewReceipt, now: number): Promise<{ inserted: boolean; row: ReceiptRow }> {
    const result = await this.db
      .prepare(
        `INSERT INTO receipts (run_id, leaf, manifest_hash, agent, principal, schema_version, agent_signature, mode, state,
           manifest_json, settle_lease_until, direct_service_signature, direct_deadline, created_at, queued_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id) DO NOTHING`,
      )
      .bind(
        input.runId,
        input.leaf,
        input.manifestHash,
        input.agent,
        input.principal,
        input.schemaVersion,
        input.agentSignature,
        input.mode,
        input.state,
        input.manifestJson,
        input.state === "unpaid" ? input.settleLeaseUntil : null,
        input.directServiceSignature,
        input.directDeadline,
        now,
        input.state === "unpaid" ? null : now,
        now,
      )
      .run();
    const row = await this.getReceipt(input.runId);
    if (!row) throw new Error(`receipt ${input.runId} vanished after insert`);
    return { inserted: result.meta.changes === 1, row };
  }

  /**
   * Rewrites an unpaid row (nobody paid for it, so it does not own the run id): the same leaf
   * re-submitted (possibly switching mode), or another leaf after its payment was refused.
   * Refused while the row's settlement lease is held: a payment for it may be settling, or may
   * already have moved (app.ts, payments.ts).
   *
   * The stored manifest survives only when the leaf stays the same. A different leaf means a
   * different manifest hash, and the old manifest would make the exported file fail its own
   * manifest check.
   */
  async rewriteUnpaid(expected: { runId: Hex; leaf: Hex }, input: NewReceipt, now: number): Promise<boolean> {
    const sameLeaf = expected.leaf === input.leaf;
    const result = await this.db
      .prepare(
        `UPDATE receipts SET leaf = ?, manifest_hash = ?, agent = ?, principal = ?, schema_version = ?, agent_signature = ?,
           mode = ?, manifest_json = CASE WHEN ? THEN COALESCE(?, manifest_json) ELSE ? END,
           direct_service_signature = ?, direct_deadline = ?, payment_json = NULL, settle_lease_until = ?,
           created_at = ?, updated_at = ?
         WHERE run_id = ? AND state = 'unpaid' AND leaf = ?
           AND (settle_lease_until IS NULL OR settle_lease_until <= ?)`,
      )
      .bind(
        input.leaf,
        input.manifestHash,
        input.agent,
        input.principal,
        input.schemaVersion,
        input.agentSignature,
        input.mode,
        sameLeaf ? 1 : 0,
        input.manifestJson,
        input.manifestJson,
        input.directServiceSignature,
        input.directDeadline,
        input.settleLeaseUntil,
        now,
        now,
        expected.runId,
        expected.leaf,
        now,
      )
      .run();
    return result.meta.changes === 1;
  }

  /** Nothing moved, and no settlement is running: lets a retry with a valid payment rewrite the row at once. */
  async releaseSettleLease(runId: Hex, leaf: Hex, now: number): Promise<void> {
    await this.db
      .prepare(`UPDATE receipts SET settle_lease_until = NULL, payment_json = NULL, updated_at = ? WHERE run_id = ? AND leaf = ? AND state = 'unpaid'`)
      .bind(now, runId, leaf)
      .run();
  }

  /**
   * Unpaid rows with a lease and no outcome recorded, however old (see holdInterruptedSettlements).
   * `payment_json` is NULL when the request ended before it began to settle.
   */
  async interruptedSettlements(): Promise<ReceiptRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${RECEIPT_COLUMNS} FROM receipts WHERE state = 'unpaid' AND settle_lease_until IS NOT NULL
           AND (payment_json IS NULL OR json_extract(payment_json, '$.status') = 'settling')`,
      )
      .all<ReceiptRow>();
    return results;
  }

  /**
   * Claims a signed payment authorization for a run id. The first run id to claim it owns it for
   * good; the answer is the owner, which is `runId` unless another run id claimed it first.
   * Atomic: two requests racing with one authorization get the same owner.
   */
  async claimPayment(paymentKey: string, runId: Hex, now: number): Promise<Hex> {
    await this.db.prepare(`INSERT OR IGNORE INTO payment_claims (payment_key, run_id, claimed_at) VALUES (?, ?, ?)`).bind(paymentKey, runId, now).run();
    const row = await this.db.prepare(`SELECT run_id FROM payment_claims WHERE payment_key = ?`).bind(paymentKey).first<{ run_id: Hex }>();
    if (!row) throw new Error(`payment claim ${paymentKey} vanished after it was written`);
    return row.run_id;
  }

  /** unpaid → queued (batch) or direct_signed (direct), once the payment has settled. */
  async markPaid(runId: Hex, leaf: Hex, payment: unknown, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE receipts SET state = CASE mode WHEN 'batch' THEN 'queued' ELSE 'direct_signed' END,
           queued_at = ?, payment_json = ?, settle_lease_until = NULL, updated_at = ?
         WHERE run_id = ? AND leaf = ? AND state = 'unpaid'`,
      )
      .bind(now, JSON.stringify(payment), now, runId, leaf)
      .run();
    return result.meta.changes === 1;
  }

  /**
   * Records payment details on a row that is still unpaid. `holdUntil` replaces the settlement
   * lease: a payment that may have moved money keeps the row from being rewritten until then.
   */
  async notePayment(runId: Hex, leaf: Hex, payment: unknown, now: number, holdUntil: number | null = null): Promise<void> {
    await this.db
      .prepare(`UPDATE receipts SET payment_json = ?, settle_lease_until = ?, updated_at = ? WHERE run_id = ? AND leaf = ? AND state = 'unpaid'`)
      .bind(JSON.stringify(payment), holdUntil, now, runId, leaf)
      .run();
  }

  /**
   * Replaces the record of a payment that has been decided, and ends its hold. Refused if the
   * record is no longer `expected`: that answer took a while, and a retry may own the row by now.
   */
  async endHold(runId: Hex, leaf: Hex, expected: string, payment: unknown, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(`UPDATE receipts SET payment_json = ?, settle_lease_until = NULL, updated_at = ? WHERE run_id = ? AND leaf = ? AND state = 'unpaid' AND payment_json = ?`)
      .bind(JSON.stringify(payment), now, runId, leaf, expected)
      .run();
    return result.meta.changes === 1;
  }

  async attachManifest(runId: Hex, manifestJson: string, now: number): Promise<void> {
    await this.db
      .prepare(`UPDATE receipts SET manifest_json = ?, updated_at = ? WHERE run_id = ? AND manifest_json IS NULL`)
      .bind(manifestJson, now, runId)
      .run();
  }

  /** Re-issues the direct-path service signature (free) when the previous one expired. */
  async setDirectSignature(runId: Hex, signature: Hex, deadline: number, now: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE receipts SET direct_service_signature = ?, direct_deadline = ?,
           state = CASE state WHEN 'direct_expired' THEN 'direct_signed' ELSE state END, updated_at = ?
         WHERE run_id = ? AND mode = 'direct'`,
      )
      .bind(signature, deadline, now, runId)
      .run();
  }

  /** The schema version whose oldest queued receipt is oldest, with its queue size. */
  queueHead(): Promise<{ schema_version: number; oldest: number; n: number } | null> {
    return this.db
      .prepare(
        `SELECT schema_version, MIN(queued_at) AS oldest, COUNT(*) AS n FROM receipts
         WHERE state = 'queued' GROUP BY schema_version ORDER BY oldest LIMIT 1`,
      )
      .first();
  }

  async queuedReceipts(schemaVersion: number, limit: number): Promise<ReceiptRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${RECEIPT_COLUMNS} FROM receipts WHERE state = 'queued' AND schema_version = ?
         ORDER BY queued_at, run_id LIMIT ?`,
      )
      .bind(schemaVersion, limit)
      .all<ReceiptRow>();
    return results;
  }

  /**
   * Closes a batch: the batch row (already signed) and every receipt's assignment and proof,
   * in one transaction.
   */
  async createBatch(
    input: { root: Hex; count: number; schemaVersion: number; deadline: number; serviceSignature: Hex; proofs: { runId: Hex; proof: Hex[] }[] },
    now: number,
  ): Promise<BatchRow> {
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO batches (mode, root, count, schema_version, state, deadline, service_signature, created_at, updated_at)
           VALUES ('batch', ?, ?, ?, 'signed', ?, ?, ?, ?)`,
        )
        .bind(input.root, input.count, input.schemaVersion, input.deadline, input.serviceSignature, now, now),
    ];
    for (const { runId, proof } of input.proofs) {
      statements.push(
        this.db
          .prepare(
            `UPDATE receipts SET state = 'batched', batch_local_id = (SELECT id FROM batches WHERE root = ?),
               proof_json = ?, updated_at = ?
             WHERE run_id = ? AND state = 'queued'`,
          )
          .bind(input.root, JSON.stringify(proof), now, runId),
      );
    }
    const results = await this.db.batch(statements);
    const assigned = results.slice(1).reduce((sum, r) => sum + r.meta.changes, 0);
    if (assigned !== input.count) throw new Error(`batch ${input.root}: assigned ${assigned} receipts, expected ${input.count}`);
    const batch = await this.getBatchByRoot(input.root);
    if (!batch) throw new Error(`batch ${input.root} vanished after insert`);
    return batch;
  }

  /* ---------------------------------- batches --------------------------------- */

  getBatch(id: number): Promise<BatchRow | null> {
    return this.db.prepare(`SELECT * FROM batches WHERE id = ?`).bind(id).first<BatchRow>();
  }

  getBatchByRoot(root: Hex): Promise<BatchRow | null> {
    return this.db.prepare(`SELECT * FROM batches WHERE root = ?`).bind(root).first<BatchRow>();
  }

  /** The oldest batch the batcher has not finished. At most one tx is in flight at a time. */
  activeBatch(): Promise<BatchRow | null> {
    return this.db
      .prepare(`SELECT * FROM batches WHERE mode = 'batch' AND state IN ('signed', 'sent') ORDER BY id LIMIT 1`)
      .first<BatchRow>();
  }

  async updateBatch(id: number, patch: BatchPatch, now: number): Promise<void> {
    const keys = Object.keys(patch).filter((key) => BATCH_PATCHABLE.has(key));
    if (keys.length === 0) return;
    const values = keys.map((key) => (patch as Record<string, D1Value>)[key] ?? null);
    await this.db
      .prepare(`UPDATE batches SET ${keys.map((key) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .bind(...values, now, id)
      .run();
  }

  /** signed|sent → mined, and every receipt of the batch → anchored, in one transaction. */
  async markBatchMined(id: number, anchor: Anchoring, status: StatusInfo, now: number): Promise<void> {
    const statusJson = JSON.stringify(status);
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE batches SET state = 'mined', onchain_batch_id = ?, block_number = ?, block_hash = ?, tx_hash = ?, mined_at = ?,
             stage = ?, status_json = ?, next_check_at = ?, last_error = NULL, updated_at = ?
           WHERE id = ? AND state != 'mined'`,
        )
        .bind(anchor.onchainBatchId, anchor.blockNumber, anchor.blockHash, anchor.txHash, now, status.stage, statusJson, now, now, id),
      this.db
        .prepare(`UPDATE receipts SET state = 'anchored', stage = ?, status_json = ?, updated_at = ? WHERE batch_local_id = ?`)
        .bind(status.stage, statusJson, now, id),
    ]);
  }

  /** Mined batches whose status may still move, oldest check first. */
  async dueBatches(now: number, limit: number): Promise<BatchRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM batches WHERE state = 'mined' AND next_check_at IS NOT NULL AND next_check_at <= ?
         ORDER BY next_check_at, id LIMIT ?`,
      )
      .bind(now, limit)
      .all<BatchRow>();
    return results;
  }

  async setBatchStatus(id: number, status: StatusInfo, nextCheckAt: number | null, now: number): Promise<void> {
    const statusJson = JSON.stringify(status);
    await this.db.batch([
      this.db
        .prepare(`UPDATE batches SET stage = ?, status_json = ?, next_check_at = ?, updated_at = ? WHERE id = ?`)
        .bind(status.stage, statusJson, nextCheckAt, now, id),
      this.db
        .prepare(`UPDATE receipts SET stage = ?, status_json = ?, updated_at = ? WHERE batch_local_id = ?`)
        .bind(status.stage, statusJson, now, id),
    ]);
  }

  /**
   * The anchoring block is no longer canonical (reorg). A batch-path batch goes back to the
   * batcher (sent, to look its tx hashes up again; signed if it has no raw tx); its receipts
   * go back to batched/pending. Withdrawing a Bitcoin publication only changes status.
   */
  async reopenBatch(batch: BatchRow, now: number): Promise<void> {
    if (batch.mode === "direct") {
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE receipts SET state = 'direct_signed', batch_local_id = NULL, proof_json = NULL, stage = 'pending',
               status_json = NULL, updated_at = ? WHERE batch_local_id = ?`,
          )
          .bind(now, batch.id),
        this.db.prepare(`DELETE FROM batches WHERE id = ? AND mode = 'direct'`).bind(batch.id),
      ]);
      return;
    }
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE batches SET state = ?, onchain_batch_id = NULL, block_number = NULL, block_hash = NULL, mined_at = NULL,
             stage = 'pending', status_json = NULL, next_check_at = NULL, attempts = 0, next_attempt_at = ?,
             last_error = 'anchoring block reorged out', updated_at = ?
           WHERE id = ? AND state = 'mined'`,
        )
        .bind(batch.raw_tx ? "sent" : "signed", now, now, batch.id),
      this.db
        .prepare(`UPDATE receipts SET state = 'batched', stage = 'pending', status_json = NULL, updated_at = ? WHERE batch_local_id = ?`)
        .bind(now, batch.id),
    ]);
  }

  async rescheduleBatch(id: number, nextCheckAt: number, now: number): Promise<void> {
    await this.db.prepare(`UPDATE batches SET next_check_at = ?, updated_at = ? WHERE id = ?`).bind(nextCheckAt, now, id).run();
  }

  async runIdsOfBatch(id: number): Promise<Hex[]> {
    const { results } = await this.db
      .prepare(`SELECT run_id FROM receipts WHERE batch_local_id = ? ORDER BY run_id`)
      .bind(id)
      .all<{ run_id: Hex }>();
    return results.map((row) => row.run_id);
  }

  lastMinedBatch(): Promise<BatchRow | null> {
    return this.db.prepare(`SELECT * FROM batches WHERE state = 'mined' ORDER BY mined_at DESC, id DESC LIMIT 1`).first<BatchRow>();
  }

  /* -------------------------------- direct path ------------------------------- */

  async directAwaitingTx(limit: number): Promise<ReceiptRow[]> {
    const { results } = await this.db
      .prepare(`SELECT ${RECEIPT_COLUMNS} FROM receipts WHERE state = 'direct_signed' ORDER BY updated_at, run_id LIMIT ?`)
      .bind(limit)
      .all<ReceiptRow>();
    return results;
  }

  /** Marks a row as just checked, so bounded per-tick scans rotate through all rows. */
  async touchReceipt(runId: Hex, now: number): Promise<void> {
    await this.db.prepare(`UPDATE receipts SET updated_at = ? WHERE run_id = ?`).bind(now, runId).run();
  }

  async markDirectExpired(runId: Hex, now: number): Promise<void> {
    await this.db
      .prepare(`UPDATE receipts SET state = 'direct_expired', updated_at = ? WHERE run_id = ? AND state = 'direct_signed'`)
      .bind(now, runId)
      .run();
  }

  /** The caller's own `attest` tx was found on chain: record it as a mined batch of one. */
  async anchorDirect(receipt: ReceiptRow, anchor: Anchoring, status: StatusInfo, now: number): Promise<void> {
    const statusJson = JSON.stringify(status);
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO batches (mode, root, count, schema_version, state, tx_hash, tx_hashes_json, onchain_batch_id,
             block_number, block_hash, mined_at, stage, status_json, next_check_at, created_at, updated_at)
           VALUES ('direct', ?, 1, ?, 'mined', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (root) DO NOTHING`,
        )
        .bind(
          receipt.leaf,
          receipt.schema_version,
          anchor.txHash,
          JSON.stringify([anchor.txHash]),
          anchor.onchainBatchId,
          anchor.blockNumber,
          anchor.blockHash,
          now,
          status.stage,
          statusJson,
          now,
          now,
          now,
        ),
      this.db
        .prepare(
          `UPDATE receipts SET state = 'anchored', batch_local_id = (SELECT id FROM batches WHERE root = ?),
             proof_json = '[]', stage = ?, status_json = ?, updated_at = ?
           WHERE run_id = ? AND state IN ('direct_signed', 'direct_expired')`,
        )
        .bind(receipt.leaf, status.stage, statusJson, now, receipt.run_id),
    ]);
  }

  /* ---------------------------------- payments -------------------------------- */

  /** Unpaid rows whose settlement went `settlement_pending`: the poller reconciles them. */
  async pendingSettlements(limit: number): Promise<ReceiptRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${RECEIPT_COLUMNS} FROM receipts WHERE state = 'unpaid' AND json_extract(payment_json, '$.status') = 'settlement_pending'
         ORDER BY updated_at LIMIT ?`,
      )
      .bind(limit)
      .all<ReceiptRow>();
    return results;
  }

  /* ----------------------------------- misc ----------------------------------- */

  async counts(): Promise<Record<ReceiptState, number>> {
    const { results } = await this.db
      .prepare(`SELECT state, COUNT(*) AS n FROM receipts GROUP BY state`)
      .all<{ state: ReceiptState; n: number }>();
    const counts: Record<ReceiptState, number> = { unpaid: 0, queued: 0, batched: 0, direct_signed: 0, direct_expired: 0, anchored: 0 };
    for (const row of results) counts[row.state] = Number(row.n);
    return counts;
  }

  getState(key: string): Promise<string | null> {
    return this.db.prepare(`SELECT value FROM service_state WHERE key = ?`).bind(key).first<string>("value");
  }

  async setState(key: string, value: string, now: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO service_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(key, value, now)
      .run();
  }
}
