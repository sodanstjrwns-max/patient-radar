export const APP_NAME = { ko: "페이션트 레이더", en: "Patient Radar" } as const;
export const VERSION = "1.0.0";
export const DEFAULT_PUBLIC_ORIGIN = "https://patientradar.kr";
export const HUB_ORIGIN = "https://hub.patientfunnel.kr";
export const HUB_SSO_SERVICE = "radar";
export const CONTACT = {
  phone: "010-4445-1873",
  email: "patientsfunnel@gmail.com",
};
export type Bindings = {
  DB: D1Database;
  PUBLIC_ORIGIN?: string;
  ADMIN_SECRET?: string;
  PS_SSO_SECRET?: string;
  PS_SERVICE_KEY?: string;
  CRON_SECRET?: string;
  PROBE_ENABLED?: string;
  HUB_API_KEY?: string;
  // 네이버: 공식 검색 API(권장) 또는 원장 결정으로 켜는 HTML 모드
  NAVER_CLIENT_ID?: string;
  NAVER_CLIENT_SECRET?: string;
  NAVER_HTML_MODE?: string;
  // 구글·카카오·시그널 (키 없으면 해당 플랫폼은 '미측정')
  GOOGLE_CSE_KEY?: string;
  GOOGLE_CSE_CX?: string;
  GOOGLE_PLACES_KEY?: string;
  KAKAO_REST_KEY?: string;
  SIGNAL_API_URL?: string;
  SIGNAL_API_KEY?: string;
  // 메일
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  OPS_EMAIL?: string;
};
export function publicOrigin(env: Pick<Bindings, "PUBLIC_ORIGIN">): string {
  const url = new URL(env.PUBLIC_ORIGIN || DEFAULT_PUBLIC_ORIGIN);
  if (url.protocol !== "https:") throw new Error("INVALID_PUBLIC_ORIGIN");
  return url.origin;
}
/** 플랫폼별 설정 상태 — 화면·헬스체크가 같은 판정을 쓴다 */
export function platformAvailability(env: Bindings) {
  const naverApi = !!(env.NAVER_CLIENT_ID && env.NAVER_CLIENT_SECRET);
  const naverHtml = env.NAVER_HTML_MODE === "true";
  return {
    naver: naverApi || naverHtml,
    naverMode: naverHtml ? ("html" as const) : naverApi ? ("api" as const) : null,
    google: !!(env.GOOGLE_CSE_KEY && env.GOOGLE_CSE_CX),
    googlePlaces: !!env.GOOGLE_PLACES_KEY,
    kakao: !!env.KAKAO_REST_KEY,
    signal: !!(env.SIGNAL_API_URL && env.SIGNAL_API_KEY),
    mail: !!env.RESEND_API_KEY,
  };
}
