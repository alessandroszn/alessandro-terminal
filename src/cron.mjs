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
import { getYieldCurves } from "./yields.mjs";
import { getWorldCalendar, getCalendar, archiveFF } from "./calendar.mjs";
import { getPress, PRESS } from "./press.mjs";

export const BUFFER_MIN = 2;  // minutes between the last staging run and the write (KV propagation)
export const SCHEDULE_UTC = ["* 5-7 * * *", "* 20-21 * * *"]; // covers the slots in both CET and CEST
const MIN = 60_000;

// inputs staged before a slot, one per minute; "retry" re-runs the first input that is still missing.
// The evening edition reads today's consolidated closes only after the US session is final (at the slot).
export function stepsFor(periods) {
  const has = (p) => periods.includes(p);
  const s = ["universe"];
  if (has("weekly")) s.push("ref:1W");
  if (has("monthly")) s.push("ref:1M");
  if (has("weekly") || has("monthly")) s.push("fxdaily");
  s.push("yields", "calendar", ...Object.keys(PRESS).map((id) => "press:" + id));
  if (!has("evening")) s.push("closes");
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
    if (minutes >= start && minutes < start + steps.length) return { action: "step", step: steps[minutes - start], steps, first: minutes === start, ...base };
    if (periods.includes("evening") && (rel === 0 || rel === 1)) return { action: "step", step: rel === 0 ? "closes" : "retry", steps: ["closes", ...steps], ...base };
    for (const p of periods) if (WRITE_RETRY.some((r) => rel === WRITE_OFFSET[p] + r)) return { action: "write", period: p, ...base };
  }
  return { action: "idle", date, minutes };
}

const closesKey = (now) => `spx/closes/recent/${easternDate(new Date(now))}`;
const fresh = (e, minAt) => !!(e && (e.data || e.rec) && e.fetchedAt >= minAt);

// is a step's input staged for this edition?
export async function isStaged(step, plan, store, now) {
  const since = plan.startAt - MIN;
  if (step === "universe") return fresh(await store.get("spx/universe"), now - 12 * 3600_000);
  if (step === "closes") return fresh(await store.get(closesKey(now)), plan.periods.includes("evening") ? plan.slotAt : since);
  if (step.startsWith("ref:")) { const ref = step.slice(4); return fresh(await store.get(`spx/closes/${ref}/${refTarget(ref, easternDate(new Date(now)))}`), now - 24 * 3600_000); }
  if (step === "fxdaily") return !!(await store.get(tdDailyKey(now)));
  if (step === "yields") return (await Promise.all(["yields/ea", "yields/us"].map((k) => store.get(k)))).some((e) => fresh(e, since));
  if (step === "calendar") return (await Promise.all(["calendar/FF", "calendar/BLS"].map((k) => store.get(k)))).some((e) => fresh(e, since));
  if (step.startsWith("press:")) { const id = step.slice(6); return (await Promise.all(PRESS[id].feeds.map(([sec]) => store.get(`press/${id}/${sec}`)))).some((e) => fresh(e, since)); }
  if (step === "fx") return (await Promise.all(MARKET_SYMS.map((s) => store.get(`quote/${encodeURIComponent(s)}`)))).every((e) => fresh(e, since));
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
  if (step === "yields") return ok(await getYieldCurves(origin, sctx, now));
  if (step === "calendar") { const w = await getWorldCalendar(origin, sctx, now); if (w.data) await archiveFF(env, w.data).catch(() => null); if (w.events.length) return "ok"; const c = await getCalendar(origin, sctx, now); return c.events.length ? "ok_us_only" : w.err || "no_data"; }
  if (step.startsWith("press:")) return ok(await getPress(origin, sctx, step.slice(6)));
  if (step === "fx") {
    if (!deps || !deps.fetchQuotes) return "quotes_not_configured";
    const res = await deps.fetchQuotes(MARKET_SYMS);
    let n = 0;
    for (const [s, r] of res) if (r && r.rec) { n++; await sctx.store.put(`quote/${encodeURIComponent(s)}`, { rec: r.rec, fetchedAt: Date.now() }, 86400); }
    return n === MARKET_SYMS.length ? "ok" : n ? "partial" : (res.find(([, r]) => r && r.err) || [])[1]?.err || "no_data";
  }
  if (step === "retry") {
    for (const s of plan.steps) if (s !== "retry" && !(await isStaged(s, plan, sctx.store, now))) return `${s}: ${await runStep(s, plan, origin, env, sctx, now, deps)}`;
    return "nothing_missing";
  }
  return "unknown_step";
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
    return { action: "write", period: plan.period, id: ed.id, result };
  } catch (e) {
    console.log(`[cron] ${plan.action} failed: ${e && e.name}`);
    return { action: plan.action, result: "error" };
  }
}
