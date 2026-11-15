-- One x402 authorization pays for one receipt. The first run id that begins to settle a signed
-- authorization claims it for good (settling it writes the claim before the facilitator is
-- asked), and the service refuses to settle it for any other run id. Recovery that credits a
-- held payment from the chain (by its nonce, or by its transaction) checks the claim too, so one
-- transfer can never be credited to two receipts.
-- payment_key: transferMethod:asset:payer:nonce, lowercase (payments.ts paymentKey).
CREATE TABLE payment_claims (
  payment_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL
);
CREATE INDEX idx_payment_claims_run ON payment_claims (run_id);

-- Payments already on record claim their authorization for their own row; where two rows share
-- one, the row created first keeps it.
INSERT OR IGNORE INTO payment_claims (payment_key, run_id, claimed_at)
SELECT lower(json_extract(payment_json, '$.transferMethod') || ':' || json_extract(payment_json, '$.asset') || ':' ||
             json_extract(payment_json, '$.payer') || ':' || json_extract(payment_json, '$.nonce')),
       run_id, updated_at
FROM receipts
WHERE payment_json IS NOT NULL
  AND json_extract(payment_json, '$.transferMethod') IS NOT NULL
  AND json_extract(payment_json, '$.asset') IS NOT NULL
  AND json_extract(payment_json, '$.payer') IS NOT NULL
  AND json_extract(payment_json, '$.nonce') IS NOT NULL
ORDER BY created_at, run_id;
