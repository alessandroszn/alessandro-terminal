/* AZ TERMINAL — the public replay (/terminal/replay/, shown on /terminal/ to visitors without access).
   The page this script is loaded into is the real terminal (the Worker serves it from /terminal/desk/ with this script
   first, see src/replay.mjs). This script:
   - answers the terminal's /api requests from the RECORDING (/terminal/replay/recording.json): answers of official
     sources only (central banks, BIS, U.S. Treasury, FRED, CFTC, BLS, BEA), re-read and filtered by the Worker when the
     owner made it; anything else is answered "not in this recording" and the window shows N/A;
   - sets the page's clock to the time of the recording (and lets it run from there), so every date and age on screen
     is the one of the recording; a banner says it is a recording and when it was made;
   - types a few commands in the command line by itself, as a person would.
   It holds no data of its own and never fetches market data.
   ?rec=1 inside the owner's terminal (signed in): the same commands against the live /api, to list the requests the
   windows make; the Worker re-reads the official ones itself (POST /api/user/recording/take, /commit). */
(function () {
  "use strict";
  var realFetch = window.fetch.bind(window);
  var META = window.AZ_REC || null;
  var inFrameOfDesk = false;
  try { inFrameOfDesk = window.parent !== window && window.parent.location.origin === location.origin && window.parent.location.pathname.indexOf("/terminal/desk") === 0; } catch (e) { inFrameOfDesk = false; }
  var REC = new URLSearchParams(location.search).get("rec") === "1" && inFrameOfDesk;

  // this site's browser storage belongs to the owner's terminal: the replay keeps its settings in memory only
  var mem = {};
  var store = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
    setItem: function (k, v) { mem[k] = String(v); },
    removeItem: function (k) { delete mem[k]; },
    clear: function () { mem = {}; },
    key: function (i) { var ks = Object.keys(mem); return i < ks.length ? ks[i] : null; },
    get length() { return Object.keys(mem).length; }
  };
  try { Object.defineProperty(window, "localStorage", { configurable: true, get: function () { return store; } }); } catch (e) { /* the real storage stays */ }
  // the interface language chosen on /terminal/ (EN / IT), read by the terminal's i18n.js at its start
  var askedLang = new URLSearchParams(location.search).get("lang");
  if (askedLang === "en" || askedLang === "it") mem["at-lang"] = askedLang;

  // ---------- the clock of the recording ----------
  var t0 = META && META.t0 ? Date.parse(META.t0) : NaN;
  if (!REC && isFinite(t0)) {
    var RealDate = Date, offset = t0 - RealDate.now();
    var Shifted = function (a, b, c, d, e, f, g) {
      var n = arguments.length;
      if (!(this instanceof Shifted)) return new RealDate(RealDate.now() + offset).toString();
      if (n === 0) return new RealDate(RealDate.now() + offset);
      if (n === 1) return new RealDate(a);
      return new RealDate(a, b, n > 2 ? c : 1, n > 3 ? d : 0, n > 4 ? e : 0, n > 5 ? f : 0, n > 6 ? g : 0);
    };
    Shifted.prototype = RealDate.prototype;
    Shifted.now = function () { return RealDate.now() + offset; };
    Shifted.parse = RealDate.parse;
    Shifted.UTC = RealDate.UTC;
    window.Date = Shifted;
  }

  // ---------- /api: the recording (replay) or the live Worker, watched (owner's recording run) ----------
  var recording = null;
  var recP = !REC && META ? realFetch("/terminal/replay/recording.json", { cache: "no-cache" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) { recording = j; return j; }).catch(function () { return null; }) : Promise.resolve(null);
  var asked = [], inflight = 0, lastNet = 0;
  var urlOf = function (u) { try { return new URL(typeof u === "string" ? u : (u && u.url) || "", location.href); } catch (e) { return null; } };
  var answer = function (body, status) { return new Response(JSON.stringify(body), { status: status, headers: { "content-type": "application/json" } }); };
  var later = function (ms, v) { return new Promise(function (res) { setTimeout(function () { res(v); }, ms); }); };
  var sortedQuery = function (u) { var p = Array.from(u.searchParams.entries()).sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; }); return u.pathname + (p.length ? "?" + new URLSearchParams(p).toString() : ""); };
  function fromRecording(u) {
    var r = recording && recording.r;
    if (!r) return null;
    var key = u.pathname + u.search;
    if (r[key]) return r[key];
    var want = sortedQuery(u), same = [];
    for (var k in r) { var ku = urlOf(k); if (!ku || ku.pathname !== u.pathname) continue; if (sortedQuery(ku) === want) return r[k]; same.push(r[k]); }
    // the same route asked with other parameters (e.g. a date computed a moment later): only when it was recorded once
    return same.length === 1 && !u.search ? same[0] : null;
  }
  window.fetch = function (u, o) {
    var url = urlOf(u), method = String((o && o.method) || (u && u.method) || "GET").toUpperCase();
    if (!url || url.origin !== location.origin || url.pathname.indexOf("/api/") !== 0) return realFetch(u, o);
    if (REC) {
      if (method === "GET" && asked.indexOf(url.pathname + url.search) < 0) asked.push(url.pathname + url.search);
      inflight++; lastNet = Date.now();
      var p = realFetch(u, o);
      p.then(function () { inflight--; lastNet = Date.now(); }, function () { inflight--; lastNet = Date.now(); });
      return p;
    }
    if (url.pathname === "/api/health") return Promise.resolve(answer({ ok: true, recording: true }, 200));
    return recP.then(function () {
      var hit = method === "GET" ? fromRecording(url) : null;
      // a short wait, as the network would take: the windows show their loading state first
      return later(140 + (url.pathname.length % 5) * 60, hit ? answer(hit.b, hit.s || 200) : answer({ error: "not_recorded", status: "N/A" }, 404));
    });
  };

  // ---------- the script: commands typed in the command line ----------
  var L = function (en, it) { try { return window.I18N && window.I18N.lang() === "it" ? it : en; } catch (e) { return en; } };
  var STEPS = [
    { cmd: "CB", hold: 7000, say: ["Central banks — policy rates of about 40 banks as the BIS compiles them, with their last move and next decision", "Banche centrali — tassi ufficiali di circa 40 banche come li raccoglie la BRI, con l'ultima mossa e la prossima decisione"] },
    { cmd: "CURVE", hold: 7000, say: ["Yield curves — official government curves (U.S. Treasury, Bundesbank, Bank of England, Japan's Ministry of Finance)", "Curve dei rendimenti — curve ufficiali dei titoli di Stato (Tesoro USA, Bundesbank, Bank of England, Ministero delle Finanze giapponese)"] },
    { cmd: "BOND", hold: 7000, say: ["World government bonds — 2Y to 30Y from each official curve, changes and the spread over the Bund; TIPS and breakevens from FRED", "Titoli di Stato nel mondo — da 2 a 30 anni da ogni curva ufficiale, variazioni e spread sul Bund; TIPS e inflazione attesa da FRED"] },
    { cmd: "SPRD", hold: 1500, say: ["Spreads — any pair of yields; here the official 2s10s of the euro area (ECB) and of the United States (Federal Reserve)", "Spread — qualsiasi coppia di rendimenti; qui il 2s10s ufficiale dell'area euro (BCE) e degli Stati Uniti (Federal Reserve)"] },
    { click: "[data-spm=\"OFF\"]", hold: 6500 },
    { cmd: "COT", hold: 7000, say: ["Futures positioning — the CFTC's Commitments of Traders: speculators' net positions and their range", "Posizionamento sui futures — il Commitments of Traders della CFTC: posizioni nette degli speculatori e il loro intervallo"] },
    { cmd: "CAL", hold: 1500, say: ["Economic calendar — the U.S. official release schedules (BLS, BEA)", "Calendario economico — il calendario ufficiale delle pubblicazioni USA (BLS, BEA)"] },
    { click: "[data-cv=\"us\"]", hold: 6500 },
    { cmd: "TILE", hold: 4000, desk: true, say: ["Every window side by side — each one says where its data comes from and how fresh it is", "Tutte le finestre affiancate — ognuna dice da dove vengono i suoi dati e quanto sono recenti"] }
  ];
  var state = { i: -1, paused: false, done: false, started: false };
  var post = function (m) { try { if (window.parent !== window) window.parent.postMessage(Object.assign({ az: "replay" }, m), location.origin); } catch (e) { /* no parent */ } };
  var sleep = function (ms) { return new Promise(function (res) { setTimeout(res, ms); }); };
  async function holdFor(ms) { var left = ms; while (left > 0) { await sleep(200); if (!state.paused) left -= 200; } }
  async function whilePaused() { while (state.paused) await sleep(200); }
  async function idle(maxMs) { var start = Date.now(); await sleep(400); while (Date.now() - start < maxMs) { if (inflight === 0 && Date.now() - lastNet > 1200) return; await sleep(200); } }
  async function typeCmd(text) {
    var el = document.getElementById("cmd"); if (!el) return;
    el.classList.add("rp-typing"); el.value = "";
    for (var k = 0; k < text.length; k++) { await whilePaused(); el.value = text.slice(0, k + 1); if (!REC) await sleep(150); }
    if (!REC) await sleep(350);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    el.classList.remove("rp-typing");
  }
  async function run() {
    if (state.started) return; state.started = true;
    var phone = document.body.classList.contains("phone");
    if (!REC) await sleep(1200);
    for (var i = 0; i < STEPS.length; i++) {
      var s = STEPS[i]; state.i = i;
      if (s.desk && phone) continue;
      await whilePaused();
      if (s.say) { state.said = i; caption(L(s.say[0], s.say[1])); }
      if (s.cmd) await typeCmd(s.cmd);
      if (s.click) { var b = document.querySelector(s.click); if (b) b.click(); }
      post({ step: i, of: STEPS.length });
      if (REC) await idle(25000); else await holdFor(s.hold);
    }
    state.done = true;
    if (REC) return save();
    caption(L("End of the recording — ↺ plays it again. Type a function in the command line to look around.", "Fine della registrazione — ↺ la riproduce di nuovo. Scrivi una funzione nella riga di comando per esplorare."));
    post({ end: true });
  }

  // ---------- the owner's recording run: the Worker re-reads every official request itself ----------
  async function save() {
    var report = function (m) { post(Object.assign({ az: "rec" }, m)); };
    try {
      var info = await (await realFetch("/api/user/recording", { cache: "no-store" })).json();
      var routes = (info && info.routes) || [];
      var paths = asked.filter(function (p) { return routes.indexOf(p.split("?")[0]) >= 0; }).slice(0, 60);
      if (!paths.length) return report({ ok: false, error: "no_data" });
      var rid = Date.now().toString(36), n = 0;
      for (var i = 0; i < paths.length; i++) {
        await realFetch("/api/user/recording/take", { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ rid: rid, i: n, path: paths[i] }) }).then(function (r) { return r.json(); }).then(function (j) { if (j && j.ok) n++; }).catch(function () { return null; });
      }
      if (!n) return report({ ok: false, error: "no_data" });
      var c = await (await realFetch("/api/user/recording/commit", { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ rid: rid, n: n }) })).json();
      report(c && c.ok ? { ok: true, n: c.meta.n, bytes: c.meta.bytes } : { ok: false, error: (c && c.error) || "provider_error" });
    } catch (e) { report({ ok: false, error: "network" }); }
  }

  // ---------- the banner, the caption, the controls ----------
  var css = "#rpbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:5px 10px;background:var(--amber-soft);border-bottom:1px solid var(--amber);color:var(--fg);font-size:11.5px;line-height:1.4}" +
    "#rpbar b{color:var(--amber);letter-spacing:.08em}#rpbar .rp-cap{flex:1 1 320px;color:var(--fg)}#rpbar .rp-k{color:var(--muted)}" +
    "#rpbar button{font:inherit;color:var(--amber);background:transparent;border:1px solid var(--amber);border-radius:3px;padding:1px 8px;cursor:pointer}" +
    "#cmd.rp-typing{outline:1px solid var(--amber);outline-offset:1px}";
  function bar() {
    var b = document.getElementById("rpbar"); if (b) return b;
    var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
    b = document.createElement("div"); b.id = "rpbar"; b.setAttribute("role", "status");
    var net = document.getElementById("netbar"); if (net && net.parentNode) net.parentNode.insertBefore(b, net); else document.body.insertBefore(b, document.body.firstChild);
    return b;
  }
  var capText = "";
  function when() {
    if (!META || !isFinite(t0)) return "";
    try { return new Intl.DateTimeFormat(L("en-GB", "it-IT"), { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" }).format(new (window.Date)(t0)) + " " + L("Rome time", "ora di Roma"); } catch (e) { return META.t0; }
  }
  function paintBar() {
    var b = bar();
    var head = !META ? "<b>" + L("NO RECORDING YET", "NESSUNA REGISTRAZIONE ANCORA") + "</b> <span class='rp-k'>" + L("the owner has not recorded this terminal yet", "il proprietario non ha ancora registrato questo terminale") + "</span>"
      : "<b>" + L("RECORDING", "REGISTRAZIONE") + "</b> <span class='rp-k'>" + L("of", "del") + " " + when() + " · " + L("official sources only", "solo fonti ufficiali") + " · " + L("not real time", "non in tempo reale") + "</span>";
    // inside /terminal/ the page's own bar has ❚❚ and ↺; opened alone, the banner carries them
    b.innerHTML = head + "<span class='rp-cap'></span>" + (META && window.parent === window ? "<button type='button' data-rp='pause'>" + (state.paused ? "▶" : "❚❚") + "</button><button type='button' data-rp='again'>↺</button>" : "");
    b.querySelector(".rp-cap").textContent = capText;
    Array.prototype.forEach.call(b.querySelectorAll("[data-rp]"), function (x) { x.onclick = function () { if (x.dataset.rp === "again") location.reload(); else setPaused(!state.paused); }; });
  }
  function caption(t) { capText = t; if (!REC) paintBar(); }
  function setPaused(p) { state.paused = !!p; if (!REC) paintBar(); post({ paused: state.paused }); }
  window.addEventListener("message", function (e) {
    if (e.origin !== location.origin || !e.data || e.data.az !== "control") return;
    if (e.data.cmd === "pause") setPaused(true); else if (e.data.cmd === "play") setPaused(false); else if (e.data.cmd === "toggle") setPaused(!state.paused); else if (e.data.cmd === "again") location.reload();
    else if (e.data.cmd === "lang" && (e.data.lang === "en" || e.data.lang === "it")) {
      // the terminal's own EN / IT buttons: they repaint every window; then the banner and the caption in that language
      var b = document.querySelector('#cmdbar [data-lang="' + e.data.lang + '"]');
      if (b && window.I18N && window.I18N.lang() !== e.data.lang) b.click();
      if (state.done) capText = L("End of the recording — ↺ plays it again. Type a function in the command line to look around.", "Fine della registrazione — ↺ la riproduce di nuovo. Scrivi una funzione nella riga di comando per esplorare.");
      else if (state.said != null) capText = L(STEPS[state.said].say[0], STEPS[state.said].say[1]);
      else if (false) capText = L("End of the recording — ↺ plays it again. Type a function in the command line to look around.", "Fine della registrazione — ↺ la riproduce di nuovo. Scrivi una funzione nella riga di comando per esplorare.");
      if (!REC) paintBar();
    }
  });

  // the terminal calls this at the end of its start (boot): no quotes polled, no alerts, no service worker
  window.AZ_REPLAY = {
    mode: REC ? "rec" : "play",
    ready: function () {
      if (!REC) paintBar();
      post({ ready: true, empty: !META && !REC });
      if (REC || META) run();
    },
    state: state
  };
})();
