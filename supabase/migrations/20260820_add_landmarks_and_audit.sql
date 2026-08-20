-- Add landmarks support to the properties table.
-- Run: supabase db push (or supabase migration up)
--
-- landmarks: ranked list of public places near the property (JSONB array).
--             Written once by the resolver, read by Lina's feed.
-- landmarks_resolved_at: when the resolver last wrote this field.
--
-- price_change_log: audit trail for owner-dictated price changes.
-- landmark_resolution_log: audit trail for landmark writes.

-- 1. Landmarks column (nullable — new properties won't have it yet).
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS landmarks jsonb,
  ADD COLUMN IF NOT EXISTS landmarks_resolved_at timestamptz;

-- 2. Audit table: price changes applied by Hermes.
CREATE TABLE IF NOT EXISTS price_change_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id   uuid REFERENCES properties(id),
  property_number text NOT NULL,
  old_price     integer,
  new_price     integer NOT NULL,
  source        text NOT NULL DEFAULT 'owner',
  applied_at    timestamptz NOT NULL DEFAULT now()
);

-- 3. Audit table: landmark resolution writes.
CREATE TABLE IF NOT EXISTS landmark_resolution_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id     uuid REFERENCES properties(id),
  property_number text NOT NULL,
  landmarks       jsonb NOT NULL,
  applied_at      timestamptz NOT NULL DEFAULT now()
);

-- 4. Indexes for the audit tables (for fast lookups by property).
CREATE INDEX IF NOT EXISTS idx_price_change_log_property
  ON price_change_log (property_number, applied_at DESC);

CREATE INDEX IF NOT EXISTS idx_landmark_log_property
  ON landmark_resolution_log (property_number, applied_at DESC);

-- 5. Index on landmarks for the feed (Lina reads this on every conversation).
CREATE INDEX IF NOT EXISTS idx_properties_landmarks
  ON properties USING gin (landmarks) WHERE landmarks IS NOT NULL;
