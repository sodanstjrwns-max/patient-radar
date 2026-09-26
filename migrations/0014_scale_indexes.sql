-- 【2026-09-26】병원 수백 곳 대비 인덱스(읽기 경로만 빨라지고 동작은 같다)
-- review_stats: 대시보드·리포트의 "최신 stat_date" 조회와 크론의 "오늘 이미 수집" 확인이 hospital_id 접두만 쓰던 것 → (hospital_id, platform, stat_date)
CREATE INDEX IF NOT EXISTS idx_review_stats_hosp_plat_date ON review_stats(hospital_id, platform, stat_date);
-- reputation_snapshots: 같은 이유(플랫폼별 최신 스냅샷·오늘 스냅샷 확인)
CREATE INDEX IF NOT EXISTS idx_reputation_hosp_plat_date ON reputation_snapshots(hospital_id, platform, snapshot_date);
-- crawl_runs: 관측치 보관 정리(run_date < ?)와 운영 요약(run_date >= 최근 7일)이 전 테이블을 훑지 않게
CREATE INDEX IF NOT EXISTS idx_runs_date ON crawl_runs(run_date);
