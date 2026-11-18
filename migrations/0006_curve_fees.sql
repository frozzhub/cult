-- Meteora curve design (docs/ROUTE-CURVE.md): the sell tax is withheld CULT, not SOL, and refunds/sweeps move it.
-- All additions: rows from before keep their values (there is no mainnet data from the old pool).

-- A sell's tax in raw CULT, and its USD value when it was recorded (gross sold, and the withheld part).
ALTER TABLE sells ADD COLUMN fee_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sells ADD COLUMN usd REAL NOT NULL DEFAULT 0;
ALTER TABLE sells ADD COLUMN fee_usd REAL NOT NULL DEFAULT 0;

-- Buys and sells through any pool: gross raw tokens, the part withheld, USD value and the price used.
ALTER TABLE trades ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trades ADD COLUMN withheld INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trades ADD COLUMN usd REAL NOT NULL DEFAULT 0;
ALTER TABLE trades ADD COLUMN price_usd REAL NOT NULL DEFAULT 0;

-- A round's dry-run pot is the USD value of the tax its sells paid. The CULT leg of the swap is its own transaction:
-- signature and last valid height saved before it is sent, the raw CULT sold and the USDC the quote promised.
ALTER TABLE drops ADD COLUMN fee_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE drops ADD COLUMN cult_sig TEXT;
ALTER TABLE drops ADD COLUMN cult_lvbh INTEGER;
ALTER TABLE drops ADD COLUMN cult_amount TEXT;
ALTER TABLE drops ADD COLUMN cult_out INTEGER;

-- Token accounts of the coin that may hold withheld tokens. One row per address (the mint's own address stands for the
-- tokens withheld in the mint). state: queued -> claimed (a run took it) -> sent (a transaction with its signature is
-- saved) -> done, or back to queued; skip after repeated failures. `again` = touched while claimed or sent.
CREATE TABLE fee_accounts (
  address TEXT PRIMARY KEY,
  owner TEXT,                  -- the token account's owner when the transaction that queued it showed it
  state TEXT NOT NULL,
  again INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,
  claim TEXT,
  claimed_at INTEGER,
  batch TEXT,
  tries INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  updated INTEGER NOT NULL
);
CREATE INDEX fee_accounts_state ON fee_accounts (state, next_at);

-- One transaction each: refund (the accounts' own withheld back to them), sweep (withheld to the treasury) or
-- mint (withheld sitting in the mint to the treasury). items = [{ a: address, o: owner, w: raw withheld read }].
CREATE TABLE fee_batches (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,        -- sent -> confirmed | failed | lost
  sig TEXT NOT NULL,
  lvbh INTEGER,
  items TEXT NOT NULL,
  total INTEGER NOT NULL,      -- raw tokens in the items when they were read
  created INTEGER NOT NULL,
  settled INTEGER
);
CREATE INDEX fee_batches_status ON fee_batches (status);
