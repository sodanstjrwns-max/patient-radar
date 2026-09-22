-- 0002_reports.sql
CREATE TABLE weekly_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  week_start TEXT NOT NULL,
  content_json TEXT NOT NULL,            -- §9-5 리포트 본문(화면·메일 공통 원천)
  sent_at TEXT, sent_to TEXT,            -- 메일 발송 시각·수신 주소(병원 계정 이메일)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(hospital_id, week_start)
);
CREATE TABLE hospital_settings (
  hospital_id INTEGER PRIMARY KEY REFERENCES hospitals(id) ON DELETE CASCADE,
  report_email_enabled INTEGER NOT NULL DEFAULT 1,
  report_recipients TEXT NOT NULL DEFAULT '[]', -- 추가 수신자 JSON(병원 직원 이메일만, 환자 아님)
  website_url TEXT,                       -- 구글 순위 매칭용 홈페이지 도메인
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
ALTER TABLE hospitals ADD COLUMN website_url TEXT;
ALTER TABLE hospitals ADD COLUMN onboarded_at TEXT;
