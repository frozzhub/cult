-- Every buy's 10% fee, paid back to the buyer in SOL within seconds (Meteora launch).
-- One row per (buy transaction, buyer). Saved before anything is sent, so a refund is never paid twice:
-- it's only re-sent once its old transaction failed or its blockhash expired.
CREATE TABLE refunds (
  sig TEXT NOT NULL,              -- the buy
  wallet TEXT NOT NULL,           -- who got the $CULT
  lamports INTEGER NOT NULL,      -- the 10% they paid
  at INTEGER NOT NULL,            -- when they bought (ms)
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | confirmed | failed
  tx TEXT,                        -- our refund transaction
  lvbh INTEGER,
  tries INTEGER NOT NULL DEFAULT 0,
  paid_at INTEGER,
  PRIMARY KEY (sig, wallet)
);
CREATE INDEX refunds_status ON refunds (status);
CREATE INDEX refunds_at ON refunds (at DESC);
