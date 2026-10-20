// SCHEDULED EDITIONS (Cron Trigger) — the briefings are written at their time (Rome), whether or not the
// terminal is open: Daily 07:30 and Evening 22:30 (Mon–Fri), Weekly 08:00 (Sat), Monthly 08:00 (first Sat).
//
// Free plan: 10 ms CPU per run, so one run does one thing. In the minutes before the slot each run fetches
// ONE source (the same loaders the terminal uses, one per request) and stages it in Workers KV; at the slot
// the edition is written from the staged data only — no source is called while writing — exactly like
// POST /api/briefs/write. Runs execute in any Cloudflare location, which is why staging uses KV and not
// the per-location cache. Nothing is estimated: an input that could not be fetched is simply absent and
// listed in the edition's inputErrors, as for an edition written from the terminal.
import { kvStore, easternDate } from "./lib.mjs";
import { romeNow, isSlotDay, SLOT_MIN, MARKET_SYMS, PERIODS, dueEdition, writeEdition, kvJson, tdDaily, tdDailyKey, WRITE_OFFSET, WRITE_RETRY } from "./briefs.mjs";
import { getUniverse, getCloses, alpacaConfigured, refTarget } from "./spx.mjs";
import { getYieldCurves, CURVES } from "./yields.mjs";
import { BRIEF_CURVES } from "./briefs.mjs";
import { getWorldCalendar, getCalendar, archiveFF, archivedFF } from "./calendar.mjs";
import { getPress, PRESS, BRIEF_PRESS } from "./press.mjs";
import { INDICES, getIndexGroup, getIndexHistory } from "./indices.mjs";
import { getEcbFx, ecbFxKey, getImf, IMF_KEY } from "./markets.mjs";
import { getEnergySpot } from "./macro.mjs";
import { BRIEF_ECB_N, CRYPTO_SYMS, tailKey, tailOf, BRIEF_HIST } from "./briefmkt.mjs";

export const BUFFER_MIN = 2;  // minutes between the last staging run and the write (KV propagation)
export const SCHEDULE_UTC = ["* 5-7 * * *", "* 20-21 * * *"]; // covers the slots in both CET and CEST
const MIN = 60_000;

// inputs staged before a slot, one per minute; "retry" re-runs an input that is still missing.
// The evening edition reads today's consolidated closes and the U.S. index closes only after the US session is
// final: those two are staged after the slot (EVENING_AFTER), and the edition is written two minutes later.
export const EVENING_AFTER = ["closes", "idx:us", "retry"];
export function stepsFor(periods) {
  const has = (p) => periods.includes(p), long = has("weekly") || has("monthly");
  const s = ["universe"];
  if (has("weekly")) s.push("ref:1W");
  if (has("monthly")) s.push("ref:1M");
  if (long) s.push("fxdaily");
  s.push("yields", ...BRIEF_CURVES.filter((id) => id !== "US" && id !== "EA").map((id) => "bonds:" + id), "calendar", ...BRIEF_PRESS.map((id) => "press:" + id));
  // markets (20 Oct 2026): world indices, the ECB fixing, energy, crypto pairs; for a week / a month also each U.S. / MSCI
  // index's daily history (one file per minute) and the crypto closes a week / a month ago; IMF prices monthly
  s.push("idx:eu", "idx:sec", "idx:sec2", "idx:asia", "idx:world", "ecbfx", "energy", "crypto");
  if (has("weekly")) s.push("crypto:1W");
  if (has("monthly")) s.push("crypto:1M", "imf");
  if (long) s.push(...BRIEF_HIST.map((id) => "idxh:" + id));
  if (!has("evening")) s.push("idx:us", "closes");
  s.push("fx", "retry", "retry");
  return s;
}

