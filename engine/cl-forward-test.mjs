/**
 * CL Forward-Test Logger — V2 (CL-native signals)
 * ─────────────────────────────────────────────────────────────────
 * Built from scratch around crude oil's market structure.
 * NEVER places orders — pure paper trade simulation.
 *
 * Signal architecture:
 *   CL_TREND_L / CL_TREND_S  — EMA21 pullback continuation (ADX-confirmed trend)
 *   CL_ORB_L  / CL_ORB_S    — Opening range breakout (first 30 min of US session)
 *
 * Session: 14:00–20:00 UTC (US session, liquid CL window)
 * EIA filter: Wednesday 14:00–15:00 UTC blocked (inventory 14:30 UTC)
 *
 * Risk model:
 *   TREND: stop = 1.5 ATR, TP = 3.5 ATR  (2.3R — break-even at 30% WR)
 *   ORB:   stop = opposite ORB boundary + 10t, TP = 2× ORB width from entry (2R)
 *
 * Log files:
 *   logs/cl-forward-test.log         — human-readable daily log
 *   logs/cl-forward-test-trades.json — machine-readable trade records
 */
import axios from "axios";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir    = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dir, "..", "logs");
if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

const LOG_TXT  = join(LOGS_DIR, "cl-forward-test.log");
const LOG_JSON = join(LOGS_DIR, "cl-forward-test-trades.json");

const REST   = "https://api.topstepx.com";
const USER   = process.env.TV_USER    || "nicholas11morris@gmail.com";
const APIKEY = process.env.TV_API_KEY || "j7aI2WhpXbtRKe3KNkyHWfNNMwtTecQRPpNIkzTr9N4=";

const TICK_SZ  = 0.01;   // 1 tick = $10
const TICK_VAL = 10.00;

// Daily loss limit — halt new entries for the day once hit
const DAILY_LOSS_LIMIT = -500;   // ~5 full stop-outs at 10t stop
const MAX_DAY_LOSSES   = 2;      // halt after 2 losses (prevents death-spiral days)

// ── Logging ───────────────────────────────────────────────────────────────────
function log(msg) {
  const ts   = new Date().toISOString().slice(0, 19).replace("T", " ");
  const line = `[${ts}] ${msg}`;
  console.log(line);
  appendFileSync(LOG_TXT, line + "\n");
}

function logTrade(record) {
  const trades = existsSync(LOG_JSON)
    ? JSON.parse(readFileSync(LOG_JSON, "utf8"))
    : [];
  trades.push(record);
  writeFileSync(LOG_JSON, JSON.stringify(trades, null, 2));
}

// ── Session rules ─────────────────────────────────────────────────────────────
function sessionInfo(t) {
  const d  = new Date(t * 1000);
  const hm = d.getUTCHours() * 100 + d.getUTCMinutes();
  const isWed = d.getUTCDay() === 3;
  const inUS  = hm >= 1400 && hm < 2000;
  const eiaBlock = isWed && hm >= 1400 && hm < 1500;  // EIA inventory at 14:30 UTC
  return { inSession: inUS && !eiaBlock, eiaBlock, hm, isWed };
}

