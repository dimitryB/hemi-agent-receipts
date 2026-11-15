-- hemi-agent-receipts service schema, v1.
-- Only SQL that Cloudflare D1 accepts: no PRAGMAs, no extensions, no explicit transactions.
-- Timestamps are unix milliseconds unless the column name says otherwise. Hex values are
-- lowercase 0x strings. JSON columns hold the objects described in service/README.md.

-- One row per anchoring attempt of a Merkle root. Direct attestations get a row too
-- (mode 'direct', a batch of one whose root is the leaf), so the status poller treats
-- both paths the same way.
--
-- state (batcher state machine, persisted BEFORE every side effect):
--   signed  root, count and the service's BatchAttestation signature are stored; no tx yet,
--           or the last tx is known to be unusable (reverted, nonce taken, deadline passed)
--   sent    a signed raw tx and its hash are stored; it may or may not have been broadcast
--   mined   the root is anchored on chain; onchain_batch_id, block_number and block_hash
--           are known. A reorg that drops the anchoring block sends it back to sent/signed.
CREATE TABLE batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL CHECK (mode IN ('batch', 'direct')),
  root TEXT NOT NULL UNIQUE,
  count INTEGER NOT NULL CHECK (count >= 1),
  schema_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('signed', 'sent', 'mined')),
  -- BatchAttestation envelope (unix SECONDS, as signed)
  deadline INTEGER,
  service_signature TEXT,
  -- relayer transaction; tx_hashes_json lists every hash ever signed for this batch
  nonce INTEGER,
  raw_tx TEXT,
  tx_hash TEXT,
  tx_hashes_json TEXT NOT NULL DEFAULT '[]',
  max_fee_per_gas TEXT,
  max_priority_fee_per_gas TEXT,
  sent_at INTEGER,
  -- latest block when the tx was signed; "stuck" means blocks kept coming without it
  sent_block INTEGER,
  -- anchor
  onchain_batch_id INTEGER,
  block_number INTEGER,
  -- hash of the anchoring block; the poller passes it to resolveStatus to detect a reorg
  block_hash TEXT,
  mined_at INTEGER,
  -- status ladder (docs/SCHEMA.md section 7); status_json is the SDK's StatusInfo
  stage TEXT NOT NULL DEFAULT 'pending'
    CHECK (stage IN ('pending', 'hemi-included', 'hemi-confirmed', 'btc-published', 'btc-final', 'voided')),
  status_json TEXT,
  next_check_at INTEGER,
  -- batcher bookkeeping
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_batches_state ON batches (state, id);
CREATE INDEX idx_batches_next_check ON batches (next_check_at);

-- One row per run id: the idempotency key.
--
-- state:
--   unpaid          validated and signed by the agent, waiting for the x402 payment to settle;
--                   never batched, never returned by GET /receipts
--   queued          batch path, paid (or DEV_FREE); waiting for the batcher
--   batched         assigned to a batch (batch_local_id) with its Merkle proof; not mined yet
--   direct_signed   direct path, paid; service signature issued; waiting for the caller's tx
--   direct_expired  direct path; the service signature expired before the tx was seen
--   anchored        the anchor is known (batch mined, or the direct tx detected)
CREATE TABLE receipts (
  run_id TEXT PRIMARY KEY NOT NULL,
  leaf TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  agent TEXT NOT NULL,
  principal TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  agent_signature TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('batch', 'direct')),
  state TEXT NOT NULL
    CHECK (state IN ('unpaid', 'queued', 'batched', 'direct_signed', 'direct_expired', 'anchored')),
  stage TEXT NOT NULL DEFAULT 'pending'
    CHECK (stage IN ('pending', 'hemi-included', 'hemi-confirmed', 'btc-published', 'btc-final', 'voided')),
  status_json TEXT,
  batch_local_id INTEGER REFERENCES batches (id),
  proof_json TEXT,
  -- the canonical manifest, only when the submitter asked for it to be stored
  manifest_json TEXT,
  -- x402 settlement details (payer, tx, network, amount) or a settlement_pending record
  payment_json TEXT,
  -- direct path: ServiceAttestation signature and its deadline (unix SECONDS)
  direct_service_signature TEXT,
  direct_deadline INTEGER,
  created_at INTEGER NOT NULL,
  queued_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_receipts_queue ON receipts (state, schema_version, queued_at);
CREATE INDEX idx_receipts_batch ON receipts (batch_local_id);

-- Small key/value facts about this database, e.g. which chain and registry it belongs to.
CREATE TABLE service_state (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