// what this minute's run does (Rome time; DST handled by the time zone, not by the cron expression)
export function cronPlan(now = Date.now()) {
  const { date, minutes } = romeNow(now);
  const slots = {};
  for (const p of Object.keys(PERIODS)) if (isSlotDay(p, date)) (slots[SLOT_MIN[p]] = slots[SLOT_MIN[p]] || []).push(p);
  for (const [t, periods] of Object.entries(slots)) {
    const T = Number(t), steps = stepsFor(periods), start = T - steps.length - BUFFER_MIN, rel = minutes - T;
    const base = { date, periods, slotAt: now - rel * MIN, startAt: now - (minutes - start) * MIN };
    // the k-th retry of this slot (retries take turns over the inputs still missing: one failing source
    // must not use up every retry while another missing input waits behind it)
    if (minutes >= start && minutes < start + steps.length) { const i = minutes - start; return { action: "step", step: steps[i], steps, first: minutes === start, retryNo: steps.slice(0, i).filter((x) => x === "retry").length, ...base }; }
    if (periods.includes("evening") && rel >= 0 && rel < EVENING_AFTER.length) return { action: "step", step: EVENING_AFTER[rel], steps: [...EVENING_AFTER.filter((x) => x !== "retry"), ...steps], retryNo: steps.filter((x) => x === "retry").length, ...base };
    for (const p of periods) if (WRITE_RETRY.some((r) => rel === WRITE_OFFSET[p] + r)) return { action: "write", period: p, ...base };
  }
  return { action: "idle", date, minutes };
}

const closesKey = (now) => `spx/closes/recent/${easternDate(new Date(now))}`;
const utcDay = (now) => new Date(now).toISOString().slice(0, 10);
// the staged copy of one index: its own source, or the FRED close standing in for Cboe
const idxKeys = (ix) => ({ cboe: [`idx/q/${ix.id}`, ...(ix.fred ? [`idx/fred/${ix.fred}`] : [])], stoxx: [`idx/stoxx/${ix.file}`], nikkei: ["idx/nikkei"], fred: [`idx/fred/${ix.series}`],
  six: [`idx/six/q/${ix.id}`], sse: [`idx/sse/q/${ix.id}`], b3: [`idx/b3/h/${ix.id}`], asx: [`idx/asx/${ix.id}`], cnbc: [`idx/cnbc/q/${ix.g}`] })[ix.src] || [];
const anyFresh = async (store, keys, minAt) => (await Promise.all(keys.map((k) => store.get(k)))).some((e) => fresh(e, minAt));
const fresh = (e, minAt) => !!(e && (e.data || e.rec) && e.fetchedAt >= minAt);

// is a step's input staged for this edition?
export async function isStaged(step, plan, store, now) {
  const since = plan.startAt - MIN;
  if (step === "universe") return fresh(await store.get("spx/universe"), now - 12 * 3600_000);
  if (step === "closes") return fresh(await store.get(closesKey(now)), plan.periods.includes("evening") ? plan.slotAt : since);
  if (step.startsWith("ref:")) { const ref = step.slice(4); return fresh(await store.get(`spx/closes/${ref}/${refTarget(ref, easternDate(new Date(now)))}`), now - 24 * 3600_000); }
  if (step === "fxdaily") return !!(await store.get(tdDailyKey(now)));
  if (step === "yields") return (await Promise.all(["yields/ea", "yields/us", "yields/us-fred"].map((k) => store.get(k)))).some((e) => fresh(e, since));
  if (step.startsWith("bonds:")) return fresh(await store.get(CURVES[step.slice(6)].key), since);
  if (step === "calendar") return (await Promise.all(["calendar/FF", "calendar/BLS"].map((k) => store.get(k)))).some((e) => fresh(e, since));
  if (step.startsWith("press:")) { const id = step.slice(6); return (await Promise.all(PRESS[id].feeds.map(([sec]) => store.get(`press/${id}/${sec}`)))).some((e) => fresh(e, since)); }
  if (step === "fx") return (await Promise.all(MARKET_SYMS.map((s) => store.get(`quote/${encodeURIComponent(s)}`)))).every((e) => fresh(e, since));
  if (step.startsWith("idx:")) { const g = step.slice(4), minAt = g === "us" && plan.periods.includes("evening") ? plan.slotAt : since;
    return (await Promise.all(INDICES.filter((x) => x.g === g).map((ix) => anyFresh(store, idxKeys(ix), minAt)))).every(Boolean); }
  if (step.startsWith("idxh:")) return fresh(await store.get(tailKey(step.slice(5))), now - 24 * 3600_000);
  if (step === "ecbfx") return fresh(await store.get(ecbFxKey(BRIEF_ECB_N)), since);
  if (step === "energy") return anyFresh(store, ["fred/energy/v1", "eia/spot/petroleum/pri/spt"], since);
  if (step === "crypto") return fresh(await store.get(`map/CRYPTO/closes/recent/${utcDay(now)}`), since);
  if (step.startsWith("crypto:")) { const ref = step.slice(7); return !!(await store.get(`map/CRYPTO/closes/${ref}/${refTarget(ref, utcDay(now))}`)); }
  if (step === "imf") return fresh(await store.get(IMF_KEY), now - 24 * 3600_000);
  return true;
}