// ── Indicators ────────────────────────────────────────────────────────────────
function ema(closes, len) {
  if (closes.length < len) return null;
  const k = 2 / (len + 1);
  let e = closes.slice(0, len).reduce((s, x) => s + x, 0) / len;
  for (let i = len; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return e;
}

function atr(bars, len = 14) {
  if (bars.length < len + 1) return null;
  let s = 0;
  for (let i = bars.length - len; i < bars.length; i++) {
    const b = bars[i], pb = bars[i - 1];
    s += Math.max(b.high - b.low, Math.abs(b.high - pb.close), Math.abs(b.low - pb.close));
  }
  return s / len;
}

function adx(bars, len = 14) {
  if (bars.length < len + 2) return null;
  const trs = [], pdms = [], ndms = [];
  for (let i = bars.length - len - 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
    const up = b.high - p.high, dn = p.low - b.low;
    pdms.push(up > dn && up > 0 ? up : 0);
    ndms.push(dn > up && dn > 0 ? dn : 0);
  }
  let atrv = trs[0], pdm = pdms[0], ndm = ndms[0];
  for (let i = 1; i < trs.length; i++) {
    atrv = (atrv * (len - 1) + trs[i]) / len;
    pdm  = (pdm  * (len - 1) + pdms[i]) / len;
    ndm  = (ndm  * (len - 1) + ndms[i]) / len;
  }
  if (!atrv) return 0;
  const pdi = 100 * pdm / atrv, ndi = 100 * ndm / atrv;
  return (pdi + ndi) === 0 ? 0 : 100 * Math.abs(pdi - ndi) / (pdi + ndi);
}

// ── Signal evaluation ─────────────────────────────────────────────────────────
// Returns array of { id, side, stopDist, tpDist } — distances in price points
function evaluate(bars, orbState) {
  if (bars.length < 60) return [];

  const last  = bars.at(-1);
  const prev  = bars.at(-2);
  const closes = bars.map(b => b.close);

  const atr14  = atr(bars, 14);
  const adx14  = adx(bars, 14);
  const e21    = ema(closes, 21);
  const e21prv = ema(closes.slice(0, -1), 21);
  const e50    = ema(closes, 50);

  if (!atr14 || adx14 === null || !e21 || !e50) return [];

  const c      = last.close;
  const sigs   = [];

  // ── Signal 1 & 2: Trend continuation (EMA21 pullback) ─────────────────────
  // Trade with confirmed trend when price dips to EMA21 and resumes.
  // ADX > 22 ensures we're in a real trend, not noise.
  if (adx14 > 22) {
    const uptrend   = e21 > e50;
    const downtrend = e21 < e50;

    // CL_TREND_L: uptrend + pullback to EMA21 completed + price closed back above
    if (uptrend && e21prv && prev.low <= e21prv && c > e21 && c > prev.close) {
      sigs.push({ id: "CL_TREND_L", side: "long",  stopDist: atr14 * 1.5, tpDist: atr14 * 3.5 });
    }

    // CL_TREND_S: downtrend + pullback to EMA21 completed + price closed back below
    if (downtrend && e21prv && prev.high >= e21prv && c < e21 && c < prev.close) {
      sigs.push({ id: "CL_TREND_S", side: "short", stopDist: atr14 * 1.5, tpDist: atr14 * 3.5 });
    }
  }

  // ── Signal 3 & 4: Opening Range Breakout ──────────────────────────────────
  // CL's first 30 min (14:00–14:30 UTC) defines the session's mean price.
  // Breakouts above/below the ORB with follow-through predict direction.
  if (orbState.ready && !orbState.longFired && c > orbState.high && prev.close <= orbState.high) {
    const orbWidth  = orbState.high - orbState.low;
    const stopDist  = (orbState.high - orbState.low) + 10 * TICK_SZ;  // stop below ORB low − buffer
    const tpDist    = orbWidth * 2;
    if (orbWidth >= 10 * TICK_SZ && orbWidth <= 100 * TICK_SZ) {     // filter: 10–100 tick range
      sigs.push({ id: "CL_ORB_L", side: "long", stopDist, tpDist, orbWidth });
    }
  }
  if (orbState.ready && !orbState.shortFired && c < orbState.low && prev.close >= orbState.low) {
    const orbWidth  = orbState.high - orbState.low;
    const stopDist  = (orbState.high - orbState.low) + 10 * TICK_SZ;
    const tpDist    = orbWidth * 2;
    if (orbWidth >= 10 * TICK_SZ && orbWidth <= 100 * TICK_SZ) {
      sigs.push({ id: "CL_ORB_S", side: "short", stopDist, tpDist, orbWidth });
    }
  }

  return sigs;
}

// ── TopstepX API ──────────────────────────────────────────────────────────────
let token = null;

async function apiPost(path, body = {}, retries = 3) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.post(`${REST}${path}`, body, { headers, timeout: 15_000 });
      return res.data;
    } catch (err) {
      if (attempt < retries) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
      throw err;
    }
  }
}

async function login() {
  const d = await apiPost("/api/Auth/loginKey", { userName: USER, apiKey: APIKEY });
  if (!d.success) throw new Error(`Auth failed: ${d.errorMessage}`);
  token = d.token;
  log("✓ Authenticated with TopstepX");
  setTimeout(login, 22 * 60 * 60 * 1000);
}

