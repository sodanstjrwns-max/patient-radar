-- 리뷰 본문 (2026-09-25). 작성자 식별 정보는 저장하지 않는다. 보관 90일(크론이 파기), 집계는 review_stats 에 남긴다.
CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hospital_id INTEGER NOT NULL, entity_type TEXT NOT NULL, entity_id INTEGER,   -- self | competitor
  platform TEXT NOT NULL,                 -- naver_place | google_business
  review_key TEXT NOT NULL,               -- 플랫폼 리뷰 ID (중복 방지)
  rating INTEGER,                         -- 구글 1~5, 네이버 NULL
  body TEXT NOT NULL,
  reply TEXT,                             -- 사업주 답글(있으면)
  visit_count INTEGER,                    -- 네이버 방문 횟수
  written_at TEXT,                        -- YYYY-MM-DD (네이버는 연도 추정)
  treatments TEXT NOT NULL DEFAULT '[]',  -- 언급된 진료 키워드
  complaints TEXT NOT NULL DEFAULT '[]',  -- 불만 키워드
  negative INTEGER NOT NULL DEFAULT 0,    -- 별점 ≤2 또는 불만 키워드 2개 이상
  fetched_at TEXT NOT NULL,
  UNIQUE(hospital_id, platform, review_key)
);
CREATE INDEX idx_reviews_hospital ON reviews(hospital_id, platform, written_at);
CREATE TABLE review_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hospital_id INTEGER NOT NULL, entity_type TEXT NOT NULL, entity_id INTEGER, platform TEXT NOT NULL,
  stat_date TEXT NOT NULL,
  count_30d INTEGER NOT NULL DEFAULT 0, negative_30d INTEGER NOT NULL DEFAULT 0, replied_30d INTEGER NOT NULL DEFAULT 0,
  treatments TEXT NOT NULL DEFAULT '{}', complaints TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(hospital_id, entity_type, COALESCE(entity_id, 0), platform, stat_date)
);
