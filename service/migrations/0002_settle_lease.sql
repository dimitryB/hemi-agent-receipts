-- A request that stores an `unpaid` receipt holds a lease on the row while its x402
-- payment settles (SETTLEMENT_HOLD_MS; the settle hooks end it sooner). While the lease is
-- held, a second request for the same run id and leaf is answered 409 payment_pending
-- instead of being allowed to settle a second payment for the same receipt.
-- Unix milliseconds; NULL when no settlement is in flight.
ALTER TABLE receipts ADD COLUMN settle_lease_until INTEGER;
