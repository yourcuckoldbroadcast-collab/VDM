/* ===========================================================================
   VDM — Velocity Decay Monitor (web edition)
   Port of VDM v3.3 "Phoenix" CLI by @YCBRoadcast.
   Engine math (velocity / decay / chase) is a faithful port of VelocityEngine,
   including the v3.3 data-quality guards and graceful degradation.
   Ranking-trigger / bot-deployment logic is intentionally NOT included.
   =========================================================================== */
"use strict";

/* ─────────────────────────── ENGINE ─────────────────────────── */
const H = 3600000;
const now = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();
const ageHours = (s) => (now() - new Date(s).getTime()) / H;
const sortedHist = (h) => [...h].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

function parseNum(raw){                                  // "1,234" "1.2k" "5K" -> number | null
  if (raw == null) return null;
  let s = String(raw).trim().toLowerCase().replace(/,/g, "");
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([km])?$/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (m[2] === "k") n *= 1e3; else if (m[2] === "m") n *= 1e6;
  return n < 0 ? null : n;
}

function velocityAverage(postISO, views){                // views / umur(jam)
  if (!postISO || views == null) return null;
  const hrs = ageHours(postISO);
  if (hrs <= 0) return { velocity: 0, hours: 0 };
  return { velocity: views / hrs, hours: hrs };
}

function velocityRolling(history, win){                  // laju pada jendela terakhir
  if (!history || history.length < 2) return null;
  const cutoff = now() - win * H;
  let recent = history.map(h => [new Date(h.timestamp).getTime(), +h.views]).filter(p => p[0] >= cutoff);
  if (recent.length < 2) recent = history.slice(-2).map(h => [new Date(h.timestamp).getTime(), +h.views]);
  recent.sort((a, b) => a[0] - b[0]);
  const [t0, v0] = recent[0], [t1, v1] = recent[recent.length - 1];
  const span = (t1 - t0) / H;
  if (span <= 0) return null;
  if (v1 < v0) return null;                              // v3.3 guard: views tak mungkin turun
  return (v1 - v0) / span;
}

function fitDecay(history, cfg){                         // v(t)=v0*exp(-lam*t), OLS log-linear
  const minPts = cfg.decay_min_points, minSpan = cfg.decay_min_span_hours;
  if (!history || history.length < minPts) return null;
  let pts = history.filter(h => +h.velocity > 0).map(h => [new Date(h.timestamp).getTime(), +h.velocity]);
  if (pts.length < minPts) return null;
  pts.sort((a, b) => a[0] - b[0]);
  const t0 = pts[0][0];
  const xs = pts.map(p => (p[0] - t0) / H), ys = pts.map(p => Math.log(p[1]));
  if (xs[xs.length - 1] - xs[0] < minSpan) return null;  // v3.3 guard: rentang waktu minimum
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++){ num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  if (den === 0) return null;
  const b = num / den, a = my - b * mx;
  return { v0: Math.exp(a), lam: -b, t0 };
}

function projectVelocity(history, hoursAhead, cfg){
  const fit = fitDecay(history, cfg); if (!fit) return null;
  const h = sortedHist(history);
  const tLast = (new Date(h[h.length - 1].timestamp).getTime() - fit.t0) / H;
  return fit.v0 * Math.exp(-fit.lam * (tLast + hoursAhead));
}

function timeUntilVelocity(history, target, cfg){        // jam sampai laju jatuh ke target
  const fit = fitDecay(history, cfg); if (!fit) return null;
  if (fit.lam <= 0 || target <= 0 || target >= fit.v0) return null;
  const h = sortedHist(history);
  const tLast = (new Date(h[h.length - 1].timestamp).getTime() - fit.t0) / H;
  const tTarget = Math.log(fit.v0 / target) / fit.lam;
  const horizon = Math.max(0, tTarget - tLast);
  if (horizon < cfg.projection_min_horizon_hours) return null;   // v3.3 guard: horizon minimum
  return horizon;
}

function decayInfo(lam){
  return { halfLife: Math.log(2) / lam, label: lam < 0.1 ? "lambat" : lam < 0.6 ? "sedang" : "cepat" };
}

function sigmoid(x){ try { return 1 / (1 + Math.exp(-x)); } catch (e) { return x < 0 ? 0 : 1; } }

/* faithful port of VelocityEngine.chase_probability (push_effectiveness=1, panic=false) */
function chaseProbability(ourViews, ourVel, oppViews, oppVel, ageH, chapterGrowth, cfg){
  const C = cfg.chase_coef;
  if (oppVel > 0 && ourVel > 0){
    const vr = oppVel / ourVel;
    if (vr >= 3.0) return cfg.rule_3x_probability;
    if (vr >= 2.0) return cfg.rule_2x_probability;
  }
  const gf = chapterGrowth >= cfg.viral_threshold ? 1.2 : chapterGrowth >= cfg.organic_target ? 1.1 : 1.0;
  const gap = Math.max(0, oppViews - ourViews) / (ourViews + 1);
  const vr2 = ourVel / Math.max(oppVel, 0.01);
  return sigmoid(C.velocity_ratio * vr2 * gf + C.view_gap * gap + C.push_effectiveness * 1.0 + C.age_decay * Math.log(ageH + 1));
}

/* ─────────────────────── ADVICE (RulesEngine, author-action only) ───────────────────────
   Port of RulesEngine.check() classifier. Recommendations are things the AUTHOR does;
   the bot/roster-deployment lines from the original catalog are intentionally dropped. */
const ADVICE = {
  KRITIS:  ["Posting bab berikutnya sekarang untuk mengangkat thread", "Balas komentar pembaca terbaru", "Tutup adegan terakhir dengan cliffhanger agar pembaca kembali"],
  HAL2:    ["Rilis bab baru sebagai prioritas", "Balas semua komentar yang menggantung", "Buka pertanyaan diskusi untuk memancing balasan"],
  SUNYI:   ["View naik tapi sepi interaksi — pancing diskusi", "Ajukan pertanyaan terbuka ke pembaca", "Tambahkan teaser bab depan"],
  STAGNAN: ["Suntik konten/update segar", "Akhiri bab dengan hook kuat", "Sapa pembaca lama, angkat momen favorit"],
  SEHAT:   ["Thread sehat — pertahankan ritme posting normalmu"],
};
function assess(st, hist){
  const page = +st.page || 1, pos = +st.position || 1, lc = +st.last_comment_min || 0;
  if (page === 1 && pos >= 14 && lc >= 18) return { sev: "RED",    name: "Posisi kritis",      advice: ADVICE.KRITIS };
  if (page >= 2)                            return { sev: "RED",    name: "Sudah di halaman 2",  advice: ADVICE.HAL2 };
  let gr = null;                                                       // growth rate (views/menit) dari 2 sampel terakhir
  const h = sortedHist(hist);
  if (h.length >= 2){ const a = h[h.length - 2], b = h[h.length - 1];
    const dt = (new Date(b.timestamp) - new Date(a.timestamp)) / 60000; if (dt > 0) gr = (b.views - a.views) / dt; }
  if (gr != null && lc > 25 && gr > 1.0)            return { sev: "YELLOW", name: "Pertumbuhan sunyi", advice: ADVICE.SUNYI };
  if (gr != null && lc > 20 && gr > 0 && gr <= 0.5) return { sev: "ORANGE", name: "Thread stagnan",    advice: ADVICE.STAGNAN };
  return { sev: "GREEN", name: "Sehat", advice: ADVICE.SEHAT };
}

