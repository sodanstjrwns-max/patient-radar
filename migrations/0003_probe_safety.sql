-- Additive safety extensions; the supplied 0001 and 0002 remain unchanged.
CREATE TABLE probe_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'running',
  result_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE operation_locks (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE collection_pauses (
  scope TEXT PRIMARY KEY,
  until_date TEXT NOT NULL,
  reason TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- SQLite permits duplicate NULLs in a UNIQUE tuple: normalize the self key.
CREATE UNIQUE INDEX idx_reputation_identity
  ON reputation_snapshots(hospital_id,entity_type,COALESCE(entity_id,0),platform,snapshot_date);
CREATE UNIQUE INDEX idx_observation_identity
  ON observations(run_id,keyword_id,platform,entity_type,COALESCE(entity_id,0));
CREATE INDEX idx_weekly_hospital_week ON weekly_scores(hospital_id,week_start);
CREATE INDEX idx_alert_hospital_time ON alerts(hospital_id,created_at);
