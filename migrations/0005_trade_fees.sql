-- Join (buy) fee and sell tax paid to the payout wallet in each trade, in lamports. Buy fees are kept apart from
-- sells so the site never counts them as paid by those who left. Rows from before this migration read 0.
ALTER TABLE trades ADD COLUMN fee_lamports INTEGER NOT NULL DEFAULT 0;
