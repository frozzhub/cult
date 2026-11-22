-- Streak boost only on the part held since the streak began. All additions: old rows keep
-- their values. `base` = the lowest balance (raw units) a holder has had since `since`; a bag added later earns no streak boost.
-- Rows from before this column read NULL: the next snapshot takes their stored balance as the base.
ALTER TABLE holders ADD COLUMN base TEXT;
