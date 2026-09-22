-- Patient Radar 초기 스키마 (2026-09-22). D1(SQLite). 환자 PII 없음 — 병원·키워드·공개 노출 데이터만.
CREATE TABLE hospitals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ps_hospital_id TEXT UNIQUE,            -- 허브 전역 병원 ID (SSO 합류 시 채움)
  name TEXT NOT NULL,
  name_aliases TEXT NOT NULL DEFAULT '[]',-- JSON 배열: 지점명·약칭 (노출 판정에 사용)
  region_sido TEXT, region_sigungu TEXT, region_dong TEXT,
  naver_place_id TEXT,                   -- m.place.naver.com/place/<id>
  google_place_id TEXT, kakao_place_id TEXT,
  plan TEXT NOT NULL DEFAULT 'S',        -- S/M/L (가격표_최종본 규칙)
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE hospital_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  hub_user_id INTEGER, email TEXT NOT NULL, name TEXT, role TEXT NOT NULL DEFAULT 'director',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(hospital_id, email)
);
-- 키워드 세트: 「지역 × 진료」. 허브 프로필에서 자동 생성 후 원장이 수정.
CREATE TABLE keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'auto',   -- auto | manual
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(hospital_id, text)
);
-- 경쟁 병원: 같은 키워드 세트로 함께 측정. 플레이스 상위 반복 등장 병원을 자동 추천.
CREATE TABLE competitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  name TEXT NOT NULL, name_aliases TEXT NOT NULL DEFAULT '[]',
  naver_place_id TEXT, is_auto INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(hospital_id, name)
);
-- 수집 실행 단위(주 1회). 월 상한은 잡 개수가 아니라 '수집한 날짜 수'로 센다(시그널 9월 사고 교훈).
CREATE TABLE crawl_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  run_date TEXT NOT NULL,                -- KST YYYY-MM-DD
  status TEXT NOT NULL DEFAULT 'running',-- running | completed | failed | blocked
  platforms TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT, error TEXT,
  UNIQUE(hospital_id, run_date)
);
-- 관측치: 키워드 × 플랫폼 × 대상(우리 병원 또는 경쟁사) 1행. 미노출도 데이터(rank NULL, shown 0).
CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE,
  hospital_id INTEGER NOT NULL, keyword_id INTEGER NOT NULL,
  platform TEXT NOT NULL,                -- naver_serp | naver_place | google_serp | google_business | kakao_map | signal_ai
  entity_type TEXT NOT NULL,             -- self | competitor
  entity_id INTEGER,                     -- competitors.id (self면 NULL)
  shown INTEGER NOT NULL DEFAULT 0,
  rank INTEGER,                          -- 자연 노출 순위(광고 제외), 없으면 NULL
  section TEXT,                          -- naver_serp: place | blog | cafe | influencer | ai_briefing | ad
  detail TEXT NOT NULL DEFAULT '{}',     -- JSON: 섹션별 노출, 광고 여부, 상위 5 목록 등
  observed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_obs_hospital_platform ON observations(hospital_id, platform, observed_at);
CREATE INDEX idx_obs_run ON observations(run_id);
-- 평판 스냅샷(월 1회 또는 주 1회): 리뷰 수·평점·저장 수 추세. 우리 병원과 경쟁사 모두.
CREATE TABLE reputation_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hospital_id INTEGER NOT NULL, entity_type TEXT NOT NULL, entity_id INTEGER,
  platform TEXT NOT NULL,                -- naver_place | google_business | kakao_map | youtube | instagram
  snapshot_date TEXT NOT NULL,
  review_count INTEGER, blog_review_count INTEGER, rating REAL, save_count INTEGER,
  followers INTEGER, views_30d INTEGER,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(hospital_id, entity_type, entity_id, platform, snapshot_date)
);
-- 주간 점수: 플랫폼별 노출 점수·통합 점수·점유율(SOV). 대시보드는 이 표만 읽는다(원본 관측치 스캔 금지).
CREATE TABLE weekly_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hospital_id INTEGER NOT NULL, week_start TEXT NOT NULL,   -- KST 월요일
  platform TEXT NOT NULL,                -- naver_serp | naver_place | google | kakao | signal_ai | total
  score REAL NOT NULL,                   -- 0~100
  sov REAL,                              -- 0~1, 경쟁사 포함 점유율
  keyword_count INTEGER NOT NULL DEFAULT 0, shown_count INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(hospital_id, week_start, platform)
);
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hospital_id INTEGER, severity TEXT NOT NULL, code TEXT NOT NULL, message TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