// fetch one input and stage it (the loaders write through ctx.store)
export async function runStep(step, plan, origin, env, sctx, now, deps) {
  const ro = { ...sctx, readOnly: true };
  const ok = (r) => (r && (r.data || (r.curves && Object.keys(r.curves).length) || (Array.isArray(r) && r.some((x) => x.data))) ? "ok" : (r && (r.err || (Array.isArray(r) && (r.find((x) => x.err) || {}).err))) || "no_data");
  if (step === "universe") return ok(await getUniverse(origin, sctx));
  if (step === "closes" || step.startsWith("ref:")) {
    if (!alpacaConfigured(env)) return "alpaca_not_configured";
    const u = await getUniverse(origin, ro); // staged one step earlier: no second heavy load in this run
    if (!u.data) return "universe_not_staged";
    return ok(await getCloses(origin, env, sctx, step === "closes" ? "recent" : step.slice(4), u.data.items.map((x) => x.sym), now));
  }
  if (step === "fxdaily") return (await tdDaily(env, MARKET_SYMS, now, origin, sctx)) ? "ok" : "no_data";
  if (step === "yields") return ok(await getYieldCurves(origin, sctx, now, env));
  if (step.startsWith("bonds:")) return ok(await getYieldCurves(origin, sctx, now, env, [step.slice(6)])); // one country per run
  if (step === "calendar") {
    const w = await getWorldCalendar(origin, sctx, now);
    if (w.data) { await archiveFF(env, w.data).catch(() => null); if (w.events.length) return "ok"; }
    // Forex Factory refuses the scheduled runs (every edition since 7 Oct lacked it) while it answers the terminal:
    // stage this week's export as the terminal last fetched and archived it (at most 3 days old), with that time
    const a = await archivedFF(env, now);
    if (a) { await sctx.store.put("calendar/FF", { data: a.raw, fetchedAt: a.at, archived: true }, 86400); return `ff_${w.err || "no_data"}; archive_${new Date(a.at).toISOString().slice(0, 16)}`; }
    const c = await getCalendar(origin, sctx, now);
    return `ff_${w.err || "no_data"}; ${c.events.length ? "us_only" : "no_events"}`;
  }
  if (step.startsWith("press:")) return ok(await getPress(origin, sctx, step.slice(6)));
  if (step.startsWith("idx:")) {
    const rows = await getIndexGroup({ origin }, env, sctx, step.slice(4), now), bad = rows.filter((r) => r.status === "N/A");
    return !bad.length ? "ok" : bad.length < rows.length ? `partial: ${bad.map((r) => `${r.id} ${r.error || "no_data"}`).join(", ")}` : (bad[0] && bad[0].error) || "no_data";
  }
  if (step.startsWith("idxh:")) {
    const ix = INDICES.find((x) => x.id === step.slice(5)); if (!ix) return "unknown_index";
    const h = await getIndexHistory({ origin }, env, sctx, ix);
    if (!h.points) return h.error || "no_data";
    await sctx.store.put(tailKey(ix.id), tailOf(h), 3 * 86400); // the rows an edition needs, without the ten-year file
    return "ok";
  }
  if (step === "ecbfx") return ok(await getEcbFx(origin, sctx, BRIEF_ECB_N));
  if (step === "energy") { const e = await getEnergySpot(origin, env, sctx); return e.spot ? "ok" : e.err || "no_data"; }
  if (step === "crypto" || step.startsWith("crypto:")) {
    if (!alpacaConfigured(env)) return "alpaca_not_configured";
    return ok(await getCloses(origin, env, sctx, step === "crypto" ? "recent" : step.slice(7), CRYPTO_SYMS, now, "CRYPTO"));
  }
  if (step === "imf") return ok(await getImf(origin, env, sctx));
  if (step === "fx") {
    if (!deps || !deps.fetchQuotes) return "quotes_not_configured";
    const res = await deps.fetchQuotes(MARKET_SYMS);
    let n = 0;
    for (const [s, r] of res) if (r && r.rec) { n++; await sctx.store.put(`quote/${encodeURIComponent(s)}`, { rec: r.rec, fetchedAt: Date.now() }, 86400); }
    return n === MARKET_SYMS.length ? "ok" : n ? "partial" : (res.find(([, r]) => r && r.err) || [])[1]?.err || "no_data";
  }
  if (step === "retry") {
    const missing = [];
    for (const s of plan.steps) if (s !== "retry" && !missing.includes(s) && !(await isStaged(s, plan, sctx.store, now))) missing.push(s);
    if (!missing.length) return "nothing_missing";
    const s = missing[(plan.retryNo || 0) % missing.length];
    return `${s}: ${await runStep(s, plan, origin, env, sctx, now, deps)}`;
  }
  return "unknown_step";
}