/* ─────────────────────────── LEDGER (chapters) ─────────────────────────── */
function chapterAdd(views, name){
  const ch = S.chapters;
  const start = ch.length ? ch[ch.length - 1].views : views;
  ch.push({ chapter: name || ("Bab " + (ch.length + 1)), start_views: Math.round(start), views: Math.round(views), timestamp: iso(now()) });
}
function growthBetween(i){
  const ch = S.chapters;
  if (i < 0 || i >= ch.length) return 0;
  if (i === 0) return ch[0].views;
  return ch[i].views - ch[i - 1].views;
}
function growthInChapter(rec){ return rec ? rec.views - rec.start_views : 0; }

/* ─────────────────────────── FORMAT ─────────────────────────── */
const fmtInt = (n) => Math.round(n).toLocaleString("id-ID");
const fmt1   = (n) => (Math.round(n * 10) / 10).toLocaleString("id-ID");
function fmtHours(h){
  if (h < 1) return Math.round(h * 60) + "m";
  if (h < 24) return fmt1(h) + "j";
  const d = Math.floor(h / 24), r = Math.round(h % 24);
  return r ? d + "h " + r + "j" : d + "h";
}
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const HM2min = (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + m; };

/* ─────────────────────────── STATE + STORAGE (IndexedDB) ─────────────────────────── */
const SCHEMA = 3;
const DEFAULT_CFG = {
  rolling_window_hours: 1.0, decay_min_points: 3, decay_min_span_hours: 0.5,
  projection_min_horizon_hours: 0.5, trend_min_history_points: 5,
  projection_target: 5, organic_target: 4000, viral_threshold: 5000,
  rule_3x_probability: 0.05, rule_2x_probability: 0.20,
  chase_coef: { velocity_ratio: 2.5, view_gap: -1.2, push_effectiveness: 0.7, age_decay: -0.6 },
  posting_windows: [
    { name: "Pagi",        start: "07:00", end: "08:30" },
    { name: "Siang",       start: "11:00", end: "13:00" },
    { name: "Sore",        start: "16:00", end: "16:30" },
    { name: "Malam 1",     start: "18:00", end: "18:30" },
    { name: "Malam 2",     start: "19:00", end: "20:00" },
    { name: "Pra-posting", start: "20:30", end: "20:45" },
  ],
  notify_windows: false,
};
/* placeholder contacts — swap for your real beta-reader team anytime */
const DEFAULT_READERS = [
  "NTR_Ravine","Hinelle_","ChiqUser","Persona1913","Attariq_Id","UkhtiRisa","Andra_M",
  "Shika_Nara","TiaraHubby","GilangRED","Nadya_Rev","Aisyah980","Rey_Antariksa","Morgiana_ft","Fahri_nbb"
].map((n, i) => ({ id: "r" + i, name: n, note: "" }));
function freshSession(){
  return { schema_version: SCHEMA, my_thread: { title: "", post_time: null, views: null },
           velocity_history: [], watchlist: [], chapters: [],
           beta_readers: structuredClone(DEFAULT_READERS), feedback: {}, current_draft: "",
           thread_status: { page: 1, position: 1, last_comment_min: 0 },
           config: structuredClone(DEFAULT_CFG) };
}
function migrate(d){
  if (!d || typeof d !== "object") return freshSession();
  d.schema_version = d.schema_version || 1;
  d.my_thread = d.my_thread || { title: "", post_time: null, views: null };
  d.velocity_history = d.velocity_history || [];
  d.watchlist = d.watchlist || [];
  if (d.schema_version < 2) d.chapters = d.chapters || [];   // v1 -> v2: introduce chapter ledger
  d.chapters = d.chapters || [];
  if (d.schema_version < 3){ d.beta_readers = d.beta_readers || structuredClone(DEFAULT_READERS); d.feedback = d.feedback || {}; d.thread_status = d.thread_status || { page: 1, position: 1, last_comment_min: 0 }; }
  d.beta_readers = d.beta_readers || [];
  d.feedback = d.feedback || {};
  d.current_draft = d.current_draft || "";
  d.thread_status = d.thread_status || { page: 1, position: 1, last_comment_min: 0 };
  d.config = Object.assign(structuredClone(DEFAULT_CFG), d.config || {});
  if (!Array.isArray(d.config.posting_windows) || !d.config.posting_windows.length)
    d.config.posting_windows = structuredClone(DEFAULT_CFG.posting_windows);
  d.config.chase_coef = Object.assign(structuredClone(DEFAULT_CFG.chase_coef), d.config.chase_coef || {});
  d.schema_version = SCHEMA;
  return d;
}

const DB_NAME = "vdm-db", STORE = "kv", KEY = "session";
function openDB(){
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function dbGet(){
  try {
    const db = await openDB();
    return await new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      tx.onsuccess = () => res(tx.result || null); tx.onerror = () => rej(tx.error);
    });
  } catch (e) { console.warn("IDB read failed", e); return null; }
}
let memFallback = null;
async function dbSet(obj){
  try {
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(obj, KEY);
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });
    return true;
  } catch (e) { console.warn("IDB write failed; using memory", e); memFallback = obj; return false; }
}

let S = null;
async function loadSession(){ const d = await dbGet(); return migrate(d || memFallback || freshSession()); }
async function saveSession(){ await dbSet(S); }

/* undo */
const undoStack = [];
function snapshot(){ undoStack.push(JSON.stringify(S)); if (undoStack.length > 20) undoStack.shift(); updateHdr(); }
async function undo(){ if (!undoStack.length) return; S = migrate(JSON.parse(undoStack.pop())); await saveSession(); render(); updateHdr(); toast("Diurungkan"); }

/* mutation helper: snapshot -> change -> persist -> re-render */
async function mutate(fn){ snapshot(); fn(); await saveSession(); render(); }

