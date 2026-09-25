-- 【2026-09-26】행동을 닫는 것: 처방 실행 추적 · 키워드 목표 · 새 경쟁사 감지(무시 목록) · 경보 해결 표시
CREATE TABLE IF NOT EXISTS prescriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hospital_id INTEGER NOT NULL,
  keyword_id INTEGER,                      -- keywords.id (없으면 NULL)
  keyword TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'naver_place',
  code TEXT NOT NULL,                      -- playbook 규칙 코드
  text TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '',       -- 이 문장의 근거(실측 숫자)
  gain INTEGER NOT NULL DEFAULT 0,         -- 기대 이득: 한 계단 오르면 +N명
  first_run_id INTEGER, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',     -- open | done | checked | dismissed | resolved
  done_at TEXT,
  baseline TEXT,                           -- {date, rank, captured, blockSize}
  check_after TEXT,                        -- done_at + 21일: 이 날 이후 첫 측정에서 결과 판정
  result TEXT, result_at TEXT,             -- {date, rank, captured, deltaRank, deltaCaptured, verdict}
  UNIQUE(hospital_id, keyword, code)
);
CREATE INDEX IF NOT EXISTS idx_rx_hospital_status ON prescriptions(hospital_id, status);
ALTER TABLE keywords ADD COLUMN target_rank INTEGER;       -- 목표 순위(플레이스)
ALTER TABLE keywords ADD COLUMN goal_set_at TEXT;
ALTER TABLE keywords ADD COLUMN goal_base_rank INTEGER;    -- 목표 설정 시점 순위(NULL=미노출), 진행률 기준
ALTER TABLE hospital_settings ADD COLUMN ignored_competitors TEXT NOT NULL DEFAULT '[]'; -- 새 경쟁사 감지에서 무시할 이름/플레이스ID
ALTER TABLE alerts ADD COLUMN resolved_at TEXT;
