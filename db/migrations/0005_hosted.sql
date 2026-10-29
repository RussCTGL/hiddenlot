-- For a hosted, multi-instance deployment.
-- Paid model calls per visitor per UTC day (HIDDENLOT_META_VISITOR_LIMIT), so one
-- visitor cannot use up the daily cap. Visitors are a hash, never an address.
CREATE TABLE meta_usage_by_visitor (
  day      date NOT NULL,
  visitor  text NOT NULL,
  calls    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, visitor)
);

-- Short leases so only one server instance seeds or reseeds the demo at a time.
CREATE TABLE maintenance_leases (
  name   text PRIMARY KEY,
  until  timestamptz NOT NULL
);
