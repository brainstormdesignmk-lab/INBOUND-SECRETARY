-- Property geocode + landmark cache (keyed by property.id, upgrade-only)
ALTER TABLE properties ADD COLUMN lat REAL;
ALTER TABLE properties ADD COLUMN lon REAL;
ALTER TABLE properties ADD COLUMN geo_source TEXT;   -- 'stored'|'google_cached'|'osm_low_confidence'
ALTER TABLE properties ADD COLUMN geocoded_at TEXT;
ALTER TABLE properties ADD COLUMN landmark_name TEXT;
ALTER TABLE properties ADD COLUMN landmark_place_id TEXT;
ALTER TABLE properties ADD COLUMN landmark_lat REAL;
ALTER TABLE properties ADD COLUMN landmark_lon REAL;
ALTER TABLE properties ADD COLUMN landmark_tier TEXT; -- 'feed'|'google'|'extract'|'osm_poi'|'osm_low_confidence'
ALTER TABLE properties ADD COLUMN landmark_resolved_at TEXT;

-- Deterministic async re-resolution queue (replaces LLM slot)
CREATE TABLE IF NOT EXISTS geo_reresolve_queue (
  property_id INTEGER PRIMARY KEY,
  reason TEXT NOT NULL,        -- 'no_landmark'|'low_confidence_center'|'poison_sweep'
  created_at TEXT NOT NULL
);

-- Merged POI table (Google primary + OSM secondary)
DROP TABLE IF EXISTS pois;
CREATE TABLE pois (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,        -- 'google' | 'osm'
  place_id TEXT UNIQUE,
  osm_key TEXT UNIQUE,
  name TEXT NOT NULL,
  type TEXT,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  rating REAL,
  address TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pois_latlon ON pois(lat, lon);
CREATE INDEX IF NOT EXISTS idx_pois_type ON pois(type);
