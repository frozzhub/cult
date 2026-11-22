-- SOL refill (USDC quote only): a round's leg that sells USDC for SOL when the payout wallet's SOL runs low. Its own transaction, like the
-- CULT leg: signature and last valid height saved before it is sent. All additions: old rows read NULL.

-- The signature, or 'dry-run' / 'none' (nothing to do) / 'refused' (a check said no; the reason is in `error`).
ALTER TABLE drops ADD COLUMN refill_sig TEXT;
ALTER TABLE drops ADD COLUMN refill_lvbh INTEGER;
-- micro-USDC sold, and the lamports the quote promised.
ALTER TABLE drops ADD COLUMN refill_usdc INTEGER;
ALTER TABLE drops ADD COLUMN refill_lamports INTEGER;
