-- Member profiles: one per wallet, optionally linked to an X account whose name and picture it mirrors.
CREATE TABLE profiles (
  wallet TEXT PRIMARY KEY,
  x_id TEXT UNIQUE,                -- one X account can belong to one wallet
  x_handle TEXT,
  x_name TEXT,
  x_pfp TEXT,
  x_refresh TEXT,                  -- X refresh token (users.read only), used by the daily sync
  x_synced_at INTEGER,
  created_at INTEGER NOT NULL
);

-- Sign In With Solana challenges (single use, 10 minutes).
CREATE TABLE nonces (
  nonce TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  message TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Sessions. Only the SHA-256 of the cookie token is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- X OAuth (PKCE) in flight.
CREATE TABLE x_oauth (
  state TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  verifier TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
