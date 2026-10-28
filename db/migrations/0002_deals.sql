-- Deal tracking and the demo clock.
--
-- A deal follows one demand × lot pair after the buyer acts on it. It is keyed
-- by the pair, not by an opportunity, because opportunities are replaced
-- whenever the lot, demand or sharing changes; the deal keeps its history.
-- Deals belong to the buyer's network only; the seller never sees them.

CREATE TABLE deals (
  id                text PRIMARY KEY,
  buyer_network_id  text NOT NULL REFERENCES networks(id),
  demand_id         text NOT NULL REFERENCES demands(id),
  lot_id            text NOT NULL REFERENCES lots(id),
  stage             text NOT NULL CHECK (stage IN ('waiting', 'quote_requested', 'quote_in_hand', 'negotiating', 'won', 'lost')),
  ask               text,          -- the open question while waiting for an answer
  follow_up_on      date,          -- when silence becomes a risk
  snoozed_until     date,          -- "not now" on a flagged risk
  quote             jsonb,         -- the seller's offer as the buyer recorded it
  closed_reason     text,
  lot_version_at_start integer NOT NULL,
  created_by        text NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- At most one open deal per pair.
CREATE UNIQUE INDEX deals_open_pair ON deals (demand_id, lot_id) WHERE stage NOT IN ('won', 'lost');
CREATE INDEX deals_buyer ON deals (buyer_network_id, stage);

CREATE TABLE deal_events (
  id          text PRIMARY KEY,
  deal_id     text NOT NULL REFERENCES deals(id),
  actor_id    text REFERENCES users(id),  -- null = the system (digest, auto-close)
  kind        text NOT NULL,
  note        text NOT NULL,
  created_at  timestamptz NOT NULL
);
CREATE INDEX deal_events_deal ON deal_events (deal_id, created_at);

-- Demo only: lets the presenter skip ahead in time so freshness, follow-ups
-- and expiry can be shown without waiting. One row; offset 0 = real time.
CREATE TABLE demo_clock (
  id            integer PRIMARY KEY CHECK (id = 1),
  offset_hours  integer NOT NULL DEFAULT 0
);
INSERT INTO demo_clock (id, offset_hours) VALUES (1, 0);