async function resolveContract() {
  const d = await apiPost("/api/Contract/search", { searchText: "CL", live: false });
  const contracts = (d.contracts || []).filter(c => c.id?.startsWith("CON.F.US.CLE"));
  if (!contracts.length) throw new Error("No CL contract found");
  contracts.sort((a, b) => a.id.localeCompare(b.id));
  const c = contracts[0];
  log(`✓ Contract: ${c.id} (${c.name}) | tick=$${c.tickValue} | size=${c.tickSize}`);
  return c.id;
}

async function fetchBars(contractId) {
  const now   = new Date();
  const start = new Date(now - 72 * 60 * 60 * 1000);
  const d = await apiPost("/api/History/retrieveBars", {
    contractId,
    live:              false,
    startTime:         start.toISOString(),
    endTime:           now.toISOString(),
    unit:              2,
    unitNumber:        5,
    limit:             350,
    includePartialBar: false,
  });
  if (!d.success) { log(`⚠ fetchBars failed: ${d.errorMessage}`); return null; }
  return d.bars
    .map(b => ({ time: new Date(b.t).getTime() / 1000, open: +b.o, high: +b.h, low: +b.l, close: +b.c, volume: b.v }))
    .sort((a, b) => a.time - b.time);
}

// ── Per-day state ─────────────────────────────────────────────────────────────
const openTrades = new Map();  // signalId → { side, entry, stopPx, tpPx, stopTicks, tpTicks, atr, openTime }
let   lastDate   = null;
let   dayPnL     = 0;
let   dayTrades  = 0;
let   dayWins    = 0;
let   dayLosses  = 0;
let   totalPnL   = 0;
let   totalTrades = 0;
let   totalWins   = 0;

// Opening range state — resets each day
let orb = { high: -Infinity, low: Infinity, ready: false, longFired: false, shortFired: false };

function resetDay(date) {
  if (lastDate && lastDate !== date) {
    log(`📊 Day closed [${lastDate}] trades=${dayTrades} wins=${dayWins}/${dayTrades} P&L=$${dayPnL.toFixed(0)} | cumulative=$${totalPnL.toFixed(0)}`);
  }
  openTrades.clear();
  dayPnL = 0; dayTrades = 0; dayWins = 0; dayLosses = 0;
  orb = { high: -Infinity, low: Infinity, ready: false, longFired: false, shortFired: false };
  lastDate = date;
}

function updateORB(bar) {
  const { hm } = sessionInfo(bar.time);
  // Accumulate ORB during 14:00–14:30 UTC
  if (hm >= 1400 && hm < 1430) {
    orb.high = Math.max(orb.high, bar.high);
    orb.low  = Math.min(orb.low,  bar.low);
  }
  // Mark ready after 14:30 UTC
  if (hm >= 1430 && !orb.ready && orb.high > -Infinity) {
    orb.ready = true;
    log(`📐 ORB set: high=${orb.high.toFixed(2)} low=${orb.low.toFixed(2)} width=${((orb.high-orb.low)/TICK_SZ).toFixed(0)}t ($${((orb.high-orb.low)/TICK_SZ*TICK_VAL).toFixed(0)})`);
  }
}

function checkOpenTrades(bar) {
  for (const [sid, t] of openTrades.entries()) {
    let result = null;
    if (t.side === "long") {
      if (bar.low  <= t.stopPx) result = -(t.stopTicks * TICK_VAL);
      else if (bar.high >= t.tpPx) result = t.tpTicks * TICK_VAL;
    } else {
      if (bar.high >= t.stopPx) result = -(t.stopTicks * TICK_VAL);
      else if (bar.low  <= t.tpPx)  result = t.tpTicks * TICK_VAL;
    }

    if (result !== null) {
      const outcome = result > 0 ? "✅ TP" : "❌ SL";
      dayPnL += result; totalPnL += result;
      dayTrades++; totalTrades++;
      if (result > 0) { dayWins++; totalWins++; } else { dayLosses++; }
      const wr = totalTrades ? (100 * totalWins / totalTrades).toFixed(1) : "0.0";
      log(`${outcome} ${t.side.toUpperCase()} ${sid} → ${result > 0 ? "+" : ""}$${result.toFixed(0)} | day=$${dayPnL.toFixed(0)} total=$${totalPnL.toFixed(0)} WR:${wr}%`);
      logTrade({ timestamp: new Date().toISOString(), date: lastDate, signal: sid, side: t.side, entry: t.entry, result, outcome: result > 0 ? "TP" : "SL", atr: t.atr, openTime: t.openTime, closeTime: bar.time });
      openTrades.delete(sid);
    }
  }
}

