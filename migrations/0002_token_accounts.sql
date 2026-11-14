-- Holder index built from the mint's transaction history (works on any RPC, no snapshot call needed).
-- One row per $PAPER token account, with its latest balance as of the newest transaction that touched it.
CREATE TABLE token_accounts (
  address TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  amount TEXT NOT NULL,          -- raw units
  slot INTEGER NOT NULL          -- only newer slots overwrite
);
CREATE INDEX token_accounts_owner ON token_accounts (owner);
