// 허브 SSO 토큰 검증 — Patient Hub(hub.patientfunnel.kr)가 발급한
// HMAC-SHA256 서명 단기 토큰을 검증한다. 공유 시크릿: PS_SSO_SECRET.
// 형제 서비스 공통 모듈 (동일 파일이 각 저장소에 복제됨 — 수정 시 전 서비스 동기화).

const enc = new TextEncoder()

export type HubSsoClaims = {
  iss: string
  aud: string
  sub: number
  email: string
  name: string
  role: string // director | manager | staff (허브 기준)
  hid: string // ps_hospital_id (전역 병원 ID)
  hname: string
  iat: number
  exp: number
  jti: string
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export async function verifyHubSsoToken(secret: string, token: string, expectedAud: string): Promise<HubSsoClaims | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, body, sig] = parts
  try {
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    const ok = await crypto.subtle.verify('HMAC', key, b64urlDecode(sig), enc.encode(`${header}.${body}`))
    if (!ok) return null
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as HubSsoClaims
    if (claims.iss !== 'patient-hub') return null
    if (claims.aud !== expectedAud) return null
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null
    if (!claims.email || !claims.hid) return null
    return claims
  } catch {
    return null
  }
}
