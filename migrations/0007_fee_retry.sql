-- Refund and sweep retries. All additions: old rows keep their values.

-- When a row was given up on (state 'skip'). A skipped row is revived by the time since it was given up, not by the time since
-- anything last touched it: a busy account is touched every few seconds, so "an hour of silence" never came.
-- Rows given up before this column existed read NULL, which counts as long ago: the next touch revives them.
ALTER TABLE fee_accounts ADD COLUMN skipped_at INTEGER;

-- 1 = its refund batch failed whole: try this account alone in its own transaction (one closed destination fails the others).
ALTER TABLE fee_accounts ADD COLUMN solo INTEGER NOT NULL DEFAULT 0;
