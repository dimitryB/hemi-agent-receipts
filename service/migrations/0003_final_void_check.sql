-- The poller re-reads btc-final batches every POLL_FINAL_CHECK_SECONDS, so a void after btc-final
-- reaches the API. This schedules a first check right away for every btc-final batch that has
-- none (next_check_at NULL).
UPDATE batches
SET next_check_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE state = 'mined' AND stage = 'btc-final' AND next_check_at IS NULL;
