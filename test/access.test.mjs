// T05 — private terminal: the Worker refuses /api/* without a valid Cloudflare Access token.
// Real RS256 signatures with a throw-away key pair generated here; provider and Access certs mocked.
//   node test/access.test.mjs
import worker from "../src/worker.mjs";
import { __resetAccessForTests } from "../src/access.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`); cond ? pass++ : fail++; };

const TEAM = "team-test.cloudflareaccess.com", AUD = "aud-tag-of-this-app", KEY = "TESTKEY_never_returned";
const env = { TWELVEDATA_KEY: KEY, ALLOWED_ORIGIN: "https://alessandrozanichelli.com", ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
const ctx = { waitUntil: () => {} };
const alg = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
const good = await crypto.subtle.generateKey(alg, true, ["sign", "verify"]);
const evil = await crypto.subtle.generateKey(alg, true, ["sign", "verify"]);
const pub = await crypto.subtle.exportKey("jwk", good.publicKey);

const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function token({ key = good.privateKey, kid = "k1", aud = [AUD], iss = `https://${TEAM}`, exp = Math.floor(Date.now() / 1000) + 3600, email = "owner@example.com" } = {}) {
  const h = b64u(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })), p = b64u(JSON.stringify({ aud, iss, exp, iat: Math.floor(Date.now() / 1000), email }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(sig)}`;
}

let providerCalls = 0, certCalls = 0, certsDown = false;
globalThis.fetch = async (u) => {
  const url = new URL(u);
  if (url.hostname === TEAM) { certCalls++; return certsDown ? new Response("", { status: 500 }) : new Response(JSON.stringify({ keys: [{ kid: "k1", kty: "RSA", alg: "RS256", use: "sig", n: pub.n, e: pub.e }] })); }
  providerCalls++;
  return new Response(JSON.stringify({ symbol: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", mic_code: "XNGS", currency: "USD", close: "250", previous_close: "248", is_market_open: false, last_quote_at: Math.floor(Date.now() / 1000) - 60 }));
};
const call = async (path, headers = {}, e = env) => { const r = await worker.fetch(new Request("https://alessandrozanichelli.com" + path, { headers }), e, ctx); const t = await r.text(); return { status: r.status, t, www: r.headers.get("www-authenticate") }; };

// ---------- unauthenticated ----------
for (const p of ["/api/quote?symbols=AAPL", "/api/history?symbol=AAPL&range=6M", "/api/search?q=Apple", "/api/yields", "/api/news?tickers=AAPL", "/api/briefing", "/api/health"]) {
  const r = await call(p);
  ok(`no token → 401 on ${p.split("?")[0]}, no data`, r.status === 401 && JSON.parse(r.t).error === "unauthenticated" && !/price|points|results|curves|items/.test(r.t) && /Cloudflare Access/.test(r.www || ""));
}
ok("no token → the provider is never called", providerCalls === 0);

// ---------- forged / wrong tokens ----------
let r = await call("/api/quote?symbols=AAPL", { "cf-access-jwt-assertion": "abc.def.ghi" });
ok("garbage token → 403", r.status === 403);
r = await call("/api/quote?symbols=AAPL", { "cf-access-jwt-assertion": await token({ key: evil.privateKey }) });
ok("token signed by another key (same kid) → 403 bad_signature", r.status === 403 && JSON.parse(r.t).error === "bad_signature");
r = await call("/api/quote?symbols=AAPL", { "cf-access-jwt-assertion": await token({ aud: ["another-app"] }) });
ok("token for another Access application (audience) → 403", r.status === 403 && JSON.parse(r.t).error === "wrong_audience");
r = await call("/api/quote?symbols=AAPL", { "cf-access-jwt-assertion": await token({ iss: "https://evil.cloudflareaccess.com" }) });
ok("token from another team (issuer) → 403", r.status === 403 && JSON.parse(r.t).error === "wrong_issuer");
r = await call("/api/quote?symbols=AAPL", { "cf-access-jwt-assertion": await token({ exp: Math.floor(Date.now() / 1000) - 10 }) });
ok("expired token → 401", r.status === 401 && JSON.parse(r.t).error === "token_expired");
const c0 = certCalls;
r = await call("/api/quote?symbols=AAPL", { "cf-access-jwt-assertion": await token({ kid: "unknown" }) });
ok("unknown key id → certs re-fetched once, then 403", r.status === 403 && JSON.parse(r.t).error === "unknown_key" && certCalls === c0 + 1);
ok("rejected tokens → the provider is never called", providerCalls === 0);

// ---------- valid Access session ----------
r = await call("/api/quote?symbols=AAPL", { "cf-access-jwt-assertion": await token() });
ok("valid token (header set by Access) → 200 with the real quote", r.status === 200 && JSON.parse(r.t).quotes.AAPL.fields.price.value === 250 && providerCalls === 1);
r = await call("/api/quote?symbols=AAPL", { cookie: `other=1; CF_Authorization=${await token()}` });
ok("valid Access cookie → 200", r.status === 200);
ok("responses never contain the provider key", !r.t.includes(KEY));

// ---------- fail closed ----------
r = await call("/api/quote?symbols=AAPL", { "cf-access-jwt-assertion": await token() }, { ...env, ACCESS_AUD: "" });
ok("Access not configured in the Worker → 503, no data (fail closed)", r.status === 503 && JSON.parse(r.t).error === "access_not_configured");
__resetAccessForTests(); certsDown = true;
r = await call("/api/quote?symbols=AAPL", { "cf-access-jwt-assertion": await token() });
ok("Access keys unreachable → 503, no data (fail closed)", r.status === 503 && JSON.parse(r.t).error === "access_keys_unavailable");
certsDown = false;

// ---------- non-API paths are not affected (static page is protected by Access at the edge) ----------
r = await call("/terminalX");
ok("non-/api path → normal 404 from the app, no data", r.status === 404);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