/* ─────────────────────────── CHARTS (SVG) ─────────────────────────── */
function velocityChart(history, cfg){
  const W = 700, Hh = 300, pad = { l: 48, r: 16, t: 18, b: 34 };
  const pts = sortedHist(history).filter(h => +h.velocity > 0).map(h => ({ x: new Date(h.timestamp).getTime(), y: +h.velocity }));
  if (pts.length < 2)
    return `<svg viewBox="0 0 ${W} ${Hh}" role="img"><text x="${W/2}" y="${Hh/2}" fill="#5c6573" font-family="Spline Sans Mono,monospace" font-size="14" text-anchor="middle">grafik muncul setelah ≥2 sampel</text></svg>`;
  const t0 = pts[0].x;
  const xs = pts.map(p => (p.x - t0) / H);
  const fit = fitDecay(history, cfg);
  const target = cfg.projection_target;
  let maxX = xs[xs.length - 1];
  if (fit) maxX = Math.max(maxX, xs[xs.length - 1] * 1.35 + 0.5);
  let maxY = Math.max(...pts.map(p => p.y).concat([target])) * 1.12, minY = 0;
  const X = (h) => pad.l + (h / (maxX || 1)) * (W - pad.l - pad.r);
  const Y = (v) => Hh - pad.b - ((v - minY) / ((maxY - minY) || 1)) * (Hh - pad.t - pad.b);
  let grid = "";
  for (let i = 0; i <= 4; i++){ const v = minY + (maxY - minY) * i / 4, y = Y(v);
    grid += `<line x1="${pad.l}" y1="${y}" x2="${W-pad.r}" y2="${y}" stroke="#1d242f"/>`;
    grid += `<text x="${pad.l-8}" y="${y+4}" fill="#5c6573" font-family="Spline Sans Mono,monospace" font-size="10" text-anchor="end">${fmtInt(v)}</text>`; }
  let xlab = ""; const xt = Math.min(5, pts.length);
  for (let i = 0; i < xt; i++){ const h = maxX * i / (xt - 1 || 1);
    xlab += `<text x="${X(h)}" y="${Hh-12}" fill="#5c6573" font-family="Spline Sans Mono,monospace" font-size="10" text-anchor="middle">${fmtHours(h)}</text>`; }
  let tl = "";
  if (target < maxY){ const y = Y(target);
    tl = `<line x1="${pad.l}" y1="${y}" x2="${W-pad.r}" y2="${y}" stroke="#e5564e" stroke-width="1.4" stroke-dasharray="5 5" opacity=".75"/>
      <text x="${W-pad.r}" y="${y-6}" fill="#e5564e" font-family="Spline Sans Mono,monospace" font-size="10" text-anchor="end">target ${fmtInt(target)} v/j</text>`; }
  let fp = "";
  if (fit){ let d = ""; for (let i = 0; i <= 48; i++){ const h = maxX*i/48, v = fit.v0*Math.exp(-fit.lam*h); d += (i?"L":"M")+X(h).toFixed(1)+" "+Y(v).toFixed(1)+" "; }
    fp = `<path d="${d}" fill="none" stroke="#46c5b4" stroke-width="2" stroke-dasharray="6 4" opacity=".9"/>`; }
  let line = "", area = `M ${X(xs[0])} ${Y(0)} `, dots = "";
  pts.forEach((p, i) => { const x = X(xs[i]), y = Y(p.y); line += (i?"L":"M")+x.toFixed(1)+" "+y.toFixed(1)+" "; area += `L ${x.toFixed(1)} ${y.toFixed(1)} `;
    dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.4" fill="#0c0f14" stroke="#ffb43a" stroke-width="2"/>`; });
  area += `L ${X(xs[xs.length-1])} ${Y(0)} Z`;
  return `<svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="laju terhadap waktu">
    <defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb43a" stop-opacity=".22"/><stop offset="1" stop-color="#ffb43a" stop-opacity="0"/></linearGradient></defs>
    ${grid}${xlab}${tl}<path d="${area}" fill="url(#ag)"/>${fp}
    <path d="${line}" fill="none" stroke="#ffb43a" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>${dots}</svg>`;
}

function growthChart(){
  const ch = S.chapters, W = 700, Hh = 280, pad = { l: 44, r: 14, t: 16, b: 40 };
  if (!ch.length)
    return `<svg viewBox="0 0 ${W} ${Hh}" role="img"><text x="${W/2}" y="${Hh/2}" fill="#5c6573" font-family="Spline Sans Mono,monospace" font-size="14" text-anchor="middle">belum ada bab</text></svg>`;
  const vals = ch.map((_, i) => growthBetween(i));
  const maxY = Math.max(...vals, 1) * 1.15;
  const bw = (W - pad.l - pad.r) / ch.length;
  const Y = (v) => Hh - pad.b - (v / maxY) * (Hh - pad.t - pad.b);
  let grid = "";
  for (let i = 0; i <= 4; i++){ const v = maxY * i / 4, y = Y(v);
    grid += `<line x1="${pad.l}" y1="${y}" x2="${W-pad.r}" y2="${y}" stroke="#1d242f"/>`;
    grid += `<text x="${pad.l-8}" y="${y+4}" fill="#5c6573" font-family="Spline Sans Mono,monospace" font-size="10" text-anchor="end">${fmtInt(v)}</text>`; }
  const vt = S.config.viral_threshold, ot = S.config.organic_target;
  let bars = "", labels = "";
  ch.forEach((r, i) => {
    const v = vals[i], x = pad.l + i * bw + bw * 0.16, w = bw * 0.68, y = Y(v), h = Hh - pad.b - y;
    const col = v >= vt ? "#73d699" : v >= ot ? "#ffb43a" : "#46c5b4";
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0,h).toFixed(1)}" rx="3" fill="${col}" opacity=".9"/>`;
    bars += `<text x="${(x+w/2).toFixed(1)}" y="${(y-6).toFixed(1)}" fill="#8b94a4" font-family="Spline Sans Mono,monospace" font-size="9.5" text-anchor="middle">${fmtInt(v)}</text>`;
    labels += `<text x="${(x+w/2).toFixed(1)}" y="${Hh-14}" fill="#5c6573" font-family="Spline Sans Mono,monospace" font-size="10" text-anchor="middle">${esc(r.chapter.replace(/^Bab\s*/i,"B"))}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="pertumbuhan per bab">${grid}${bars}${labels}</svg>`;
}

/* ─────────────────────────── RENDER ─────────────────────────── */
let TAB = "dash";
const view = () => document.getElementById("view");

function render(){
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === TAB));
  const map = { dash: renderDash, chapters: renderChapters, watch: renderWatch, beta: renderBeta, schedule: renderSchedule, settings: renderSettings };
  view().innerHTML = (map[TAB] || renderDash)();
  bind();
  updateHdr();
}

