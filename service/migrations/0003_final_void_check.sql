-- btc-final batches used to drop out of the poller for good (next_check_at NULL), so a void after
-- btc-final never reached the API. The poller now re-reads them every POLL_FINAL_CHECK_SECONDS;
-- this schedules the ones already final for a first check right away.
UPDATE batches
SET next_check_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE state = 'mined' AND stage = 'btc-final' AND next_check_at IS NULL;
