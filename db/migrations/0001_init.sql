-- HiddenLot core schema (plan §9.1). Postgres dialect; runs on embedded PGlite
-- locally and on hosted Postgres in deployment.
--
-- Versioned rows (lot_versions, demand_versions) are immutable: edits insert a
-- new version. Match assessments point at exact versions, so any change to a
-- lot, demand or grant produces a new assessment instead of reusing an old one.

CREATE TABLE networks (
  id          text PRIMARY KEY,
  name        text NOT NULL,          -- private name, visible to members only
  alias       text NOT NULL,          -- what other networks see
  region      text,
  synthetic   boolean NOT NULL DEFAULT true
);

CREATE TABLE users (
  id          text PRIMARY KEY,
  network_id  text NOT NULL REFERENCES networks(id),
  name        text NOT NULL,
  role        text NOT NULL CHECK (role IN ('trader', 'reviewer')),
  synthetic   boolean NOT NULL DEFAULT true
);

-- Raw uploads stay with the owner network (private storage stand-in).
CREATE TABLE source_documents (
  id              text PRIMARY KEY,
  network_id      text NOT NULL REFERENCES networks(id),
  kind            text NOT NULL CHECK (kind IN ('text', 'csv', 'xlsx', 'pdf')),
  filename        text,
  mime            text,
  size_bytes      integer NOT NULL,
  sha256          text NOT NULL,
  parser_version  text NOT NULL,
  status          text NOT NULL CHECK (status IN ('uploaded', 'parsed', 'extracted', 'needs_review', 'published', 'failed', 'withdrawn')),
  error           text,
  content         bytea NOT NULL,
  rights_status   text NOT NULL DEFAULT 'synthetic',
  synthetic       boolean NOT NULL DEFAULT true,
  created_by      text NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Idempotency: the same file re-uploaded by the same network is not re-imported.
  UNIQUE (network_id, sha256, parser_version)
);

CREATE TABLE source_fragments (
  document_id  text NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  fragment_id  text NOT NULL,
  seq          integer NOT NULL,
  text         text NOT NULL,
  locator      jsonb NOT NULL,       -- text_span / sheet_cell row / pdf_text
  cells        jsonb,                -- tabular rows: cell refs with offsets into text
  PRIMARY KEY (document_id, fragment_id)
);

CREATE TABLE extraction_runs (
  id                    text PRIMARY KEY,
  document_id           text NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  extractor             text NOT NULL CHECK (extractor IN ('meta', 'regex_baseline', 'canonical_seed')),
  model_run             jsonb,       -- provider, model, latency, usage, status; never the key or full prompt
  status                text NOT NULL,
  issues                jsonb NOT NULL DEFAULT '[]',
  ignored_instructions  jsonb NOT NULL DEFAULT '[]',
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lots (
  id                text PRIMARY KEY,
  owner_network_id  text NOT NULL REFERENCES networks(id),
  current_version   integer NOT NULL,
  status            text NOT NULL CHECK (status IN ('needs_review', 'published', 'sold', 'withdrawn', 'stale')),
  source_document_id text REFERENCES source_documents(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lot_versions (
  lot_id      text NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  data        jsonb NOT NULL,        -- InventoryLot (domain schema), validated before insert
  created_by  text NOT NULL REFERENCES users(id),
  change_note text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lot_id, version)
);

CREATE TABLE demands (
  id                text PRIMARY KEY,
  buyer_network_id  text NOT NULL REFERENCES networks(id),
  current_version   integer NOT NULL,
  status            text NOT NULL CHECK (status IN ('active', 'withdrawn', 'expired')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE demand_versions (
  demand_id   text NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  data        jsonb NOT NULL,
  created_by  text NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (demand_id, version)
);

-- A grant lets one network's published lots (all, or one lot) take part in
-- another network's discovery, limited to field_scope. Identity disclosure is
-- a separate permission and is off by default.
CREATE TABLE sharing_grants (
  id                         text PRIMARY KEY,
  owner_network_id           text NOT NULL REFERENCES networks(id),
  recipient_network_id       text NOT NULL REFERENCES networks(id),
  lot_id                     text REFERENCES lots(id),   -- null = all published lots of the owner
  field_scope                jsonb NOT NULL,
  purpose                    text NOT NULL DEFAULT 'discovery',
  allow_discovery            boolean NOT NULL DEFAULT true,
  allow_model_processing     boolean NOT NULL DEFAULT false,
  allow_identity_disclosure  boolean NOT NULL DEFAULT false,
  expires_at                 timestamptz,
  revoked_at                 timestamptz,
  created_by                 text NOT NULL REFERENCES users(id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (owner_network_id <> recipient_network_id)
);

CREATE TABLE match_assessments (
  id                    text PRIMARY KEY,
  lot_id                text NOT NULL REFERENCES lots(id),
  lot_version           integer NOT NULL,
  demand_id             text NOT NULL REFERENCES demands(id),
  demand_version        integer NOT NULL,
  permission_version    text NOT NULL,
  rules_version         text NOT NULL,
  freshness             text NOT NULL CHECK (freshness IN ('fresh', 'stale')),
  compatibility_status  text NOT NULL,
  checks                jsonb NOT NULL,
  score                 jsonb NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lot_id, lot_version, demand_id, demand_version, permission_version, rules_version, freshness)
);

CREATE TABLE opportunities (
  id                  text PRIMARY KEY,
  assessment_id       text NOT NULL REFERENCES match_assessments(id),
  demand_id           text NOT NULL REFERENCES demands(id),
  lot_id              text NOT NULL REFERENCES lots(id),
  buyer_network_id    text NOT NULL REFERENCES networks(id),
  seller_network_id   text NOT NULL REFERENCES networks(id),
  novelty             text NOT NULL CHECK (novelty IN ('cross_network', 'same_network')),
  compatibility_status text NOT NULL,
  status              text NOT NULL CHECK (status IN ('discovered', 'under_review', 'information_requested', 'shortlisted', 'dismissed', 'invalidated')),
  invalidated_reason  text,
  explanation         jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assessment_id)
);
CREATE INDEX opportunities_buyer ON opportunities (buyer_network_id, status);
CREATE INDEX opportunities_pair ON opportunities (demand_id, lot_id);

CREATE TABLE review_decisions (
  id               text PRIMARY KEY,
  opportunity_id   text NOT NULL REFERENCES opportunities(id),
  actor_id         text NOT NULL REFERENCES users(id),
  decision         text NOT NULL CHECK (decision IN ('under_review', 'information_requested', 'shortlisted', 'dismissed')),
  reason           text NOT NULL,
  evidence_version jsonb NOT NULL,   -- lot/demand/assessment versions the decision was made on
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id          bigserial PRIMARY KEY,
  actor_id    text,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