function adviceCard(){
  const a = assess(S.thread_status, S.velocity_history);
  const sevPill = { RED: "cepat", ORANGE: "sedang", YELLOW: "sedang", GREEN: "lambat" }[a.sev] || "sedang";
  const st = S.thread_status;
  const items = a.advice.map(x => `<div class="line"><span class="val">› ${esc(x)}</span></div>`).join("");
  return `<section class="panel fore"><div class="ptitle"><span class="dot"></span>Saran${a.name?` — ${esc(a.name)}`:""}<span class="pull"><span class="pill ${sevPill}">${a.sev}</span></span></div>
    <div class="row" style="margin-bottom:8px">
      <div class="field"><label>Halaman</label><input type="number" id="ts_page" min="1" step="1" value="${st.page}"></div>
      <div class="field"><label>Posisi</label><input type="number" id="ts_position" min="1" step="1" value="${st.position}"></div>
      <div class="field"><label>Menit sejak komentar</label><input type="number" id="ts_last_comment_min" min="0" step="1" value="${st.last_comment_min}"></div>
    </div>
    ${items}
    <div class="hint">Saran untuk tindakan<b>mu</b> sendiri, dari status thread + laju terbaru. Bukan instruksi mengaktifkan siapa pun.</div></section>`;
}

function renderDash(){
  const t = S.my_thread, cfg = S.config, hist = S.velocity_history;
  const hasThread = !!t.post_time && t.views != null;
  if (!hasThread){
    return `<section class="panel">
      <div class="ptitle"><span class="dot"></span>Siapkan thread</div>
      <div class="field"><label>Judul / penanda thread</label>
        <input type="text" id="setTitle" placeholder="mis. Senja di Ujung Bab" value="${esc(t.title||"")}"></div>
      <div class="row">
        <div class="field"><label>Waktu posting</label><input type="datetime-local" id="setTime"></div>
        <div class="field"><label>Views saat ini</label><input type="text" id="setViews" placeholder="mis. 1.2k atau 1234" inputmode="decimal"></div>
      </div>
      <button class="btn primary block" id="setBtn">Mulai memantau →</button>
      <div class="hint">Angka boleh ditulis <code>1,234</code>, <code>1.2k</code>, atau <code>5K</code>. Atau muat data contoh dari tab Pengaturan.</div>
    </section>`;
  }
  const va = velocityAverage(t.post_time, t.views);
  const roll = velocityRolling(hist, cfg.rolling_window_hours);
  let delta = "";
  if (roll != null && va){ const d = roll - va.velocity, cls = d > 0.5 ? "up" : d < -0.5 ? "down" : "flat", a = d > 0.5 ? "▲" : d < -0.5 ? "▼" : "■";
    delta = `<div class="delta ${cls}">${a} ${fmt1(Math.abs(d))} vs rata²</div>`; }

  let html = `<section class="panel">
    <div class="ptitle"><span class="dot"></span>Thread${t.title?` — ${esc(t.title)}`:""}<span class="pull">umur ${va?fmtHours(va.hours):"—"}</span></div>
    <div class="grid">
      <div class="stat"><div class="k">Views</div><div class="v">${fmtInt(t.views)}</div></div>
      <div class="stat live"><div class="k">Laju rata²</div><div class="v">${va?fmt1(va.velocity):"—"}<span class="u"> v/j</span></div></div>
      <div class="stat roll"><div class="k">Laju kini</div><div class="v">${roll!=null?fmt1(roll):"—"}<span class="u"> v/j</span></div>${delta}</div>
      <div class="stat"><div class="k">Sampel</div><div class="v">${hist.length}</div></div>
    </div>
    <div class="row" style="margin-top:14px">
      <div class="field"><label>Catat views sekarang</label>
        <input type="text" id="logViews" placeholder="angka terbaru…" inputmode="decimal" value="${t.views!=null?fmtInt(t.views):""}"></div>
      <button class="btn primary" id="logBtn">Catat</button>
    </div>
    <div class="hint">Tekan tiap kali kamu lihat angka di thread — makin sering &amp; rapi sampelnya, makin tepat foresight-nya.</div>
  </section>`;

  html += adviceCard();
  html += `<section class="panel fore"><div class="ptitle"><span class="dot teal"></span>Foresight</div>`;
  if (hist.length < cfg.trend_min_history_points){
    const pct = Math.round(hist.length / cfg.trend_min_history_points * 100);
    html += `<div class="building"><div class="cap">Membangun riwayat — ${hist.length}/${cfg.trend_min_history_points} sampel</div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="hint" style="margin-top:2px">Decay &amp; proyeksi tampil setelah cukup data — perilaku graceful v3.3.</div></div>`;
  } else {
    const fit = fitDecay(hist, cfg), tu = timeUntilVelocity(hist, cfg.projection_target, cfg);
    let any = false;
    if (roll != null){ any = true; html += `<div class="line"><span class="lab">Laju kini</span><span class="val"><b>${fmt1(roll)}</b> v/j</span></div>`; }
    if (fit){ any = true; const di = decayInfo(fit.lam);
      html += `<div class="line"><span class="lab">Peluruhan</span><span class="val">laju separuh tiap <b>${fmtHours(di.halfLife)}</b></span><span class="pill ${di.label}">${di.label}</span></div>`; }
    if (tu != null){ any = true;
      html += `<div class="line"><span class="lab">Proyeksi</span><span class="val">turun ke <b>${fmtInt(cfg.projection_target)}</b> v/j dalam <b>~${fmtHours(tu)}</b></span></div>`; }
    if (!any) html += `<div class="hint">Belum ada sinyal peluruhan yang jelas — kemungkinan laju masih naik atau noise. Tambah sampel lagi.</div>`;
  }
  html += `</section>`;

  html += `<section class="panel"><div class="ptitle"><span class="dot"></span>Laju terhadap waktu</div>
    <div class="chart-host">${velocityChart(hist, cfg)}</div>
    <div class="legend"><span class="amber"><i></i>laju terukur</span>
      <span class="teal"><i style="border-top-style:dashed"></i>model decay</span>
      <span class="red"><i style="border-top-style:dashed"></i>target ${fmtInt(cfg.projection_target)} v/j</span></div></section>`;
  return html;
}

