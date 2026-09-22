export const APP_NAME = { ko: "페이션트 레이더", en: "Patient Radar" } as const;
export const VERSION = "0.1.0-foundation";
export const DEFAULT_PUBLIC_ORIGIN = "https://patientradar.kr";
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
};
export function publicOrigin(env: Pick<Bindings, "PUBLIC_ORIGIN">): string {
  const url = new URL(env.PUBLIC_ORIGIN || DEFAULT_PUBLIC_ORIGIN);
  if (url.protocol !== "https:") throw new Error("INVALID_PUBLIC_ORIGIN");
  return url.origin;
}
