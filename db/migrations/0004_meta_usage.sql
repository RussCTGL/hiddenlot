-- Paid model calls per UTC day, so a public deployment can cap them
-- (HIDDENLOT_META_DAILY_LIMIT). One row per day; retries inside one call count once.
CREATE TABLE meta_usage (
  day    date PRIMARY KEY,
  calls  integer NOT NULL DEFAULT 0
);