function renderChapters(){
  const ch = S.chapters;
  let html = `<section class="panel"><div class="ptitle"><span class="dot"></span>Pertumbuhan per bab</div>
    <div class="chart-host">${growthChart()}</div>
    <div class="legend"><span class="teal"><i></i>di bawah target</span><span class="amber"><i></i>≥ target organik</span><span style="color:var(--green)"><i></i>≥ viral</span></div></section>`;

  html += `<section class="panel"><div class="ptitle"><span class="dot green"></span>Daftar bab<span class="pull">${ch.length} bab</span></div>`;
  if (!ch.length){
    html += `<div class="wl-empty">Belum ada bab. Tambahkan bab beserta total views-nya.</div>`;
  } else {
    ch.forEach((r, i) => {
      const gb = growthBetween(i), gin = growthInChapter(r);
      html += `<div class="wl-row" data-i="${i}">
        <div class="name"><span class="n">${esc(r.chapter)}</span>
          <span class="m">+${fmtInt(gb)} dari bab lalu <span class="gap">· internal +${fmtInt(gin)}</span></span></div>
        <div class="stepper">
          <button data-step="-1" aria-label="kurangi">−</button>
          <input type="text" class="ch-input" inputmode="decimal" value="${fmtInt(r.views)}">
          <button data-step="1" aria-label="tambah">+</button>
        </div>
        <button class="del" title="hapus">✕</button></div>`;
    });
    html += `<button class="btn primary block sm" id="chSave" style="margin-top:6px">Simpan total views bab</button>`;
  }
  const suggested = ch.length ? "" : (S.my_thread.views != null ? fmtInt(S.my_thread.views) : "");
  html += `<div class="row" style="margin-top:12px">
      <div class="field"><label>Nama bab (opsional)</label><input type="text" id="chName" placeholder="Bab ${ch.length+1}"></div>
      <div class="field"><label>Total views saat ini</label><input type="text" id="chViews" inputmode="decimal" placeholder="mis. 5K" value="${suggested}"></div>
      <button class="btn ghost" id="chAdd">Tambah bab</button>
    </div>
    <div class="hint">start_views otomatis = total views bab sebelumnya, jadi “pertumbuhan antar-bab” langsung akurat (sesuai perbaikan v3.0).</div></section>`;
  return html;
}

function renderWatch(){
  const cfg = S.config, t = S.my_thread;
  const ourViews = t.views || 0;
  const ourVel = velocityRolling(S.velocity_history, cfg.rolling_window_hours) ?? (velocityAverage(t.post_time, t.views)?.velocity ?? 0);
  const ageH = t.post_time ? ageHours(t.post_time) : 0;
  const lastCh = S.chapters[S.chapters.length - 1];
  const chGrowth = growthInChapter(lastCh);

  let html = `<section class="panel"><div class="ptitle"><span class="dot green"></span>Watchlist<span class="pull">${S.watchlist.length} thread</span></div>`;
  if (!S.watchlist.length){
    html += `<div class="wl-empty">Belum ada. Tambahkan thread lain untuk pembanding laju.</div>`;
  } else {
    S.watchlist.forEach((w, i) => {
      const hist = w.history || [];
      const cur = hist.length ? hist[hist.length - 1].views : null;
      const rv = velocityRolling(hist, cfg.rolling_window_hours);
      let chaseHtml = "";
      if (cur != null && rv != null && ourVel > 0){
        const p = chaseProbability(ourViews, ourVel, cur, rv, ageH, chGrowth, cfg);
        const gap = cur - ourViews;
        chaseHtml = ` <span class="gap">· selisih ${gap>=0?"+":""}${fmtInt(gap)}</span> <span class="chase">· peluang menyusul ~${Math.round(p*100)}%</span>`;
      }
      html += `<div class="wl-row" data-i="${i}">
        <div class="name"><span class="n">${esc(w.name)}</span>
          <span class="m">${rv!=null?fmt1(rv)+" v/j":"— v/j"}${chaseHtml}</span></div>
        <div class="stepper">
          <button data-step="-1" aria-label="kurangi">−</button>
          <input type="text" class="wl-input" inputmode="decimal" value="${cur!=null?fmtInt(cur):""}" placeholder="views">
          <button data-step="1" aria-label="tambah">+</button>
        </div>
        <button class="del" title="hapus">✕</button></div>`;
    });
    html += `<button class="btn primary block sm" id="wlSave" style="margin-top:6px">Simpan semua</button>`;
  }
  html += `<div class="row" style="margin-top:12px">
      <div class="field"><label>Tambah thread ke watchlist</label><input type="text" id="wlName" placeholder="nama / penanda thread lain"></div>
      <button class="btn ghost" id="wlAdd">Tambah</button>
    </div>
    <div class="hint">“Peluang menyusul” adalah estimasi dari model chase v3.3 (laju kamu vs laju mereka, selisih views, umur thread). Murni hitungan atas angka yang kamu amati.</div></section>`;
  return html;
}

function renderBeta(){
  const draft = S.current_draft || "";
  const key = draft || "(tanpa label)";
  const fb = S.feedback[key] || {};
  const readers = S.beta_readers || [];
  let rows = "";
  if (!readers.length){
    rows = `<div class="wl-empty">Belum ada kontak. Tambahkan beta reader-mu.</div>`;
  } else {
    readers.forEach(r => {
      const done = fb[r.id] === "returned";
      rows += `<div class="wl-row br-row" data-id="${r.id}" style="grid-template-columns:1fr auto auto auto">
        <div class="name"><input class="br-name" type="text" value="${esc(r.name)}"
          style="font-family:var(--sans);font-weight:600;font-size:14px;background:transparent;border:none;padding:0;color:var(--text);width:100%"></div>
        <button class="br-toggle icon-btn" style="${done?'background:rgba(115,214,153,.18);border-color:rgba(115,214,153,.5);color:var(--green)':''}">${done?'✓ sudah mengulas':'pending'}</button>
        <button class="br-invite icon-btn" title="salin pesan undangan">✉ undang</button>
        <button class="br-del del" title="hapus">✕</button></div>`;
    });
  }
  const ret = readers.filter(r => fb[r.id] === "returned").length;
  return `<section class="panel"><div class="ptitle"><span class="dot teal"></span>Beta reader<span class="pull">${ret}/${readers.length} sudah mengulas</span></div>
      <div class="field"><label>Draf / bab yang sedang direview</label>
        <input type="text" id="draftLabel" placeholder="mis. Bab 14" value="${esc(draft)}"></div>
      ${rows}
      <div class="row" style="margin-top:12px">
        <div class="field"><label>Tambah beta reader</label><input type="text" id="brName" placeholder="nama lengkap"></div>
        <button class="btn ghost" id="brAdd">Tambah</button>
      </div>
      <div class="hint">Checklist masukan menempel pada draf yang kamu pilih — murni untuk melacak siapa yang sudah memberi kritik. Tombol “undang” menyalin pesan permintaan masukan yang kamu kirim sendiri. Saat ini terisi username placeholder; ganti ke nama tim aslimu (klik namanya), atau tambah/kurangi kapan saja.</div></section>`;
}

