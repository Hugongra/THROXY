-- Rename existing apo-* versions to runned APO v1, v2, ... (by created_at)
WITH ordered AS (
  SELECT id, version, ROW_NUMBER() OVER (ORDER BY created_at ASC) AS rn
  FROM prompt_versions
  WHERE source = 'apo' AND version LIKE 'apo-%'
)
UPDATE prompt_versions p
SET version = 'runned APO v' || o.rn::text
FROM ordered o
WHERE p.id = o.id;
