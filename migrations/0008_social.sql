-- 콘텐츠 도달(3층): 유튜브·인스타그램·스레드 (2026-09-25)
ALTER TABLE hospitals ADD COLUMN youtube_channel_id TEXT;
ALTER TABLE hospitals ADD COLUMN youtube_channel_title TEXT;
ALTER TABLE hospitals ADD COLUMN ig_user_id TEXT;
ALTER TABLE hospitals ADD COLUMN ig_username TEXT;
ALTER TABLE hospitals ADD COLUMN ig_token_enc TEXT;      -- 장기 토큰(암호화)
ALTER TABLE hospitals ADD COLUMN ig_token_expires_at TEXT;
ALTER TABLE hospitals ADD COLUMN threads_user_id TEXT;
ALTER TABLE hospitals ADD COLUMN threads_username TEXT;
ALTER TABLE hospitals ADD COLUMN threads_token_enc TEXT;
ALTER TABLE hospitals ADD COLUMN threads_token_expires_at TEXT;
CREATE TABLE oauth_states (state TEXT PRIMARY KEY, hospital_id INTEGER NOT NULL, provider TEXT NOT NULL, created_at TEXT NOT NULL);
-- 스냅샷은 reputation_snapshots(platform youtube|instagram|threads, followers, views_30d, detail) 재사용
