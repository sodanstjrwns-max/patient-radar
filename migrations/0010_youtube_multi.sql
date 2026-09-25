-- 유튜브 채널 여러 개 (2026-09-25). [{id,title}] JSON. 기존 youtube_channel_id 는 첫 채널로 유지.
ALTER TABLE hospitals ADD COLUMN youtube_channels TEXT NOT NULL DEFAULT '[]';
UPDATE hospitals SET youtube_channels = '[{"id":"' || youtube_channel_id || '","title":"' || COALESCE(youtube_channel_title,'') || '"}]' WHERE youtube_channel_id IS NOT NULL;