// what did not work in the scheduled runs (shown in SYS; the Worker's own logs are off on this account)
export async function logCronIssue(env, now, step, result) {
  try { const t = await env.BRIEFS.get("cron/issues"); const L = t ? JSON.parse(t) : []; L.unshift({ at: new Date(now).toISOString(), step, result: String(result).slice(0, 160) }); await env.BRIEFS.put("cron/issues", JSON.stringify(L.slice(0, 20))); } catch { /* best effort */ }
}
export async function runCron(scheduledTime, env, ctx, deps = {}) {
  const now = Number(scheduledTime) || Date.now();
  const plan = cronPlan(now);
  if (plan.action === "idle" || !env.BRIEFS) return { action: plan.action };
  const origin = env.ALLOWED_ORIGIN || "https://alessandrozanichelli.com";
  const store = kvStore(env.BRIEFS);
  const sctx = { store, waitUntil: (p) => ctx.waitUntil(p) };
  try {
    if (plan.action === "step") {
      if (plan.first) ctx.waitUntil(env.BRIEFS.put("cron/last", JSON.stringify({ at: new Date(now).toISOString(), periods: plan.periods, slotAt: new Date(plan.slotAt).toISOString() })));
      const result = await runStep(plan.step, plan, origin, env, sctx, now, deps);
      console.log(`[cron] ${plan.periods.join("+")} step ${plan.step}: ${result}`);
      if (!/^(ok|nothing_missing)$/.test(result) && !/: ok$/.test(result)) ctx.waitUntil(logCronIssue(env, now, plan.step, result));
      return { action: "step", step: plan.step, result };
    }
    // write: only the edition of this slot, only once, only from staged data
    const ed = dueEdition(plan.period, now);
    if (!ed || ed.d !== plan.date || !ed.writable) return { action: "write", period: plan.period, result: "not_due" };
    if (await kvJson(env, `brief/${ed.id}`)) return { action: "write", period: plan.period, result: "exists" };
    if (!env.AI || typeof env.AI.run !== "function") return { action: "write", period: plan.period, result: "model_unavailable" };
    const r = await writeEdition(origin, env, { ...sctx, readOnly: true }, plan.period, ed, MARKET_SYMS, now, false, "schedule");
    const result = r.status === 201 ? "written" : r.status === 202 ? "in_progress" : (r.body && r.body.error) || `http_${r.status}`;
    console.log(`[cron] write ${ed.id}: ${result}`);
    if (result !== "written" && result !== "in_progress") ctx.waitUntil(logCronIssue(env, now, "write " + ed.id, result));
    return { action: "write", period: plan.period, id: ed.id, result };
  } catch (e) {
    console.log(`[cron] ${plan.action} failed: ${e && e.name}`);
    return { action: plan.action, result: "error" };
  }
}
