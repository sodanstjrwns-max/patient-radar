-- 검색 기회(수요 × 노출 확률) 주간 집계 (2026-09-23)
CREATE TABLE weekly_opportunity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hospital_id INTEGER NOT NULL, week_start TEXT NOT NULL, platform TEXT NOT NULL, -- naver_place | google | kakao
  pool INTEGER NOT NULL,            -- 활성 키워드 월 검색수 합(검색수 있는 것만)
  captured REAL NOT NULL,           -- Σ 검색수 × 노출 확률(순위별)
  coverage REAL NOT NULL,           -- captured / pool
  detail TEXT NOT NULL DEFAULT '{}',-- { lost:[{keyword,volume,rank,lost,gainTop3,above:[...]}], competitors:{c1:{captured,coverage}} }
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(hospital_id, week_start, platform)
);
