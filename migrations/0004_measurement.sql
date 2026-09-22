-- 측정 운영에 필요한 열 추가 (2026-09-23). 기존 표 유지.
ALTER TABLE hospitals ADD COLUMN clinic_type TEXT;
ALTER TABLE hospitals ADD COLUMN key_treatments TEXT NOT NULL DEFAULT '[]';
ALTER TABLE crawl_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'weekly'; -- first | weekly | manual
ALTER TABLE crawl_runs ADD COLUMN summary TEXT NOT NULL DEFAULT '{}';
ALTER TABLE competitors ADD COLUMN google_place_id TEXT;
ALTER TABLE competitors ADD COLUMN kakao_place_id TEXT;
ALTER TABLE competitors ADD COLUMN website_url TEXT;
CREATE INDEX IF NOT EXISTS idx_keywords_hospital ON keywords(hospital_id, is_active);
CREATE INDEX IF NOT EXISTS idx_runs_hospital_date ON crawl_runs(hospital_id, run_date);
CREATE INDEX IF NOT EXISTS idx_hospital_users_email ON hospital_users(email);