function renderSchedule(){
  const cfg = S.config, win = cfg.posting_windows;
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  let active = null, next = null, nextDiff = Infinity;
  win.forEach(w => {
    const s = HM2min(w.start), e = HM2min(w.end);
    if (s <= nowMin && nowMin <= e) active = w;
    const diff = s - nowMin;
    if (diff > 0 && diff < nextDiff){ nextDiff = diff; next = w; }
  });
  let cd;
  if (active) cd = `<div class="countdown"><div class="big">SEKARANG</div><div class="lbl">Window “${esc(active.name)}” terbuka — waktu bagus untuk posting bab baru</div></div>`;
  else if (next) cd = `<div class="countdown"><div class="big">${Math.floor(nextDiff/60)}j ${nextDiff%60}m</div><div class="lbl">menuju window “${esc(next.name)}” (${next.start})</div></div>`;
  else cd = `<div class="countdown"><div class="big">—</div><div class="lbl">window berikutnya besok pagi</div></div>`;

  let rows = "";
  win.forEach((w, i) => {
    const isNow = active && active.name === w.name;
    rows += `<div class="win-row ${isNow?"now":""}" data-i="${i}">
      <div><div class="wn">${esc(w.name)}</div></div>
      <input type="time" class="ws" value="${w.start}" style="width:108px">
      <input type="time" class="we" value="${w.end}" style="width:108px">
      ${isNow?`<span class="badge">aktif</span>`:`<button class="del" title="hapus">✕</button>`}</div>`;
  });

  const canNotify = "Notification" in window;
  return `<section class="panel"><div class="ptitle"><span class="dot"></span>Jadwal posting</div>
      ${cd}
      <div class="toggle"><div>
          <div style="font-weight:600;font-size:14px">Ingatkan saat window terbuka</div>
          <div class="hint" style="margin-top:2px">${canNotify?"Notifikasi muncul selama aplikasi terbuka. Latar belakang tak dijamin semua browser.":"Browser ini tak mendukung notifikasi."}</div>
        </div>
        <label class="switch"><input type="checkbox" id="notifToggle" ${cfg.notify_windows?"checked":""} ${canNotify?"":"disabled"}><span class="sl"></span></label>
      </div>
    </section>
    <section class="panel"><div class="ptitle"><span class="dot faint"></span>Window<span class="pull">${win.length}</span></div>
      ${rows||`<div class="wl-empty">Belum ada window.</div>`}
      <button class="btn primary block sm" id="winSave" style="margin-top:6px">Simpan jam</button>
      <div class="row" style="margin-top:12px">
        <div class="field"><label>Nama window baru</label><input type="text" id="winName" placeholder="mis. Tengah malam"></div>
        <div class="field" style="max-width:120px"><label>Mulai</label><input type="time" id="winStart" value="21:00"></div>
        <div class="field" style="max-width:120px"><label>Selesai</label><input type="time" id="winEnd" value="21:30"></div>
        <button class="btn ghost" id="winAdd">Tambah</button>
      </div>
      <div class="hint">Ini murni pengingat untuk memposting karya barumu di jam ramai — bukan instruksi push apa pun.</div></section>`;
}

function renderSettings(){
  const c = S.config;
  return `<section class="panel"><div class="ptitle"><span class="dot faint"></span>Ambang &amp; parameter</div>
      <div class="muted-row">
        <label>Jendela laju kini (jam)<input class="mini" type="number" id="cfgWin" min="0.1" step="0.1" value="${c.rolling_window_hours}"></label>
        <label>Target proyeksi (v/j)<input class="mini" type="number" id="cfgTar" min="1" step="1" value="${c.projection_target}"></label>
        <label>Min. sampel tren<input class="mini" type="number" id="cfgTrend" min="2" step="1" value="${c.trend_min_history_points}"></label>
      </div>
      <div class="muted-row">
        <label>Target organik (views/bab)<input class="mini" type="number" id="cfgOrg" min="0" step="100" value="${c.organic_target}"></label>
        <label>Ambang viral (views/bab)<input class="mini" type="number" id="cfgViral" min="0" step="100" value="${c.viral_threshold}"></label>
      </div>
    </section>
    <section class="panel"><div class="ptitle"><span class="dot teal"></span>Data</div>
      <div class="btn-grid">
        <button class="btn ghost sm" id="expJSON">Ekspor cadangan (JSON)</button>
        <button class="btn ghost sm" id="impJSON">Impor cadangan (JSON)</button>
        <button class="btn ghost sm" id="expCSV">Ekspor riwayat (CSV)</button>
        <button class="btn ghost sm" id="expMD">Ekspor ringkasan (MD)</button>
        <button class="btn ghost sm" id="demoBtn">Muat data contoh</button>
        <button class="btn ghost sm danger" id="resetBtn">Reset semua</button>
      </div>
      <div class="hint">Data tersimpan di perangkat ini (IndexedDB). Pindah perangkat? Ekspor JSON di sini lalu impor di tempat lain.</div>
    </section>
    <section class="panel"><div class="ptitle"><span class="dot faint"></span>Tentang</div>
      <div class="about">
        <b>VDM — Velocity Decay Monitor</b> · web edition.<br>
        Port mesin velocity/decay/chase dari VDM v3.3 “Phoenix” (CLI oleh @YCBRoadcast), dengan guard kualitas-data v3.3 dan graceful degradation.<br>
        Logika trigger-peringkat / deploy tidak disertakan.
      </div></section>`;
}

/* header (undo + install visibility) */
function updateHdr(){
  const u = document.getElementById("undoBtn");
  if (u) u.hidden = undoStack.length === 0;
}

/* ─────────────────────────── EVENTS ─────────────────────────── */
function nowLocalValue(){ const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); }
const localToISO = (v) => v ? new Date(v).toISOString() : iso(now());

function logViews(viewsNum, whenISO){
  const t = S.my_thread; t.views = viewsNum;
  if (!t.post_time) t.post_time = whenISO;
  const va = velocityAverage(t.post_time, viewsNum);
  S.velocity_history.push({ timestamp: whenISO, views: viewsNum, velocity: va ? va.velocity : 0 });
  S.velocity_history = sortedHist(S.velocity_history);
}

