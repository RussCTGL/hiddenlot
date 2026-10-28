-- An assessment can become current again after its opportunity was
-- invalidated (e.g. the demo clock is moved back before a staleness cut-off).
-- It then gets a new opportunity, so earlier decisions do not carry over;
-- the old row stays as history. What must hold is only that each assessment,
-- and each demand × lot pair, has at most one open opportunity.

ALTER TABLE opportunities DROP CONSTRAINT opportunities_assessment_id_key;
CREATE UNIQUE INDEX opportunities_open_assessment ON opportunities (assessment_id) WHERE status <> 'invalidated';
CREATE UNIQUE INDEX opportunities_open_pair ON opportunities (demand_id, lot_id) WHERE status <> 'invalidated';
