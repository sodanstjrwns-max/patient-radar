// 토큰 저장용 AES-GCM. 키 = SHA-256(PS_SSO_SECRET + ":radar-token"). 값은 base64(iv|ciphertext).
const enc = new TextEncoder(), dec = new TextDecoder();
async function keyOf(secret: string) {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(secret + ":radar-token"));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export async function encryptToken(secret: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyOf(secret), enc.encode(plain)));
  const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length);
  return b64(out);
}
export async function decryptToken(secret: string, packed: string): Promise<string> {
  const all = unb64(packed);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, await keyOf(secret), all.slice(12));
  return dec.decode(pt);
}
