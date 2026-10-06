// PRIVATE TERMINAL (T05) — defence in depth behind Cloudflare Access.
// Cloudflare Access already stops unauthenticated visitors at the edge for /terminal and /api.
// The Worker checks again: every /api request must carry the Access JWT issued for THIS application
// (RS256 signature by the team's public keys, audience = the app's AUD tag, issuer, expiry).
// No valid token → 401/403 and no provider call is made. Missing configuration → fail closed.
const B64 = (s) => s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
const bytes = (s) => Uint8Array.from(atob(B64(s)), (c) => c.charCodeAt(0));
const json64 = (s) => JSON.parse(new TextDecoder().decode(bytes(s)));

let CERTS = { team: null, at: 0, keys: [] };
export function __resetAccessForTests() { CERTS = { team: null, at: 0, keys: [] }; }

async function teamKeys(team, now, force = false) {
  if (!force && CERTS.team === team && now - CERTS.at < 3600_000 && CERTS.keys.length) return CERTS.keys;
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error("certs " + r.status);
  const j = await r.json();
  CERTS = { team, at: now, keys: Array.isArray(j.keys) ? j.keys : [] };
  return CERTS.keys;
}

// the token Access forwards to the origin (header), or the browser's Access cookie
export function accessToken(req) {
  const h = req.headers.get("cf-access-jwt-assertion");
  if (h) return h.trim();
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.headers.get("cookie") || "");
  return m ? m[1] : null;
}

const deny = (status, error) => ({ ok: false, status, error });

export async function verifyAccess(req, env, now = Date.now()) {
  const team = env.ACCESS_TEAM_DOMAIN, aud = env.ACCESS_AUD;
  if (!team || !aud) return deny(503, "access_not_configured");
  const tok = accessToken(req);
  if (!tok) return deny(401, "unauthenticated");
  const parts = tok.split(".");
  if (parts.length !== 3) return deny(403, "invalid_token");
  let head, claims;
  try { head = json64(parts[0]); claims = json64(parts[1]); } catch { return deny(403, "invalid_token"); }
  if (head.alg !== "RS256" || !head.kid) return deny(403, "invalid_token");
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) return deny(403, "wrong_audience");
  if (claims.iss !== `https://${team}`) return deny(403, "wrong_issuer");
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now) return deny(401, "token_expired");
  if (Number.isFinite(claims.nbf) && claims.nbf * 1000 > now + 60_000) return deny(403, "invalid_token");
  let keys;
  try {
    keys = await teamKeys(team, now);
    if (!keys.some((k) => k.kid === head.kid)) keys = await teamKeys(team, now, true); // key rotation
  } catch { return deny(503, "access_keys_unavailable"); }
  const jwk = keys.find((k) => k.kid === head.kid);
  if (!jwk) return deny(403, "unknown_key");
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const good = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, bytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
    if (!good) return deny(403, "bad_signature");
  } catch { return deny(403, "invalid_token"); }
  return { ok: true, email: claims.email || null };
}
