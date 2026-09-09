-- v7: per-property landmark resolution — replaces the old address_key cache
-- with property-level columns so each property stores its own resolved landmark.
-- This enables:
--   1. Property-level landmark overrides (feed landmarks, Google-verified)
--   2. Confidence tracking (tier = 'feed'|'extract'|'google'|'osm_poi'|'osm_low_confidence')
--   3. Re-resolution queue for properties with bad geocoding

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS landmark_name TEXT,
  ADD COLUMN IF NOT EXISTS landmark_place_id TEXT,
  ADD COLUMN IF NOT EXISTS landmark_lat REAL,
  ADD COLUMN IF NOT EXISTS landmark_lon REAL,
  ADD COLUMN IF NOT EXISTS landmark_tier TEXT,  -- 'feed'|'extract'|'google'|'osm_poi'|'osm_low_confidence'
  ADD COLUMN IF NOT EXISTS landmark_resolved_at TIMESTAMPTZ;
