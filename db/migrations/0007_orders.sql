-- After the buyer accepts an offer, the deal becomes an order both sides work
-- through: the seller confirms, then each step (contract, payment, mill test
-- certificate, shipment, receipt) is done by the side that owns it, with files
-- either side shares. The lot as the buyer saw it is kept on the deal, because
-- the lot itself is marked sold and leaves the buyer's view.
ALTER TABLE deals DROP CONSTRAINT deals_stage_check;
ALTER TABLE deals ADD CONSTRAINT deals_stage_check CHECK (stage IN ('waiting', 'quote_requested', 'quote_in_hand', 'negotiating', 'ordered', 'won', 'lost'));
ALTER TABLE deals ADD COLUMN order_lot jsonb;

CREATE TABLE deal_milestones (
  deal_id  text NOT NULL REFERENCES deals(id),
  step     text NOT NULL,
  done_by  text NOT NULL REFERENCES users(id),
  done_at  timestamptz NOT NULL,
  note     text,
  PRIMARY KEY (deal_id, step)
);

CREATE TABLE deal_files (
  id           text PRIMARY KEY,
  deal_id      text NOT NULL REFERENCES deals(id),
  network_id   text NOT NULL REFERENCES networks(id),
  uploaded_by  text NOT NULL REFERENCES users(id),
  step         text,
  filename     text NOT NULL,
  mime         text NOT NULL,
  size_bytes   integer NOT NULL,
  content      bytea NOT NULL,
  created_at   timestamptz NOT NULL
);
CREATE INDEX deal_files_deal ON deal_files (deal_id, created_at);
