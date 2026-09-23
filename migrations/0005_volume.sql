-- 네이버 검색광고 키워드도구 월간 검색수 (2026-09-23)
ALTER TABLE keywords ADD COLUMN monthly_pc INTEGER;
ALTER TABLE keywords ADD COLUMN monthly_mobile INTEGER;
ALTER TABLE keywords ADD COLUMN volume_low INTEGER NOT NULL DEFAULT 0; -- "< 10" 등 하한 표시
ALTER TABLE keywords ADD COLUMN volume_updated_at TEXT;
ALTER TABLE weekly_scores ADD COLUMN weighted_score REAL; -- 검색량 가중 점수 (수요 가중)
