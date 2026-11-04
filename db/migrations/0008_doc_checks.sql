-- Files attached to an order step are read and checked against that step's
-- document template (src/workflow/doc-templates.ts): each field with the line
-- it was read from, what the order expects, and whether they agree. A step
-- whose document still has open points can only be completed with a reason,
-- which both sides see.
ALTER TABLE deal_files ADD COLUMN doc_check jsonb;
ALTER TABLE deal_milestones ADD COLUMN override_reason text;
