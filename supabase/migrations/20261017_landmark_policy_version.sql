-- Track which deterministic landmark-ranking policy produced each stored list.
-- Null/legacy values are re-ranked by the next feed sweep.
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS landmark_policy_version integer;

ALTER TABLE landmark_resolution_log
  ADD COLUMN IF NOT EXISTS landmark_policy_version integer;
