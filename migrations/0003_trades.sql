-- Every buy and sell through the pool, from the mint's history: powers the price chart and total volume.
CREATE TABLE trades (
  sig TEXT PRIMARY KEY,
  at INTEGER NOT NULL,            -- ms
  side TEXT NOT NULL,             -- 'buy' | 'sell'
  wallet TEXT NOT NULL,
  sol_lamports INTEGER NOT NULL,  -- SOL into the pool (buy) or out of it before the fee (sell)
  price_sol REAL NOT NULL,        -- SOL per whole $PAPER, after the trade
  sol_usd REAL NOT NULL           -- SOL price when recorded
);
CREATE INDEX trades_at ON trades (at);