// ── Main tick ─────────────────────────────────────────────────────────────────
let contractId = null;

async function tick() {
  const bars = await fetchBars(contractId);
  if (!bars || bars.length < 65) return;

  const last = bars.at(-1);
  const date = new Date(last.time * 1000).toISOString().slice(0, 10);

  if (date !== lastDate) resetDay(date);

  // Always check open trades regardless of session
  if (openTrades.size > 0) checkOpenTrades(last);

  // Update opening range from today's US session bars
  for (const b of bars) {
    const bd = new Date(b.time * 1000).toISOString().slice(0, 10);
    if (bd === date) updateORB(b);
  }

  const { inSession, eiaBlock, hm } = sessionInfo(last.time);

  if (!inSession) return;

  if (dayPnL <= DAILY_LOSS_LIMIT) {
    log(`⛔ Daily loss limit ($${dayPnL.toFixed(0)}) — halted for today`);
    return;
  }
  if (dayLosses >= MAX_DAY_LOSSES) {
    log(`⛔ 2-loss halt (${dayLosses} losses, $${dayPnL.toFixed(0)}) — no new entries`);
    return;
  }

  const sigs = evaluate(bars, orb);
  if (!sigs.length) return;

  const atr14 = atr(bars, 14);
  if (!atr14) return;

  for (const sig of sigs) {
    if (openTrades.has(sig.id)) continue;

    const entry     = last.close;
    const stopPx    = sig.side === "long"  ? entry - sig.stopDist : entry + sig.stopDist;
    const tpPx      = sig.side === "long"  ? entry + sig.tpDist   : entry - sig.tpDist;
    const stopTicks = Math.round(sig.stopDist / TICK_SZ);
    const tpTicks   = Math.round(sig.tpDist   / TICK_SZ);

    openTrades.set(sig.id, { side: sig.side, entry, stopPx, tpPx, stopTicks, tpTicks, atr: atr14, openTime: last.time });

    if (sig.id.startsWith("CL_ORB")) {
      if (sig.side === "long")  orb.longFired  = true;
      if (sig.side === "short") orb.shortFired = true;
    }

    log(`📍 ${sig.id} ${sig.side.toUpperCase()} @ ${entry.toFixed(2)} | stop ${stopPx.toFixed(2)} (${stopTicks}t=$${(stopTicks*TICK_VAL).toFixed(0)}) tp ${tpPx.toFixed(2)} (${tpTicks}t=$${(tpTicks*TICK_VAL).toFixed(0)}) atr=${atr14.toFixed(3)}`);
    logTrade({ timestamp: new Date().toISOString(), date, signal: sig.id, side: sig.side, entry, stopPx, tpPx, stopTicks, tpTicks, atr: atr14, openTime: last.time, status: "open" });
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
log("═".repeat(60));
log("CL Forward-Test V2 — CL-native signals, no orders placed");
log("Signals: CL_TREND_L, CL_TREND_S (EMA21 pullback, ADX>22)");
log("         CL_ORB_L,   CL_ORB_S   (opening range breakout 14:00-14:30 UTC)");
log("Session: 14:00-20:00 UTC | Wednesday 14:00-15:00 blocked (EIA)");
log(`Risk: TREND 1.5/3.5 ATR (2.3R) | ORB 2× range width (2R)`);
log(`Halt: daily loss $${-DAILY_LOSS_LIMIT} | ${MAX_DAY_LOSSES}-loss/day limit`);
log("═".repeat(60));

await login();
contractId = await resolveContract();

setInterval(() => tick().catch(e => log(`⚠ tick error: ${e.message}`)), 30_000);
await tick();
log("✓ Polling every 30s");
