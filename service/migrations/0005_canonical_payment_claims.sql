-- Permit2 reads its nonce as a number, so "042" and "42" are one authorization; claims written
-- before nonces were normalized keep the string as sent (payments.ts canonicalNonce). Each
-- permit2 key whose nonce is decimal is rewritten without leading zeros. Where two claims
-- become one key, the claim written first keeps it. A key SQL cannot normalize (a nonce in
-- hex) is left as it is: the service looks claims up by the canonical key, so it is never
-- matched, and the first run id to claim the canonical key owns the authorization.
-- Key layout: 'permit2:' (8) + asset (42) + ':' + payer (42) + ':' + nonce, from position 95.
CREATE TABLE payment_claims_canonical (
  payment_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO payment_claims_canonical (payment_key, run_id, claimed_at)
SELECT CASE
         WHEN substr(payment_key, 1, 8) = 'permit2:' AND substr(payment_key, 51, 1) = ':' AND substr(payment_key, 94, 1) = ':'
              AND length(payment_key) > 94 AND substr(payment_key, 95) NOT GLOB '*[^0-9]*'
         THEN substr(payment_key, 1, 94) || coalesce(nullif(ltrim(substr(payment_key, 95), '0'), ''), '0')
         ELSE lower(payment_key)
       END,
       run_id, claimed_at
FROM payment_claims
ORDER BY claimed_at, rowid;

DROP TABLE payment_claims;
ALTER TABLE payment_claims_canonical RENAME TO payment_claims;
CREATE INDEX idx_payment_claims_run ON payment_claims (run_id);
