-- 【2026-09-26】허브 올패스 권한 캐시(규약: 허브_올패스_권한연동_규약_2026-09-26.md). 병원별 30분, hub-events 'subscription_updated' 로 삭제.
-- payload = 유효 권한 JSON({tier,status,source,ends_at,trial,via}) 또는 'null'(권한 없음). 허브 호출 실패는 저장하지 않는다.
CREATE TABLE IF NOT EXISTS hub_entitlement_cache (
  ps_hospital_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL           -- epoch ms
);
