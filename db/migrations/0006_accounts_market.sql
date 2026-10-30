-- Sign-in accounts and the simulated market.
--
-- Every demo user gets a username and a scrypt password hash. Sessions keep
-- only a hash of their token, and point at a user id without a foreign key,
-- so the daily demo reload (which re-creates users with the same ids) does
-- not sign everyone out.
ALTER TABLE users ADD COLUMN username text UNIQUE;
ALTER TABLE users ADD COLUMN password_hash text;
-- Pseudo users whose stock, demands and answers come from the market simulator.
ALTER TABLE users ADD COLUMN simulated boolean NOT NULL DEFAULT false;

CREATE TABLE user_sessions (
  token_hash  text PRIMARY KEY,
  user_id     text NOT NULL,
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL
);
CREATE INDEX user_sessions_user ON user_sessions (user_id);

-- Simulated sellers post documents through the same intake as everyone else.
ALTER TABLE extraction_runs DROP CONSTRAINT extraction_runs_extractor_check;
ALTER TABLE extraction_runs ADD CONSTRAINT extraction_runs_extractor_check CHECK (extractor IN ('meta', 'regex_baseline', 'canonical_seed', 'market_sim'));

-- What the simulated users did, for the Activity page. owner_summary is shown
-- to the acting network; shared_summary (null = nothing) to networks that the
-- acting network shares stock with, and never names a withheld field.
CREATE TABLE market_events (
  id              bigserial PRIMARY KEY,
  at              timestamptz NOT NULL,
  network_id      text NOT NULL,
  actor_id        text NOT NULL,
  kind            text NOT NULL,
  owner_summary   text NOT NULL,
  shared_summary  text
);
CREATE INDEX market_events_at ON market_events (at DESC);

-- One row: how far the simulated market has run.
CREATE TABLE market_state (
  id         integer PRIMARY KEY CHECK (id = 1),
  ticks      integer NOT NULL DEFAULT 0,
  last_tick  timestamptz
);