function bind(){
  // dashboard
  const setBtn = document.getElementById("setBtn");
  if (setBtn){ const tEl = document.getElementById("setTime"); if (tEl) tEl.value = nowLocalValue();
    setBtn.onclick = () => { const v = parseNum(document.getElementById("setViews").value);
      if (v == null) return toast("Angka views tidak valid");
      mutate(() => { S.my_thread.title = document.getElementById("setTitle").value.trim(); logViews(v, localToISO(document.getElementById("setTime").value)); });
      toast("Mulai memantau ✓"); };
  }
  const logBtn = document.getElementById("logBtn");
  if (logBtn) logBtn.onclick = () => { const v = parseNum(document.getElementById("logViews").value);
    if (v == null) return toast("Angka tidak valid");
    mutate(() => logViews(v, iso(now()))); toast("Tercatat ✓"); };

  // chapters
  const chAdd = document.getElementById("chAdd");
  if (chAdd) chAdd.onclick = () => { const v = parseNum(document.getElementById("chViews").value);
    if (v == null) return toast("Total views tidak valid");
    const nm = document.getElementById("chName").value.trim();
    mutate(() => chapterAdd(v, nm)); toast("Bab ditambahkan ✓"); };
  const chSave = document.getElementById("chSave");
  if (chSave) chSave.onclick = () => { let n = 0;
    document.querySelectorAll("#view .wl-row").forEach(row => { const i = +row.dataset.i, v = parseNum(row.querySelector(".ch-input").value);
      if (v != null && S.chapters[i] && S.chapters[i].views !== v){ S.chapters[i]._v = v; n++; } });
    if (!n) return toast("Tidak ada perubahan");
    mutate(() => { document.querySelectorAll("#view .wl-row").forEach(row => { const i = +row.dataset.i, v = parseNum(row.querySelector(".ch-input").value); if (v != null && S.chapters[i]) S.chapters[i].views = v; }); });
    toast(n + " bab diperbarui ✓"); };

  // watchlist
  const wlAdd = document.getElementById("wlAdd");
  if (wlAdd) wlAdd.onclick = () => { const nm = document.getElementById("wlName").value.trim();
    if (!nm) return toast("Isi nama thread");
    mutate(() => S.watchlist.push({ id: "w" + Date.now().toString(36), name: nm, history: [] })); toast("Ditambahkan ✓"); };
  const wlSave = document.getElementById("wlSave");
  if (wlSave) wlSave.onclick = () => { const updates = [];
    document.querySelectorAll("#view .wl-row").forEach(row => { const i = +row.dataset.i, v = parseNum(row.querySelector(".wl-input").value);
      const w = S.watchlist[i]; if (v == null || !w) return;
      const prev = w.history.length ? w.history[w.history.length - 1].views : null;
      if (prev !== v) updates.push([i, v]); });
    if (!updates.length) return toast("Tidak ada perubahan");
    mutate(() => updates.forEach(([i, v]) => S.watchlist[i].history.push({ timestamp: iso(now()), views: v })));
    toast(updates.length + " thread diperbarui ✓"); };

  // shared steppers + delete (chapters & watchlist rows)
  document.querySelectorAll("#view .wl-row").forEach(row => {
    if (row.classList.contains("br-row")) return;
    const i = +row.dataset.i, input = row.querySelector("input");
    row.querySelectorAll("[data-step]").forEach(b => b.onclick = () => { const cur = parseNum(input.value) || 0; input.value = fmtInt(Math.max(0, cur + (+b.dataset.step) * 10)); });
    const del = row.querySelector(".del");
    if (del) del.onclick = () => { mutate(() => { if (TAB === "chapters") S.chapters.splice(i, 1); else S.watchlist.splice(i, 1); }); };
  });

  // schedule
  const winSave = document.getElementById("winSave");
  if (winSave) winSave.onclick = () => mutate(() => {
    document.querySelectorAll("#view .win-row").forEach(row => { const i = +row.dataset.i, s = row.querySelector(".ws").value, e = row.querySelector(".we").value;
      if (S.config.posting_windows[i]){ S.config.posting_windows[i].start = s; S.config.posting_windows[i].end = e; } });
  });
  const winAdd = document.getElementById("winAdd");
  if (winAdd) winAdd.onclick = () => { const nm = document.getElementById("winName").value.trim() || "Window";
    mutate(() => S.config.posting_windows.push({ name: nm, start: document.getElementById("winStart").value, end: document.getElementById("winEnd").value })); };
  document.querySelectorAll("#view .win-row .del").forEach(d => { const i = +d.closest(".win-row").dataset.i;
    d.onclick = () => mutate(() => S.config.posting_windows.splice(i, 1)); });
  const notifToggle = document.getElementById("notifToggle");
  if (notifToggle) notifToggle.onchange = async () => {
    if (notifToggle.checked && Notification.permission !== "granted"){ const p = await Notification.requestPermission();
      if (p !== "granted"){ notifToggle.checked = false; toast("Izin notifikasi ditolak"); return; } }
    S.config.notify_windows = notifToggle.checked; await saveSession(); toast(notifToggle.checked ? "Pengingat aktif" : "Pengingat mati"); };

  // settings — config fields
  const cfgBind = (id, key, parse = parseFloat, guard = (x) => x > 0) => { const el = document.getElementById(id);
    if (el) el.onchange = async () => { const x = parse(el.value); if (guard(x)){ S.config[key] = x; await saveSession(); render(); } }; };
  cfgBind("cfgWin", "rolling_window_hours"); cfgBind("cfgTar", "projection_target");
  cfgBind("cfgTrend", "trend_min_history_points", (v) => parseInt(v, 10), (x) => x >= 2);
  cfgBind("cfgOrg", "organic_target", parseFloat, (x) => x >= 0); cfgBind("cfgViral", "viral_threshold", parseFloat, (x) => x >= 0);

  // settings — data
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on("expJSON", () => download(`vdm-backup-${stamp()}.json`, JSON.stringify(S, null, 2), "application/json"));
  on("expCSV", exportCSV); on("expMD", exportMD);
  on("impJSON", () => document.getElementById("fileInput").click());
  on("demoBtn", loadDemo);
  on("resetBtn", () => { if (confirm("Hapus semua data dan mulai dari nol?")) mutate(() => { Object.assign(S, freshSession()); }); });

  // advice inputs (dashboard)
  ["page", "position", "last_comment_min"].forEach(k => { const el = document.getElementById("ts_" + k);
    if (el) el.onchange = async () => { const v = parseInt(el.value, 10); S.thread_status[k] = isNaN(v) ? 0 : Math.max(0, v); await saveSession(); render(); }; });

  // beta tab
  const draftEl = document.getElementById("draftLabel");
  if (draftEl) draftEl.onchange = async () => { S.current_draft = draftEl.value.trim(); await saveSession(); render(); };
  const brAdd = document.getElementById("brAdd");
  if (brAdd) brAdd.onclick = () => { const nm = document.getElementById("brName").value.trim(); if (!nm) return toast("Isi nama");
    mutate(() => S.beta_readers.push({ id: "r" + Date.now().toString(36), name: nm, note: "" })); toast("Ditambahkan ✓"); };
  document.querySelectorAll("#view .br-row").forEach(row => {
    const id = row.dataset.id;
    const nameEl = row.querySelector(".br-name");
    if (nameEl) nameEl.onchange = async () => { const r = S.beta_readers.find(x => x.id === id); if (r){ r.name = nameEl.value.trim() || r.name; await saveSession(); } };
    const tog = row.querySelector(".br-toggle");
    if (tog) tog.onclick = () => { const key = S.current_draft || "(tanpa label)";
      mutate(() => { S.feedback[key] = S.feedback[key] || {}; S.feedback[key][id] = S.feedback[key][id] === "returned" ? "pending" : "returned"; }); };
    const inv = row.querySelector(".br-invite");
    if (inv) inv.onclick = () => { const r = S.beta_readers.find(x => x.id === id); const d = S.current_draft || "draf terbaru";
      copyText(`Hai ${r ? r.name : ""}, boleh minta pandanganmu soal ${d}? Khususnya bagian yang mungkin membingungkan atau ide pokok yang terlewat. Makasih sebelumnya!`); };
    const del = row.querySelector(".br-del");
    if (del) del.onclick = () => mutate(() => { S.beta_readers = S.beta_readers.filter(x => x.id !== id); });
  });
}

