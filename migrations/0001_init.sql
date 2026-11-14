-- $PAPER indexer.

-- One row per sell into the pool, from the Helius webhook. drop_n is set when an airdrop claims it.
CREATE TABLE sells (
  sig TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  tokens REAL NOT NULL,          -- $PAPER sold (whole tokens)
  sol_out INTEGER NOT NULL,      -- lamports the seller received
  fee_lamports INTEGER NOT NULL, -- lamports that went to the payout wallet (the 15%)
  sol_usd REAL NOT NULL,         -- SOL price when it happened
  at INTEGER NOT NULL,           -- ms
  drop_n INTEGER
);
CREATE INDEX sells_at ON sells (at DESC);
CREATE INDEX sells_drop ON sells (drop_n);

-- Wall of Paper Hands. paid_usdc is the USD value of the fees they paid, at the time.
CREATE TABLE sellers (
  wallet TEXT PRIMARY KEY,
  sells INTEGER NOT NULL DEFAULT 0,
  paid_usdc REAL NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL
);
CREATE INDEX sellers_paid ON sellers (paid_usdc DESC);

-- Current holders as of the last snapshot. `since` = first snapshot they were seen holding.
CREATE TABLE holders (
  wallet TEXT PRIMARY KEY,
  balance TEXT NOT NULL,         -- raw units
  since INTEGER NOT NULL,
  seen INTEGER NOT NULL          -- drop number of the last snapshot that saw them
);

-- One row per airdrop. status: snapshot -> swap -> allocate -> paying -> done (or skipped).
CREATE TABLE drops (
  n INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,           -- the period boundary it covers sells up to
  status TEXT NOT NULL,
  fee_lamports INTEGER NOT NULL DEFAULT 0,
  rent_lamports INTEGER NOT NULL DEFAULT 0,
  swap_lamports INTEGER,
  swap_sig TEXT,
  swap_lvbh INTEGER,
  usdc_micro INTEGER,            -- total paid out
  holders INTEGER,               -- wallets paid
  weight_total REAL,             -- eligible streak-weighted supply (whole tokens)
  price_usd REAL,
  error TEXT,
  updated INTEGER NOT NULL
);

-- Each eligible holder's weight in a drop, then their USDC amount and which batch pays it.
CREATE TABLE payouts (
  drop_n INTEGER NOT NULL,
  wallet TEXT NOT NULL,
  weight REAL NOT NULL,
  needs_ata INTEGER NOT NULL DEFAULT 0,
  micro INTEGER,
  batch INTEGER,
  PRIMARY KEY (drop_n, wallet)
);
CREATE INDEX payouts_wallet ON payouts (wallet);

-- One transaction each. status: pending -> sent -> confirmed (or failed after too many tries).
CREATE TABLE batches (
  drop_n INTEGER NOT NULL,
  i INTEGER NOT NULL,
  sig TEXT,
  lvbh INTEGER,
  status TEXT NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (drop_n, i)
);

-- Prices, mint info and the tick lock.
CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, at INTEGER NOT NULL);
