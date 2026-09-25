-- 페이션트 폼 내원경로 주간 집계 반입 (2026-09-25). 개인정보 없음 — 건수만.
CREATE TABLE weekly_arrivals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hospital_id INTEGER NOT NULL, week_start TEXT NOT NULL,
  first_visits INTEGER NOT NULL, answered INTEGER NOT NULL, declined INTEGER NOT NULL DEFAULT 0, unanswered INTEGER NOT NULL DEFAULT 0,
  groups TEXT NOT NULL DEFAULT '{}',    -- {search:n, ai:n, sns:n, content:n, referral:n, agreement:n, sign:n, nearby:n, other:n}
  primary_paths TEXT NOT NULL DEFAULT '{}', -- {"search.naver":n, "search.google":n, ...}
  fetched_at TEXT NOT NULL,
  UNIQUE(hospital_id, week_start)
);
ALTER TABLE hospital_settings ADD COLUMN form_api_key TEXT; -- 페이션트 폼 연동 키(pfk_…), 병원별. 운영자가 어드민에서 넣는다.