/* ─────────────────────────── EXPORT / IMPORT ─────────────────────────── */
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
function download(name, text, type){
  const blob = new Blob([text], { type }); const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500); toast("Diunduh ✓");
}
function copyText(t){ try { navigator.clipboard.writeText(t).then(() => toast("Undangan disalin ✓"), () => toast("Gagal menyalin")); } catch (e) { toast("Gagal menyalin"); } }
function exportCSV(){
  let csv = "type,timestamp,label,views,velocity\n";
  S.velocity_history.forEach(h => csv += `sample,${h.timestamp},,${h.views},${(h.velocity||0).toFixed(3)}\n`);
  S.chapters.forEach(r => csv += `chapter,${r.timestamp},"${r.chapter.replace(/"/g,'""')}",${r.views},\n`);
  download(`vdm-history-${stamp()}.csv`, csv, "text/csv");
}
function exportMD(){
  const t = S.my_thread, va = velocityAverage(t.post_time, t.views), roll = velocityRolling(S.velocity_history, S.config.rolling_window_hours);
  let md = `# VDM — ${t.title || "thread"}\n\n`;
  md += `- Views: **${t.views!=null?fmtInt(t.views):"—"}**\n- Laju rata²: **${va?fmt1(va.velocity):"—"} v/j**\n- Laju kini: **${roll!=null?fmt1(roll):"—"} v/j**\n- Umur: **${va?fmtHours(va.hours):"—"}**\n- Sampel: **${S.velocity_history.length}**\n\n`;
  if (S.chapters.length){ md += `## Bab\n\n| Bab | Views | +antar-bab |\n|---|---:|---:|\n`;
    S.chapters.forEach((r, i) => md += `| ${r.chapter} | ${fmtInt(r.views)} | +${fmtInt(growthBetween(i))} |\n`); md += "\n"; }
  download(`vdm-ringkasan-${stamp()}.md`, md, "text/markdown");
}
function importJSON(file){
  const fr = new FileReader();
  fr.onload = async () => { try { const d = JSON.parse(fr.result);
      if (!d || (!d.my_thread && !d.velocity_history)) return toast("File tidak dikenali");
      snapshot(); S = migrate(d); await saveSession(); render(); toast("Cadangan dimuat ✓");
    } catch (e){ toast("Gagal membaca file"); } };
  fr.readAsText(file);
}

/* ─────────────────────────── DEMO ─────────────────────────── */
async function loadDemo(){
  snapshot();
  S = freshSession();
  S.my_thread.title = "Senja di Ujung Bab";
  const base = now() - 6 * H;
  S.my_thread.post_time = iso(base);
  [[1,820],[2,1500],[3,2040],[4,2470],[5,2760],[5.8,2930]].forEach(([hh, vv]) =>
    S.velocity_history.push({ timestamp: iso(base + hh * H), views: vv, velocity: vv / hh }));
  S.my_thread.views = 2930;
  S.chapters = [
    { chapter: "Bab 1", start_views: 0, views: 900, timestamp: iso(base) },
    { chapter: "Bab 2", start_views: 900, views: 1850, timestamp: iso(base + 2 * H) },
    { chapter: "Bab 3", start_views: 1850, views: 2930, timestamp: iso(base + 5 * H) },
  ];
  S.watchlist = [
    { id: "w1", name: "Hujan di Bab 12", history: [{ timestamp: iso(now() - 1.2 * H), views: 3100 }, { timestamp: iso(now() - 0.1 * H), views: 3380 }] },
    { id: "w2", name: "Catatan Tengah Malam", history: [{ timestamp: iso(now() - 0.3 * H), views: 1990 }] },
  ];
  await saveSession(); render(); toast("Data contoh dimuat ✓");
}

/* ─────────────────────────── NOTIFICATIONS (while open) ─────────────────────────── */
let lastNotified = null;
function checkWindows(){
  if (!S || !S.config.notify_windows || !("Notification" in window) || Notification.permission !== "granted") return;
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  for (const w of S.config.posting_windows){
    const s = HM2min(w.start);
    if (nowMin === s && lastNotified !== w.name + s){
      lastNotified = w.name + s;
      try { new Notification("Waktunya posting", { body: `Window “${w.name}” terbuka — saat bagus untuk merilis bab baru.` }); } catch (e) {}
    }
  }
}

/* ─────────────────────────── TOAST ─────────────────────────── */
let toastT;
function toast(msg){ const el = document.getElementById("toast"); el.textContent = msg; el.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), 1900); }

/* ─────────────────────────── PWA WIRING ─────────────────────────── */
if ("serviceWorker" in navigator){
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(e => console.warn("SW gagal", e)));
}
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredPrompt = e;
  const b = document.getElementById("installBtn"); if (b) b.hidden = false; });
window.addEventListener("appinstalled", () => { const b = document.getElementById("installBtn"); if (b) b.hidden = true; });

/* ─────────────────────────── BOOT ─────────────────────────── */
function wireChrome(){
  document.querySelectorAll(".tab").forEach(t => t.onclick = () => { TAB = t.dataset.tab; render(); window.scrollTo({ top: 0, behavior: "smooth" }); });
  document.getElementById("undoBtn").onclick = undo;
  const inst = document.getElementById("installBtn");
  inst.onclick = async () => { if (!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; inst.hidden = true; };
  document.getElementById("fileInput").onchange = (e) => { if (e.target.files[0]) importJSON(e.target.files[0]); e.target.value = ""; };
}
(async () => {
  wireChrome();
  S = await loadSession();
  render();
  setInterval(() => { if (TAB === "schedule" || TAB === "dash") render(); }, 60000); // refresh laju/countdown
  setInterval(checkWindows, 30000);
})();
