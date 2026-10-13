/**
 * engine/topstepx-engine.js
 * TopstepX funded-account engine (ProjectX Gateway API)
 *
 * REST  : https://api.topstepx.com
 * RTC   : https://rtc.topstepx.com/hubs/user
 * Docs  : https://gateway.docs.projectx.com
 *
 * Key differences from v9-engine (IBKR):
 *  • API-key auth → bearer token (no username/password)
 *  • Brackets attached to entry order — no separate OCO/OCA needed
 *  • TrailingStop bracket type native to the API
 *  • SignalR for real-time fills (not IBKR event bus)
 *  • Hard cap: 2 contracts (Topstep 50K rule)
 *  • Daily loss halt: $900 (buffer from Topstep $1 000 limit)
 */

import axios from "axios";
import { HubConnectionBuilder, HttpTransportType, LogLevel, HubConnectionState } from "@microsoft/signalr";
import dotenv from "dotenv";
import { evaluate, evaluateExtended } from "./strategies.js";
import { evaluateNQ, resetConfRevState } from "./nq-strategies.js";
import { atr, volumeSMA } from "./indicators.js";
import { appendFileSync, writeFileSync, openSync, closeSync, unlinkSync, mkdirSync, existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));

// Packaged Electron apps must NOT store persistent state under process.resourcesPath
// (join(__dir, "..", "logs")) — that directory lives inside the app bundle and gets
// wiped and replaced wholesale on every auto-update. main.js passes LOGS_DIR pointing
// at app.getPath("userData") instead so trade history, peak balance, and session
// gates survive updates. Falls back to the repo-relative path for dev/CLI usage.
const LOGS_DIR = process.env.LOGS_DIR || resolve(__dir, "..", "logs");

// Account-scoped id used to namespace every per-account state file below —
// session gates, peak balance, dayPnL, and trade log all used to share one
// filename regardless of account, so running 2+ accounts simultaneously (the
// whole point of multi-account.mjs) would have them silently clobber each
// other's profit-cap/DLL state, peak balance, and P&L. Only the engine
// lockfile and seen-trades file were scoped like this before.
const SAFE_ACCOUNT_ID = String(process.env.ACCOUNT_ID || process.env.TV_USER || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);

// ── Per-account engine singleton lockfile ─────────────────────────────────────
// Prevents a second engine from running for the same account ID if a supervisor
// crashes and orphans a child — the new supervisor's spawn attempt is blocked here.
{
  const safeId     = SAFE_ACCOUNT_ID;
  mkdirSync(LOGS_DIR, { recursive: true });
  const engineLock = resolve(LOGS_DIR, `engine-${safeId}.lock`);

  const writeLock = (blockedCount = 0) => {
    writeFileSync(engineLock, JSON.stringify({ pid: process.pid, blockedCount }));
  };
  const readLock = () => {
    const raw = readFileSync(engineLock, 'utf8').trim();
    // Legacy format was a bare PID number — support both.
    if (/^\d+$/.test(raw)) return { pid: parseInt(raw, 10), blockedCount: 0 };
    try { return JSON.parse(raw); } catch { return { pid: NaN, blockedCount: 0 }; }
  };

  const acquireEngineLock = () => {
    try {
      const fd = openSync(engineLock, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, blockedCount: 0 }));
      closeSync(fd);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const { pid: existingPid, blockedCount = 0 } = readLock();
      let alive = true;
      try { process.kill(existingPid, 0); } catch { alive = false; }

      // PIDs get recycled by the OS — an unrelated process can end up with the
      // same PID as a crashed/force-killed engine that never released its lock,
      // making `alive` look true forever even though our engine is long gone.
      // If 3 separate start attempts have each independently found this EXACT
      // same PID still "blocking" them, that's far more consistent with a stale
      // reused PID than a genuinely running duplicate — force-clear it rather
      // than lock the account out permanently.
      if (alive && blockedCount >= 2) {
        console.warn(`\n⚠️  PID ${existingPid} has blocked engine startup for account ${safeId} ${blockedCount + 1} times in a row — treating as a stale lock (likely a recycled PID from a crashed process) and taking over.\n`);
        alive = false;
      }

      if (alive) {
        console.error(`\n❌  Engine for account ${safeId} already running (PID ${existingPid}). Exiting.\n`);
        try { writeFileSync(engineLock, JSON.stringify({ pid: existingPid, blockedCount: blockedCount + 1 })); } catch {}
        process.exit(1);
      }
      // Stale — remove and retry once
      unlinkSync(engineLock);
      try {
        const fd = openSync(engineLock, 'wx');
        writeFileSync(fd, JSON.stringify({ pid: process.pid, blockedCount: 0 }));
        closeSync(fd);
      } catch {
        console.error(`\n❌  Engine lock race for ${safeId} — another engine won. Exiting.\n`);
        process.exit(1);
      }
    }
    const release = () => { try { unlinkSync(engineLock); } catch {} };
    process.on('exit',   release);
    process.on('SIGINT',  () => { release(); process.exit(1); });
    process.on('SIGTERM', () => { release(); process.exit(1); });
    // Catch leaked async errors — prevents Node 15+ from crashing the process on
    // unhandled rejections (e.g. from SignalR's internal promise chains on disconnect).
    process.on('unhandledRejection', (reason) => {
      console.error('[Engine] Unhandled rejection (non-fatal):', reason instanceof Error ? reason.message : reason);
    });
    process.on('uncaughtException', (err) => {
      console.error('[Engine] Uncaught exception (non-fatal):', err.message);
    });
  };
  acquireEngineLock();
}

// Shared state file — read by cl-forward-test.mjs to gate signals
const SHARED_STATE_PATH = join(LOGS_DIR, `nq-state-${SAFE_ACCOUNT_ID}.json`);
function writeSharedState(dayPnL) {
  try {
    if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
    writeFileSync(SHARED_STATE_PATH, JSON.stringify({
      date:      new Date().toISOString().slice(0, 10),
      dayPnL:    +dayPnL.toFixed(2),
      updatedAt: new Date().toISOString(),
    }));
  } catch { /* non-fatal — CL bot falls back to ungated if file missing */ }
}

// Peak balance persistence — tracks the all-time high for trailing DD floor
// calculations. Unlike session gates, this must NEVER reset on restart or
// date-rollover — TopstepX's trailing DD trails up from the true peak.
const PEAK_BALANCE_PATH = join(LOGS_DIR, `peak-balance-${SAFE_ACCOUNT_ID}.json`);

function savePeakBalance(peakBalance) {
  try {
    if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
    writeFileSync(PEAK_BALANCE_PATH, JSON.stringify({ peakBalance, updatedAt: new Date().toISOString() }));
  } catch { /* non-fatal */ }
}

function loadPeakBalance() {
  try {
    if (!existsSync(PEAK_BALANCE_PATH)) return null;
    const saved = JSON.parse(readFileSync(PEAK_BALANCE_PATH, "utf8"));
    return typeof saved.peakBalance === "number" ? saved.peakBalance : null;
  } catch { return null; }
}

// EOD-locked peak — the actual peak TopstepX's trailing DD floor is based on.
// Confirmed against TopstepX's published rules (2026-10-09): the floor moves up
// using the END-OF-DAY closing balance, never continuous intraday highs — "if the
// balance touches the floor at any point during the session... the account is
// liquidated," but the floor itself only re-locks once per day. state.peakBalance
// above updates on every single balance push (correct for the "Peak balance"
// informational display, wrong for anything computing the real floor/cushion) —
// this tracks the same thing but only advances at the daily session-reset point,
// using that moment's balance (= yesterday's close, before today's first trade).
const EOD_PEAK_PATH = join(LOGS_DIR, `eod-peak-${SAFE_ACCOUNT_ID}.json`);

function saveEodPeakBalance(eodPeakBalance) {
  try {
    if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
    writeFileSync(EOD_PEAK_PATH, JSON.stringify({ eodPeakBalance, updatedAt: new Date().toISOString() }));
  } catch { /* non-fatal */ }
}

function loadEodPeakBalance() {
  try {
    if (!existsSync(EOD_PEAK_PATH)) return null;
    const saved = JSON.parse(readFileSync(EOD_PEAK_PATH, "utf8"));
    return typeof saved.eodPeakBalance === "number" ? saved.eodPeakBalance : null;
  } catch { return null; }
}

// Session gate persistence — survives engine restarts during outages.
// Saves all intra-day filters so a reconnect during the AM session restores
// the exact gate state rather than re-firing signals with a clean slate.
const SESSION_GATE_PATH = join(LOGS_DIR, `session-gates-${SAFE_ACCOUNT_ID}.json`);

function saveSessionGates(state) {
  try {
    if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
    writeFileSync(SESSION_GATE_PATH, JSON.stringify({
      date:               new Date().toISOString().slice(0, 10),
      dayPnL:             +state.dayPnL.toFixed(2),
      haltedToday:        state.haltedToday,
      profitCappedToday:  state.profitCappedToday,
      amTrendChecked:     state.amTrendChecked,
      noShortsToday:      state.noShortsToday,
      noLongsToday:       state.noLongsToday,
      sessionLongWon:     state.sessionLongWon,
      consecutiveWins:    state.consecutiveWins,
      consecutiveLosses:  state.consecutiveLosses,
      cooldownUntil:      state.cooldownUntil,
      updatedAt:          new Date().toISOString(),
    }));
  } catch { /* non-fatal */ }
}

function restoreSessionGates(state) {
  try {
    if (!existsSync(SESSION_GATE_PATH)) return false;
    const saved = JSON.parse(readFileSync(SESSION_GATE_PATH, "utf8"));
    const today = new Date().toISOString().slice(0, 10);
    if (saved.date !== today) return false;  // stale — different day

    state.dayPnL            = saved.dayPnL            ?? 0;
    state.haltedToday       = saved.haltedToday       ?? false;
    state.profitCappedToday = saved.profitCappedToday ?? false;
    state.amTrendChecked    = saved.amTrendChecked     ?? false;
    state.noShortsToday     = saved.noShortsToday      ?? false;
    state.noLongsToday      = saved.noLongsToday       ?? false;
    state.sessionLongWon    = saved.sessionLongWon     ?? false;
    state.consecutiveWins   = saved.consecutiveWins    ?? 0;
    state.consecutiveLosses = saved.consecutiveLosses  ?? 0;
    state.cooldownUntil     = saved.cooldownUntil      ?? 0;
    return true;
  } catch { return false; }
}

// Read last N lines of ES.txt (efficient tail — avoids loading the whole 100MB file)
function esTextTailLines(n = 3000) {
  const filePath = resolve(__dir, "../ES.txt");
  try {
    const buf = readFileSync(filePath);
    let end = buf.length - 1;
    while (end > 0 && (buf[end] === 10 || buf[end] === 13)) end--; // trim trailing newlines
    let count = 0, pos = end;
    while (pos >= 0 && count < n) { if (buf[pos] === 10) count++; pos--; }
    return buf.slice(pos + 2, end + 1).toString("utf8").split("\n");
  } catch { return []; }
}

// Compute 10-day directional persistence from ES.txt daily closes.
// Returns upPct (0–1): fraction of last 10 days that closed higher than previous day.
function computeUpPct() {
  const lines = esTextTailLines(15000); // ~10 trading days × ~1380 1m bars/day
  const dailyClose = new Map();
  for (const line of lines) {
    const p = line.split(",");
    if (p.length < 6) continue;
    const [mo, dy, yr] = p[0].split("/");
    const date = `${yr}-${mo.padStart(2,"0")}-${dy.padStart(2,"0")}`;
    dailyClose.set(date, +p[5]); // keeps overwriting → last bar of the day wins
  }
  const todayStr = new Date().toISOString().slice(0, 10);
  const sortedDays = [...dailyClose.keys()].sort().filter(d => d < todayStr);
  const last10 = sortedDays.slice(-10);
  let upCount = 0;
  for (let k = 1; k < last10.length; k++) {
    if (dailyClose.get(last10[k]) > dailyClose.get(last10[k - 1])) upCount++;
  }
  const comparisons = last10.length - 1;
  const upPct = comparisons >= 5 ? upCount / comparisons : 0;
  return { upPct, upCount, comparisons, last10 };
}
const TRADE_LOG   = resolve(LOGS_DIR, `trades-${SAFE_ACCOUNT_ID}.jsonl`);   // one JSON object per line
// Signals that fired but were blocked by the activeDirections slot gate (same
// direction already has an open position) leave NO trace anywhere otherwise --
// added 2026-10-13 so cross-strategy competition/cannibalization is actually
// measurable instead of invisible. Never affects trading, log-only.
const BLOCKED_SIGNAL_LOG = resolve(LOGS_DIR, `blocked-signals-${SAFE_ACCOUNT_ID}.jsonl`);
const WEEKLY_LOG  = resolve(LOGS_DIR, `weekly-${SAFE_ACCOUNT_ID}.jsonl`);   // weekly summaries
const SL_POSTMORTEM_PATH = resolve(LOGS_DIR, `sl-postmortems-${SAFE_ACCOUNT_ID}.json`);
const SL_REVIEW_LOG      = resolve(LOGS_DIR, `sl-review-${SAFE_ACCOUNT_ID}.jsonl`);

// Ensure logs directory exists
if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

// Per-account open-trade state file — survives process restarts.
// Written on every open/close so RECOVERED trades can restore signal/direction/entry.
function openTradeStatePath() {
  const acctId = process.env.ACCOUNT_ID || "default";
  return resolve(LOGS_DIR, `open-trade-${acctId}.json`);
}
function persistOpenTrade(data) {
  try { writeFileSync(openTradeStatePath(), JSON.stringify(data)); } catch {}
}
function clearPersistedOpenTrade() {
  try { writeFileSync(openTradeStatePath(), "{}"); } catch {}
}
function loadPersistedOpenTrade() {
  try {
    const raw = readFileSync(openTradeStatePath(), "utf8");
    const d = JSON.parse(raw);
    if (d && d.signalId) return d;
  } catch {}
  return null;
}

// Persist seenTradeIds across restarts — prevents reconcileMissedTrades from
// double-counting trades that were already processed before the restart.
function seenTradesPath() {
  const acctId = process.env.ACCOUNT_ID || "default";
  return resolve(LOGS_DIR, `seen-trades-${acctId}.json`);
}
function loadSeenTradeIds() {
  try {
    const raw = readFileSync(seenTradesPath(), "utf8");
    const { date, ids } = JSON.parse(raw);
    const today = new Date().toISOString().slice(0, 10);
    if (date === today && Array.isArray(ids)) {
      console.log(`[SeenTrades] Restored ${ids.length} trade IDs from disk`);
      return new Set(ids.map(String));
    }
  } catch {}
  return new Set();
}
function saveSeenTradeIds() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(seenTradesPath(), JSON.stringify({ date: today, ids: [...state.seenTradeIds].slice(-1000) }));
  } catch {}
}

dotenv.config({ path: new URL("../.env", import.meta.url).pathname });

// ─── US Market Holidays (ES futures closed — no regular session) ──────────────
// Format: "YYYY-MM-DD" in US Central time (CME exchange timezone)
// Update each January for the new year.
const MARKET_HOLIDAYS = new Set([
  // 2026
  "2026-01-01",  // New Year's Day
  "2026-01-19",  // Martin Luther King Jr. Day
  "2026-02-16",  // Presidents' Day
  "2026-04-03",  // Good Friday
  "2026-05-25",  // Memorial Day
  "2026-06-19",  // Juneteenth
  "2026-07-03",  // Independence Day (observed)
  "2026-09-07",  // Labor Day
  "2026-11-26",  // Thanksgiving
  "2026-12-25",  // Christmas
  // 2027
  "2027-01-01",  // New Year's Day
  "2027-01-18",  // Martin Luther King Jr. Day
  "2027-02-15",  // Presidents' Day
  "2027-04-02",  // Good Friday
  "2027-05-31",  // Memorial Day
  "2027-06-19",  // Juneteenth (observed Sat → Fri)
  "2027-07-05",  // Independence Day (observed Mon)
  "2027-09-06",  // Labor Day
  "2027-11-25",  // Thanksgiving
  "2027-12-24",  // Christmas (observed Fri)
]);

// Early-close days: US markets close at 12:00 PM CT (17:00 UTC) — no PM session
const EARLY_CLOSE_DAYS = new Set([
  "2026-11-27",  // Day after Thanksgiving
  "2026-12-24",  // Christmas Eve
  "2027-11-26",  // Day after Thanksgiving
  "2027-12-31",  // New Year's Eve
]);

function isTodayHoliday() {
  // Use CT date (CME timezone) — UTC-5 or UTC-6
  const ctOffset = isDST() ? -5 : -6;
  const ct = new Date(Date.now() + ctOffset * 60 * 60 * 1000);
  const dateStr = ct.toISOString().slice(0, 10);
  return MARKET_HOLIDAYS.has(dateStr);
}

function isTodayWeekend() {
  // ES futures have no regular AM/PM session on Saturday or Sunday
  const ctOffset = isDST() ? -5 : -6;
  const ct = new Date(Date.now() + ctOffset * 60 * 60 * 1000);
  const day = ct.getUTCDay(); // 0=Sunday, 6=Saturday
  return day === 0 || day === 6;
}

function isTodayScaleEdgeDay() {
  // Monday or Friday — the funded-account day-of-week scaling rule pins these
  // to 1ct regardless of cushion (start/end of week = smaller sample, more gap risk).
  const ctOffset = isDST() ? -5 : -6;
  const ct = new Date(Date.now() + ctOffset * 60 * 60 * 1000);
  const day = ct.getUTCDay(); // 0=Sunday, 1=Monday, 5=Friday, 6=Saturday
  return day === 1 || day === 5;
}

function isTodayEarlyClose() {
  const ctOffset = isDST() ? -5 : -6;
  const ct = new Date(Date.now() + ctOffset * 60 * 60 * 1000);
  return EARLY_CLOSE_DAYS.has(ct.toISOString().slice(0, 10));
}

// Format a UTC Date (or now) as "h:mm AM/PM MT" in Mountain time
function mtTimeStr(date = new Date()) {
  const offset = isDST() ? -6 : -7;   // MDT = UTC-6, MST = UTC-7
  const mt = new Date(date.getTime() + offset * 3600 * 1000);
  let h = mt.getUTCHours(), m = mt.getUTCMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  const label = isDST() ? "MDT" : "MST";
  return `${h}:${String(m).padStart(2,"0")} ${ampm} ${label}`;
}

function isDST() {
  // US DST: second Sunday in March → first Sunday in November
  const now = new Date();
  const year = now.getUTCFullYear();
  const dstStart = nthSundayUTC(year, 2, 2);   // March (month 2), 2nd Sunday
  const dstEnd   = nthSundayUTC(year, 10, 1);  // November (month 10), 1st Sunday
  return now >= dstStart && now < dstEnd;
}

function nthSundayUTC(year, month, n) {
  const d = new Date(Date.UTC(year, month, 1));
  const day = d.getUTCDay();
  const first = day === 0 ? 1 : 8 - day;
  return new Date(Date.UTC(year, month, first + (n - 1) * 7, 8, 0, 0)); // 8am UTC = open
}

// ─── Economic News Filter ─────────────────────────────────────────────────────
// Tier 1 events cause 10–50 tick spikes — pause entries around them.
// Source: ForexFactory calendar API (free, no auth required)
const TIER1_KEYWORDS = [
  "Non-Farm", "NFP",
  "CPI", "Consumer Price Index",
  "FOMC", "Fed Funds", "Federal Funds",
  "PCE", "Core PCE",
  "GDP",
  "ISM Manufacturing",
];

async function refreshNewsFilter() {
  // Skip if already fetched today — avoids 429 on multiple restarts
  const todayKey = ctDateStr();
  if (state._newsFetchedDate === todayKey) {
    console.log("[News] Calendar already loaded for today — skipping fetch");
    return;
  }
  try {
    const res = await axios.get("https://nfs.faireconomy.media/ff_calendar_thisweek.json", {
      timeout: 8000,
    });
    const events = res.data || [];
    const todayCT = ctDateStr();
    let fomcDay = false;
    const blocks = [];

    for (const ev of events) {
      if (!ev.date?.startsWith(todayCT)) continue;
      if (ev.impact !== "High") continue;
      const isTier1 = TIER1_KEYWORDS.some(k => ev.title?.includes(k));
      if (!isTier1) continue;

      if (ev.title?.includes("FOMC") || ev.title?.includes("Fed Funds")) {
        fomcDay = true;
      }

      // ev.date is like "2026-05-28T14:30:00-04:00"
      const evTime = new Date(ev.date).getTime();
      blocks.push({ title: ev.title, from: evTime - 10 * 60000, to: evTime + 20 * 60000 });
    }

    state.isFOMCDay      = fomcDay;
    state._newsBlocks    = blocks;
    state._newsFetchedDate = todayKey;

    if (blocks.length) {
      console.log(`[News] ${blocks.length} Tier-1 event(s) today — entries paused ±10/20 min:`);
      blocks.forEach(b => console.log(`       ${b.title} | block ${new Date(b.from).toUTCString()} → ${new Date(b.to).toUTCString()}`));
    }
    if (fomcDay) console.log("[News] ⚠️  FOMC day — PM session (18:00–20:00 UTC) disabled");
  } catch (err) {
    console.warn("[News] Calendar fetch failed:", err.message);
  }
}

function isNewsBlocked() {
  const now = Date.now();
  if (!state._newsBlocks) return false;
  return state._newsBlocks.some(b => now >= b.from && now <= b.to);
}

// ─── Push Notifications (ntfy.sh) ────────────────────────────────────────────
const NTFY_CHANNEL = (process.env.NTFY_CHANNEL || "").trim();

async function notify(title, message, priority = "default") {
  if (!NTFY_CHANNEL) return;
  try {
    // Multiple accounts commonly share one NTFY_CHANNEL (simpler than subscribing
    // to N separate topics on a phone), and most notify() calls here — DLL hit,
    // profit cap hit, order rejected, combine target reached, drawdown warning,
    // hub reconnecting — bypass the orchestrator's per-account bundle/label system
    // entirely (that only covers TRADE_ENTERED/CLOSED, TREND_FILTER, and the brief/
    // summary events). Without this, two accounts with different configs (e.g. a
    // $350 vs $4,500 profit cap) send visually identical pushes with no way to
    // tell which account triggered which.
    const label = process.env.ACCOUNT_LABEL ? `[${process.env.ACCOUNT_LABEL}] ` : "";
    await axios.post(`https://ntfy.sh/${NTFY_CHANNEL}`, message, {
      headers: {
        Title:    label + title,
        Priority: priority,   // min / low / default / high / urgent
        Tags:     "chart_with_upwards_trend",
      },
      timeout: 5000,
    });
  } catch { /* non-fatal — don't crash engine if ntfy is down */ }
}

// When running under multi-account orchestrator, emit structured events instead of
// sending ntfy directly — the orchestrator aggregates and sends one bundled notification.
const IS_MULTI       = process.env.MULTI_ACCOUNT === "1";
// Separate from IS_MULTI on purpose: the Electron app's main.js also sets
// MULTI_ACCOUNT=1 for its own multi-account support, but it discards every
// [BUNDLE] line outright and has no combined-notification replacement — so
// gating the individual brief on IS_MULTI there would silently leave those
// users with NO pre-session notification at all. Only multi-account.mjs (my
// own launcher) actually consumes [BUNDLE] events and sends a combined one,
// so only it sets this flag explicitly.
const HAS_BUNDLE_CONSUMER = process.env.BUNDLE_CONSUMER === "1";
// Stagger entry per account so all 4 combines don't hit the same tick simultaneously.
// Combine-1 → 0ms, Combine-2 → 2500ms, Combine-3 → 5000ms, Combine-4 → 7500ms.
// Prefer an explicit ACCOUNT_IDX from the launcher (main.js/multi-account.mjs pass
// the account's real position in the config list). NEVER derive the index from
// parsing ACCOUNT_LABEL's trailing digits as the primary path — TopstepX's own
// auto-generated account names (e.g. "50KTC-V2-DLL-646004-94940643") end in a
// large, unpredictable numeric ID, and parsing that out overflowed a 32-bit
// setTimeout — which Node silently clamps to 1ms — silently disabling the
// stagger protection entirely. The label-parsing fallback below only exists for
// bare CLI usage with no launcher, and is hard-capped so it can never repeat that.
const ACCOUNT_LABEL  = process.env.ACCOUNT_LABEL ?? "";
const MAX_SANE_ACCOUNT_IDX = 20; // 20 accounts × 2.5s = 50s max stagger — generous but bounded
let ACCOUNT_IDX;
if (process.env.ACCOUNT_IDX !== undefined) {
  ACCOUNT_IDX = Math.max(0, Math.min(MAX_SANE_ACCOUNT_IDX, parseInt(process.env.ACCOUNT_IDX) || 0));
} else {
  const parsedFallback = Math.max(0, (parseInt(ACCOUNT_LABEL.match(/(\d+)$/)?.[1] || "1") || 1) - 1);
  if (parsedFallback > MAX_SANE_ACCOUNT_IDX) {
    console.warn(`[Stagger] ⚠️  ACCOUNT_IDX not set and label "${ACCOUNT_LABEL}" parsed to an implausible index (${parsedFallback}) — clamping to 0. Pass ACCOUNT_IDX explicitly to fix properly.`);
    ACCOUNT_IDX = 0;
  } else {
    ACCOUNT_IDX = parsedFallback;
  }
}
// Artificial per-account delay before order submission — defaults to OFF.
// Each account already independently checks its own DLL/profit-cap gates and
// computes its own cushion-based size before this point, so removing the delay
// doesn't touch risk management or scaling at all — it only affects how close
// together in time two accounts' orders go out once each has independently
// decided to trade the same signal. Multiple accounts trading the same signal
// at nearly the same instant (natural network/processing latency only, no
// artificial delay added) was an explicit choice — set STAGGER_MS_PER_ACCOUNT
// to restore spacing if ever needed.
const STAGGER_MS_PER_ACCOUNT = parseInt(process.env.STAGGER_MS_PER_ACCOUNT || "0");
const ENTRY_STAGGER_MS = ACCOUNT_IDX * STAGGER_MS_PER_ACCOUNT;
function emitBundleEvent(type, data) {
  if (IS_MULTI) process.stdout.write(`[BUNDLE] ${JSON.stringify({ type, ...data })}\n`);
}

function ctDateStr(date = new Date()) {
  const offset = isDST() ? -5 : -6;
  const ct = new Date(date.getTime() + offset * 3600000);
  return ct.toISOString().slice(0, 10);
}

// ─── Trade log ────────────────────────────────────────────────────────────────
// Appends one JSONL record per closed trade. Used for tax records and analysis.
// Section 1256 contracts (ES futures): 60% long-term / 40% short-term capital
// gains regardless of holding period. Report on Form 6781 at year-end.
function logTrade(record) {
  try {
    appendFileSync(TRADE_LOG, JSON.stringify(record) + "\n");
  } catch (e) {
    console.warn("[Log] Failed to write trade log:", e.message);
  }
}

function logBlockedSignal(sig, dir, blockedBy) {
  try {
    appendFileSync(BLOCKED_SIGNAL_LOG, JSON.stringify({
      timestamp: new Date().toISOString(),
      signal: sig.id, dir, price: sig.price,
      blockedBy, // which direction's slot was already taken
    }) + "\n");
  } catch (e) {
    console.warn("[Log] Failed to write blocked-signal log:", e.message);
  }
}

// ─── SL post-mortem tracker ─────────────────────────────────────────────────
// For every stop-out, keep watching subsequent bars (same session only, same
// cutoff the live engine itself uses for EOD force-close) to see whether price
// would have reached the ORIGINAL take-profit anyway — quantifies how much of
// "losing" is really "direction right, stop too tight" vs "direction wrong",
// and exactly how many ticks the stop would have needed to survive the
// drawdown and still catch the TP. Works from REST order lookups only (not
// in-memory trade state), so it's identical whether the close came through the
// live SignalR path or the REST orphan-recovery path — on this account, most
// trades go through the latter (see reconcileMissedTrades).
function loadSlPostMortems() {
  try { return JSON.parse(readFileSync(SL_POSTMORTEM_PATH, "utf8")); } catch { return []; }
}
function saveSlPostMortems(list) {
  try { writeFileSync(SL_POSTMORTEM_PATH, JSON.stringify(list)); } catch {}
}
function logSlReview(record) {
  try { appendFileSync(SL_REVIEW_LOG, JSON.stringify(record) + "\n"); } catch {}
}

async function startSlPostMortem(closingOrderId, exitPrice, contracts, fallbackSignalId) {
  try {
    const slOd = await apiPost("/api/Order/searchById", { accountId: state.accountId, orderId: closingOrderId });
    const slOrder = slOd?.order ?? (slOd?.orders ?? slOd?.items ?? [])[0];
    if (!slOrder) return;
    const parentOrderId = slOrder.parentOrderId;
    const isLong  = slOrder.side === 1; // closing side is opposite of position — Ask(1)=sell=was LONG
    const slPrice = slOrder.stopPrice;

    let entryPrice = null, tpPrice = null, signalId = fallbackSignalId ?? null;
    if (parentOrderId != null) {
      const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
      const sibOd = await apiPost("/api/Order/search", { accountId: state.accountId, startTimestamp: since });
      const orders = sibOd?.orders ?? sibOd?.items ?? [];
      const entryOrder = orders.find(o => o.id === parentOrderId);
      const tpOrder = orders.find(o => o.parentOrderId === parentOrderId && /-TP$/.test(o.customTag || ""));
      if (entryOrder) {
        entryPrice = entryOrder.filledPrice;
        if (!signalId && entryOrder.customTag) signalId = entryOrder.customTag.replace(/_\d{10,}$/, '');
      }
      if (tpOrder) tpPrice = tpOrder.limitPrice;
    }
    if (entryPrice == null || tpPrice == null) {
      console.warn(`[SLReview] Could not resolve entry/TP for closing order ${closingOrderId} — skipping post-mortem`);
      return;
    }

    const list = loadSlPostMortems();
    list.push({
      closingOrderId,  // join key back to this trade's row in trades.jsonl (its exit order id)
      signalId: signalId ?? "unknown", isLong, entryPrice, tpPrice, slPrice, exitPrice, contracts,
      actualStopTicks: Math.round(Math.abs(exitPrice - entryPrice) / CFG.tickSize),
      worstAdverseTicks: Math.round(Math.abs(exitPrice - entryPrice) / CFG.tickSize),
      openedDate: new Date().toISOString().slice(0, 10),
      startedAt: new Date().toISOString(),
    });
    saveSlPostMortems(list);
    console.log(`[SLReview] 📋 Tracking post-mortem for ${signalId} ${isLong ? "LONG" : "SHORT"} — entry ${entryPrice}, TP ${tpPrice}, watching for reversal`);
  } catch (e) {
    console.warn(`[SLReview] Failed to start post-mortem: ${e.message}`);
  }
}

// Called on every new 5-min bar close — updates MAE and resolves any pending
// post-mortems whose window (same session) has hit TP or ended.
//
// Takes the FULL bars array and processes every bar newer than the last one
// we've already checked — not just the single latest bar. The caller only
// invokes this when its own tick lands inside the 10s window after a 5m
// boundary; if a tick is ever skipped entirely (a hub reconnect, a slow
// fetch, any delay that pushes past that window), the bar that closed during
// the gap was previously never evaluated at all — state.bars.at(-1) only
// shows whichever bar is newest *right now*, silently skipping whatever
// closed in between. A 2026-09-30 trade's real worst excursion (42t, in a
// bar that fell in exactly this kind of gap) was recorded as just 16t as a
// result — a real accuracy bug, not a 5-minute-granularity limitation.
let lastSlPostMortemBarTime = 0;
function checkSlPostMortems(bars) {
  const list = loadSlPostMortems();
  if (list.length === 0) return;
  const newBars = bars.filter(b => b.time > lastSlPostMortemBarTime).sort((a, b) => a.time - b.time);
  if (newBars.length === 0) return;
  lastSlPostMortemBarTime = newBars[newBars.length - 1].time;

  let stillOpen = list;
  for (const bar of newBars) {
    const d  = new Date(bar.time * 1000);
    const hm = d.getUTCHours() * 100 + d.getUTCMinutes();
    const sessionOver = (hm >= 1500 && hm < 1800) || hm >= 2000;
    const next = [];
    for (const p of stillOpen) {
      let resolved = false;
      if (p.isLong) {
        const adverseTicks = Math.round((p.entryPrice - bar.low) / CFG.tickSize);
        if (adverseTicks > p.worstAdverseTicks) p.worstAdverseTicks = adverseTicks;
        if (bar.high >= p.tpPrice) resolved = true;
      } else {
        const adverseTicks = Math.round((bar.high - p.entryPrice) / CFG.tickSize);
        if (adverseTicks > p.worstAdverseTicks) p.worstAdverseTicks = adverseTicks;
        if (bar.low <= p.tpPrice) resolved = true;
      }
      if (resolved) {
        // Distinguish a genuinely actionable near-miss (stop only needed a little
        // more room) from a wild outlier swing (needed way more room than any
        // reasonable stop would risk) — the former is worth reviewing on the
        // weekend, the latter is just noise from one extreme move.
        const marginTicks = p.worstAdverseTicks - p.actualStopTicks;
        const closeCall = marginTicks <= 10;
        logSlReview({ ...p, resolution: "WOULD_HAVE_WON", ticksNeededToSurvive: p.worstAdverseTicks, marginTicks, closeCall, resolvedAt: new Date().toISOString() });
        console.log(`[SLReview] ${closeCall ? "🟡 CLOSE CALL" : "✅"} ${p.signalId} WOULD have hit TP — needed ${p.worstAdverseTicks}t stop to survive (actual stop was ${p.actualStopTicks}t, margin +${marginTicks}t)${closeCall ? " — worth a look this weekend" : ""}`);
        continue;
      }
      if (sessionOver) {
        logSlReview({ ...p, resolution: "DIRECTION_WRONG", ticksNeededToSurvive: null, resolvedAt: new Date().toISOString() });
        console.log(`[SLReview] ❌ ${p.signalId} never reached TP by session end — direction was wrong`);
        continue;
      }
      next.push(p);
    }
    stillOpen = next;
    if (stillOpen.length === 0) break;
  }
  saveSlPostMortems(stillOpen);
}

function logWeeklySummary(record) {
  try {
    appendFileSync(WEEKLY_LOG, JSON.stringify(record) + "\n");
  } catch (e) {
    console.warn("[Log] Failed to write weekly log:", e.message);
  }
}

// User config may specify which of the 6 active strategies to enable.
// ENABLED_STRATEGIES=AVWAP_L,RSI2_L → disable the rest from the active set.
// V3 signals (2026-08-02 quant rebuild — see strategies.js header for methodology)
// NQ_BB_SQUEEZE_L/S are NQ-only signals from nq-strategies.js — must be in this list
// or they bypass the ENABLED_STRATEGIES whitelist filter entirely.
// V5 NQ signals (Portfolio V5, 2026-09-10 quant rebuild — see nq-strategies.js header for methodology)
const ACTIVE_STRATEGIES = ["DONCH15_L","VOLBO_L","VOLBO_S","EMA21_PULL_L","BO10_S","3BAR_BEAR_S","KELT_L","NQ_OB_FADE_L","NQ_OB_FADE_S","NQ_AM_VWAP_FADE_L","NQ_AM_VWAP_FADE_S","NQ_ADR_FADE_L","NQ_ADR_FADE_S","NQ_14H_REV_S","NQ_FIRST30_FADE_L","NQ_FIRST30_FADE_S","NQ_PM_VWAP_FADE_L","NQ_PM_VWAP_FADE_S","NQ_OVERNIGHT_TRAP_S","NQ_TIGHT_VWAP_AM_L","NQ_TIGHT_VWAP_AM_S","NQ_HILOW_REJ_AM_L","NQ_HILOW_REJ_AM_S","NQ_MOM_EXHAUST_AM_L","NQ_MOM_EXHAUST_AM_S","NQ_PULLBACK_AM_L","NQ_PULLBACK_AM_S"];
function buildUserDisabledStrategies() {
  const env = process.env.ENABLED_STRATEGIES;
  if (!env) return [];
  const enabled = new Set(env.split(",").map(s => s.trim()));
  return ACTIVE_STRATEGIES.filter(s => !enabled.has(s));
}

// ─── Config ───────────────────────────────────────────────────────────────────
const CFG = {
  userName:       process.env.TV_USER       || "",
  apiKey:         process.env.TV_API_KEY    || "",
  accountId:      process.env.ACCOUNT_ID    ? parseInt(process.env.ACCOUNT_ID) : null,
  contractSearch: process.env.SYMBOL        || "ES",
  maxContracts:   parseInt(process.env.MAX_CONTRACTS || "2"),  // overridable per account via env
  // AUTO_SCALING=0 disables cushion-based sizing — trades a fixed maxContracts every time
  // (still hard-capped at the account's real contract limit by TopstepX itself).
  autoScaling:    process.env.AUTO_SCALING !== "0",
  stopTicks:      parseInt(process.env.STOP_LOSS_TICKS   || "10"),
  // Every trade uses exactly this many ticks from fill regardless of the
  // signal's own stopTicks or the bar-anchored barHigh/barLow calc. Defaults
  // to 10 (not null) as of 2026-10-03 — this used to default to null, silently
  // falling back to the old fully variable bar-anchored model (which hit
  // 112-339t on 2026-09-25, and separately caused a user's config missing
  // this env var to see 191-308t stops and zero trades, since every signal
  // then got filtered by maxStopTicks). An extensive backtest campaign
  // confirmed fixed-10t beats every alternative by a wide margin — that
  // decision should hold by default, not only when a user happens to set
  // this var correctly. Set FORCE_FIXED_STOP_TICKS to a different value to
  // override, or explicitly to the string "off" to opt back into the
  // bar-anchored model (not recommended).
  forceFixedStopTicks: process.env.FORCE_FIXED_STOP_TICKS === "off" ? null : parseInt(process.env.FORCE_FIXED_STOP_TICKS || "10"),
  maxStopTicks:   parseInt(process.env.MAX_STOP_TICKS    || "25"),  // skip trade if bar range would push SL > this many ticks from fill
  trailTicks:     parseInt(process.env.TRAIL_TICKS       || "8"),
  tpTicks:        parseInt(process.env.TAKE_PROFIT_TICKS || "48"),
  stopMode:       process.env.STOP_MODE || null,   // "trail"|"fixed"|null (null = per-strategy default)
  regimeFilter:   process.env.REGIME_FILTER || "auto",  // "auto"|"bull"|"bear"
  cooldownLosses:   parseInt(process.env.COOLDOWN_LOSSES    || "5"),
  badDayThreshold:  parseInt(process.env.BAD_DAY_THRESHOLD  || "1000"),  // prior-day loss cap for next-day 1ct mode
  dailyLossLimit:   parseInt(process.env.DAILY_LOSS_LIMIT   || "1400"),
  dailyProfitCap:  parseInt(process.env.DAILY_PROFIT_CAP  || "2000"),
  combineTarget:   parseFloat(process.env.COMBINE_TARGET  || "6000"),    // override per-account via accounts.json
  accountBase:     parseFloat(process.env.ACCOUNT_BASE    || "100000"),   // starting balance — 50K or 100K combine
  combineBalance:  parseFloat(process.env.ACCOUNT_BASE || "100000") + parseFloat(process.env.COMBINE_TARGET || "6000"),
  trailDD:         parseFloat(process.env.TRAIL_DD        || "2500"),     // TopstepX trailing DD limit (EOD, not intraday)
  // Extra delay (ms) before a shared-API-key account's FIRST reconnect attempt after
  // being kicked by another account logging in. 0 (default) = reconnect immediately,
  // same as before. Set on the lower-priority account only — see the hub onclose handler.
  reconnectPriorityDelayMs: parseInt(process.env.RECONNECT_PRIORITY_DELAY_MS || "0"),
  trailDDWarn:     2000,   // warn at $2,000 drawdown (buffer from $2,500 trailing EOD DD)
  // Dollar cushion required per contract step in the combine ladder (Layer 0a).
  // Default 400 matches the original 100K calibration; larger accounts with a
  // proportionally larger trailDD should widen this so the ladder steps stay
  // conservative relative to account size.
  cushionStepDollars: parseFloat(process.env.CUSHION_STEP_DOLLARS || "400"),
  // Risk-based sizing cap — complements the bar-anchored stop model, where stop
  // distance (and therefore $ risk per contract) varies trade to trade instead
  // of being fixed. The cushion ladder alone doesn't know how wide THIS trade's
  // stop is; this caps contracts so no single trade risks more than this many
  // dollars, regardless of how much cushion would otherwise allow. 0 = disabled.
  targetRiskDollars: parseFloat(process.env.TARGET_RISK_DOLLARS || "0"),
  tickSize:       0.25,
  tickValue:      12.50,

  // ── Trailing stop (5m entries only) ──
  // 17yr Kibot backtest shows 8t is the optimal fixed trail — wider loses money:
  //   8t: 40%WR +$17/tr | 10t: 34% -$1/tr | 12t: 32% -$15/tr | 16t: 31% -$35/tr
  // Avg loss at 8t = $53 vs $82 at 12t (smaller losses, similar wins). TP rarely hits anyway.
  // Clamping max to 8t removes ATR-adaptive widening that hurt live performance.
  // Changed 2026-06-13 from atrTrailMax:16 → 8 (effectively fixed 8t trail).
  atrTrailMult:   0.75,
  atrTrailMin:    8,
  atrTrailMax:    8,

  // ── Pre-filter (13:45–14:15 UTC) ─────────────────────────────────────────────
  // All strategies allowed from 13:45 onward — backtest (2022–2026) confirmed
  // relaxing the old EMAPB_L-only gate adds +$1,745/yr with better $/trade quality
  // (23.9%WR/$23/tr vs 23.8%WR/$18/tr). Trend direction gate at 14:15 still protects
  // against counter-trend signals on strong directional days.
  preFilterAllowed: null,  // null = no restriction; all strategies eligible from open

  // ── Forward-test strategies ───────────────────────────────────────────────
  // Signals are evaluated and logged but no order is placed.
  // Use to accumulate live signal data before committing real capital.
  // ORB_L: reverted to forward-test 2026-08-01 — accurate backtest (evaluateExtended) shows 27%WR +$1,115/yr at 25t/8t,
  //         but -$1,513 in 2026 and high year-to-year variance. Re-activate when 3mo live signals show >24% WR.
  forwardTestStrategies: new Set(["BB_FADE_L", "ORB_L"]),

  // ── Early-AM tighter uptrend gate (14:15–14:30 UTC) ─────────────────────────
  // After amTrendChecked fires at 14:15, the standard threshold is 10pts. But in the
  // first 15 min after the check (14:15–14:30), apply a tighter 5pt threshold to catch
  // borderline uptrend days (like Jul 14 2026 where the full 10pt gate didn't trigger
  // but shorts still got destroyed). After 14:30 only the standard 10pt gate applies.
  earlyAMUptrendPts: 5,

  // ── Strategy gate — signals whose id starts with any of these prefixes are skipped ──
  // Add a prefix here to pause a strategy without touching strategies.js.
  // Remove to re-enable. Review dates in memory doc.
  // V3 (2026-08-02): all 7 signals are active — no pauses needed.
  // Old V2 signal IDs from strategies-v2-backup.js preserved in this list as tombstones
  // so the engine never accidentally fires them if strategies.js is rolled back partially.
  pausedStrategies: [
    // ── V2 tombstones (signals no longer in strategies.js after V3 rebuild) ────
    // These are harmless dead entries — V3 strategies.js never emits these IDs.
    // Kept so the paused filter still works if V2 backup is temporarily imported.
    "AVWAP_L", "AVWAP_S", "EMAPB_L", "EMAPB_S", "RSI2_L", "RSI2_S",
    "EMAXPB_L", "EMAXPB_S", "EMA50_PB_L", "EMAFAN_S", "BB_SQ_L", "BB_FADE_L",
    "STOCH_L", "STOCH_S", "KELT_S", "DONCHIAN_BO_L", "INSIDE_BAR_BO_L", "INSIDE_BAR_BO_S",
    "LIQ_SWEEP_S", "PDH_REJ_S", "ORB_FAIL_S", "FAILED_AUCTION_S", "SESSION_HIGH_FAIL_S",
    "GAP_FAIL_S", "GAP_ACCEPTED_FADE_S", "OVERNIGHT_HIGH_S", "RSI_FAIL_S",
    "VOL_CLIMAX_S", "EXHST_S", "BEARISH_FVG_S", "BODY_ENGULF_S", "TRAP_S",
    "E200_REJ_S", "ORB_L", "MACD_FAN_S", "VWAP_RECLAIM_L", "MARKET_STRUCT_S",
    "DAY_BREAK_FAIL_S", "EXHAUST_CONT_S", "PIVOT_R1_S",
    // ── NQ V2 tombstones (replaced by Portfolio V5 on 2026-09-10) ────────────
    // These IDs are no longer emitted by nq-strategies.js. Kept here so the paused
    // filter prevents accidental execution if nq-strategies.js is ever rolled back.
    "NQ_BB_SQUEEZE_L", "NQ_BB_SQUEEZE_S", "NQ_DONCHIAN_BO_L", "NQ_DONCHIAN_BO_S",
    "NQ_VWAP_TOUCH_L", "NQ_VWAP_TOUCH_S", "CONF_TREND_L", "CONF_TREND_S",
    "CONF_REV_L", "CONF_REV_S", "NQ_ORB_L", "NQ_ORB_S", "NQ_DIV_L", "NQ_DIV_S",
    // ── V5 long fades disabled 2026-09-14 ──────────────────────────────────
    // 7.5-year backtest (2019–2026) showed long fades net-negative vs shorts-only.
    // Shorts-only: +$719K ($93K/yr at 4ct). All long fades combined: -$56K drag.
    // NQ_14H_REV_S: short only (long side tombstoned with other fades 2026-09-14).
    "NQ_OB_FADE_L", "NQ_AM_VWAP_FADE_L", "NQ_ADR_FADE_L", "NQ_PM_VWAP_FADE_L", "NQ_FIRST30_FADE_L",
    // ── Active V5.5 shorts (regime overfit Jun–Sep 2026, deployed 2026-09-20) ──
    // NQ_OB_FADE_S, NQ_AM_VWAP_FADE_S, NQ_ADR_FADE_S,
    // NQ_14H_REV_S, NQ_FIRST30_FADE_S, NQ_PM_VWAP_FADE_S,
    // NQ_OVERNIGHT_TRAP_S
    // NQ_SESSION_HIGH_FAIL_S — disabled V5.5 (negative Jun–Sep 2026)
    // ── Active ES/V3 signals (none paused) ──
    // DONCH15_L, VOLBO_L, VOLBO_S, EMA21_PULL_L, BO10_S, 3BAR_BEAR_S, KELT_L
    // Additional strategies disabled by user config (ENABLED_STRATEGIES env var)
    ...buildUserDisabledStrategies(),
  ],

  // Strategies suppressed when upPctOverbought (≥ 8/10 days closed up).
  // Backtest 2022-2026: 13% WR, -$63/tr avg on blocked trades. +$436/yr improvement.
  // V3: suppress long-biased signals and short reversal (3BAR_BEAR_S) in overbought regimes.
  // ≥8/10 days closed up = near-term short setups unreliable; longs near resistance.
  overboughtSuppressSet: new Set([
    "3BAR_BEAR_S", "KELT_L", "EMA21_PULL_L",
  ]),

  // ── ATR volatility filter ──
  // Skip any signal when ATR(20) on the last 150 5m bars is below this threshold (in points).
  // Backtest 2022-2026: ATR 1.5-2.0 = 15.2%WR / -$8/tr (net negative). ATR 2.0-2.5 = 31%WR / +$106/tr.
  // Raised from 1.5 → 2.0 on 2026-07-30: cuts 66 losing-ATR trades, +$115/yr, no WR cost.
  atrMinFilter:       parseFloat(process.env.ATR_MIN_FILTER       || "2.0"),
  fundedStartBalance: parseInt(process.env.FUNDED_START_BALANCE  || "-1"),  // >= 0 enables cushion scaling; -1 = disabled

  // Real TopstepX Express Funded scaling plan (confirmed from the account's own
  // Risk Settings page, not a convention we made up like the old $2K-step ladder).
  // Format: "threshold:contracts,threshold:contracts,..." ascending by threshold.
  // FUNDED_SCALE_BASE is the floor below the first threshold.
  // Mon/Fri edge-day cap (1ct regardless of cushion) is a personal risk preference,
  // not a default for every commercial customer's funded account — opt-in only.
  scaleEdgeDayCap:  process.env.SCALE_EDGE_DAY_CAP === "1",
  // Cap SIZE on Mon/Fri — default 1ct; raised to 2ct here 2026-10-06 after the AM/PM
  // window-widening backtest showed Mon/Fri's win rate held up (OOS 42%/44%) with
  // acceptable worst-day risk at higher size. Revisit after a few live weeks.
  scaleEdgeDayCapContracts: parseInt(process.env.SCALE_EDGE_DAY_CAP_CONTRACTS || "1"),
  fundedScaleBase:  parseInt(process.env.FUNDED_SCALE_BASE || "0"),  // 0 = table not active for this account
  fundedScaleTiers: (process.env.FUNDED_SCALE_TIERS || "")
    .split(",").filter(Boolean)
    .map(s => { const [t, c] = s.split(":"); return [parseFloat(t), parseInt(c)]; })
    .sort((a, b) => a[0] - b[0]),
  // Below the first real tier threshold, ramp 1 contract per this many $ instead
  // of jumping straight to fundedScaleBase — smoother sizing on the way up.
  fundedScaleBaseStep: parseInt(process.env.FUNDED_SCALE_BASE_STEP || "0"),  // 0 = jump straight to base (old behavior)
  // Above the LAST tier's threshold, ramp 1 contract per this many $ (starting
  // from the second-to-last tier's count) instead of jumping straight to the
  // last tier's count — that count is treated as the real ceiling, not a jump target.
  fundedScalePostStep: parseInt(process.env.FUNDED_SCALE_POST_STEP || "0"),  // 0 = jump straight to ceiling (old behavior)

  // ── Trend-day direction filters ──────────────────────────────────────────────
  // Measure the AM session's first-30-min move (open of 13:45 bar → close of 14:15 bar).
  // If the move exceeds a threshold, suppress the losing direction for the AM remainder ONLY.
  // PM session filter deliberately OFF — accuracy test showed 46-51% (coin flip), costs money.
  //
  // Accuracy test 2022-2026 (4.4yrs, post-filter window):
  //   +4pts uptrend: 52.5% accurate, PM 50.8% — too noisy, fires on too many reversals
  //   +8pts uptrend: 60.0% accurate — cleaner signal
  //  +10pts uptrend: best net P&L in sweep (+$3,367/yr vs +$2,601/yr at +4pts)
  //   -6pts downtrend: 51.3% accurate but sweep confirms -6pts is already optimal
  //
  // Sweep result: +10pts / -6pts / PM filter OFF = +$3,367/yr (best of 96 combos tested)
  // Previous:     +4pts  / -6pts / PM filter ON  = +$2,601/yr
  uptrendFilterPts:   parseInt(process.env.TREND_UP_PTS || "10"),
  downtrendFilterPts: parseInt(process.env.TREND_DN_PTS || "6"),
};

// ─── NQ Instrument Overrides ──────────────────────────────────────────────────
// Applied immediately when SYMBOL=NQ — overrides ES defaults before any trading logic runs.
// NQ tick: $5/tick, 0.25pt. V5 signals each specify their own stop (8t) and TP (28-40t).
// Portfolio V5 (2020-2026): $978K | 68%WR | $102/tr | ~$140K/yr | WFO OOS 106% of IS
if (CFG.contractSearch === "NQ") {
  CFG.tickValue  = 5.00;        // $5/tick vs ES $12.50
  // V5: tpTicks and stopTicks are NOT set here — every V5 signal specifies its own
  //     stopTicks (8t) and tpTicks (28-40t) in the signal object. CFG defaults are
  //     only used when sig.stopTicks / sig.tpTicks are absent (legacy fallback).
  // maxStopTicks: accounts.json MAX_STOP_TICKS takes priority; only fall back to 60 if unset.
  if (!process.env.MAX_STOP_TICKS) CFG.maxStopTicks = 60;
  // Clear ES-specific tombstones from pausedStrategies, then re-apply ENABLED_STRATEGIES
  // filter for NQ-specific signals. Without the re-apply the whitelist has no effect on NQ.
  CFG.pausedStrategies.length = 0;
  CFG.pausedStrategies.push(...buildUserDisabledStrategies());
  CFG.forwardTestStrategies.clear();
  CFG.overboughtSuppressSet.clear(); // upPct gate reads ES.txt — not applicable for NQ
}

// ─── Funded Account Overrides ─────────────────────────────────────────────────
// Applied automatically at startup when account.simulated === false (funded account).
// Combine accounts are simulated=true; funded accounts are simulated=false.
// DO NOT edit these until the combine is passed — they activate on their own.
const CFG_FUNDED = {
  // MAX_CONTRACTS env var (accounts.json) takes priority; fall back to 2ct default for NQ
  maxContracts:   process.env.MAX_CONTRACTS ? parseInt(process.env.MAX_CONTRACTS) : 2,
  dailyLossLimit: process.env.DAILY_LOSS_LIMIT ? parseInt(process.env.DAILY_LOSS_LIMIT) : 900,
  // Topstep 50K funded daily loss limit = $1,000. Engine halts at $900 to leave $100 buffer.
  // accounts.json sets DAILY_LOSS_LIMIT=900 explicitly; this fallback ensures it's never inherited from combine default ($1,400).
  // No consistency rule on funded, and the incremental profit-lock staircase
  // already banks gains as a trade runs (see checkProfitLockLadder) — so there's
  // no need to hard-cap and force-close the day at a fixed dollar number anymore.
  dailyProfitCap: Infinity,
};

// ─── 15m Layer Config ─────────────────────────────────────────────────────────
// V3 (2026-08-02): 15m layer disabled — V3 strategies are 5m-calibrated only.
// evaluateExtended() returns [] and no V3 signals pass the allowedStrategies filter.
// Re-evaluate after sufficient live data confirms 15m signal quality.
const CFG15m = {
  stopTicks:         8,
  tpTicks:           40,
  stopType:          "trail",
  allowedStrategies: new Set([]),  // V3: 15m layer inactive
  minBars:           210,
};

const REST_BASE = "https://api.topstepx.com";
const USER_HUB  = "https://rtc.topstepx.com/hubs/user";

// ─── API Enums ────────────────────────────────────────────────────────────────
const OrderType = { Limit: 1, Market: 2, Stop: 4, TrailingStop: 5 };
const OrderSide = { Bid: 0, Ask: 1 };   // Bid = Buy, Ask = Sell

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  token:              null,
  accountId:          null,
  contractId:         null,
  tickValue:          CFG.tickValue,
  simulated:          true,   // set from account lookup — drives live: flag

  bars:               [],           // normalised OHLCV 5m bars
  bars15:             [],           // normalised OHLCV 15m bars
  esBars:             [],           // ES 5m bars for NQ_DIV divergence signal
  esContractId:       null,         // resolved at boot, used for ES bar fetches

  activeDirections:   new Set(),    // "long" | "short" — direction gate (SHARED by 5m + 15m)
  openTrades:         new Map(),    // orderId → { signalId, isLong }
  seenTradeIds:       loadSeenTradeIds(),  // persisted across restarts — prevents double-count on reconcile

  consecutiveLosses:  0,
  consecutiveWins:    0,
  cooldownUntil:      0,
  dayPnL:             0,
  prevDayPnL:         0,   // prior session's final P&L — persists across the 13:30 UTC reset
  dayWins:            0,
  dayLosses:          0,
  sessionLongCount:   0,   // longs entered today (used for 2nd-long-after-win gate)
  sessionLongWon:     false, // true once a long TP fires today — unlocks 2nd long bypass
  upPctOverbought:    false, // true when ≥ 8 of last 10 days closed up — suppresses trending strats
  haltedToday:             false,
  profitCappedToday:       false,
  briefSentToday:          false,
  earlyHealthCheckDone:    false,  // true once the 13:10 UTC pre-open connectivity check has run today
  runnerClosePending:      false,  // true once runner-close market order has been sent (dedup guard)
  combineTargetNotified:   false,  // true once combine target push notification has fired
  balance:            null,   // live account balance (updated on every account event)
  startOfDayBalance:  null,   // balance at 13:30 UTC reset — used for API reconciliation
  dayContextRecovered: false, // true after reconcileMissedTrades restores mid-day dayPnL
  peakBalance:        null,
  eodPeakBalance:     null,  // see loadEodPeakBalance() — the real trailing-DD floor basis
  openPositionSize:   0,      // current open position size (updated by onPositionEvent)
  openPositionDir:    null,   // "long" | "short" | null

  pendingRetry:       null,  // { signalId, isLong, contracts, tradeOpts } — set on mismatch close, cleared after one retry attempt
  mismatchRetryDone:  false, // true after one retry attempt today — prevents infinite loop if retry also misfires

  watchdogBusy:       false,    // prevents concurrent watchdog runs
  lastStopTimes:      new Map(), // signalId → ms timestamp of last stop loss (per-signal 15-min cooldown)
  watchdogForcedAt:   null,     // ms timestamp of last watchdog-initiated force close

  newsBlockUntil:     0,   // epoch ms — no new entries until this time
  isFOMCDay:          false,

  // Trend-day filter state (reset each morning at 13:30 UTC)
  amSessionOpenPrice: null,   // open of first RTH bar (13:30 UTC) — trend filter baseline
  amTrendChecked:     false,  // true once the 30-min check has fired today
  noShortsToday:      false,  // uptrend day: suppress all short signals
  noLongsToday:       false,  // downtrend day: suppress all long signals
  gapUpDay:           false,  // true when today's AM open > prior session close by >1pt — PM blocked

  hub:                null,
  hubReconnecting:    false,  // guards against onclose firing re-entrantly on our own stop() calls
};

// ─── REST helpers ─────────────────────────────────────────────────────────────
async function apiPost(path, body = {}) {
  const headers = state.token
    ? { Authorization: `Bearer ${state.token}` }
    : {};
  try {
    const res = await axios.post(`${REST_BASE}${path}`, body, { headers });
    return res.data;
  } catch (err) {
    // A 401 here means the token went stale OUTSIDE the normal 22h scheduled
    // refresh (found 2026-10-07: bars silently stopped updating for ~2 hours —
    // every fetchBars/ESBars/watchdog call 401'd with no recovery short of a
    // manual restart, since nothing previously re-authenticated off of this).
    if (err.response?.status === 401 && path !== "/api/Auth/loginKey") maybeReauth();
    throw err;
  }
}

let _reauthInFlight = null;
let _lastReauthAttempt = 0;
function maybeReauth() {
  const now = Date.now();
  if (_reauthInFlight || now - _lastReauthAttempt < 30_000) return;  // debounce a 401 burst to one attempt
  _lastReauthAttempt = now;
  console.warn("[Auth] ⚠️  Got 401 outside scheduled refresh — re-authenticating now");
  _reauthInFlight = login()
    .then(() => console.log("[Auth] ✓ Re-authenticated after 401"))
    .catch(e => console.error(`[Auth] ✗ Re-auth after 401 failed: ${e.message}`))
    .finally(() => { _reauthInFlight = null; });
}

// ─── Authentication ───────────────────────────────────────────────────────────
async function login() {
  const data = await apiPost("/api/Auth/loginKey", {
    userName: CFG.userName,
    apiKey:   CFG.apiKey,
  });
  if (!data.success) throw new Error(`Login failed: ${data.errorMessage}`);
  state.token = data.token;
  console.log("[Auth] ✓ Logged in");

  scheduleTokenRefresh(22 * 60 * 60 * 1000);
}

// The scheduled refresh call itself can fail (transient network error, rate
// limit) — if it does and nothing catches it, the next refresh never gets
// scheduled (that only happens from inside a successful login() above), so
// the token silently goes stale forever and every REST call starts 401ing
// with no recovery short of a full process restart or a lucky hub disconnect
// that happens to trigger its own separate re-login. Retry on a short backoff
// instead of giving up silently.
function scheduleTokenRefresh(delay) {
  setTimeout(async () => {
    try {
      await login();
    } catch (e) {
      console.error(`[Auth] ⚠️  Scheduled token refresh failed: ${e.message} — retrying in 5 min`);
      scheduleTokenRefresh(5 * 60 * 1000);
    }
  }, delay);
}

// ─── Account resolution ───────────────────────────────────────────────────────
async function resolveAccount() {
  const data = await apiPost("/api/Account/search", {});
  if (!data.success) throw new Error(`Account search failed: ${data.errorMessage}`);

  // If ACCOUNT_ID is set, target that specific account; otherwise prefer funded then any canTrade
  const acct = CFG.accountId
    ? data.accounts.find(a => a.id === CFG.accountId)
    : (data.accounts.find(a => a.canTrade && !a.simulated) ||
       data.accounts.find(a => a.canTrade) ||
       data.accounts[0]);

  if (!acct) throw new Error("No tradeable account found");

  state.accountId   = acct.id;
  // Populate immediately from this REST snapshot — otherwise state.balance stays
  // null until the first async SignalR account push arrives, which can take a
  // while after a restart. A signal firing in that gap fell through the
  // contract-sizing null-guards to an unsafe default (CFG.maxContracts) instead
  // of a conservative one — root cause of an 8ct entry that should've been 2ct.
  state.balance     = +acct.balance;
  const persistedPeak = loadPeakBalance();
  state.peakBalance = persistedPeak != null ? Math.max(persistedPeak, acct.balance) : acct.balance;
  savePeakBalance(state.peakBalance);
  // Deliberately NOT Math.max'd against the live acct.balance here — on a mid-day
  // restart, current balance already includes today's in-progress trades, and
  // folding that in would reintroduce the exact bug this is fixing. Only the daily
  // session-reset point (which fires before today's first trade) is allowed to
  // advance this. First-ever-run bootstrap: no better data exists yet, so start
  // from current balance same as peakBalance above.
  const persistedEodPeak = loadEodPeakBalance();
  state.eodPeakBalance = persistedEodPeak != null ? persistedEodPeak : acct.balance;
  state.simulated   = acct.simulated ?? true;
  state.tickValue   = CFG.tickValue;

  // ── Auto-apply funded account settings ───────────────────────────────────
  // TopstepX Express Funded accounts stay simulated:true in the API even when funded.
  // Detect funded state by: simulated:false OR account name starts with "EXPRESS".
  const isFunded = !state.simulated || /^EXPRESS/i.test(acct.name ?? "");
  state.isFunded = isFunded;  // stored so every other funded-only code path (contract
                              // scaling, edge-day cap) uses the same detection — a raw
                              // !state.simulated check misses Express Funded accounts,
                              // which report simulated:true even when genuinely funded.
  if (isFunded) {
    Object.assign(CFG, CFG_FUNDED);
    console.log(`[Account] 🎉 FUNDED ACCOUNT detected — applying funded settings:`);
    console.log(`[Account]    maxContracts=${CFG.maxContracts}ct | dailyProfitCap=${Number.isFinite(CFG.dailyProfitCap) ? `$${CFG.dailyProfitCap}` : "none (profit-lock ladder only)"}`);
  }

  const mode = isFunded ? "⭐ FUNDED" : "Combine";
  console.log(`[Account] ${acct.name} | id=${acct.id} | balance=$${acct.balance.toFixed(2)} | ${mode}`);
}

// ─── Contract resolution ──────────────────────────────────────────────────────
async function resolveContract() {
  // Combine accounts are simulated → use live:false; funded live accounts use live:true
  const data = await apiPost("/api/Contract/search", {
    searchText: CFG.contractSearch,
    live: !state.simulated,
  });
  if (!data.success) throw new Error(`Contract search failed: ${data.errorMessage}`);

  // Pick front-month active contract — support ES and NQ
  // NQ futures are named "ENQ" in the API (e.g. ENQU26); search with "NQ" returns them
  const sym = CFG.contractSearch;
  const prefix = sym === "NQ" ? "ENQ" : sym;
  const contract =
    data.contracts.find(c => c.activeContract && c.name.startsWith(prefix)) ||
    data.contracts.find(c => c.activeContract);

  if (!contract) throw new Error(`No active ${CFG.contractSearch} contract found`);

  state.contractId = contract.id;
  state.tickValue  = contract.tickValue ?? CFG.tickValue;

  console.log(`[Contract] ${contract.name} | id=${contract.id} | tick=$${contract.tickValue} | tickSize=${contract.tickSize}`);
}

// ─── Historical bars ──────────────────────────────────────────────────────────
async function fetchBars(limit = 300, partial = false, lookbackHours = 48) {
  const now   = new Date();
  const start = new Date(now - lookbackHours * 60 * 60 * 1000); // default 48h; boot uses 720h (30 days)

  // NOTE: tried live:true here on 2026-10-08 (theory: TopstepX's live-money feed
  // might be fresher than the delayed/simulated one) — it outright fails for this
  // account (errorCode:1, no bars; Contract/search with live:true also returns zero
  // contracts), so this account has no live-data entitlement. live:false is the only
  // working option, confirmed. Investigating 2026-10-05's ~1-bar-stale signal price
  // (entry fired using a bar that was already one 5m bucket old) pointed at TopstepX's
  // API itself serving a stale bar that moment, not our request params — see the
  // staleness check right after this call, added to catch it with hard evidence if
  // it recurs instead of reconstructing it after the fact.
  const data = await apiPost("/api/History/retrieveBars", {
    contractId:       state.contractId,
    live:             !state.simulated,
    startTime:        start.toISOString(),
    endTime:          now.toISOString(),
    unit:             2,     // Minute
    unitNumber:       5,     // 5-min bars
    limit,
    includePartialBar: partial,
  });

  if (!data.success) {
    console.warn(`[Bars] Failed: ${data.errorMessage}`);
    return;
  }

  // Normalize {t,o,h,l,c,v} → internal format matching v9-engine
  state.bars = data.bars
    .map(b => ({
      time:   new Date(b.t).getTime() / 1000,
      open:   +b.o,
      high:   +b.h,
      low:    +b.l,
      close:  +b.c,
      volume: b.v,
    }))
    .sort((a, b) => a.time - b.time);

  const latest = state.bars.at(-1);
  const latestStr = latest ? new Date(latest.time * 1000).toISOString() : "none (market closed/weekend)";
  console.log(`[Bars] ${state.bars.length} bars loaded (latest: ${latestStr})`);

  // Staleness check — found 2026-10-05: a signal fired using a bar that was already
  // one full 5m bucket old (TopstepX served it that way, not a bug in our request —
  // see note above fetchBars's apiPost call). Bars are start-time labeled, so a bar
  // closes 5 min after its own `time`. Only checked during the two trading sessions
  // (outside that, an old "latest" bar can just mean genuinely no new volume, not staleness)
  // and only on confirmed-closed fetches, not partial-bar ones.
  if (!partial && latest) {
    const nowHM = now.getUTCHours() * 100 + now.getUTCMinutes();
    const inSession = (nowHM >= 1330 && nowHM < 1500) || (nowHM >= 1800 && nowHM < 2000);
    if (inSession) {
      const barClosedAt = latest.time * 1000 + 5 * 60 * 1000;
      const staleMs = now.getTime() - barClosedAt;
      if (staleMs > 2 * 60 * 1000) {
        console.warn(`[Bars] ⚠️  STALE — latest bar (${latestStr}) closed ${Math.round(staleMs / 60000)}min ago but we're evaluating on it now. TopstepX likely served a stale bar.`);
      }
    }
  }

  // Bar stream log — write each confirmed-closed bar once for live vs backtest comparison
  // Guard checks in-memory state AND the last line of the file to survive engine restarts
  if (!partial && latest && latest.time > (state._lastLoggedBarTime ?? 0)) {
    const dateStr = new Date(latest.time * 1000).toISOString().slice(0, 10);
    const logPath = resolve(__dir, '..', 'logs', `bar-stream-${dateStr}.jsonl`);
    const isoTime = new Date(latest.time * 1000).toISOString();
    // Check file's last written timestamp to avoid duplicates across restarts
    let alreadyLogged = false;
    try {
      const existing = readFileSync(logPath, 'utf8').trimEnd();
      const lastLine = existing.slice(existing.lastIndexOf('\n') + 1);
      if (lastLine) alreadyLogged = JSON.parse(lastLine).t === isoTime;
    } catch {}
    if (!alreadyLogged) {
      state._lastLoggedBarTime = latest.time;
      const entry = JSON.stringify({ t: isoTime, o: latest.open, h: latest.high, l: latest.low, c: latest.close, v: latest.volume });
      try { appendFileSync(logPath, entry + '\n'); } catch {}
    } else {
      state._lastLoggedBarTime = latest.time;
    }
  }
}

// Fetch 15-minute bars — separate store from the 5m bars
async function fetchBars15(limit = 300) {
  const now   = new Date();
  const start = new Date(now - 120 * 60 * 60 * 1000); // 120h back — ensures 210+ 15m bars even on Monday after long weekend

  const data = await apiPost("/api/History/retrieveBars", {
    contractId:       state.contractId,
    live:             !state.simulated,
    startTime:        start.toISOString(),
    endTime:          now.toISOString(),
    unit:             2,     // Minute
    unitNumber:       15,    // 15-min bars
    limit,
    includePartialBar: false,
  });

  if (!data.success) {
    console.warn(`[Bars15] Failed: ${data.errorMessage}`);
    return;
  }

  state.bars15 = data.bars
    .map(b => ({
      time:   new Date(b.t).getTime() / 1000,
      open:   +b.o,
      high:   +b.h,
      low:    +b.l,
      close:  +b.c,
      volume: b.v,
    }))
    .sort((a, b) => a.time - b.time);

  const latest = state.bars15.at(-1);
  const latestStr = latest ? new Date(latest.time * 1000).toISOString() : "none";
  console.log(`[Bars15] ${state.bars15.length} bars loaded (latest: ${latestStr})`);
}

// ─── ES contract + bars (NQ_DIV signal dual-feed) ────────────────────────────
async function resolveESContract() {
  if (CFG.contractSearch !== "NQ") return; // only needed for NQ engine
  try {
    const data = await apiPost("/api/Contract/search", { searchText: "ES", live: !state.simulated });
    if (!data.success) { console.warn("[ESContract] Search failed:", data.errorMessage); return; }
    const contract = data.contracts.find(c => c.activeContract && c.name.startsWith("EP")) ||
                     data.contracts.find(c => c.activeContract);
    if (!contract) { console.warn("[ESContract] No active ES contract found"); return; }
    state.esContractId = contract.id;
    console.log(`[ESContract] ${contract.name} | id=${contract.id}`);
  } catch (e) {
    console.warn("[ESContract] Error resolving ES contract:", e.message);
  }
}

async function fetchESBars() {
  if (!state.esContractId) return;
  const now   = new Date();
  const start = new Date(now - 48 * 60 * 60 * 1000);
  try {
    const data = await apiPost("/api/History/retrieveBars", {
      contractId:        state.esContractId,
      live:              !state.simulated,
      startTime:         start.toISOString(),
      endTime:           now.toISOString(),
      unit:              2,   // Minute
      unitNumber:        5,   // 5-min bars
      limit:             300,
      includePartialBar: true,
    });
    if (!data.success) { console.warn("[ESBars] Failed:", data.errorMessage); return; }
    state.esBars = data.bars
      .map(b => ({ time: new Date(b.t).getTime() / 1000, open: +b.o, high: +b.h, low: +b.l, close: +b.c, volume: b.v }))
      .sort((a, b) => a.time - b.time);
  } catch (e) {
    console.warn("[ESBars] Error fetching:", e.message);
  }
}

// ─── SignalR Hub ──────────────────────────────────────────────────────────────
// Tear down the current hub connection properly before replacing it. Just
// setting state.hub = null leaves the old connection object alive in the
// background — its own automatic-reconnect timers and onclose handler keep
// running against a connection nothing references anymore, and when it
// eventually closes on its own, that orphaned onclose handler fires a SECOND,
// colliding reconnect attempt (throws "Invocation canceled due to the
// underlying connection being closed" and can even null out the NEW
// connection from under it). Root cause of a customer's Friday outage where
// the hub never recovered from the 13:10 UTC health check.
async function stopHubSafely() {
  if (!state.hub) return;
  try { await state.hub.stop(); } catch { /* already closed/closing — fine */ }
  state.hub = null;
}

// Shared full-reconnect flow — re-login, rebuild the hub connection, re-subscribe,
// and reconcile any trades that closed while disconnected. Used both when SignalR
// gives up on its own retries (onclose) and when the server force-kicks the
// session (GatewayLogout) — both leave the engine with no live events until a
// fresh login + connection replaces the dead one.
async function triggerFullReconnect(reason) {
  // stop() always fires onclose as part of its own teardown — so every one of our
  // OWN stopHubSafely() calls (from this loop, or from the two health checks)
  // re-invokes this same handler re-entrantly on the dying connection. Without this
  // guard that spawns a second, concurrent reconnect loop every single time, which
  // is the actual source of the repeating "Invocation canceled due to the underlying
  // connection being closed" cascades — not a fresh bug, a re-entrancy gap in the
  // original stopHubSafely() fix.
  if (state.hubReconnecting) return;
  state.hubReconnecting = true;
  console.warn(`[Hub] ⚠️  Connection down${reason ? ` (${reason})` : ''} — reconnecting...`);
  notify("⚠️ Hub reconnecting", "SignalR connection lost — reconnecting in 30s. No events until restored.", "high").catch(() => {});
  let attempt = 0;
  try {
    while (true) {
      attempt++;
      // Accounts sharing one TV_API_KEY fight over a single TopstepX session —
      // whichever logs in last invalidates the other's hub. RECONNECT_PRIORITY_DELAY_MS
      // lets a lower-priority account (e.g. a combine, vs. a funded account with real
      // money on the line) wait longer before trying to reclaim the shared session,
      // so the primary account holds it instead of both racing to re-login and
      // re-kicking each other every time either one reconnects.
      const priorityDelay = attempt === 1 ? (CFG.reconnectPriorityDelayMs || 0) : 0;
      const delay = Math.min(30_000 * attempt, 300_000) + priorityDelay; // 30s, 60s, 90s … cap at 5min
      await new Promise(r => setTimeout(r, delay));
      try {
        await login();
        await stopHubSafely();
        await connectHub();
        console.log("[Hub] ✅ Full reconnect successful");
        notify("✅ Hub reconnected", "SignalR connection restored.", "default").catch(() => {});
        await reconcileMissedTrades();
        return;
      } catch (e) {
        console.error(`[Hub] Reconnect attempt ${attempt} failed: ${e.message} — retrying in ${Math.min(30 * (attempt + 1), 300)}s`);
      }
    }
  } finally {
    state.hubReconnecting = false;
  }
}

// The recurring "WebSocket closed with status code: 1006" disconnects (investigated
// 2026-10-12) are NOT infra flakiness on our end -- they cluster overwhelmingly at
// 21:00 UTC (16:00 CT), a standard daily futures settlement/EOD cutover time: 139 of
// ~198 occurrences in the error log sit in that one hour, another 20 right at the
// 20:00 UTC PM session close. This is TopstepX recycling gateway connections on their
// own schedule. The automatic reconnect + full relogin + reconcileMissedTrades() below
// already recovers from it every time; nothing to "fix" here beyond making sure that
// recovery path stays solid (see the awaited notify() fix in reconcileMissedTrades,
// which closed the one real gap this daily blip was causing).
async function connectHub() {
  state.hub = new HubConnectionBuilder()
    .withUrl(USER_HUB, {
      skipNegotiation: true,
      transport:       HttpTransportType.WebSockets,
      accessTokenFactory: () => state.token,
    })
    .withAutomaticReconnect([0, 1000, 3000, 5000, 10000, 15000, 30000])
    .withKeepAliveInterval(10_000)   // ping every 10s so dead connections surface fast
    .withServerTimeout(25_000)       // declare dead after 25s of silence (default is 30s)
    .configureLogging(LogLevel.Warning)
    .build();

  // Register event handlers before connecting
  state.hub.on("GatewayUserOrder",    onOrderEvent);
  state.hub.on("GatewayUserTrade",    onTradeEvent);
  state.hub.on("GatewayUserPosition", onPositionEvent);
  state.hub.on("GatewayUserAccount",  onAccountEvent);
  // Server-initiated session kick — found 2026-10-08: this previously only logged
  // a message and did nothing, leaving the hub "connected" at the transport level
  // but receiving zero further events (no bars, no fills, no account pushes) until
  // someone noticed and manually restarted. Most likely cause per the comment below
  // (another login with the same credentials, e.g. a diagnostic script run against
  // the live account's API key) — but regardless of cause, treat it exactly like a
  // permanently-closed connection and run the same full reconnect.
  state.hub.on("GatewayLogout", () => {
    console.warn("[Hub] ⚠️  Server sent GatewayLogout — session ended by TopstepX, triggering full reconnect");
    triggerFullReconnect("GatewayLogout");
  });

  state.hub.onreconnected(() => {
    console.log("[Hub] Reconnected — re-subscribing");
    subscribeHub().catch(console.error);
    reconcileMissedTrades().catch(console.error);
  });

  // When SignalR exhausts ALL reconnect attempts it calls onclosed and gives up.
  // Without this handler the hub sits permanently dead — the engine keeps running
  // but receives zero events. Re-login and reconnect from scratch so the engine
  // stays live without needing a full process restart.
  state.hub.onclose((err) => triggerFullReconnect(err ? err.message : null));

  await state.hub.start();
  console.log("[Hub] ✓ Connected");
  await subscribeHub();
}

async function subscribeHub() {
  await state.hub.invoke("SubscribeOrders",    state.accountId);
  await state.hub.invoke("SubscribePositions", state.accountId);
  await state.hub.invoke("SubscribeTrades",    state.accountId);
  await state.hub.invoke("SubscribeAccounts");
  console.log("[Hub] ✓ Subscribed (orders, positions, trades, accounts)");
}

// ─── Fast-path fill check ─────────────────────────────────────────────────────
// Called immediately when a pnl=0 trade event fires (entry fill signal).
// GatewayUserOrder drops consistently — this is the PRIMARY path for placing
// protective orders. Polls REST for any unprotected open trade and places SL+TP
// within 1-2 seconds of fill instead of waiting 30 seconds for the watchdog.
async function checkUnprotectedTrades() {
  for (const [entryOrderId, trade] of state.openTrades.entries()) {
    if (trade.isProtective || trade.protected) continue;
    try {
      const d = await apiPost("/api/Order/searchById", { accountId: state.accountId, orderId: entryOrderId });
      const o = d.order ?? (d.orders ?? d.items ?? [])[0];
      if (o?.status === 2) {
        const fp = +(o.filledPrice ?? o.avgPrice ?? o.price ?? 0);
        if (fp > 0 && !trade.protected) {
          console.log(`[Fill] ⚡ Fast-path: fill confirmed orderId=${entryOrderId} @ ${fp} (${trade.signalId})`);
          await placeProtectiveOrders(entryOrderId, fp);
        }
      }
    } catch (e) {
      // Ignore — watchdog provides 30s backup
    }
  }
}

// ─── Event: Order ─────────────────────────────────────────────────────────────
function onOrderEvent(order) {
  if (!order) return;
  const id     = String(order.id ?? order.orderId);   // normalise to string — REST returns number, SignalR may return string
  const status = order.status ?? order.orderStatus;
  // OrderStatus enum: 1=Open/Working, 2=Filled, 3=Cancelled, 5=Rejected (confirmed from API spec)

  if (status === 2) {
    const trade = state.openTrades.get(id);
    console.log(`[Order] ✓ Filled orderId=${id}${trade ? ` signal=${trade.signalId}` : ""}`);

    if (trade && !trade.isProtective && !trade.protected) {
      // Entry filled — place SL + TP now
      // filledPrice is the correct field per API spec (OrderModel schema)
      const fillPrice = order.filledPrice ?? order.avgPrice ?? order.price ?? null;
      if (fillPrice != null) {
        placeProtectiveOrders(id, +fillPrice).catch(err =>
          console.error("[Order] Protective order error:", err.message)
        );
      } else {
        // Fill price not in event — fetch via searchById (correct endpoint per API spec)
        apiPost("/api/Order/searchById", { accountId: state.accountId, orderId: id })
          .then(d => {
            const o = (d.orders ?? d.items ?? [])[0];
            const fp = o?.filledPrice ?? o?.avgPrice ?? o?.price ?? null;
            if (fp != null) placeProtectiveOrders(id, +fp).catch(console.error);
            else console.error(`[Order] Could not determine fill price for orderId=${id}`);
          })
          .catch(console.error);
      }
    }

    if (trade?.isProtective) {
      // One of the protective orders (SL or TP) filled — cancel the other (OCO)
      const pairedId = trade.pairedWith;
      if (pairedId) {
        apiPost("/api/Order/cancel", { orderId: pairedId, accountId: state.accountId })
          .then(d => console.log(`[Order] OCO cancel sent for orderId=${pairedId} — success=${d.success}`))
          .catch(err => console.warn(`[Order] OCO cancel failed for orderId=${pairedId}:`, err.message));
      }
    }

  } else if (status === 5) {
    // Rejected = 5 per API spec (NOT 4 — that value is unused in the enum)
    console.warn(`[Order] ✗ Rejected orderId=${id} — ${order.errorMessage ?? order.reason ?? "no reason"}`);
    const trade = state.openTrades.get(id);
    if (trade && !trade.isProtective) {
      state.activeDirections.delete(trade.isLong ? "long" : "short");
      notify("❌ Order rejected", `${trade.signalId} ${trade.isLong ? "LONG" : "SHORT"} ${trade.contracts}ct\nReason: ${order.errorMessage ?? order.reason ?? "unknown"}`, "high").catch(()=>{});
    }
    state.openTrades.delete(id);
  }
}

// ─── Event: Trade (completed half-turn with P&L) ───────────────────────────────
function onTradeEvent(trade) {
  if (!trade) return;
  const pnl = trade.profitAndLoss ?? trade.pnl ?? 0;

  // Deduplicate — SignalR can replay queued events on reconnect at the same time
  // reconcileMissedTrades() is processing the same trades via REST. Both call
  // onTradeEvent; seenTradeIds guards against double-counting P&L.
  const tradeId = trade.id ?? trade.tradeId ?? null;
  if (tradeId != null) {
    const tid = String(tradeId);
    if (state.seenTradeIds.has(tid)) {
      console.log(`[Trade] Duplicate event for ${tid} — skipping (already processed)`);
      return;
    }
    state.seenTradeIds.add(tid);
    saveSeenTradeIds();
  }

  // Skip voided trades — platform can void fills on bad ticks; voided P&L must not count
  if (trade.voided) {
    console.log(`[Trade] ⚠️  Voided trade — skipping P&L (gross pnl would have been $${pnl?.toFixed(2)})`);
    return;
  }

  // Entry fills arrive as pnl=0 events; also a genuine breakeven close has pnl=0.
  // TopstepX does NOT push P&L in SignalR trade events — profitAndLoss is always null,
  // so closing fills (SL/TP hits) also arrive here with pnl=0. Detect them by checking
  // if the orderId matches a known SL/TP order in openTrades, and if so trigger an
  // immediate REST reconciliation to get the real P&L.
  if (pnl === 0) {
    const closingOrderId = String(trade.orderId ?? trade.order_id ?? "");
    const maybeClosing = closingOrderId ? state.openTrades.get(closingOrderId) : null;
    if (maybeClosing?.isProtective) {
      console.log(`[Trade] 🔍 Bracket fill (${maybeClosing.signalId}) — P&L missing from SignalR; reconciling REST in 3s`);
      // Remove from seenTradeIds so reconcileMissedTrades can find and book this trade with real P&L
      const tidStr = tradeId != null ? String(tradeId) : null;
      if (tidStr) { state.seenTradeIds.delete(tidStr); saveSeenTradeIds(); }
      setTimeout(() => reconcileMissedTrades().catch(() => {}), 3000);
      return;
    }
    console.log("[Trade] Flat P&L event — checking for unprotected fills");
    // GatewayUserOrder drops consistently — use this trade event as the PRIMARY
    // trigger for placing protective orders. Fires within seconds of fill.
    checkUnprotectedTrades().catch(() => {});
    return;
  }

  // ── Resolve signal context from openTrades map ────────────────────────────
  // SignalR GatewayUserTrade events carry the triggering orderId (the SL or TP
  // order that fired). openTrades is keyed by those order IDs, so this lookup
  // recovers the original strategy name and direction for every live close.
  // RECOVERED trades arrive from the REST reconciler with no orderId, so they
  // fall through to the "RECOVERED" tag — the seenTradeIds guard ensures they
  // never double-count P&L, but we also skip logging them to avoid duplicate rows.
  const closingOrderId = String(trade.orderId ?? trade.order_id ?? "");
  const knownTrade     = closingOrderId ? state.openTrades.get(closingOrderId) : null;
  // Prefer knownTrade (in-memory), then whatever signalId was provided (may be restored from disk)
  const resolvedSignal = knownTrade?.signalId ?? trade.signalId ?? "unknown";
  const resolvedIsLong = knownTrade?.isLong ?? trade.isLong ?? null;
  const dirLabel       = resolvedIsLong === true ? "LONG" : resolvedIsLong === false ? "SHORT" : "?";

  if (knownTrade?.orderKind === "SL") {
    const exitPx = trade.exitPrice ?? trade.price ?? null;
    if (exitPx != null) {
      startSlPostMortem(closingOrderId, exitPx, knownTrade.contracts ?? 1, resolvedSignal).catch(() => {});
    }
  }

  // Clean up openTrades for the order that just fired and its bracket partner
  if (knownTrade) {
    state.openTrades.delete(closingOrderId);
    if (knownTrade.pairedWith) state.openTrades.delete(String(knownTrade.pairedWith));
  }

  // Position is closed — clear persisted open-trade state
  clearPersistedOpenTrade();

  state.dayPnL += pnl;
  writeSharedState(state.dayPnL);
  const pnlStr  = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
  const dayStr  = state.dayPnL >= 0 ? `+$${state.dayPnL.toFixed(2)}` : `-$${Math.abs(state.dayPnL).toFixed(2)}`;
  console.log(`[Trade] ${pnlStr} | Day: ${dayStr} | ${resolvedSignal} ${dirLabel}`);

  // Trade close — immediately reconcile gates so the next signal isn't blocked for up to 5 min
  reconcilePositions().catch(() => {});

  // Skip writing a duplicate JSONL row for RECOVERED trades — the live close already
  // logged it above. The reconciler fires shortly after the live event and would create
  // a second row for the same trade if we let it through here.
  if (resolvedSignal === "RECOVERED" && !knownTrade) {
    // Genuine reconciler-only recovery (missed live event) — still log it
  }

  // ── Persistent trade record (tax log) ─────────────────────────────────────
  // Section 1256 (ES futures): 60% LT / 40% ST capital gains — report on Form 6781
  const now = new Date();

  // Slippage: positive = filled worse than signal price (adverse), negative = better
  const sigPrice   = knownTrade?.sigPrice ?? null;
  const entryFill  = trade.entryPrice ?? null;
  const entrySlipT = (sigPrice != null && entryFill != null)
    ? Math.round((resolvedIsLong ? entryFill - sigPrice : sigPrice - entryFill) / CFG.tickSize)
    : null;
  if (entrySlipT !== null && resolvedSignal !== "RECOVERED") {
    const slipLabel = entrySlipT === 0 ? "exact" : entrySlipT > 0 ? `+${entrySlipT}t adverse` : `${entrySlipT}t favorable`;
    console.log(`[Slip] ${resolvedSignal} ${dirLabel} — sig:${sigPrice?.toFixed(2)} fill:${entryFill?.toFixed(2)} → ${slipLabel}`);
  }

  // Exit slippage: how far the actual SL/TP fill landed from the price we asked
  // for. Positive = worse than intended (slipped through the stop / filled short
  // of the limit); needed to know real execution cost before tightening the stop
  // further than 10t. Both SL and TP closes for a LONG are sells (lower fill =
  // worse) and for a SHORT are buys (higher fill = worse) — same formula either way.
  const exitFill    = trade.exitPrice ?? trade.price ?? null;
  const intendedPx  = knownTrade?.intendedPrice ?? null;
  const orderKind   = knownTrade?.orderKind ?? null;
  const exitSlipT   = (intendedPx != null && exitFill != null && resolvedIsLong !== null)
    ? Math.round((resolvedIsLong ? intendedPx - exitFill : exitFill - intendedPx) / CFG.tickSize)
    : null;
  if (exitSlipT !== null && resolvedSignal !== "RECOVERED") {
    const exitSlipLabel = exitSlipT === 0 ? "exact" : exitSlipT > 0 ? `+${exitSlipT}t adverse` : `${exitSlipT}t favorable`;
    console.log(`[Slip] ${resolvedSignal} ${dirLabel} ${orderKind} exit — intended:${intendedPx?.toFixed(2)} fill:${exitFill?.toFixed(2)} → ${exitSlipLabel}`);
  }

  logTrade({
    timestamp:      now.toISOString(),
    date:           now.toISOString().slice(0, 10),
    time_mt:        mtTimeStr(now),
    tax_year:       now.getUTCFullYear(),
    contract:       (state.contractId ?? "").split(".").slice(-2).join("") || "ES",
    contract_id:    state.contractId,
    signal:         resolvedSignal,
    direction:      dirLabel,
    contracts:      knownTrade?.contracts ?? trade.contracts ?? "?",
    signal_price:   sigPrice,
    entry_price:    entryFill,
    entry_slip_ticks: entrySlipT,
    exit_price:     exitFill,
    exit_order_kind: orderKind,
    exit_intended_price: intendedPx,
    exit_slip_ticks: exitSlipT,
    gross_pnl:      +pnl.toFixed(2),
    balance_after:  state.balance     != null ? +state.balance.toFixed(2)     : null,
    peak_balance:   state.peakBalance != null ? +state.peakBalance.toFixed(2) : null,
    day_pnl_after:  +state.dayPnL.toFixed(2),
    voided:         false,
    // Form 6781 note: ES futures are Section 1256 contracts.
    // At year-end: 60% of net gain/loss = long-term rate; 40% = short-term rate.
    // Mark-to-market rules apply — open positions valued at Dec 31 close price.
    section_1256:   true,
  });

  const recovered = resolvedSignal === "RECOVERED";
  const recovTag  = recovered ? " ♻️ [recovered]" : "";

  if (pnl > 0) {
    state.dayWins++;
    state.consecutiveLosses = 0;
    state.consecutiveWins++;
    if (resolvedIsLong === true && !state.sessionLongWon) {
      state.sessionLongWon = true;
      console.log(`[Gate] 🟢 First long won — 2nd long bypass active (noLongsToday suppressed for 1 more trade)`);
    }
    const ct = calcContracts();
    console.log(`[Trade] ✅ Winner — ${resolvedSignal} ${dirLabel} | streak: ${state.consecutiveWins}W | next trade: ${ct}ct${recovTag}`);
    emitBundleEvent('TRADE_CLOSED', { win: true, pnl: +pnl.toFixed(2), signal: resolvedSignal, dir: dirLabel.toLowerCase(), contracts: knownTrade?.contracts ?? trade.contracts ?? 1 });
    notify(
      `✅ Winner +$${pnl.toFixed(0)}${recovTag}`,
      `[${(process.env.MARKET ?? "es").toUpperCase()}] ${resolvedSignal} ${dirLabel}\nDay P&L: $${state.dayPnL.toFixed(0)}  |  Streak: ${state.consecutiveWins}W\nNext size: ${ct}ct`,
      "default"
    ).catch(()=>{});
  } else {
    state.dayLosses++;
    state.consecutiveWins = 0;
    state.consecutiveLosses++;

    // Per-signal stop cooldown: block same signal for 15 min after a stop loss.
    // Prevents immediate re-entry on the same choppy bar (e.g. two BB_SQUEEZE fires in 10 min).
    if (resolvedSignal !== "RECOVERED" && resolvedSignal !== "unknown") {
      state.lastStopTimes.set(resolvedSignal, Date.now());
      console.log(`[Cooldown] 🕐 ${resolvedSignal} stop — 15min re-entry cooldown active`);
    }

    const ct = calcContracts();
    console.log(`[Risk] ❌ Loss — ${resolvedSignal} ${dirLabel} | streak: ${state.consecutiveLosses}L | next trade: ${ct}ct${recovTag}`);
    emitBundleEvent('TRADE_CLOSED', { win: false, pnl: +pnl.toFixed(2), signal: resolvedSignal, dir: dirLabel.toLowerCase(), contracts: knownTrade?.contracts ?? trade.contracts ?? 1 });
    notify(
      `❌ Loss -$${Math.abs(pnl).toFixed(0)}${recovTag}`,
      `[${(process.env.MARKET ?? "es").toUpperCase()}] ${resolvedSignal} ${dirLabel}\nDay P&L: $${state.dayPnL.toFixed(0)}  |  Streak: ${state.consecutiveLosses}L\nNext size: ${ct}ct`,
      "default"
    ).catch(()=>{});

    if (state.consecutiveLosses >= CFG.cooldownLosses) {
      state.cooldownUntil = Date.now() + 30 * 60 * 1000;
      console.log(`[Risk] ⏸️  ${CFG.cooldownLosses} losses in a row — paused 30 min`);
      notify("⏸️ Trading paused 30 min", `${CFG.cooldownLosses} consecutive losses\nDay P&L: $${state.dayPnL.toFixed(0)}`, "high").catch(()=>{});
    }
  }

  // Topstep daily loss hard stop
  if (!state.haltedToday && state.dayPnL <= -CFG.dailyLossLimit) {
    state.haltedToday = true;
    console.log(`[Risk] 🛑 Daily loss limit $${CFG.dailyLossLimit} hit — no more trades today`);
    notify("🛑 Daily loss limit hit", `Down $${Math.abs(state.dayPnL).toFixed(0)} today — engine stopped for the day`, "urgent").catch(()=>{});
  }

  // Daily profit cap — combine uses $1,400 (consistency rule); funded uses $2,500 (lock in big days)
  if (!state.profitCappedToday && state.dayPnL >= CFG.dailyProfitCap) {
    state.profitCappedToday = true;
    const capReason = state.simulated
      ? `Stopping to protect consistency rule\nCombine: $${(state.balance - CFG.accountBase).toFixed(0)} / $${CFG.combineTarget.toFixed(2)}`
      : `Locking in a great funded day`;
    console.log(`[Risk] 🏆 Day P&L $${state.dayPnL.toFixed(2)} — profit cap $${CFG.dailyProfitCap} reached. Stopping for the day`);
    notify("🏆 Great day — locked in", `Up $${state.dayPnL.toFixed(0)}\n${capReason}`, "high").catch(()=>{});
  }

  saveSessionGates(state);
}

// ─── Event: Position ──────────────────────────────────────────────────────────
function onPositionEvent(pos) {
  if (!pos) return;
  const size = pos.size ?? pos.netSize ?? 1;

  if (size !== 0) {
    // Position just opened (or size changed) — log direction and check for mismatch
    const posDir = pos.type === 1 ? "long" : pos.type === 2 ? "short" : null;
    if (posDir) {
      state.openPositionSize = Math.abs(size);
      state.openPositionDir  = posDir;
      console.log(`[Position] 📍 Open ${posDir.toUpperCase()} position size=${size} (type=${pos.type})`);

      // Direction mismatch: exchange opened wrong side vs what the engine intended
      const oppositeDir = posDir === "long" ? "short" : "long";
      if (state.activeDirections.has(oppositeDir) && !state.activeDirections.has(posDir)) {
        console.error(`[Position] 🚨 DIRECTION MISMATCH — engine intended ${oppositeDir.toUpperCase()} but exchange opened ${posDir.toUpperCase()}!`);
        notify(
          `🚨 Wrong direction! Engine=${oppositeDir.toUpperCase()} Exchange=${posDir.toUpperCase()}`,
          `Exchange opened a ${posDir.toUpperCase()} but engine intended a ${oppositeDir.toUpperCase()}.\nClosing rogue position now — check platform.`,
          "urgent"
        ).catch(() => {});

        // Capture the intended trade for retry (before clearing openTrades)
        // Only retry once per day — if retry itself misfired, just close and stop
        const entryTrade = [...state.openTrades.values()].find(t => !t.isProtective);
        if (entryTrade && !state.pendingRetry && !state.mismatchRetryDone) {
          state.pendingRetry = {
            signalId:  entryTrade.signalId,
            isLong:    entryTrade.isLong,
            contracts: entryTrade.contracts,
            tradeOpts: {
              stopTicks: entryTrade.stopTicks,
              tpTicks:   entryTrade.tpTicks,
              stopType:  entryTrade.stopType,
              tf:        entryTrade.tf,
            },
          };
          state.mismatchRetryDone = true;  // block any further retries today
          console.log(`[Retry] Queued retry for ${entryTrade.signalId} ${oppositeDir.toUpperCase()} after mismatch close`);
        } else if (state.mismatchRetryDone) {
          console.warn(`[Retry] Second mismatch detected — auto-closing, no further retry today`);
          notify(`🛑 Second wrong-direction — ${entryTrade?.signalId ?? "unknown"}`, `Retry also opened in wrong direction. Closing and stopping for today.`, "urgent").catch(() => {});
        }

        // Cancel all open protective orders (wrong direction — they won't protect us)
        for (const [orderId, trade] of state.openTrades.entries()) {
          if (trade.isProtective) {
            apiPost("/api/Order/cancel", { orderId, accountId: state.accountId })
              .then(d => console.log(`[Position] Cancelled wrong-direction bracket ${orderId} — success=${d.success}`))
              .catch(() => {});
          }
        }

        // Clear only the mismatched direction's trades + gate — leave the opposing
        // direction alone (it may have a legitimate open trade of its own).
        for (const [oid, t] of state.openTrades.entries()) {
          if ((oppositeDir === "long" && t.isLong) || (oppositeDir === "short" && !t.isLong)) {
            state.openTrades.delete(oid);
          }
        }
        state.activeDirections.delete(oppositeDir);

        // Place a market close order (flatten the rogue position)
        const closeSize = Math.abs(size);
        const closeSide = posDir === "long" ? OrderSide.Ask : OrderSide.Bid;  // sell to close long, buy to close short
        apiPost("/api/Order/place", {
          accountId:  state.accountId,
          contractId: state.contractId,
          type:       OrderType.Market,
          side:       closeSide,
          size:       closeSize,
          customTag:  `MISMATCH_CLOSE_${Date.now()}`,
        }).then(d => {
          if (d.success) console.log(`[Position] ✓ Rogue position close order placed orderId=${d.orderId ?? d.id}`);
          else           console.error(`[Position] ✗ Rogue position close failed: ${d.errorMessage}`);
        }).catch(err => console.error(`[Position] ✗ Rogue position close error: ${err.message}`));
      }
    }
    return;
  }

  if (size === 0) {
    state.openPositionSize = 0;
    state.openPositionDir  = null;
    // Position flat — clear direction gate and tidy openTrades map
    // PositionType enum: 0=Undefined, 1=Long, 2=Short (confirmed from API spec)
    // Do NOT fall through type=0 to "short" — that would falsely delete the short gate.
    const dir = pos.type === 1 ? "long" : pos.type === 2 ? "short" : null;
    if (dir) {
      if (state.activeDirections.has(dir)) {
        state.activeDirections.delete(dir);
        console.log(`[Gate] ${dir} position closed — direction slot freed`);
      }
    } else {
      // type=0 (Undefined) or unknown — clear both gates to be safe
      state.activeDirections.delete("long");
      state.activeDirections.delete("short");
      console.warn(`[Gate] Position type=0 (Undefined) flat event — cleared both gates`);
    }

    // CRITICAL: Explicitly cancel all open protective orders for this direction before
    // removing them from the map. Without this, orphan TP/SL orders stay live on the
    // exchange after their position closes — a filled orphan TP creates a phantom
    // reversed position with no protection (root cause of 2026-06-12 -$625 loss).
    const cancelPromises = [];
    for (const [orderId, trade] of state.openTrades.entries()) {
      const matchDir = !dir || (trade.isLong && dir === "long") || (!trade.isLong && dir === "short");
      if (matchDir && trade.isProtective) {
        cancelPromises.push(
          apiPost("/api/Order/cancel", { orderId, accountId: state.accountId })
            .then(d => console.log(`[Gate] Cancelled orphan protective order ${orderId} — success=${d.success}`))
            .catch(err => console.warn(`[Gate] Failed to cancel orphan order ${orderId}:`, err.message))
        );
      }
    }
    if (cancelPromises.length > 0) {
      console.log(`[Gate] Cancelling ${cancelPromises.length} orphan protective order(s) for closed ${dir ?? "all"} position`);
      Promise.all(cancelPromises).catch(() => {});
    }

    // Prune closed trades from openTrades map (keep map lean)
    // If dir is null we clear everything since we don't know which side closed
    for (const [orderId, trade] of state.openTrades.entries()) {
      if (!dir || (trade.isLong && dir === "long") || (!trade.isLong && dir === "short")) {
        state.openTrades.delete(orderId);
      }
    }

    // Mismatch retry: position is now flat — attempt one retry in the correct direction
    if (state.pendingRetry) {
      const retry = state.pendingRetry;
      state.pendingRetry = null;  // clear immediately — only one attempt ever

      const now   = new Date();
      const hm    = now.getUTCHours() * 100 + now.getUTCMinutes();
      const inAM  = hm >= 1330 && hm < 1455;   // 5 min buffer before AM close at 15:00
      const inPM  = hm >= 1830 && hm < 2025;   // 5 min buffer before PM close at 20:30
      const inSession = inAM || inPM;

      if (!inSession || state.haltedToday || state.profitCappedToday) {
        console.log(`[Retry] Skipping ${retry.signalId} retry — outside session window or halted`);
        notify(`⏭️ Retry skipped — ${retry.signalId}`, `Wrong-direction position closed but session window or daily limit prevents retry.`, "default").catch(() => {});
        return;
      }

      const intendedDir = retry.isLong ? "LONG" : "SHORT";
      console.log(`[Retry] ♻️  Position flat — retrying ${intendedDir} ${retry.signalId} in 5s`);
      notify(
        `♻️ Retrying ${intendedDir} — ${retry.signalId}`,
        `Wrong-direction position closed ✓\nRetrying ${intendedDir} entry in 5s — watch the platform.`,
        "high"
      ).catch(() => {});

      setTimeout(() => {
        const retryDir = retry.isLong ? "long" : "short";
        if (state.activeDirections.has(retryDir)) {
          console.log(`[Retry] Gate already held for ${retryDir} — skipping retry`);
          return;
        }
        if (state.haltedToday || state.profitCappedToday) {
          console.log(`[Retry] Halted/capped — skipping retry`);
          return;
        }
        console.log(`[Retry] Firing ${intendedDir} entry for ${retry.signalId}`);
        placeEntry(retry.signalId, retry.isLong, retry.contracts, retry.tradeOpts)
          .catch(err => console.error(`[Retry] Entry error: ${err.message}`));
      }, 5_000);
    }
  }
}

// ─── Incremental profit-lock staircase ─────────────────────────────────────────
// As an open trade's price runs a % of the way to ITS OWN take-profit target, move
// the stop (via the atomic /api/Order/modify — no cancel/replace gap, so the
// position is never briefly unprotected) to lock in a smaller % of that same TP
// distance, leaving a fixed give-back cushion. Expressed as a fraction of each
// trade's own tpTicks (not a flat dollar amount or flat tick count) so the ladder
// scales correctly on its own with both contract count (more contracts just means
// more $ per tick — the tick math is contract-count-agnostic) and with strategy
// (each strategy has its own tpTicks, e.g. 28-48t, so "50% to TP" means something
// different in ticks per strategy but the same thing in risk/reward terms).
// The trade's own TP (100%) or the full daily cap handles anything beyond this.
const PROFIT_LOCK_STEPS = [
  { atProgress: 0.50, lockAt: 0.35 },  // halfway to TP → lock 35% of TP distance
  { atProgress: 0.75, lockAt: 0.60 },  // 3/4 to TP     → lock 60% of TP distance
];

async function checkProfitLockLadder(bal) {
  if (!state.openPositionDir || state.openPositionSize === 0) return;
  if (state.startOfDayBalance == null) return;

  const entryTrade = [...state.openTrades.values()].find(t => !t.isProtective && t.slId && t.entryFillPrice != null);
  if (!entryTrade || !entryTrade.tpTicks) return;

  const totalDayPnL     = bal - state.startOfDayBalance;
  const tradeUnrealized = totalDayPnL - (entryTrade.dayPnLAtOpen ?? 0);
  // Ticks moved in this trade's favor — dollars-per-tick and contracts cancel out
  // of tradeUnrealized / (contracts * tickValue), so this is just the price move,
  // independent of how many contracts are on.
  const ticksInFavor = tradeUnrealized / (entryTrade.contracts * state.tickValue);
  const progress     = ticksInFavor / entryTrade.tpTicks;
  const currentLevel  = entryTrade.profitLockLevel ?? 0;

  for (let i = currentLevel; i < PROFIT_LOCK_STEPS.length; i++) {
    const { atProgress, lockAt } = PROFIT_LOCK_STEPS[i];
    if (progress < atProgress) break; // steps are ascending — not there yet
    const level = i + 1;

    const lockTicks = Math.round(lockAt * entryTrade.tpTicks);
    const newStopPrice = entryTrade.isLong
      ? entryTrade.entryFillPrice + lockTicks * CFG.tickSize
      : entryTrade.entryFillPrice - lockTicks * CFG.tickSize;
    const lockDollars = Math.round(lockTicks * entryTrade.contracts * state.tickValue);

    console.log(`[ProfitLock] 🔒 ${entryTrade.signalId} — ${(progress*100).toFixed(0)}% to TP (${ticksInFavor.toFixed(1)}t/${entryTrade.tpTicks}t), moving stop to lock ${lockTicks}t (~$${lockDollars}) @ ${newStopPrice.toFixed(2)}`);

    let modified = false;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3 && !modified; attempt++) {
      const res = await apiPost("/api/Order/modify", {
        accountId: state.accountId,
        orderId:   entryTrade.slId,
        stopPrice: newStopPrice,
      }).catch(e => ({ success: false, errorMessage: e.message }));
      if (res.success) {
        modified = true;
      } else {
        lastErr = res.errorMessage;
        if (attempt < 3) await new Promise(r => setTimeout(r, 500));
      }
    }

    if (modified) {
      entryTrade.profitLockLevel = level;
      console.log(`[ProfitLock] ✅ Stop moved — locking ${lockTicks}t (~$${lockDollars}) on ${entryTrade.signalId}`);
      notify(`🔒 Profit locked ~$${lockDollars}`, `${entryTrade.signalId} ${entryTrade.isLong ? "LONG" : "SHORT"}\n${(progress*100).toFixed(0)}% to TP — stop moved to secure the gain`, "default").catch(() => {});
    } else {
      // Modify is atomic (no cancel-then-place), so the ORIGINAL stop is still
      // live and the position is still protected — safe to just retry on the
      // next poll (~5s) rather than force-close over a transient failure.
      console.warn(`[ProfitLock] ⚠️  Failed to move stop after 3 attempts (${lastErr}) — original stop still in place, will retry next check`);
    }
    break; // one level per call — re-check picks up further levels on the next poll
  }
}

// ─── Event: Account (balance update) ─────────────────────────────────────────
function onAccountEvent(acct) {
  if (!acct || acct.balance == null) return;
  const bal = +acct.balance;
  state.balance = bal;
  // Dedicated, always-fires-on-change balance line for consumers that parse stdout
  // (the product's main.js) — the only other place "balance=$X" was ever logged was
  // the one-time boot banner, so the UI's account total never updated again after
  // that, including after every trade closing. Dedup on value so a burst of
  // identical pushes doesn't spam the log.
  if (state._lastLoggedBalance !== bal) {
    state._lastLoggedBalance = bal;
    console.log(`[Balance] current=$${bal.toFixed(2)}`);
  }
  if (state.peakBalance === null) state.peakBalance = bal;
  if (bal > state.peakBalance) { state.peakBalance = bal; savePeakBalance(state.peakBalance); }
  // Lazy-fill startOfDayBalance only before the session opens — after 13:30 a mid-day
  // restart must use reconcileMissedTrades() to infer the true start balance from today's
  // closed trades, not the current balance (which already includes today's P&L).
  if (state.startOfDayBalance === null && !state.dayContextRecovered) {
    const _hm = new Date().getUTCHours() * 100 + new Date().getUTCMinutes();
    if (_hm >= 1330 && _hm < 1340) {
      // Right at session open: current balance IS the start balance
      state.startOfDayBalance = bal;
      console.log(`[Account] startOfDayBalance set at open: $${bal.toFixed(2)}`);
    }
    // After 1340: wait for reconcileMissedTrades to set it correctly from trade history
  } else if (state.startOfDayBalance === null && state.dayContextRecovered) {
    // reconcileMissedTrades already recovered dayPnL but ran before this balance
    // push arrived — backfill startOfDayBalance now using the authoritative dayPnL.
    state.startOfDayBalance = bal - state.dayPnL;
    console.log(`[Account] startOfDayBalance backfilled from dayPnL: $${state.startOfDayBalance.toFixed(2)}`);
  }

  // Auto-capture starting balance for funded accounts only (not combines).
  // Combines use Layer 0a (trail-DD floor scaling) instead.
  if (CFG.fundedStartBalance < 0 && state.autoStartBalance == null && state.isFunded) {
    state.autoStartBalance = bal;
    console.log(`[Account] Auto-detected starting balance: $${bal.toFixed(2)} — cushion scaling active`);
  }

  // One-shot combine target notification
  if (state.simulated && !state.combineTargetNotified && bal >= CFG.accountBase + CFG.combineTarget) {
    state.combineTargetNotified = true;
    const profit = (bal - CFG.accountBase).toFixed(0);
    notify("🎯 Combine Target Hit!", `Balance: $${bal.toFixed(2)}\nProfit: +$${profit} / $${CFG.combineTarget.toFixed(0)} target\nCheck TopstepX dashboard to activate funded account`, "high").catch(() => {});
    console.log(`[Account] 🎯 COMBINE TARGET HIT — $${bal.toFixed(2)} (+$${profit})`);
  }

  const drawdown = (state.eodPeakBalance ?? state.peakBalance) - bal;
  if (drawdown >= CFG.trailDDWarn) {
    console.log(`[Risk] ⚠️  Trailing drawdown $${drawdown.toFixed(2)} from peak — Topstep limit is $2,000!`);
    notify("⚠️ Drawdown warning!", `Down $${drawdown.toFixed(0)} from peak\nTopstep trailing limit: $2,000 — getting close!`, "urgent").catch(()=>{});
  }

  // Incremental profit-lock staircase — runs before the full-cap runner close so
  // it can bank partial gains on trades that reverse before hitting the cap or TP.
  // Applies to every account: the ladder is expressed as a % of each trade's own
  // tpTicks, so it self-scales with contract count and strategy TP width and
  // doesn't depend on how large the daily profit cap is.
  if (!state.profitCappedToday && !state.runnerClosePending) {
    checkProfitLockLadder(bal).catch(e => console.warn(`[ProfitLock] error: ${e.message}`));
  }

  // Runner failsafe: if total day P&L (realized + unrealized) hits the cap while a
  // position is still open, close it with a market order immediately.
  // The existing onPositionEvent(size=0) handler cancels the orphaned brackets automatically.
  if (
    !state.profitCappedToday &&
    !state.runnerClosePending &&
    state.startOfDayBalance != null &&
    state.openPositionSize > 0 &&
    state.openPositionDir
  ) {
    const totalDayPnL = bal - state.startOfDayBalance;
    if (totalDayPnL >= CFG.dailyProfitCap) {
      state.profitCappedToday  = true;
      state.runnerClosePending = true;
      const closeSide = state.openPositionDir === "long" ? OrderSide.Ask : OrderSide.Bid;
      console.log(`[Risk] 🏆 Runner close — total P&L $${totalDayPnL.toFixed(2)} (incl. unrealized) hit cap $${CFG.dailyProfitCap}. Closing ${state.openPositionDir.toUpperCase()} ${state.openPositionSize}ct.`);
      notify("🏆 Runner auto-closed", `Total P&L $${totalDayPnL.toFixed(0)} (incl. unrealized) hit cap\nClosed ${state.openPositionDir.toUpperCase()} ${state.openPositionSize}ct — done for the day`, "high").catch(() => {});
      apiPost("/api/Order/place", {
        accountId:  state.accountId,
        contractId: state.contractId,
        type:       OrderType.Market,
        side:       closeSide,
        size:       state.openPositionSize,
        customTag:  `RUNNER_CLOSE_${Date.now()}`,
      }).then(d => {
        if (d.success) console.log(`[Risk] ✓ Runner close order placed orderId=${d.orderId ?? d.id}`);
        else           console.error(`[Risk] ✗ Runner close failed: ${d.errorMessage}`);
      }).catch(err => console.error(`[Risk] ✗ Runner close error: ${err.message}`));
    }
  }
}

// ─── Session-open ATR → thin market check ─────────────────────────────────────
// Computes Wilder ATR(20) on the 150 most recent 5m bars.
// A very low ATR (<3.0 pts on ES) indicates an unusually thin, choppy market
// (holiday-adjacent sessions, pre-news paralysis, etc.) where our trail/TP
// parameters have less edge. Backtest: only triggered May 25 (Memorial Day
// adjacent, ATR=2.15) — cutting to 1ct saved $213 and shaved $150 off DD.
function calcSessionOpenATR() {
  const bars = state.bars.slice(-150);
  if (bars.length < 21) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let a = trs.slice(0, 20).reduce((s, x) => s + x, 0) / 20;
  for (let i = 20; i < trs.length; i++) a = (a * 19 + trs[i]) / 20;
  return a;
}

// ─── Overnight range → regime ─────────────────────────────────────────────────
function calcOvernightRange() {
  const now    = Date.now() / 1000;
  const cutoff = now - 18 * 3600;
  const bars   = state.bars.filter(b => {
    if (b.time < cutoff) return false;
    const hm = new Date(b.time * 1000).getUTCHours() * 100 +
               new Date(b.time * 1000).getUTCMinutes();
    // Exclude regular session hours
    return !((hm >= 1330 && hm < 1500) || (hm >= 1800 && hm < 2030));
  });
  if (bars.length < 5) return null;
  return Math.max(...bars.map(b => b.high)) - Math.min(...bars.map(b => b.low));
}

// TopstepX's real per-account-size contract limit — independent of whatever
// MAX_CONTRACTS is configured to for the pre-lock conservative ceiling.
function trueAccountMaxContracts() {
  if (CFG.accountBase >= 150000) return 15;
  if (CFG.accountBase >= 100000) return 10;
  if (CFG.accountBase >= 50000)  return 5;
  return CFG.maxContracts;
}

// Combine cushion ladder — steps every `stepDollars` of cushion above the
// trailing-DD floor, capped at `preLockCap` (CFG.maxContracts) while the floor
// is still trailing. TopstepX locks the trailing DD floor once peak balance
// reaches the account's starting balance (it never moves again after that,
// even as balance keeps climbing) — once locked, cushion grows unbounded from
// a fixed floor instead of being perpetually chased, so the ceiling opens up
// to the account's true contract limit instead of staying capped at preLockCap.
function cushionLadderContracts(cushion, isLocked) {
  const ceiling = isLocked ? trueAccountMaxContracts() : CFG.maxContracts;
  const steps = Math.floor(Math.max(0, cushion) / CFG.cushionStepDollars);
  return Math.max(1, Math.min(ceiling, steps + 1));
}

// Estimate the stop distance (in ticks) a signal will actually get, mirroring
// the exact formula placeEntry() uses — needed BEFORE entry so sizing can react
// to it, since bar-anchored stops vary trade to trade instead of being fixed.
function estimateStopTicks(sig, isLong) {
  const stopTicks = sig.stopTicks ?? CFG.stopTicks;
  if (CFG.forceFixedStopTicks != null && !sig.useOwnStop) return CFG.forceFixedStopTicks;
  if (sig.barHigh != null && sig.barLow != null && sig.price != null) {
    return isLong
      ? Math.round((sig.price - sig.barLow) / CFG.tickSize) + stopTicks
      : Math.round((sig.barHigh - sig.price) / CFG.tickSize) + stopTicks;
  }
  return stopTicks;
}

// Caps contracts so no single trade risks more than CFG.targetRiskDollars,
// regardless of how many contracts the cushion ladder would otherwise allow.
// The cushion ladder answers "how much size has this account earned overall";
// this answers "how much can THIS trade's specific stop distance afford" —
// take the smaller of the two. Disabled (returns baseContracts unchanged) when
// TARGET_RISK_DOLLARS isn't set.
function riskCappedContracts(baseContracts, stopTicksEstimate) {
  if (!CFG.targetRiskDollars || CFG.targetRiskDollars <= 0) return baseContracts;
  if (!stopTicksEstimate || stopTicksEstimate <= 0) return baseContracts;
  const maxByRisk = Math.max(1, Math.floor(CFG.targetRiskDollars / (Math.abs(stopTicksEstimate) * state.tickValue)));
  return Math.min(baseContracts, maxByRisk);
}

// Real TopstepX Express Funded scaling table, smoothed internally so we don't
// always jump straight to whatever TopstepX's own tier allows:
//   - Below the first real tier threshold: ramp 1ct per fundedScaleBaseStep $,
//     capped at fundedScaleBase (the real pre-first-tier ceiling). Ramp counts
//     from the account's real floor (-trailDD), not from $0 profit — the
//     account already has trailDD dollars of real risk room below $0, so
//     treating $0 as the ramp's start point undercounts the cushion that
//     genuinely exists and delays reaching fundedScaleBase later than it should.
//   - Between tier thresholds: use TopstepX's own tier counts as-is.
//   - Above the LAST tier's threshold: that tier's count is the real ceiling,
//     not a jump target — ramp up to it 1ct per fundedScalePostStep $, starting
//     from the count at the second-to-last tier.
// TopstepX only raises the limit for the NEXT session once a threshold is
// crossed, so callers should pass state.startOfDayBalance where available.
function fundedScalePlanContracts(balance) {
  const tiers = CFG.fundedScaleTiers;
  if (tiers.length === 0) return CFG.fundedScaleBase;

  const firstThreshold = tiers[0][0];
  if (balance < firstThreshold) {
    if (!CFG.fundedScaleBaseStep) return CFG.fundedScaleBase; // no smoothing configured — old jump-straight behavior
    const distanceAboveFloor = balance + CFG.trailDD; // real floor is -trailDD, not $0
    const steps = Math.floor(Math.max(0, distanceAboveFloor) / CFG.fundedScaleBaseStep);
    return Math.max(1, Math.min(CFG.fundedScaleBase, steps + 1));
  }

  // Walk every tier except the last — those thresholds map directly to their count.
  let result = CFG.fundedScaleBase;
  for (let i = 0; i < tiers.length - 1; i++) {
    const [threshold, ct] = tiers[i];
    if (balance >= threshold) result = ct;
  }

  const [lastThreshold, ceiling] = tiers[tiers.length - 1];
  if (balance >= lastThreshold) {
    if (!CFG.fundedScalePostStep) return ceiling; // no smoothing configured — old jump-to-ceiling behavior
    const stepsAboveLast = Math.floor((balance - lastThreshold) / CFG.fundedScalePostStep);
    result = Math.min(ceiling, result + 1 + stepsAboveLast);
  }
  return result;
}

function calcContracts() {
  // User opted out of auto-scaling — trade a fixed size every time, still
  // subject to the thin-market ATR cap below and TopstepX's own account limit.
  if (!CFG.autoScaling) {
    if (CFG.scaleEdgeDayCap && state.isFunded && isTodayScaleEdgeDay()) return CFG.scaleEdgeDayCapContracts;
    const sessionATR = calcSessionOpenATR();
    if (sessionATR !== null && sessionATR < 3.0) return 1;
    return Math.max(1, CFG.maxContracts);
  }

  // Default LOW, not high — if balance/peak data isn't available yet (e.g. a
  // signal fires in the brief window right after a restart before state is
  // populated), fail safe at 1ct rather than silently trading full size blind.
  let base = 1;

  // ── Funded scaling plan (real TopstepX table) — takes priority over the
  // generic Layer 0/0a ladders below when configured. Uses startOfDayBalance,
  // not the live-updating balance, since TopstepX only raises the limit for
  // the NEXT session once a threshold is crossed intraday.
  if (state.isFunded && CFG.fundedScaleTiers.length > 0) {
    const refBalance = state.startOfDayBalance ?? state.balance ?? 0;
    base = fundedScalePlanContracts(refBalance);
  } else {

  // ── Layer 0: Funded account cushion-based auto-scaling ────────────────────
  // Activated when FUNDED_START_BALANCE >= 0 (use -1 or omit to disable).
  // TopstepX API returns profit above funded start, not full equity, so
  // state.balance IS the cushion — no subtraction needed.
  // Ladder: $2K cushion per contract step, capped at MAX_CONTRACTS.
  // 100K Express Funded (10ct max): reaches full size at $18K cushion (~2 weeks at V5 returns).
  // <$2K=1ct | $2K=2ct | $4K=3ct | $6K=4ct | $8K=5ct | $10K=6ct | $12K=7ct | $14K=8ct | $16K=9ct | $18K+=10ct
  const startBal = CFG.fundedStartBalance >= 0 ? CFG.fundedStartBalance : state.autoStartBalance ?? null;
  if (startBal != null && state.balance != null) {
    const cushion = state.balance - startBal;
    let cushionMax;
    if      (cushion >= 18000) cushionMax = 10;
    else if (cushion >= 16000) cushionMax = 9;
    else if (cushion >= 14000) cushionMax = 8;
    else if (cushion >= 12000) cushionMax = 7;
    else if (cushion >= 10000) cushionMax = 6;
    else if (cushion >= 8000)  cushionMax = 5;
    else if (cushion >= 6000)  cushionMax = 4;
    else if (cushion >= 4000)  cushionMax = 3;
    else if (cushion >= 2000)  cushionMax = 2;
    else                       cushionMax = 1;
    base = Math.min(CFG.maxContracts, cushionMax);
  }

  // ── Layer 0a: Combine cushion scaling ────────────────────────────────────
  // Active when funded scaling (Layer 0) is off. Self-regulating: a bad day
  // shrinks cushion, next session trades fewer contracts automatically.
  // Floor locks at (accountBase − trailDD) once peak balance first reaches
  // accountBase — matches TopstepX's own trailing-DD-locks-at-starting-balance
  // rule — so the ladder's ceiling opens up past CFG.maxContracts to the
  // account's true contract limit once locked (see cushionLadderContracts).
  // Uses eodPeakBalance, NOT the continuously-updating peakBalance — confirmed
  // against TopstepX's published rules (2026-10-09) that the real floor only
  // advances on END-OF-DAY closing balance, never intraday highs. Using the raw
  // intraday peak here made the computed floor too high/tight on any day price
  // ran up before the close, understating real cushion and under-sizing contracts.
  const floorPeak = state.eodPeakBalance ?? state.peakBalance;
  if (startBal == null && state.balance != null && floorPeak != null) {
    const isLocked = floorPeak >= CFG.accountBase;
    const floor    = Math.min(floorPeak, CFG.accountBase) - CFG.trailDD;
    const cushion  = state.balance - floor;
    base = cushionLadderContracts(cushion, isLocked);
  }

  } // end funded-scale-table / Layer 0 / Layer 0a branch

  // ── Funded-account day-of-week edge cap ───────────────────────────────────
  // Monday and Friday pinned to a fixed size regardless of cushion — week-open/
  // week-close sessions get less benefit-of-the-doubt sizing. Funded accounts only.
  if (CFG.scaleEdgeDayCap && state.isFunded && isTodayScaleEdgeDay()) {
    base = Math.min(base, CFG.scaleEdgeDayCapContracts);
  }

  // ── Thin-market cap ───────────────────────────────────────────────────────
  // ATR < 3.0 = no range, edge doesn't work — cap at 1ct regardless of cushion.
  const sessionATR = calcSessionOpenATR();
  if (sessionATR !== null && sessionATR < 3.0) return 1;

  // ── Universal account-size safety ceiling ─────────────────────────────────
  // Every path above (funded-scale-table, Layer 0 cushion, Layer 0a cushion
  // ladder) computes `base` from config values that are NOT cross-checked
  // against the account's real size — a misconfigured FUNDED_SCALE_TIERS
  // (e.g. a 100K account's table copied onto a 50K account) would otherwise
  // size well past what TopstepX actually allows for that account. Clamp
  // against the real per-size ceiling regardless of which path produced `base`.
  // Applies to combine accounts too (2026-10-05) — confirmed the combine-phase
  // contract limits match the same 5/10/15 table, not funded-only.
  //
  // CFG.maxContracts ALSO applies here now (2026-10-10) — previously it only
  // capped the funded-scale-table path when the user's config happened to fall
  // through to Layer 0/0a, never the scale-table path itself, so "Max Contracts"
  // silently did nothing for any funded account on the real tier table (ours
  // included). Now a genuine user-set ceiling consistently caps every path, not
  // just some of them.
  base = Math.min(base, trueAccountMaxContracts(), CFG.maxContracts);

  return Math.max(1, base);
}

function calcContractsVerbose() {
  // Same as calcContracts but returns a description for the brief
  const edgeDayCapped = CFG.scaleEdgeDayCap && state.isFunded && isTodayScaleEdgeDay();
  if (!CFG.autoScaling) {
    const sessionATR = calcSessionOpenATR();
    const thinMarket  = sessionATR !== null && sessionATR < 3.0;
    const contracts   = edgeDayCapped ? Math.min(CFG.maxContracts, CFG.scaleEdgeDayCapContracts) : thinMarket ? 1 : Math.max(1, CFG.maxContracts);
    const regimeLabel = edgeDayCapped
      ? `📅 Mon/Fri edge day — capped ${CFG.scaleEdgeDayCapContracts}ct`
      : thinMarket
      ? `⚠️ THIN ATR(${sessionATR?.toFixed(2)}) — capped 1ct`
      : `🔒 ${contracts}ct fixed — auto-scaling off`;
    return { contracts, regimeLabel, streakLabel: "—", regimeMult: 1.0, streakMult: 1.0 };
  }

  let base = 1;  // same safe-default reasoning as calcContracts()
  let scaleTableUsed = false;
  // Hoisted above the branch below — cushionAmt further down needs it regardless
  // of which branch runs (a scoping bug briefly had this declared only inside the
  // else block, which threw ReferenceError on every funded-account call, i.e. ours).
  const floorPeakV = state.eodPeakBalance ?? state.peakBalance;
  if (state.isFunded && CFG.fundedScaleTiers.length > 0) {
    const refBalance = state.startOfDayBalance ?? state.balance ?? 0;
    base = fundedScalePlanContracts(refBalance);
    scaleTableUsed = true;
  } else {
    const startBal = CFG.fundedStartBalance >= 0 ? CFG.fundedStartBalance : state.autoStartBalance ?? null;
    if (startBal != null && state.balance != null) {
      const cushion = state.balance - startBal;
      let cushionMax;
      if      (cushion >= 18000) cushionMax = 10;
      else if (cushion >= 16000) cushionMax = 9;
      else if (cushion >= 14000) cushionMax = 8;
      else if (cushion >= 12000) cushionMax = 7;
      else if (cushion >= 10000) cushionMax = 6;
      else if (cushion >= 8000)  cushionMax = 5;
      else if (cushion >= 6000)  cushionMax = 4;
      else if (cushion >= 4000)  cushionMax = 3;
      else if (cushion >= 2000)  cushionMax = 2;
      else                       cushionMax = 1;
      base = Math.min(CFG.maxContracts, cushionMax);
    }

    // Layer 0a: Combine cushion scaling (mirrors calcContracts) — eodPeakBalance, see note there
    if (startBal == null && state.balance != null && floorPeakV != null) {
      const isLocked = floorPeakV >= CFG.accountBase;
      const floor    = Math.min(floorPeakV, CFG.accountBase) - CFG.trailDD;
      const cushion  = state.balance - floor;
      base = cushionLadderContracts(cushion, isLocked);
    }
  }

  if (edgeDayCapped) base = Math.min(base, CFG.scaleEdgeDayCapContracts);
  base = Math.min(base, trueAccountMaxContracts(), CFG.maxContracts);  // see note in calcContracts()

  const sessionATR = calcSessionOpenATR();
  const thinMarket = sessionATR !== null && sessionATR < 3.0;
  const contracts  = thinMarket ? 1 : Math.max(1, base);
  const cushionAmt = (state.balance != null && floorPeakV != null)
    ? Math.round(state.balance - (Math.min(floorPeakV, CFG.accountBase) - CFG.trailDD))
    : null;
  const regimeLabel = thinMarket
    ? `⚠️ THIN ATR(${sessionATR?.toFixed(2)}) — capped 1ct`
    : edgeDayCapped
    ? `📅 Mon/Fri edge day — capped ${CFG.scaleEdgeDayCapContracts}ct (balance $${(state.startOfDayBalance ?? state.balance)?.toFixed(0) ?? "?"})`
    : scaleTableUsed
    ? `🟢 ${contracts}ct  |  scaling-plan balance $${(state.startOfDayBalance ?? state.balance)?.toFixed(0) ?? "?"}`
    : `🟢 ${contracts}ct  |  cushion $${cushionAmt ?? "?"}`;
  return { contracts, regimeLabel, streakLabel: "—", regimeMult: 1.0, streakMult: 1.0 };
}

// ─── Order placement ──────────────────────────────────────────────────────────
// Entry order with bracket SL + TP attached in a single API call.
// PlaceOrderBracket schema: { ticks: number, type: OrderType }
// This eliminates all timing gaps — stop and TP are live the instant the entry fills.
// Falls back to separate order placement if brackets are rejected.
//
// tradeOpts controls protective order sizing:
//   { stopTicks, tpTicks, stopType }
//   stopType: "trail" = TrailingStop | "fixed" = hard Stop
async function placeEntry(signalId, isLong, contracts, tradeOpts = {}) {
  if (!state.accountId || !state.contractId) {
    console.warn("[Order] Not ready — accountId or contractId missing");
    return;
  }

  // Per-account entry stagger — spreads fills across up to 7.5s so all 4 combines
  // don't hit the same tick simultaneously. Combine-1=0ms, -2=2500ms, -3=5000ms, -4=7500ms.
  if (ENTRY_STAGGER_MS > 0) {
    console.log(`[Order] ⏱  Stagger ${ENTRY_STAGGER_MS}ms (${ACCOUNT_LABEL}) before ${signalId}`);
    await new Promise(r => setTimeout(r, ENTRY_STAGGER_MS));
    // Re-check guards after stagger — market or risk state may have changed
    if (state.haltedToday || state.profitCappedToday) {
      console.log(`[Order] Stagger: halted/capped after delay — skipping ${signalId}`);
      state.activeDirections.delete(isLong ? "long" : "short");
      return null;
    }
  }

  const stopTicks = tradeOpts.stopTicks ?? CFG.stopTicks;
  const tpTicks   = tradeOpts.tpTicks   ?? CFG.tpTicks;
  const stopType  = CFG.stopMode || tradeOpts.stopType || "trail";
  const tfLabel   = tradeOpts.tf        ?? "5m";

  const dir  = isLong ? "long" : "short";
  const side = isLong ? OrderSide.Bid : OrderSide.Ask;

  // Fixed stop: placed at signal bar high/low + stopTicks (matches backtest model).
  // The bracket `ticks` field is a signed offset from fill price — since fill ≈ sigPrice
  // (market order fills at current price ≈ bar close), we compute the offset as:
  //   SHORT: stopTicksFromFill = (barHigh - sigPrice) / tickSize + stopTicks  (positive = above fill)
  //   LONG:  stopTicksFromFill = (barLow  - sigPrice) / tickSize - stopTicks  (negative = below fill)
  // Falls back to stopTicks from fill if barHigh/barLow not provided.
  let slTicks;
  if (CFG.forceFixedStopTicks != null && !tradeOpts.useOwnStop) {
    slTicks = isLong ? -CFG.forceFixedStopTicks : CFG.forceFixedStopTicks;
  } else if (stopType === "fixed" && tradeOpts.barHigh != null && tradeOpts.barLow != null && tradeOpts.sigPrice != null) {
    const sigPrice = tradeOpts.sigPrice;
    if (isLong) {
      slTicks = -Math.round((sigPrice - tradeOpts.barLow) / CFG.tickSize) - stopTicks;  // negative
    } else {
      slTicks = Math.round((tradeOpts.barHigh - sigPrice) / CFG.tickSize) + stopTicks;   // positive
    }
  } else {
    slTicks = isLong ? -stopTicks : stopTicks;  // fallback: N ticks from fill
  }

  // Reject trades where the bar range pushes the stop too far — bad R:R and backtest mismatch.
  // e.g. a 13.5-pt bar gives slTicks=64 against a 40t TP — skip it.
  if (stopType === "fixed" && Math.abs(slTicks) > CFG.maxStopTicks) {
    console.log(`[Order] ⛔ ${signalId} skipped — stop ${Math.abs(slTicks)}t exceeds max ${CFG.maxStopTicks}t (bar too wide)`);
    return null;
  }

  const body = {
    accountId:  state.accountId,
    contractId: state.contractId,
    type:       OrderType.Market,
    side,
    size:       contracts,
    customTag:  `${signalId}_${Date.now()}`,
    stopLossBracket:   { ticks: slTicks, type: stopType === "trail" ? OrderType.TrailingStop : OrderType.Stop },
    takeProfitBracket: { ticks: isLong ?  tpTicks : -tpTicks,  type: OrderType.Limit },
  };

  console.log(`[Order] 📤 Entry body: side=${side}(${isLong ? "Bid/Buy" : "Ask/Sell"}) size=${contracts} slTicks=${slTicks} tpTicks=${isLong ? tpTicks : -tpTicks}`);
  const data = await apiPost("/api/Order/place", body);

  if (!data.success) {
    const errMsg   = data.errorMessage ?? "unknown";
    const isMargin = /margin|scaling|contract.limit|position.limit/i.test(errMsg);
    console.error(`[Order] ✗ Failed (${signalId}): ${errMsg}`);
    state.activeDirections.delete(dir);

    // Scaling-plan / margin rejection: retry once at 1ct (minimum allowed).
    // Catches cases where balance drops below a scaling tier mid-session.
    if (isMargin && contracts > 1) {
      console.warn(`[Order] ↩  Scaling-plan rejection — retrying at 1ct`);
      notify("⚠️ Order scaled down to 1ct", `${signalId} ${dir.toUpperCase()} — rejected at ${contracts}ct (scaling plan)\nRetrying at 1ct`, "high").catch(()=>{});
      await placeEntry(signalId, isLong, 1, tradeOpts);
      return;
    }

    // Position Brackets conflict — account has Auto OCO Brackets disabled
    if (/position.brackets|auto.oco/i.test(errMsg)) {
      notify("🔧 Fix needed — Position Brackets",
        `Signal: ${signalId}\nTopstepX account has Position Brackets ON.\nGo to account settings → switch to Auto OCO Brackets → leave templates blank.\nEngine cannot place stops until this is fixed.`,
        "urgent"
      ).catch(() => {});
      return;
    }

    // All other failures — notify with clear context and give up
    const hint = isMargin ? "\n⚠️ Scaling plan limit — check XFA balance tier" : "";
    notify("❌ Order rejected", `${signalId} ${dir.toUpperCase()} ${contracts}ct\nReason: ${errMsg}${hint}`, "urgent").catch(()=>{});
    return;
  }

  const entryOrderId = String(data.orderId ?? data.id);

  // Confirmed from API schema (swagger.json): PlaceOrderResponse only ever returns
  // { success, errorCode, errorMessage, orderId } — bracket child IDs are NEVER in the
  // response. OrderModel also contains no bracket reference fields.
  // Correct verification: /api/Order/searchOpen at 3s checks if stop/limit orders are
  // actually on the book. Prevents duplicate orders without leaving position naked.
  state.openTrades.set(entryOrderId, {
    signalId, isLong, contracts, protected: true,
    stopTicks, tpTicks, stopType, tf: tfLabel,
    barHigh: tradeOpts.barHigh ?? null,
    barLow:  tradeOpts.barLow  ?? null,
    sigPrice: tradeOpts.sigPrice ?? null,
    useOwnStop: tradeOpts.useOwnStop === true,
  });
  state.activeDirections.add(dir);

  // ── Watchdog: verify protective orders exist at 3s ────────────────────────
  // PlaceOrderResponse never includes bracket IDs — only way to confirm brackets
  // landed is to query open orders after fill. Two REST calls, runs once per trade.
  setTimeout(async () => {
    const t = state.openTrades.get(entryOrderId);
    if (!t) return;  // trade already closed (very fast fill + close edge case)

    console.log(`[Watchdog] 🔍 Verifying bracket protection for ${signalId}`);
    try {
      // Step 1: confirm entry filled and get fill price
      const d = await apiPost("/api/Order/searchById", { accountId: state.accountId, orderId: entryOrderId });
      const o = d.order ?? (d.orders ?? d.items ?? [])[0];
      if (!o) return;

      if (o.status === 2) {  // Filled
        const fp = +(o.filledPrice ?? o.avgPrice ?? o.price ?? 0);
        if (fp <= 0) return;

        // Step 2: check open orders for protective stop/limit on the closing side
        // LONG closes with Ask (sell); SHORT closes with Bid (buy)
        const closeSide  = isLong ? OrderSide.Ask : OrderSide.Bid;
        const openData   = await apiPost("/api/Order/searchOpen", { accountId: state.accountId });
        const openOrders = openData.orders ?? openData.items ?? [];
        const hasProtection = openOrders.some(ord =>
          ord.side === closeSide &&
          (ord.type === OrderType.TrailingStop || ord.type === OrderType.Stop || ord.type === OrderType.Limit)
        );

        if (hasProtection) {
          console.log(`[Watchdog] ✓ ${signalId} — protective orders confirmed on open order book`);
          return;  // brackets are live — nothing to do
        }

        // No protective orders on the book — check if position is already flat
        // (stop may have filled and closed us before this 3s watchdog ran)
        const posData2 = await apiPost("/api/Position/searchOpen", { accountId: state.accountId }).catch(() => ({ positions: [] }));
        const positions2 = posData2.positions ?? posData2.items ?? [];
        const stillOpen  = positions2.some(p => p.contractId === state.contractId && Math.abs(+(p.size ?? p.qty ?? 0)) > 0);
        if (!stillOpen) {
          console.log(`[Watchdog] ℹ️  ${signalId}: no open position found — stop already filled, cleaning up`);
          state.openTrades.delete(entryOrderId);
          state.activeDirections.delete(dir);
          // The fast-stop fill closed before this watchdog ran, so onTradeEvent
          // never processed it — dayPnL and the profit-cap/DLL checks are now
          // stale. Reconcile immediately via the same orphan-trade path used
          // elsewhere, instead of waiting for the next periodic trigger — a
          // stale dayPnL here means the engine keeps trading past its own cap.
          reconcileMissedTrades().catch(e => console.error(`[Watchdog] Reconcile after fast-stop failed: ${e.message}`));
          return;
        }

        // No protective orders on the book → bracket wasn't placed
        if (t.emergencyClose) {
          console.log(`[Watchdog] ℹ️  ${signalId}: emergency close already in flight — skipping bracket retry`);
          return;
        }
        console.warn(`[Watchdog] ⚠️  ${signalId}: no open protective orders found — placing SL/TP now`);
        notify(`⚠️ Bracket missing — ${signalId}`, `Placing SL/TP now (not found on open order book)\n${isLong ? "LONG" : "SHORT"} ${contracts}ct @ ${fp}`, "urgent").catch(() => {});
        t.protected = false;  // unlock so placeProtectiveOrders will run
        await placeProtectiveOrders(entryOrderId, fp);

      } else if (o.status === 3 || o.status === 5) {
        // Entry cancelled or rejected — clean up
        state.openTrades.delete(entryOrderId);
        state.activeDirections.delete(dir);
        console.warn(`[Watchdog] Order ${entryOrderId} was cancelled/rejected (status=${o.status}) — cleaned up`);
      }
      // status=1 (still pending) — entry not yet filled; do nothing
    } catch (e) {
      console.error("[Watchdog] REST poll failed:", e.message);
    }
  }, 3_000);

  const stopDesc   = stopType === "trail" ? `Trail ${stopTicks}t` : `Stop ${Math.abs(slTicks)}t`;
  const bracketTag = " [bracketed ✅]";
  const briefing = `${dir.toUpperCase()} ${contracts}ct  |  ${tfLabel}  |  ${stopDesc}  TP ${tpTicks}t${bracketTag}\nDay P&L so far: $${state.dayPnL.toFixed(0)}`;
  emitBundleEvent('TRADE_ENTERED', { signal: signalId, dir, contracts });
  notify(`📈 Trade entered — ${signalId}`, briefing, "default").catch(()=>{});
  console.log(`[Order] ➡️  ${dir.toUpperCase()} ${contracts}ct | orderId=${entryOrderId} | signal=${signalId} | ${tfLabel} | ${stopDesc} TP=${tpTicks}t${bracketTag}`);
}

// Place protective orders (stop + limit TP) after entry fills.
// Called from onOrderEvent when entry status = Filled.
// Uses per-trade stopTicks/tpTicks/stopType stored when entry was placed:
//   stopType "trail" → TrailingStop (5m default, 8t from high watermark)
//   stopType "fixed" → Stop at hard price (15m layer, 12t below/above fill)
async function placeProtectiveOrders(entryOrderId, fillPrice) {
  const trade = state.openTrades.get(entryOrderId);
  if (!trade || trade.protected || trade.isProtective) return;
  trade.protected = true;  // prevent double-placement on duplicate events

  const { isLong, contracts, signalId, stopTicks, tpTicks, stopType, barHigh, barLow, useOwnStop } = trade;
  const closeSide = isLong ? OrderSide.Ask : OrderSide.Bid;  // close = opposite of entry

  // Persist open trade state so a restart can recover signal/direction/entry price
  persistOpenTrade({
    entryOrderId, signalId, isLong, contracts, fillPrice,
    stopTicks, tpTicks, stopType, useOwnStop, openedAt: Date.now(),
  });

  // Stop order — trailing or fixed depending on which layer placed the entry
  // For fixed stop: use signal bar high/low + stopTicks if available (matches backtest model).
  // Falls back to fillPrice ± stopTicks if bar context wasn't stored.
  const initialStopPrice = (() => {
    if (CFG.forceFixedStopTicks != null && !useOwnStop) {
      return isLong
        ? fillPrice - CFG.forceFixedStopTicks * CFG.tickSize
        : fillPrice + CFG.forceFixedStopTicks * CFG.tickSize;
    }
    if (stopType === "fixed" && barHigh != null && barLow != null) {
      return isLong
        ? barLow  - stopTicks * CFG.tickSize   // LONG: stop below signal bar low
        : barHigh + stopTicks * CFG.tickSize;  // SHORT: stop above signal bar high
    }
    return isLong
      ? fillPrice - stopTicks * CFG.tickSize
      : fillPrice + stopTicks * CFG.tickSize;
  })();

  let slBody;
  let slDesc;
  if (stopType === "fixed") {
    // Fixed stop — hard price level, used by 15m layer
    slBody = {
      accountId:  state.accountId,
      contractId: state.contractId,
      type:       OrderType.Stop,
      side:       closeSide,
      size:       contracts,
      stopPrice:  initialStopPrice,           // ✅ correct field for Stop orders
      customTag:  `${signalId}_SL_${Date.now()}`,
    };
    slDesc = `Fixed stop @ ${initialStopPrice.toFixed(2)} (${stopTicks}t)`;
  } else {
    // Trailing stop — trailPrice = distance; stopPrice = initial anchor
    // Both fields required: without stopPrice the API computes trail distance
    // from (currentPrice - 0) ≈ 7300+, which triggers "Trail Distance exceeds max (1000)"
    const trailPrice = stopTicks * CFG.tickSize;  // e.g. 12t × 0.25 = 3.00
    slBody = {
      accountId:  state.accountId,
      contractId: state.contractId,
      type:       OrderType.TrailingStop,
      side:       closeSide,
      size:       contracts,
      trailPrice,                             // trail distance in price units
      stopPrice:  initialStopPrice,           // ✅ initial anchor — fixes "exceeds max (1000)"
      customTag:  `${signalId}_SL_${Date.now()}`,
    };
    slDesc = `Trail stop ${stopTicks}t ($${trailPrice.toFixed(2)}) from peak`;
  }

  // ── Take profit (Limit order) ─────────────────────────────────────────────
  const tpPrice = isLong
    ? fillPrice + tpTicks * CFG.tickSize
    : fillPrice - tpTicks * CFG.tickSize;

  const tpBody = {
    accountId:  state.accountId,
    contractId: state.contractId,
    type:       OrderType.Limit,
    side:       closeSide,
    size:       contracts,
    limitPrice: tpPrice,                      // ✅ correct field for Limit orders
    customTag:  `${signalId}_TP_${Date.now()}`,
  };

  const [slData, tpData] = await Promise.all([
    apiPost("/api/Order/place", slBody).catch(e => ({ success: false, errorMessage: e.message })),
    apiPost("/api/Order/place", tpBody).catch(e => ({ success: false, errorMessage: e.message })),
  ]);

  let slOk = slData.success && (slData.orderId ?? slData.id);
  let slId = String(slData.orderId ?? slData.id ?? "");
  let slDataFinal = slData;

  // ── TrailingStop fallback: if trailing stop is rejected, retry as a fixed Stop ──
  // Ensures we always have a stop in place — no naked positions.
  if (!slOk && stopType !== "fixed") {
    console.warn(`[Order] ⚠️  TrailingStop rejected (${signalId}): ${slData.errorMessage} — falling back to fixed Stop`);
    notify(`⚠️ Bracket rejected — check direction! ${signalId}`, `Trailing stop rejected — may mean position opened in WRONG direction.\n⚡ Open platform NOW and verify position is ${isLong ? "LONG" : "SHORT"}.\nIf wrong direction → close immediately.\nPlacing fixed stop @ ${initialStopPrice.toFixed(2)} (${stopTicks}t) as backup.`, "high").catch(()=>{});
    const fallbackBody = {
      accountId:  state.accountId,
      contractId: state.contractId,
      type:       OrderType.Stop,
      side:       closeSide,
      size:       contracts,
      stopPrice:  initialStopPrice,
      customTag:  `${signalId}_SL_FB_${Date.now()}`,
    };
    slDataFinal = await apiPost("/api/Order/place", fallbackBody).catch(e => ({ success: false, errorMessage: e.message }));
    slOk  = slDataFinal.success && (slDataFinal.orderId ?? slDataFinal.id);
    slId  = String(slDataFinal.orderId ?? slDataFinal.id ?? "");
    if (slOk)  slDesc = `Fixed stop (fallback) @ ${initialStopPrice.toFixed(2)} (${stopTicks}t)`;
  }

  const tpOk = tpData.success && (tpData.orderId ?? tpData.id);
  const tpId = String(tpData.orderId ?? tpData.id ?? "");

  if (!slOk) console.error(`[Order] ✗ Stop failed (${signalId}): ${slDataFinal.errorMessage}`);
  else console.log(`[Order] 🛡️  ${slDesc} | orderId=${slId}`);

  if (!tpOk) console.error(`[Order] ✗ Take profit failed (${signalId}): ${tpData.errorMessage}`);
  else console.log(`[Order] 🎯 Take profit @ ${tpPrice.toFixed(2)} (${tpTicks}t) | orderId=${tpId}`);

  // ── Stop failed: emergency market close ───────────────────────────────────
  // If the stop can't be placed (market moved through it before placement),
  // we must close at market immediately — never leave a position naked.
  if (!slOk) {
    // Position Brackets conflict is a config issue, not a market-movement issue
    if (/position.brackets|auto.oco/i.test(slDataFinal.errorMessage ?? "")) {
      notify("🔧 Fix needed — Position Brackets",
        `Stop order blocked for ${signalId}.\nTopstepX account has Position Brackets ON — switch to Auto OCO Brackets in account settings (leave templates blank).\nClosing position now as safety measure.`,
        "urgent"
      ).catch(() => {});
    }
    trade.emergencyClose = true;  // flag so 3s watchdog doesn't double-retry
    console.error(`[Order] 🚨 Stop placement failed for ${signalId} — emergency market close to prevent naked position`);
    notify(
      `🚨 Stop failed → emergency close (${signalId})`,
      `Stop rejected: ${slDataFinal.errorMessage}\n${isLong ? "LONG" : "SHORT"} ${contracts}ct @ ${fillPrice.toFixed(2)}\nClosing at market now.`,
      "urgent"
    ).catch(() => {});
    const emgData = await apiPost("/api/Order/place", {
      accountId:  state.accountId,
      contractId: state.contractId,
      type:       OrderType.Market,
      side:       closeSide,
      size:       contracts,
      customTag:  `${signalId}_EMG_${Date.now()}`,
    }).catch(e => ({ success: false, errorMessage: e.message }));
    if (emgData.success) {
      console.log(`[Order] ✓ Emergency close placed orderId=${emgData.orderId ?? emgData.id}`);
      if (tpOk) apiPost("/api/Order/cancel", { orderId: tpId, accountId: state.accountId }).catch(() => {});
    } else {
      console.error(`[Order] ✗ Emergency close ALSO failed: ${emgData.errorMessage} — MANUAL INTERVENTION NEEDED`);
      notify(
        `🚨🚨 MANUAL CLOSE NEEDED — ${signalId}`,
        `Stop AND emergency market close both failed.\nPosition is NAKED — close manually NOW!\n${isLong ? "LONG" : "SHORT"} ${contracts}ct`,
        "urgent"
      ).catch(() => {});
    }
    return;  // do not set up OCO tracking — position is closing
  }

  // ── Notify on success ─────────────────────────────────────────────────────
  if (slOk && tpOk) {
    const dir  = isLong ? "LONG" : "SHORT";
    const tf   = trade.tf ?? "5m";
    const fallbackNote = slDesc.includes("fallback") ? "\n⚠️ Trail rejected — verify position direction is correct on platform!" : "";
    notify(
      `🛡️ Protected — ${signalId}`,
      `${dir} ${contracts}ct filled @ ${fillPrice.toFixed(2)}  [${tf}]\n${slDesc}\nTP @ ${tpPrice.toFixed(2)} (+${tpTicks}t)\nBoth orders confirmed ✅${fallbackNote}`,
      "default"
    ).catch(()=>{});
  } else {
    // TP failed but stop is placed — position is protected, just missing upside
    const failMsg = [
      `✅ Stop placed`,
      `❌ TP FAILED: ${tpData.errorMessage}`,
    ].join("\n");
    notify(`⚠️ TP order failed — ${signalId}`, failMsg, "urgent").catch(()=>{});
    console.error(`[Order] ⚠️  TP placement failed for ${signalId} — stop is live but no take profit`);
  }

  // ── Track for OCO (cancel survivor when the other fills) ──────────────────
  // intendedPrice lets onTradeEvent compare the actual closing fill against what
  // we asked for — the data needed to know real slippage before tightening the
  // stop further (stopType "trail" has no fixed intended price; only "fixed" does).
  if (slId) state.openTrades.set(slId, { signalId, isLong, contracts, isProtective: true, pairedWith: tpId, intendedPrice: stopType === "fixed" ? initialStopPrice : null, orderKind: "SL" });
  if (tpId) state.openTrades.set(tpId, { signalId, isLong, contracts, isProtective: true, pairedWith: slId, intendedPrice: tpPrice, orderKind: "TP" });

  // Attach fields the incremental profit-lock staircase needs onto the entry's
  // own tracking object: the live SL order id to target with /api/Order/modify,
  // the fill price to measure unrealized gain against, the realized dayPnL at
  // the moment this trade opened (so per-trade unrealized can be isolated from
  // total day P&L), and which lock tier (if any) has already been applied.
  if (trade) {
    trade.slId          = slId || null;
    trade.entryFillPrice = fillPrice;
    trade.dayPnLAtOpen  = state.dayPnL;
    trade.profitLockLevel = 0;
  }

  // Update persisted state with real bracket order IDs so recoverOpenPosition can restore
  // state.openTrades by exact orderId — eliminates RECOVERED classification after restarts
  persistOpenTrade({ entryOrderId, signalId, isLong, contracts, fillPrice,
    stopTicks, tpTicks, stopType, slId: slId || null, tpId: tpId || null });

  // Log entry to trades.jsonl immediately — so if the bot crashes mid-trade and
  // reconnects, the open position is already in the log and won't appear as ORPHANED.
  const nowEntry = new Date();
  logTrade({
    timestamp:   nowEntry.toISOString(),
    date:        nowEntry.toISOString().slice(0, 10),
    time_mt:     mtTimeStr(nowEntry),
    tax_year:    nowEntry.getUTCFullYear(),
    contract:    (state.contractId ?? '').split('.').slice(-2).join('') || 'NQ',
    contract_id: state.contractId,
    signal:      signalId,
    direction:   isLong ? 'long' : 'short',
    contracts,
    entry_price: +fillPrice.toFixed(2),
    exit_price:  null,
    gross_pnl:   null,
    stop_ticks:  stopTicks,
    tp_ticks:    tpTicks,
    status:      'open',
    entry_order_id: entryOrderId,
    voided:      false,
    section_1256: true,
  });
}

// ─── Boot: open-position recovery ────────────────────────────────────────────
// Called once at startup. If the engine died while a position was open, restores
// engine state and verifies/replaces protective orders so the trade stays managed.
// If the position already closed while we were down, sets a flag so the next
// signal evaluate fires immediately (instead of waiting for the next 5m boundary).
let _reEvaluateAfterBoot = false;

async function recoverOpenPosition() {
  const persisted = loadPersistedOpenTrade();

  // Always check the REST API for open positions regardless of persisted state.
  // Root cause: if engine crashed before writing the state file (empty {}), the old
  // code returned here and left the position completely unprotected.
  const posData = await apiPost("/api/Position/searchOpen", { accountId: state.accountId });
  if (!posData.success) return;
  const openPositions = (posData.positions ?? []).filter(p => (p.size ?? 0) !== 0);

  if (openPositions.length === 0) {
    if (!persisted) return;
    // Persisted state exists but position is now flat — reconcileMissedTrades will log it.
    console.log(`[Boot] Persisted trade found but position is flat — will reconcile and re-evaluate immediately`);
    _reEvaluateAfterBoot = true;
    return;
  }

  // Position is still live — restore engine state so we keep managing it
  const openPos   = openPositions[0];
  const posIsLong = openPos.type === 1;  // PositionType: 1=Long, 2=Short

  // If no persisted state, construct a minimal entry from what the API tells us.
  // This covers the crash-before-persist case — we still find the position and protect it.
  const hasPersisted = persisted && Object.keys(persisted).length > 0;
  if (!hasPersisted) {
    console.warn(`[Boot] ⚠️  Open ${posIsLong ? "LONG" : "SHORT"} position found but NO persisted state — placing emergency brackets`);
    notify(`⚠️ Untracked position found`, `Open ${posIsLong ? "LONG" : "SHORT"} ${openPos.size ?? "?"}ct — no persisted context. Placing emergency SL/TP now.`, "urgent").catch(() => {});

    const syntheticId = `orphan-boot-${Date.now()}`;
    // Use average open price from position API if available; never fall back to account balance
    const avgPrice = openPos.avgPrice ?? openPos.averagePrice ?? null;
    state.activeDirections.add(posIsLong ? "long" : "short");
    state.openTrades.set(syntheticId, {
      signalId:     "ORPHAN",
      isLong:       posIsLong,
      contracts:    openPos.size ?? 1,
      isProtective: false,
      protected:    false,
      stopTicks:    CFG.stopTicks,
      tpTicks:      CFG.tpTicks,
      stopType:     "trail",
    });
    if (avgPrice) {
      await placeProtectiveOrders(syntheticId, avgPrice);
    } else {
      console.error(`[Boot] Cannot place emergency brackets — no fill price available`);
    }
    return;
  }

  console.log(`[Boot] 🔄 Recovering open ${posIsLong ? "LONG" : "SHORT"} position — signal: ${persisted.signalId}`);
  notify(`🔄 Position recovered`, `${persisted.signalId} ${posIsLong ? "LONG" : "SHORT"} ${persisted.contracts ?? "?"}ct @ ${persisted.fillPrice ?? "?"}`, "default").catch(() => {});

  const dir = posIsLong ? "long" : "short";
  state.activeDirections.add(dir);

  // Restore with real SL/TP order IDs when available so state.openTrades.get(closingOrderId)
  // succeeds on the live close event — prevents RECOVERED classification after restarts
  const savedSlId   = persisted.slId ? String(persisted.slId) : null;
  const savedTpId   = persisted.tpId ? String(persisted.tpId) : null;
  const syntheticId = `recovered-boot-${Date.now()}`;
  const tradeEntry  = {
    signalId:     persisted.signalId,
    isLong:       posIsLong,
    contracts:    persisted.contracts ?? openPos.size,
    isProtective: true,
    protected:    false,
    stopTicks:    persisted.stopTicks ?? CFG.stopLossTicks,
    tpTicks:      persisted.tpTicks   ?? CFG.tpTicks,
    stopType:     persisted.stopType  ?? "trail",
  };
  if (savedSlId) state.openTrades.set(savedSlId, { ...tradeEntry, pairedWith: savedTpId ?? "" });
  if (savedTpId) state.openTrades.set(savedTpId, { ...tradeEntry, pairedWith: savedSlId ?? "" });
  if (!savedSlId && !savedTpId) state.openTrades.set(syntheticId, tradeEntry);

  // Verify protective orders are still on the book
  const closeSide  = posIsLong ? OrderSide.Ask : OrderSide.Bid;
  const ordData    = await apiPost("/api/Order/searchOpen", { accountId: state.accountId });
  const openOrders = ordData.orders ?? ordData.items ?? [];
  const hasProtection = openOrders.some(ord =>
    ord.side === closeSide &&
    (ord.type === OrderType.TrailingStop || ord.type === OrderType.Stop || ord.type === OrderType.Limit)
  );

  if (hasProtection) {
    if (savedSlId && state.openTrades.has(savedSlId)) state.openTrades.get(savedSlId).protected = true;
    if (savedTpId && state.openTrades.has(savedTpId)) state.openTrades.get(savedTpId).protected = true;
    if (!savedSlId && !savedTpId) state.openTrades.get(syntheticId).protected = true;
    console.log(`[Boot] ✓ Protective orders confirmed — position is managed`);
  } else {
    // Brackets were lost — re-place them now.
    // syntheticId must be in openTrades as a non-protective entry so placeProtectiveOrders
    // can find it — without this, the call returns early when savedSlId/savedTpId are set.
    console.warn(`[Boot] ⚠️  No protective orders found — re-placing SL/TP`);
    notify(`⚠️ Re-placing brackets`, `${persisted.signalId} lost protection on restart — placing now`, "urgent").catch(() => {});
    if (persisted.fillPrice) {
      state.openTrades.set(syntheticId, { ...tradeEntry, isProtective: false });
      await placeProtectiveOrders(syntheticId, persisted.fillPrice);
    } else {
      console.error(`[Boot] Cannot re-place protection — fill price unknown`);
    }
  }
}

// ─── Missed-trade recovery ────────────────────────────────────────────────────
// Called when SignalR reconnects or when a stuck gate is detected.
// Fetches the last 2 hours of trade history via REST and replays any close events
// that weren't delivered by SignalR (not in seenTradeIds).
async function reconcileMissedTrades() {
  if (!state.accountId) return;
  if (state.reconcileInProgress) { console.warn("[Recovery] Already in progress — skipped duplicate call"); return; }
  state.reconcileInProgress = true;
  // Captured BEFORE the recovery block below can flip it to true — tells the
  // orphan-trade loop further down whether THIS call already did a full
  // trade-history resum (which folds every orphan's pnl in automatically) or
  // whether dayPnL was left untouched coming in, so any orphan found needs its
  // pnl added explicitly. Using the live value there would always read true.
  const alreadyRecoveredOnEntry = state.dayContextRecovered;
  try {
    // Always look back to today's session start (13:30 UTC) — never earlier.
    // Before 13:30 UTC there's no AM session yet, so nothing to reconcile.
    // The 2-hour fallback was removed because it could pick up yesterday's PM trades
    // and double-count them (seenTradeIds now persists to disk as a second guard).
    const todaySessionStart = new Date();
    todaySessionStart.setUTCHours(13, 30, 0, 0);
    if (new Date() < todaySessionStart) return; // nothing to reconcile yet
    const since = todaySessionStart.toISOString();
    const data = await apiPost("/api/Trade/search", {
      accountId:      state.accountId,
      startTimestamp: since,
    });
    if (!data.success) return;
    const trades = data.trades ?? data.items ?? [];

    // ── Mid-day restart: recover dayPnL and startOfDayBalance from trade history ─
    // The 13:30 UTC day-reset won't fire again after a mid-day restart, so we infer
    // the true start-of-day balance from the sum of today's closed trades.
    // dayPnL itself must NOT depend on state.balance being populated yet — balance
    // arrives async via the hub's account push event, and gating the whole P&L
    // recovery on it being non-null meant a fast boot (reconcile called moments
    // after connectHub, before that push lands) silently skipped recovering
    // dayPnL entirely, leaving the engine's own profit-cap/DLL check blind to
    // real trades that already happened today.
    if (!state.dayContextRecovered) {
      let tradedPnL = 0, dayWins = 0, dayLosses = 0;
      for (const t of trades) {
        const p = t.profitAndLoss ?? 0;
        if (p !== 0 && !t.voided) {
          tradedPnL += p;
          if (p > 0) dayWins++; else dayLosses++;
        }
      }
      state.dayPnL             = tradedPnL;
      state.dayWins            = dayWins;
      state.dayLosses          = dayLosses;
      state.dayContextRecovered = true;
      writeSharedState(state.dayPnL);
      // Fetch a FRESH balance via REST rather than trusting state.balance — it's updated
      // async via the SignalR account push, which can lag behind a just-closed trade's P&L
      // by enough to still be in flight here. Using a stale pre-trade balance against a
      // post-trade tradedPnL double-subtracts that trade (see 2026-10-08 note on the normal
      // session-reset path above) and knocks the scaling tier down a notch for the rest of
      // the day on a genuine mid-day restart, which this same subtraction also runs for.
      let freshBalance = state.balance;
      try {
        const acctData = await apiPost("/api/Account/search", {});
        const acct = acctData.accounts?.find(a => a.id === state.accountId);
        if (acct?.balance != null) freshBalance = +acct.balance;
      } catch { /* non-fatal — fall back to state.balance below */ }
      if (freshBalance != null) {
        state.balance = freshBalance;
        state.startOfDayBalance = freshBalance - tradedPnL;
        console.log(`[Day] ♻️  Mid-day context recovered — day P&L: ${tradedPnL >= 0 ? '+' : ''}$${tradedPnL.toFixed(2)} | wins: ${dayWins} | losses: ${dayLosses} | inferred start: $${state.startOfDayBalance.toFixed(2)}`);
      } else {
        console.log(`[Day] ♻️  Mid-day dayPnL recovered — day P&L: ${tradedPnL >= 0 ? '+' : ''}$${tradedPnL.toFixed(2)} | wins: ${dayWins} | losses: ${dayLosses} | (balance not yet available — startOfDayBalance will backfill on next account push)`);
      }

      // Restore gate flags from disk (trend filter, halted, cooldown, etc.)
      // dayPnL above comes from trade history (authoritative); gates file fills in
      // everything else (noShortsToday, haltedToday, consecutiveLosses, etc.)
      const gatesRestored = restoreSessionGates(state);
      // Re-apply dayPnL from trade history — it's more accurate than the file value
      state.dayPnL = tradedPnL;
      writeSharedState(state.dayPnL);
      if (gatesRestored) {
        console.log(`[Gates] ♻️  Session gates restored — noShorts=${state.noShortsToday} noLongs=${state.noLongsToday} halted=${state.haltedToday} cooldownUntil=${state.cooldownUntil > Date.now() ? new Date(state.cooldownUntil).toISOString() : "none"}`);
      }
      // Check DLL/profit-cap against recovered dayPnL (orphaned trades won't call onTradeEvent)
      if (!state.haltedToday && state.dayPnL <= -CFG.dailyLossLimit) {
        state.haltedToday = true;
        console.log(`[Day] 🛑 DLL reached in recovery (dayPnL $${state.dayPnL.toFixed(2)}) — halted for today`);
        saveSessionGates(state);
      } else if (!state.profitCappedToday && state.dayPnL >= CFG.dailyProfitCap) {
        state.profitCappedToday = true;
        console.log(`[Day] 🏁 Profit cap reached in recovery (dayPnL $${state.dayPnL.toFixed(2)}) — no more trades today`);
        saveSessionGates(state);
      }
    }

    // Restore context from persisted state file if available (written on each entry fill)
    const persisted = loadPersistedOpenTrade();

    // Collect entry fills (pnl=0) keyed by side+size for matching against closes
    const entryFills = [];
    for (const trade of trades) {
      const pnl = trade.profitAndLoss ?? 0;
      if (pnl === 0) entryFills.push(trade);
    }

    // Finds the real entry fill for an orphaned exit — so trades.jsonl stops
    // logging entry_price:null on nearly every trade (every trade that resolves
    // via this orphan path, which on this account is almost all of them — every
    // slippage/MFE question this week needed a live bar re-fetch to answer
    // because this wasn't captured at write time). Matches the closest-preceding,
    // not-yet-claimed entry fill with the opposite side and same size — trades
    // here routinely resolve in well under a second, so timestamp-adjacency is
    // reliable; the claimed-set stops one entry from being matched to two exits
    // when a batch has multiple orphans.
    const claimedEntryIds = new Set();
    function matchEntryFill(exitTrade) {
      const exitTime = new Date(exitTrade.creationTimestamp).getTime();
      const exitSize = exitTrade.size ?? exitTrade.contracts ?? null;
      let best = null, bestTime = -Infinity;
      for (const e of entryFills) {
        const eid = String(e.id ?? e.tradeId ?? "");
        if (!eid || claimedEntryIds.has(eid)) continue;
        if (e.side === exitTrade.side) continue;  // closing side must be opposite of entry side
        if (exitSize != null && (e.size ?? e.contracts) !== exitSize) continue;
        const eTime = new Date(e.creationTimestamp).getTime();
        if (eTime > exitTime) continue;  // entry must precede its own exit
        if (eTime > bestTime) { best = e; bestTime = eTime; }
      }
      if (best) claimedEntryIds.add(String(best.id ?? best.tradeId ?? ""));
      return best;
    }

    for (const trade of trades) {
      const tid = String(trade.id ?? trade.tradeId ?? "");
      if (!tid || state.seenTradeIds.has(tid)) continue;
      const pnl = trade.profitAndLoss ?? 0;
      if (pnl === 0) { state.seenTradeIds.add(tid); saveSeenTradeIds(); continue; } // entry fill — skip

      // Try to recover direction from persisted file only.
      // Root cause: entry-fill matching accepts trades from OTHER engine instances during
      // restart churn, not just this engine's session. Only trust the persisted state file —
      // that represents the ONE trade this engine knew about from its previous run.
      let signalId        = "RECOVERED";
      let isLong          = null;
      let entryPrice      = null;
      let persistedMatch  = false;

      if (persisted && !persisted._used) {
        signalId        = persisted.signalId;
        isLong          = persisted.isLong;
        entryPrice      = persisted.fillPrice ?? null;
        persisted._used = true;
        persistedMatch  = true;
        console.warn(`[Recovery] ♻️  Restored context from disk: ${signalId} ${isLong ? "LONG" : "SHORT"} entry@${entryPrice}`);
      }

      // Orphaned trade: already closed on TopstepX, no persisted context.
      // Day P&L was already recovered above via trade history sum, so no DLL risk.
      // Log to trades.jsonl so the day is fully auditable.
      if (!persistedMatch) {
        // The single-slot `persisted` file can only ever match ONE orphan per
        // reconcile() call — any batch with 2+ orphans (routine on a day where
        // trades resolve in ~15ms, faster than SignalR delivers the close event)
        // left every trade after the first with no strategy attribution and no
        // slippage data. Recover both directly from the closing ORDER's own
        // customTag (TopstepX auto-suffixes our own "<signalId>_<ts>" tag with
        // "-SL"/"-TP" on bracket sub-orders) and stopPrice/limitPrice — far more
        // reliable than the fragile single-slot file, works no matter how many
        // trades are in one batch.
        let orphanSignalId = null, orphanOrderKind = null, orphanExitSlipT = null;
        const orphanOrderId = trade.orderId ?? trade.order_id ?? null;
        if (orphanOrderId != null) {
          try {
            const od = await apiPost("/api/Order/searchById", { accountId: state.accountId, orderId: orphanOrderId });
            const order = od?.order ?? (od?.orders ?? od?.items ?? [])[0];
            if (order?.customTag) {
              orphanSignalId = order.customTag.replace(/-(SL|TP)$/, '').replace(/_\d{10,}$/, '') || null;
              orphanOrderKind = /-SL$/.test(order.customTag) ? "SL" : /-TP$/.test(order.customTag) ? "TP" : null;
            }
            const intendedPx = order?.type === OrderType.Stop ? order?.stopPrice : order?.type === OrderType.Limit ? order?.limitPrice : null;
            const exitFillPx = trade.price ?? null;
            if (intendedPx != null && exitFillPx != null) {
              // Closing a LONG = sell (worse fill = lower price = adverse); closing
              // a SHORT = buy (worse fill = higher price = adverse) — trade.side is
              // the closing fill's own side here, so side===1(Ask/sell) means it was
              // closing a LONG, side===0(Bid/buy) means it was closing a SHORT.
              const wasLong = trade.side === 1;
              orphanExitSlipT = Math.round((wasLong ? intendedPx - exitFillPx : exitFillPx - intendedPx) / CFG.tickSize);
            }
          } catch (e) {
            console.warn(`[Recovery] Order lookup failed for orphan ${tid} (orderId ${orphanOrderId}): ${e.message}`);
          }
        }
        // dayPnL is only guaranteed current if THIS call did the full trade-history
        // resum above (only happens when dayContextRecovered was false on entry) —
        // that resum already folds this trade's pnl in, so adding it again here
        // would double-count. On every LATER call — stuck-gate detection, hub
        // reconnects, the watchdog's fast-stop path — that resum is skipped
        // entirely, and an orphan found here represents P&L this engine has never
        // recorded anywhere, so it must be added and the risk gates re-checked.
        if (alreadyRecoveredOnEntry) {
          state.dayPnL += pnl;
          writeSharedState(state.dayPnL);
          if (!state.haltedToday && state.dayPnL <= -CFG.dailyLossLimit) {
            state.haltedToday = true;
            console.log(`[Day] 🛑 DLL reached via orphan recovery (dayPnL $${state.dayPnL.toFixed(2)}) — halted for today`);
            saveSessionGates(state);
          } else if (!state.profitCappedToday && state.dayPnL >= CFG.dailyProfitCap) {
            state.profitCappedToday = true;
            console.log(`[Day] 🏁 Profit cap reached via orphan recovery (dayPnL $${state.dayPnL.toFixed(2)}) — no more trades today`);
            saveSessionGates(state);
          }
        }
        const _dir = trade.side === 0 ? "SHORT" : "LONG";  // closing side is inverse of position direction
        const _signalLabel = orphanSignalId ?? "ORPHANED";
        const matchedEntry = matchEntryFill(trade);
        console.warn(`[Recovery] ⚠️  Orphaned trade ${tid} — ${_signalLabel} ${_dir} (P&L $${pnl.toFixed(2)}) — logging to trades.jsonl (dayPnL now $${state.dayPnL.toFixed(2)})`);
        // Force a fresh balance fetch right as this trade's P&L books — the async
        // SignalR account push that normally updates state.balance can lag well
        // behind this (this whole path exists because trades here routinely close
        // faster than events arrive), leaving the product UI's account total stuck
        // on a pre-trade value until the next push happens to land. This is every
        // trade's real, immediate close — refresh now instead of waiting on it.
        apiPost("/api/Account/search", {}).then(d => {
          const acct = d.accounts?.find(a => a.id === state.accountId);
          if (acct?.balance != null) onAccountEvent({ balance: acct.balance });
        }).catch(() => {});
        if (orphanOrderKind === "SL" && orphanOrderId != null) {
          startSlPostMortem(orphanOrderId, trade.price, trade.size ?? trade.contracts ?? 1, orphanSignalId).catch(() => {});
        }
        state.seenTradeIds.add(tid);
        saveSeenTradeIds();
        const now = new Date();
        logTrade({
          timestamp:     now.toISOString(),
          date:          now.toISOString().slice(0, 10),
          time_mt:       mtTimeStr(now),
          tax_year:      now.getUTCFullYear(),
          contract:      (state.contractId ?? "").split(".").slice(-2).join("") || "ES",
          contract_id:   state.contractId,
          signal:        _signalLabel,
          // trade.side here is the CLOSING fill's side (only nonzero-P&L trades reach
          // this branch), which is the OPPOSITE of the position's own direction:
          // buying to close (Bid=0) means the position was SHORT; selling to close
          // (Ask=1) means it was LONG.
          direction:     _dir,
          contracts:     trade.size ?? trade.contracts ?? "?",
          entry_price:     matchedEntry?.price ?? null,
          entry_timestamp: matchedEntry?.creationTimestamp ?? null,
          exit_price:    trade.price ?? null,
          exit_order_kind: orphanOrderKind,
          exit_slip_ticks: orphanExitSlipT,
          duration_sec:  matchedEntry ? Math.round((new Date(trade.creationTimestamp) - new Date(matchedEntry.creationTimestamp)) / 1000) : null,
          gross_pnl:     +pnl.toFixed(2),
          balance_after: state.balance != null ? +state.balance.toFixed(2) : null,
          peak_balance:  state.peakBalance != null ? +state.peakBalance.toFixed(2) : null,
          day_pnl_after: +state.dayPnL.toFixed(2),
          voided:        trade.voided ?? false,
          section_1256:  true,
          note:          orphanSignalId ? "recovered via order lookup" : "recovered after restart — context unavailable",
        });
        // Send win/loss notification for the orphaned trade. Awaited on purpose —
        // the engine process has been observed exiting (crash/restart) immediately
        // after this recovery path runs, which killed the fire-and-forget ntfy POST
        // mid-flight and silently dropped the notification even though the trade
        // was already durably logged above.
        const _mkt = (process.env.MARKET ?? "es").toUpperCase();
        if (pnl > 0) {
          await notify(
            `✅ Winner +$${pnl.toFixed(0)} [recovered]`,
            `[${_mkt}] ${_signalLabel} ${_dir}\nDay P&L: $${state.dayPnL.toFixed(0)}  |  Recovered after restart`,
            "default"
          ).catch(() => {});
        } else {
          await notify(
            `❌ Loss -$${Math.abs(pnl).toFixed(0)} [recovered]`,
            `[${_mkt}] ${_signalLabel} ${_dir}\nDay P&L: $${state.dayPnL.toFixed(0)}  |  Recovered after restart`,
            "default"
          ).catch(() => {});
        }
        continue;
      }

      const dirLabel = isLong === true ? "LONG" : isLong === false ? "SHORT" : "?";
      console.warn(`[Recovery] ♻️  Replaying missed trade ${tid} — P&L $${pnl.toFixed(2)} ${signalId} ${dirLabel}`);

      // dayPnL was already set by the recovery block above (sum of all trades).
      // onTradeEvent will re-add pnl, so subtract it first to avoid double-counting.
      state.dayPnL -= pnl;

      const normalized = {
        id:             tid,
        tradeId:        tid,
        profitAndLoss:  pnl,
        voided:         trade.voided ?? false,
        signalId,
        isLong,
        side:           trade.side,
        contracts:      trade.size ?? trade.contracts,
        exitPrice:      trade.price ?? null,
        entryPrice,
      };
      onTradeEvent(normalized);
    }
    saveSeenTradeIds();
  } catch (e) {
    console.warn("[Recovery] Could not fetch missed trades:", e.message);
  } finally {
    state.reconcileInProgress = false;
  }
}

// ─── Safety: REST position reconciliation ────────────────────────────────────
// Runs every 5 min alongside bar fetch. If SignalR dropped a position-close event
// (brief network hiccup), activeDirections could stay locked forever — this
// catches that by comparing what the engine thinks is open vs what the API says.
async function reconcilePositions() {
  try {
    // Correct endpoint: /api/Position/searchOpen (not /api/Position/search — that doesn't exist)
    const data = await apiPost("/api/Position/searchOpen", { accountId: state.accountId });
    if (!data.success) return;
    const openPositions = (data.positions || []).filter(p => (p.size ?? 0) !== 0);
    // PositionType enum: 0=Undefined, 1=Long, 2=Short
    // Only map known types — exclude Undefined (type=0) to avoid phantom "short" entries
    const openDirs = new Set(
      openPositions
        .map(p => p.type === 1 ? "long" : p.type === 2 ? "short" : null)
        .filter(Boolean)
    );
    // Any direction the engine thinks is active but REST shows no position → stuck gate
    let missedClose = false;
    for (const dir of ["long", "short"]) {
      if (state.activeDirections.has(dir) && !openDirs.has(dir)) {
        state.activeDirections.delete(dir);
        console.warn(`[Gate] ⚠️  Stuck ${dir} gate cleared by REST reconciliation (position already closed)`);
        missedClose = true;
      }
    }
    // If a position was found closed that we didn't know about, recover the P&L
    if (missedClose) reconcileMissedTrades().catch(() => {});

    // Rogue position detection: REST shows a position the engine has NO gate for.
    // This means an orphan order filled and created a phantom position — alert immediately.
    // Root cause: an OCO-paired order was not cancelled when its partner filled (2026-06-12).
    for (const dir of ["long", "short"]) {
      if (openDirs.has(dir) && !state.activeDirections.has(dir)) {
        console.error(`[Gate] 🚨 ROGUE position detected: API shows open ${dir} position but engine has no gate for it!`);
        notify(
          `🚨 Rogue ${dir} position!`,
          `API shows open ${dir} position but engine has no record.\nCheck the platform — this may be an orphan order fill.\nManual intervention may be needed.`,
          "urgent"
        ).catch(() => {});
      }
    }
  } catch { /* non-fatal — skip silently */ }
}

// ─── Post-session P&L reconciliation ─────────────────────────────────────────
// Pulls real account balance from REST after each session close and corrects
// dayPnL. Handles cases where SignalR missed trade close events (WiFi drops, etc.)
async function reconcileDayPnL(label) {
  try {
    const data = await apiPost("/api/Account/search", {});
    if (!data.success) return;
    const acct = data.accounts?.find(a => a.id === state.accountId);
    if (!acct?.balance) return;

    const realBalance = +acct.balance;
    state.balance = realBalance;

    if (state.startOfDayBalance == null) return;
    const realDayPnL = realBalance - state.startOfDayBalance;
    const drift = realDayPnL - state.dayPnL;

    if (Math.abs(drift) > 1) {
      console.log(`[PnL] 🔄 ${label} reconcile — API balance: $${realBalance.toFixed(2)} | Real day P&L: $${realDayPnL.toFixed(2)} | Was: $${state.dayPnL.toFixed(2)} | Drift: $${drift.toFixed(2)}`);
      state.dayPnL = realDayPnL;
      writeSharedState(state.dayPnL);

      // The dollar drift above can come from a trade this engine never processed
      // through onTradeEvent (e.g. closed during a disconnect) — dayWins/dayLosses
      // would then be stale too, showing "Trades: 0" in the EOD summary next to a
      // real non-zero P&L. Recompute both from actual trade history so the count
      // matches the dollars.
      try {
        const todaySessionStart = new Date();
        todaySessionStart.setUTCHours(13, 30, 0, 0);
        const tradeData = await apiPost("/api/Trade/search", {
          accountId: state.accountId,
          startTimestamp: todaySessionStart.toISOString(),
        });
        if (tradeData.success) {
          let w = 0, l = 0;
          for (const t of tradeData.trades ?? tradeData.items ?? []) {
            const p = t.profitAndLoss ?? 0;
            if (p === 0 || t.voided) continue;
            if (p > 0) w++; else l++;
          }
          if (w !== state.dayWins || l !== state.dayLosses) {
            console.log(`[PnL] 🔄 ${label} reconcile — trade counts corrected: ${state.dayWins}W/${state.dayLosses}L → ${w}W/${l}L`);
            state.dayWins = w;
            state.dayLosses = l;
          }
        }
      } catch { /* non-fatal — dollar amount above is already correct either way */ }
    } else {
      console.log(`[PnL] ✓ ${label} reconcile — balance $${realBalance.toFixed(2)} | day P&L $${realDayPnL.toFixed(2)} (in sync)`);
    }

    // If a false halt was set (e.g. double-counted losses after restart), clear it
    if (state.haltedToday && state.dayPnL > -CFG.dailyLossLimit) {
      console.warn(`[PnL] ⚠️  Clearing false halt — reconciled day P&L $${state.dayPnL.toFixed(0)} is above limit -$${CFG.dailyLossLimit}`);
      state.haltedToday = false;
      notify("✅ Halt cleared by reconciliation", `Reconciled P&L: $${state.dayPnL.toFixed(0)}\nAbove daily limit — trading resumed`, "default").catch(() => {});
    }
  } catch { /* non-fatal */ }
}

// ─── Runner watchdog — REST poll ──────────────────────────────────────────────
// Polls account balance every 5s while a position is open. Guarantees the runner
// failsafe fires within ~5s even if GatewayUserAccount events are infrequent.
// Only runs during session hours so it doesn't hammer the API overnight.
async function runnerWatchdog() {
  if (
    state.profitCappedToday ||
    state.runnerClosePending ||
    state.openPositionSize === 0 ||
    !state.openPositionDir ||
    state.startOfDayBalance == null
  ) return;

  try {
    const data = await apiPost("/api/Account/search", {});
    if (!data.success) return;
    const acct = data.accounts?.find(a => a.id === state.accountId);
    if (!acct?.balance) return;
    const bal = +acct.balance;
    // Feed through the same account event handler — dedup flag prevents double-close
    onAccountEvent({ balance: bal });
  } catch { /* non-fatal */ }
}

setInterval(() => {
  const h = new Date().getUTCHours(), m = new Date().getUTCMinutes();
  const hm = h * 100 + m;
  const inSession = (hm >= 1340 && hm < 1505) || (hm >= 1825 && hm < 1905);
  if (inSession) runnerWatchdog().catch(() => {});
}, 5_000);

// ─── Force-close all open positions + cancel brackets ─────────────────────────
// Used by the active watchdog for mismatch corrections and ghost position cleanup.
async function forceCloseAll(reason) {
  if (!state.accountId || !state.contractId) return false;
  if (!state.openPositionDir || state.openPositionSize === 0) return false;

  const closeSide = state.openPositionDir === "long" ? OrderSide.Ask : OrderSide.Bid;
  console.warn(`[Watchdog] 🔴 Force-closing ${state.openPositionDir.toUpperCase()} ${state.openPositionSize}ct — ${reason}`);
  notify(
    `🔴 Watchdog force-closed ${state.openPositionDir.toUpperCase()}`,
    reason,
    "urgent"
  ).catch(() => {});

  // Cancel all known protective orders so we don't end up with orphaned brackets
  for (const [orderId, trade] of state.openTrades.entries()) {
    if (trade.isProtective) {
      apiPost("/api/Order/cancel", { orderId, accountId: state.accountId }).catch(() => {});
    }
  }

  const data = await apiPost("/api/Order/place", {
    accountId:  state.accountId,
    contractId: state.contractId,
    type:       OrderType.Market,
    side:       closeSide,
    size:       state.openPositionSize,
    customTag:  `WATCHDOG_CLOSE_${Date.now()}`,
  });

  if (data.success) {
    console.log(`[Watchdog] ✓ Force close placed orderId=${data.orderId ?? data.id}`);
    return true;
  } else {
    console.error(`[Watchdog] ✗ Force close failed: ${data.errorMessage}`);
    return false;
  }
}

// ─── Active position watchdog (60s) ──────────────────────────────────────────
// Polls every 60s during session hours. Catches three failure modes:
//   1. Direction mismatch  — position opened in wrong direction vs engine intent
//   2. Ghost position      — exchange has an open position the engine doesn't know about
//                            (manual trade, rogue fill, etc.) — closes for safety
//   3. Naked position      — position open with no SL/TP on the book — re-places brackets
//
// After a watchdog-forced close, re-entry is evaluated on the next bar boundary
// via the normal tick/runEvaluate loop, with a slippage guard: won't re-enter if
// price has moved more than 20 ticks from the original entry price.
async function activePositionWatchdog() {
  if (state.watchdogBusy) return;
  if (!state.accountId) return;
  if (state.haltedToday || state.profitCappedToday) return;

  state.watchdogBusy = true;
  try {
    // ── Get actual open position from API ────────────────────────────────────
    const posData = await apiPost("/api/Position/searchOpen", { accountId: state.accountId });
    if (!posData.success) return;
    const openPositions = (posData.positions ?? []).filter(p => (p.size ?? 0) !== 0);

    // Nothing open — reconcilePositions() already handles clearing stuck gates
    if (openPositions.length === 0) return;

    const actualPos    = openPositions[0];
    const actualIsLong = actualPos.type === 1;
    const actualDir    = actualIsLong ? "long" : "short";
    const actualSize   = Math.abs(actualPos.size ?? 0);

    const engineExpectsLong  = state.activeDirections.has("long");
    const engineExpectsShort = state.activeDirections.has("short");
    const engineExpectsFlat  = !engineExpectsLong && !engineExpectsShort;

    // ── 1. Direction mismatch ────────────────────────────────────────────────
    const dirMismatch = (actualDir === "long"  && engineExpectsShort) ||
                        (actualDir === "short" && engineExpectsLong);

    if (dirMismatch) {
      const intendedDir = engineExpectsLong ? "long" : "short";
      console.error(`[Watchdog] 🚨 Direction mismatch — engine wants ${intendedDir.toUpperCase()} but API has ${actualDir.toUpperCase()}`);
      // onPositionEvent already fires the mismatch retry path — if it already handled
      // this, skip to avoid double-close. Only intervene if no pendingRetry queued.
      if (!state.pendingRetry) {
        await forceCloseAll(`Watchdog: intended ${intendedDir.toUpperCase()}, exchange opened ${actualDir.toUpperCase()}`);
        state.watchdogForcedAt = Date.now();
      }
      return;
    }

    // ── 2. Ghost position (untracked manual or rogue fill) ───────────────────
    // Engine is flat (no active directions, no openTrades) but exchange has a position.
    const ghostPosition = engineExpectsFlat && state.openTrades.size === 0 && actualSize > 0;
    if (ghostPosition) {
      console.warn(`[Watchdog] 👻 Ghost position — ${actualDir.toUpperCase()} ${actualSize}ct on exchange, engine is flat`);
      notify(
        `⚠️ Untracked position closed`,
        `${actualDir.toUpperCase()} ${actualSize}ct open on exchange but engine has no record.\nClosing for safety (possible manual trade).`,
        "urgent"
      ).catch(() => {});
      await forceCloseAll(`Watchdog: untracked ${actualDir.toUpperCase()} position`);
      return;
    }

    // ── 3. Naked position — protective orders missing ────────────────────────
    if (!engineExpectsFlat) {
      const closeSide     = actualIsLong ? OrderSide.Ask : OrderSide.Bid;
      const ordData       = await apiPost("/api/Order/searchOpen", { accountId: state.accountId });
      const openOrders    = ordData.orders ?? ordData.items ?? [];
      const hasProtection = openOrders.some(ord =>
        ord.side === closeSide &&
        (ord.type === OrderType.TrailingStop || ord.type === OrderType.Stop || ord.type === OrderType.Limit)
      );

      if (!hasProtection && state.openTrades.size > 0) {
        console.warn(`[Watchdog] ⚠️  Naked position — ${actualDir.toUpperCase()} ${actualSize}ct has no SL/TP`);
        notify(
          `⚠️ Naked position — re-placing brackets`,
          `${actualDir.toUpperCase()} ${actualSize}ct has no protective orders`,
          "urgent"
        ).catch(() => {});
        const persisted = loadPersistedOpenTrade();
        if (persisted?.fillPrice) {
          const entryKey = [...state.openTrades.keys()][0];
          if (entryKey) await placeProtectiveOrders(entryKey, persisted.fillPrice);
        } else {
          console.error(`[Watchdog] Cannot re-place protection — fill price unknown, closing to prevent runaway`);
          await forceCloseAll(`Watchdog: naked position, fill price unknown`);
        }
      }
    }

  } catch (e) {
    console.warn(`[Watchdog] Error: ${e.message}`);
  } finally {
    state.watchdogBusy = false;
  }
}

// 60-second active position watchdog — covers AM and PM windows with buffer
setInterval(() => {
  const hm = new Date().getUTCHours() * 100 + new Date().getUTCMinutes();
  // Widened to cover the Mon/Fri 17:30 PM-open edge-day window too (harmless on other days).
  const inRange = (hm >= 1300 && hm < 1530) || (hm >= 1730 && hm < 2030);
  if (inRange) activePositionWatchdog().catch(() => {});
}, 60_000);

// ─── Strategy evaluation ──────────────────────────────────────────────────────
// ATR-adaptive trail distance for 5m entries. Falls back to fixed CFG.trailTicks
// if ATR can't be computed (not enough bars). Same 150-bar slice as strategies.js
// so the Wilder smoothing has converged.
function adaptiveTrailTicks() {
  if (state.bars.length < 150) return CFG.trailTicks;
  const a = atr(state.bars.slice(-150), 20);
  if (!a || !isFinite(a)) return CFG.trailTicks;
  const ticks = Math.round(CFG.atrTrailMult * a / CFG.tickSize);
  return Math.min(CFG.atrTrailMax, Math.max(CFG.atrTrailMin, ticks));
}

// Returns current ATR(20) in points, or null if not enough bars.
// Used to block entries in low-volatility chop (< CFG.atrMinFilter pts).
function currentATR() {
  if (state.bars.length < 150) return null;
  const a = atr(state.bars.slice(-150), 20);
  return (a && isFinite(a)) ? a : null;
}

function runEvaluate() {
  if (state.bars.length < 210)          { return; }  // strategies need 210 bars for EMA200 warmup
  if (state.haltedToday)                { return; }
  if (state.profitCappedToday)          { return; }  // Topstep consistency cap
  if (Date.now() < state.cooldownUntil) { return; }
  if (isTodayWeekend())                 { return; }  // no regular session on weekends
  if (isTodayHoliday())                 { return; }  // market closed
  if (isNewsBlocked())                  { return; }  // Tier-1 news window

  const now = new Date();
  const hm  = now.getUTCHours() * 100 + now.getUTCMinutes();

  // ── Trend-day filter + gap detection ──────────────────────────────────────
  // Step 1: capture AM session open price (RTH open 13:30 UTC, once per day).
  // Runs BEFORE the inAM session gate so the 13:30 bar (closed and reliable) is
  // captured at the 13:34:50 pre-close tick — avoids the race where the 13:45 bar
  // has just opened (0s old) and the API doesn't return it yet as a partial bar.
  if (hm >= 1330 && hm < 1500 && state.amSessionOpenPrice === null && state.bars.length > 0) {
    const todayAMStart = (() => {
      const d = new Date(); d.setUTCHours(13, 30, 0, 0); return d.getTime() / 1000;
    })();
    const firstAMBar = state.bars.find(b => b.time >= todayAMStart);
    if (firstAMBar) {
      state.amSessionOpenPrice = firstAMBar.open;
      console.log(`[Trend] AM open captured: ${firstAMBar.open} at ${new Date(firstAMBar.time * 1000).toISOString()}`);

      // Gap detection: compare today's AM open to the prior session's last bar close.
      // Gap-up days (>1pt) have 9.9%WR in PM (-$82/tr over 4.5yr) — PM session blocked.
      const lastPriorBar = state.bars.filter(b => b.time < todayAMStart).at(-1);
      if (lastPriorBar) {
        const gap = firstAMBar.open - lastPriorBar.close;
        state.gapUpDay = gap > 1.0;
        const sign = gap >= 0 ? "+" : "";
        if (state.gapUpDay) {
          console.log(`[Gap] ↑ Gap-up day: open ${firstAMBar.open} vs prior close ${lastPriorBar.close.toFixed(2)} = ${sign}${gap.toFixed(2)}pts — PM session BLOCKED`);
          notify("⚠️ Gap-Up Day", `ES gapped up ${sign}${gap.toFixed(2)}pts — PM session blocked today (9.9% WR historically)`, "default").catch(console.error);
        } else {
          console.log(`[Gap] Gap: ${sign}${gap.toFixed(2)}pts — PM normal`);
        }
      }
    }
  }

  // Session gate — signal evaluation only runs during active trading windows.
  // AM session: 13:45–15:00 UTC (skip first 15 min of RTH — OB_FADE handles 13:30 retroactively)
  // PM session: 18:00–20:00 UTC (V5 PM_VWAP_FADE covers full 2-hour window)
  // FOMC days: block non-NQ (directionless/whipsaw); NQ V5 fade signals are exempt —
  //   large FOMC moves are ideal fade setups and 8t stops bound the risk.
  const isNQ = CFG.contractSearch === "NQ";
  // Mon/Fri session widening (walk-forward backtested 2026-10-06): AM close 15:00->15:30,
  // PM open 18:00->17:30. Must mirror nq-strategies.js's amCloseHM()/pmOpenHM() exactly —
  // keep both in sync if this window is ever adjusted again.
  const edgeDay = isTodayScaleEdgeDay();
  const amCloseHM = edgeDay ? 1530 : 1500;
  const pmOpenHM  = edgeDay ? 1730 : 1800;
  const inAM = hm >= 1330 && hm < amCloseHM && (!state.isFOMCDay || isNQ);
  const inPM = hm >= pmOpenHM && hm < 2000 && (!state.isFOMCDay || isNQ) && !isTodayEarlyClose();
  if (!inAM && !inPM) return;

  // Monday PM filter: skip for NQ V5 (backtest included Monday PM sessions; fade edge is session-agnostic)
  if (inPM && !isNQ && now.getUTCDay() === 1) return;
  // Gap-up PM filter: gap-up days have 9.9%WR in PM (-$82/tr, 4.5yr) for ES.
  // NQ exempt: backtest shows same 32% WR on gap-up vs normal PM days (-$4,566/yr drag if applied).
  if (inPM && state.gapUpDay && !isNQ) return;

  const contracts = calcContracts();

  // ATR volatility filter: skip all entries when market is too choppy.
  const curATR = currentATR();
  if (curATR !== null && curATR < CFG.atrMinFilter) {
    const hm2 = new Date().getUTCHours() * 100 + new Date().getUTCMinutes();
    console.log(`[ATR] ${hm2} UTC — ATR(20)=${curATR.toFixed(2)}pts < ${CFG.atrMinFilter}pts threshold — skipping bar`);
    return;
  }

  // Step 2: at 14:15 UTC (45 min after RTH open), evaluate the move and set day flags.
  if (inAM && !state.amTrendChecked && hm >= 1415) {
    state.amTrendChecked = true;
    if (state.amSessionOpenPrice === null) {
      console.log("[Trend] ⚠️  AM open price not captured (late start) — no trend filter applied");
    } else {
      const move = (state.bars.at(-1)?.close ?? state.amSessionOpenPrice) - state.amSessionOpenPrice;
      const sign = move >= 0 ? "+" : "";
      if (move >= CFG.uptrendFilterPts) {
        state.noShortsToday = true;
        const msg = `AM ${sign}${move.toFixed(2)}pts in 45min → shorts suppressed rest of day`;
        console.log(`[Trend] ↑ UPTREND DAY — ${msg}`);
        emitBundleEvent('TREND_FILTER', { dir: 'up', move: +move.toFixed(2) });
        notify("📈 Uptrend Day", msg, "default").catch(console.error);
      } else if (move <= -CFG.downtrendFilterPts) {
        state.noLongsToday = true;
        const msg = `AM ${sign}${move.toFixed(2)}pts in 45min → longs suppressed rest of day`;
        console.log(`[Trend] ↓ DOWNTREND DAY — ${msg}`);
        emitBundleEvent('TREND_FILTER', { dir: 'down', move: +move.toFixed(2) });
        notify("📉 Downtrend Day", msg, "default").catch(console.error);
      } else {
        const msg = `AM ${sign}${move.toFixed(2)}pts in 45min — all signals active`;
        console.log(`[Trend] → NEUTRAL DAY — ${msg}`);
        notify("→ Neutral Day", msg, "default").catch(console.error);
      }
    }
    saveSessionGates(state);
  }

  let signals;
  try {
    const mainSigs = isNQ ? evaluateNQ(state.bars, state.esBars) : evaluate(state.bars);
    const extSigs  = isNQ ? [] : evaluateExtended(state.bars);  // MARKET_STRUCT_S + DAY_BREAK_FAIL_S (ES only)
    signals = [...mainSigs, ...extSigs];
    if (CFG.regimeFilter === "bull") signals = signals.filter(s => s.side === "long");
    else if (CFG.regimeFilter === "bear") signals = signals.filter(s => s.side === "short");
  } catch (err) {
    console.error("[Strategy] Error:", err.message);
    return;
  }

  {
    const hm2 = new Date().getUTCHours() * 100 + new Date().getUTCMinutes();
    if (signals.length === 0) {
      console.log(`[Strategy] ${hm2} UTC — evaluated ${state.bars.length} bars, 0 signals`);
    } else {
      // Log every evaluated signal before any filter — lets us compare against backtest
      for (const s of signals) {
        const _slT = CFG.forceFixedStopTicks != null ? CFG.forceFixedStopTicks : (() => {
          const _slBase = s.side === 'long'
            ? (s.barLow  != null ? s.barLow  - (s.stopTicks ?? CFG.stopTicks) * 0.25 : s.price - (s.stopTicks ?? CFG.stopTicks) * 0.25)
            : (s.barHigh != null ? s.barHigh + (s.stopTicks ?? CFG.stopTicks) * 0.25 : s.price + (s.stopTicks ?? CFG.stopTicks) * 0.25);
          return Math.round(Math.abs(s.price - _slBase) / 0.25);
        })();
        console.log(`[Sig] ${hm2} UTC  ${s.id.padEnd(26)} ${s.side.toUpperCase().padEnd(5)}  px:${s.price.toFixed(2)}  SL:${_slT}t  barLow:${s.barLow?.toFixed(2) ?? '?'}`);
      }
    }
  }

  const _stopCooldownMs = 15 * 60 * 1000;
  const _now = Date.now();

  for (const sig of signals) {
    // Paused strategy gate — skip any signal whose id starts with a paused prefix
    if (CFG.pausedStrategies.some(p => sig.id.startsWith(p))) continue;

    // Per-signal stop cooldown: 15 min after a stop loss, same signal can't re-fire.
    // Prevents double-entry on choppy bars where the signal fires again within minutes.
    const _lastStop = state.lastStopTimes.get(sig.id);
    if (_lastStop && _now - _lastStop < _stopCooldownMs) {
      const _rem = Math.ceil((_stopCooldownMs - (_now - _lastStop)) / 60000);
      console.log(`[Cooldown] ${sig.id} skipped — ${_rem}min remaining in post-stop cooldown`);
      continue;
    }

    // Forward-test gate — log the signal but do NOT place an order.
    // Once ~3mo of live signal data confirms the edge, move to ACTIVE.
    if (CFG.forwardTestStrategies.has(sig.id)) {
      const tpT = sig.tpTicks ?? CFG.tpTicks;
      const stopPx = sig.barLow != null ? (sig.barLow - CFG.stopTicks * 0.25).toFixed(2) : '?';
      const tpPx = (sig.price + tpT * 0.25).toFixed(2);
      console.log(`[FWD] 📋 ${sig.id} would fire | price $${sig.price.toFixed(2)} → stop $${stopPx} | TP $${tpPx} (${tpT}t) | ORB range ${sig.orbHigh ?? '?'}/${sig.orbLow ?? '?'} | NO ORDER`);
      continue;
    }

    // Pre-filter: all strategies allowed from 13:45 (relaxed 2026-07-30).
    // Trend direction gate at 14:15 still protects counter-trend signals.

    const dir = sig.side === "long" ? "long" : "short";  // strategies.js always uses sig.side
    // Trend-day direction filter — AM only. PM accuracy tested at 46-51% (coin flip),
    // so suppression is disabled in PM to avoid blocking profitable counter-trend signals.
    if (inAM && state.noShortsToday && dir === "short" && !sig.ignoreTrendFilter) continue;
    // noLongsToday gate: bypass once if the first long already won (momentum confirmation)
    if (inAM && state.noLongsToday && dir === "long" && !sig.ignoreTrendFilter) {
      if (state.sessionLongWon && state.sessionLongCount < 2) {
        console.log(`[Gate] 🟢 noLongsToday bypassed — first long won, allowing 2nd (${sig.id})`);
      } else {
        continue;
      }
    }

    // Overbought persistence gate: when ≥ 8 of last 10 days closed up, trending
    // strategies have 13% WR (-$63/tr avg across 4.5yr backtest) — suppress them.
    if (state.upPctOverbought && CFG.overboughtSuppressSet.has(sig.id)) {
      console.log(`[Gate] 📉 upPctOverbought — trending strat blocked (${sig.id})`);
      continue;
    }

    // Early-AM tighter short gate (14:15–14:30 UTC, first 15 min after trend check).
    // Standard threshold is 10pts but borderline uptrend days (5-9pts) still crush shorts
    // in the opening 15 min. Apply a tighter 5pt gate in this window only.
    if (inAM && dir === "short" && hm >= 1415 && hm < 1430 && state.amSessionOpenPrice !== null) {
      const earlyMove = (state.bars.at(-1)?.close ?? state.amSessionOpenPrice) - state.amSessionOpenPrice;
      if (earlyMove >= CFG.earlyAMUptrendPts) {
        console.log(`[Trend] ↑ Early-AM short blocked — move +${earlyMove.toFixed(2)}pts >= ${CFG.earlyAMUptrendPts}pt early gate (${sig.id})`);
        continue;
      }
    }
    if (state.activeDirections.has(dir)) {
      const blocker = [...state.openTrades.values()].find(t => !t.isProtective && t.isLong === (dir === "long"));
      logBlockedSignal(sig, dir, blocker?.signalId ?? "unknown");
      continue;  // direction gate (same direction already open)
    }

    // No simultaneous long+short — found 2026-10-07 via a friend's bot logs: the
    // exchange nets opposite-direction positions on the same contract instead of
    // holding both, so a "hedge" here silently loses one signal's fill entirely
    // and can misattribute the other's P&L to the wrong signal ID on recovery.
    // The 15m path (below) already had this right; the 5m path didn't.
    const oppositeDir5m = dir === "long" ? "short" : "long";
    if (state.activeDirections.has(oppositeDir5m)) {
      console.log(`[Gate] Skipping ${sig.id} ${dir.toUpperCase()} — ${oppositeDir5m} already active (opposing gate)`);
      continue;
    }

    // Claim direction before async placeEntry to prevent double entry
    state.activeDirections.add(dir);
    if (dir === "long") state.sessionLongCount++;
    const sizedContracts = riskCappedContracts(contracts, estimateStopTicks(sig, dir === "long"));
    const entryTradeOpts = {
      stopTicks: sig.stopTicks ?? CFG.stopTicks,  // per-strategy stop override
      tpTicks:   sig.tpTicks   ?? CFG.tpTicks,   // per-strategy TP override from strategies.js
      stopType:  "fixed",
      barHigh:   sig.barHigh,
      barLow:    sig.barLow,
      sigPrice:  sig.price,
      // Opt-out of FORCE_FIXED_STOP_TICKS for this one signal (default: respect the
      // global override, unchanged for every current strategy). Added 2026-10-12 --
      // the override was silently stomping the deliberately-tight stop on 4 new
      // signal families with no way to exempt them; this makes that explicit instead
      // of implicit the next time a signal needs its own stop distance.
      useOwnStop: sig.useOwnStop === true,
    };
    placeEntry(sig.id, dir === "long", sizedContracts, entryTradeOpts).then(result => {
      // placeEntry returns null when skipped (e.g. stop too wide) — release gate immediately
      if (result === null) state.activeDirections.delete(dir);
    }).catch(err => {
      console.error("[Order] Error:", err.message);
      state.activeDirections.delete(dir);  // release on failure
    });
  }
}

// ─── 15m Strategy Evaluation ─────────────────────────────────────────────────
// Runs after each completed 15m bar (:00, :15, :30, :45 UTC).
// Same risk guards as 5m. Shared direction gate prevents double-exposure.
// Only EMAPB and KELT — the two strategies that backtest positively on 15m.
function runEvaluate15() {
  if (state.bars15.length < CFG15m.minBars)  { return; }
  if (state.haltedToday)                     { return; }
  if (state.profitCappedToday)               { return; }
  if (Date.now() < state.cooldownUntil)      { return; }
  if (isTodayWeekend())                      { return; }  // no regular session on weekends
  if (isTodayHoliday())                      { return; }
  if (isNewsBlocked())                       { return; }

  const now = new Date();
  const hm  = now.getUTCHours() * 100 + now.getUTCMinutes();
  const isNQ = CFG.contractSearch === "NQ";  // was referenced below without being defined in this scope — ReferenceError on every FOMC day

  const inAM = hm >= 1330 && hm < 1500 && (!state.isFOMCDay || isNQ);
  const inPM = hm >= 1800 && hm < 2000 && (!state.isFOMCDay || isNQ) && !isTodayEarlyClose();
  if (!inAM && !inPM) return;

  // Monday PM filter (mirrors 5m path)
  if (inPM && now.getUTCDay() === 1) return;
  // Gap-up PM filter (mirrors 5m path)
  if (inPM && state.gapUpDay) return;

  const contracts = calcContracts();

  // ATR filter on 5m bars (same source as 5m path — ATR is a market-state check, not timeframe-specific)
  const curATR15 = currentATR();
  if (curATR15 !== null && curATR15 < CFG.atrMinFilter) {
    console.log(`[ATR15] ${hm} UTC — ATR(20)=${curATR15.toFixed(2)}pts < ${CFG.atrMinFilter}pts — skipping 15m bar`);
    return;
  }

  let signals;
  try {
    signals = evaluate(state.bars15);
  } catch (err) {
    console.error("[Strategy15] Error:", err.message);
    return;
  }

  const eligible = (signals ?? []).filter(sig => {
    const root = sig.id.replace(/_[LS]$/, "");
    if (!CFG15m.allowedStrategies.has(root)) return false;
    if (CFG.pausedStrategies.some(p => sig.id.startsWith(p))) return false;
    const dir = sig.side === "long" ? "long" : "short";
    if (inAM && state.noShortsToday && dir === "short" && !sig.ignoreTrendFilter) return false;
    if (inAM && state.noLongsToday && dir === "long" && !sig.ignoreTrendFilter) {
      if (state.sessionLongWon && state.sessionLongCount < 2) return true;  // bypass: first long won
      return false;
    }
    if (state.upPctOverbought && CFG.overboughtSuppressSet.has(sig.id)) return false;
    return true;
  });

  if (eligible.length === 0) {
    console.log(`[Strategy15] ${hm} UTC — evaluated ${state.bars15.length} bars, 0 signals`);
    return;
  }

  for (const sig of eligible) {
    const dir = sig.side === "long" ? "long" : "short";
    if (state.activeDirections.has(dir)) {
      console.log(`[Strategy15] ${sig.id} blocked — ${dir} gate held (5m or 15m trade open)`);
      continue;
    }
    const oppositeDir15 = dir === "long" ? "short" : "long";
    if (state.activeDirections.has(oppositeDir15)) {
      console.log(`[Strategy15] Skipping ${sig.id} ${dir.toUpperCase()} — ${oppositeDir15} already active (opposing gate)`);
      continue;
    }
    // Claim gate before async to prevent race with 5m tick
    state.activeDirections.add(dir);
    if (dir === "long") state.sessionLongCount++;
    const sizedContracts = riskCappedContracts(contracts, CFG15m.stopTicks);
    placeEntry(sig.id, dir === "long", sizedContracts, {
      stopTicks: CFG15m.stopTicks,
      tpTicks:   sig.tpTicks ?? CFG15m.tpTicks,   // per-strategy TP override from strategies.js
      stopType:  CFG15m.stopType,
      tf:        "15m",
    }).then(result => {
      if (result === null) state.activeDirections.delete(dir);
    }).catch(err => {
      console.error("[Order] 15m entry error:", err.message);
      state.activeDirections.delete(dir);
    });
  }
}

// ─── Pre-session brief ────────────────────────────────────────────────────────
async function preSessionBrief() {
  // ── Engine health check — verify actual engine state, not process count ──
  // pgrep from inside Node.js on macOS can't see sibling processes (only children),
  // so it always returns 0 and triggers false alerts. Check real state instead.
  let engineHealthLine = "✅ running";
  {
    const hubOk   = state.hub?.state === HubConnectionState.Connected;
    const acctOk  = !!state.accountId;
    const barsOk  = state.bars?.length >= 10;
    const healthy = hubOk && acctOk && barsOk;
    if (!healthy) {
      const reasons = [
        !hubOk  && "SignalR disconnected",
        !acctOk && "account not loaded",
        !barsOk && `bars thin (${state.bars?.length ?? 0})`,
      ].filter(Boolean).join(", ");
      engineHealthLine = `🚨 ${reasons} — restart needed`;
      const msg = [
        `🚨 Engine unhealthy at session open`,
        reasons,
        `Fix: pm2 restart topstepx-all`,
      ].join("\n");
      await notify("🚨 ENGINE HEALTH ALERT", msg, "urgent");
      console.error(`[Health] ❌ ALERT SENT — ${reasons}`);
    } else {
      console.log(`[Health] ✅ hub connected, account loaded, ${state.bars.length} bars — clean`);
    }
  }

  const range  = calcOvernightRange();
  const { contracts, regimeLabel, streakLabel, regimeMult, streakMult } = calcContractsVerbose();
  const dayPnL = state.dayPnL;

  // CFG.maxContracts is only a real ceiling on the Layer 0/0a cushion-ladder paths —
  // once the funded-scale-table is active it's unused by calcContracts() and showing
  // it here is just stale/misleading (e.g. "3 / 1 max" reads like a hard cap that
  // isn't actually in effect). Show the real effective ceiling instead.
  const displayMaxContracts = CFG.fundedScaleTiers.length > 0 ? trueAccountMaxContracts() : CFG.maxContracts;

  // Volume snapshot — same 20-bar SMA the BB_SQUEEZE / DONCHIAN gates use
  const volAvg20 = volumeSMA(state.bars, 20);
  const lastVol  = state.bars.at(-1)?.volume ?? null;
  const volPct   = (volAvg20 && lastVol != null) ? Math.round((lastVol / volAvg20) * 100) : null;
  const volLine  = volPct != null
    ? `Vol (last 5m bar)   : ${lastVol.toLocaleString()} vs avg ${Math.round(volAvg20).toLocaleString()} — ${volPct}% ${volPct >= 120 ? "✅ gate open" : volPct >= 80 ? "⚠️  borderline" : "🔇 quiet — signals unlikely"}`
    : `Vol (last 5m bar)   : N/A (not enough bars yet)`;

  const accountMode = state.simulated
    ? (() => {
        const profit = state.balance != null ? Math.max(0, state.balance - CFG.accountBase) : null;
        const needed = profit != null ? Math.max(0, CFG.combineTarget - profit) : null;
        return needed != null
          ? (needed <= 0 ? `Account mode        : 🎯 COMBINE PASSED — check Topstep dashboard` : `Account mode        : Combine  $${profit.toFixed(0)} / $${CFG.combineTarget.toFixed(2)}  ($${needed.toFixed(2)} to go)`)
          : `Account mode        : Combine`;
      })()
    : `Account mode        : ⭐ FUNDED  |  Daily profit cap: ${Number.isFinite(CFG.dailyProfitCap) ? `$${CFG.dailyProfitCap}` : "none"}  |  Max: ${displayMaxContracts}ct`;

  const lines = [
    ``,
    `━━━ PRE-SESSION BRIEF ${new Date().toUTCString()} ━━━`,
    accountMode,
    `${CFG.contractSearch} Overnight Range  : ${range != null ? range.toFixed(2) + " pts" : "N/A"}`,
    `Regime filter       : ${regimeLabel.padEnd(12)} (${(regimeMult * 100).toFixed(0)}%)`,
    `Streak filter       : ${streakLabel.padEnd(20)} (${(streakMult * 100).toFixed(0)}%)`,
    `Contracts today     : ${contracts} / ${displayMaxContracts} max`,
    `Day P&L             : ${dayPnL >= 0 ? "+" : ""}$${dayPnL.toFixed(2)}`,
    `Consec. wins        : ${state.consecutiveWins} | Consec. losses: ${state.consecutiveLosses}`,
    `Peak balance        : ${state.peakBalance != null ? "$" + state.peakBalance.toFixed(2) : "N/A"}`,
    `Trail DD limit      : $${CFG.trailDD.toFixed(0)} EOD-trail (warning at -$${CFG.trailDDWarn})`,
    `Daily loss limit    : $${CFG.dailyLossLimit} | Halted: ${state.haltedToday}`,
    CFG.contractSearch === "NQ"
      ? (() => {
          const disabled = new Set(buildUserDisabledStrategies());
          const nqEnabledCount = ACTIVE_STRATEGIES.filter(s => s.startsWith("NQ_") && !disabled.has(s)).length;
          return `5m strategies (V5)  : NQ mode — ${nqEnabledCount} active signals, fixed 6t stop, 20-84t TP per-strategy`;
        })()
      : `5m strategies (V3)  : DONCH15_L(15s/72t) VOLBO_L(6s/12t) VOLBO_S(6s/12t) EMA21_PULL_L(6s/16t) BO10_S(8s/24t) 3BAR_BEAR_S(10s/64t) KELT_L(15s/48t)`,
    CFG.contractSearch === "NQ"
      ? `15m strategies      : none (NQ — V3 5m only)`
      : `15m strategies      : none (V3 quant rebuild — 5m only, evaluateExtended returns [])`,
    (() => {
      const userDisabled = buildUserDisabledStrategies();
      return userDisabled.length === 0
        ? `Paused strategies   : none (all 7 V3 signals active)`
        : `Paused strategies   : ⚠️  ${userDisabled.join(", ")} (disabled by user config)`;
    })(),
    `AM session          : ${state.isFOMCDay ? (CFG.contractSearch === "NQ" ? "⚠️  FOMC day — NQ fade signals ACTIVE (others blocked)" : "⛔ DISABLED (FOMC day)") : `${isDST() ? "7:30–9:00 MDT" : "6:30–8:00 MST"} (13:30-15:00 UTC)`}`,
    `PM session          : ${state.isFOMCDay ? "⛔ DISABLED (FOMC day)" : isTodayEarlyClose() ? "⛔ DISABLED (early close)" : `${isDST() ? "12:00–2:00 PM MDT" : "11:00 AM–1:00 PM MST"} (18:00-20:00 UTC)`}`,
    `Trend filter        : ${state.noShortsToday ? "📈 UPTREND — shorts suppressed" : state.noLongsToday ? "📉 DOWNTREND — longs suppressed" : state.amTrendChecked ? "→ Neutral — all signals active" : "⏳ Pending (fires at 14:15 UTC)"}`,
    `Overbought gate     : ${state.upPctOverbought ? "🔴 ACTIVE — trending strats suppressed (8+/10 days up)" : "✅ Off"}`,
    `News blocks today   : ${(state._newsBlocks?.length || 0)} Tier-1 event(s)`,
    volLine,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
  ];
  console.log(lines.join("\n"));

  const balance    = state.balance     ?? state.peakBalance ?? null;
  const peak       = state.peakBalance ?? balance;  // informational display only — true intraday high
  // Floor/buffer math uses the EOD-locked peak (see note at the eodPeakBalance
  // persistence functions above) — TopstepX's real trailing-DD floor only
  // advances on end-of-day closes, not intraday highs.
  const floorPeakBrief = state.eodPeakBalance ?? peak;
  const ddUsed     = floorPeakBrief != null && balance != null ? Math.max(0, floorPeakBrief - balance) : null;
  // Distance to the REAL floor, not "trailDD minus drawdown-from-raw-peak" — those
  // diverge once the trailing DD locks (peak reaches accountBase and stops moving
  // the floor further), where continuing to measure against the ever-rising raw
  // peak would understate how much actual room remains above the frozen floor.
  const ddBuffer   = (balance != null && floorPeakBrief != null)
    ? Math.max(0, balance - (Math.min(floorPeakBrief, CFG.accountBase) - CFG.trailDD))
    : null;
  const profitSoFar = balance != null ? Math.max(0, balance - CFG.accountBase) : null;

  const bundlePayload = {
    contracts,
    regime:       regimeLabel,
    streak:       streakLabel,
    newsBlocks:   state._newsBlocks?.length || 0,
    isFOMC:       !!state.isFOMCDay,
    simulated:    !!state.simulated,
    balance:      balance != null ? +balance.toFixed(2) : null,
    peakBalance:  peak    != null ? +peak.toFixed(2)    : null,
    ddBuffer:     ddBuffer != null ? +ddBuffer.toFixed(0) : null,
    profitSoFar:  profitSoFar != null ? +profitSoFar.toFixed(2) : null,
    combineTarget: CFG.combineTarget,
    dailyLossLimit: CFG.dailyLossLimit,
    dailyProfitCap: CFG.dailyProfitCap,
    prevDayPnL:   state.prevDayPnL ?? null,
    overnightRange: range != null ? +range.toFixed(2) : null,
    trendStatus:  state.noShortsToday ? 'UPTREND' : state.noLongsToday ? 'DOWNTREND' : state.amTrendChecked ? 'NEUTRAL' : 'PENDING',
    consecutiveWins:   state.consecutiveWins,
    consecutiveLosses: state.consecutiveLosses,
    maxContracts: CFG.maxContracts,
    tz: isDST() ? "MDT" : "MST",
    volPct: volPct,
    haltedToday: !!state.haltedToday,
    trailDD: CFG.trailDD,
    upPctOverbought: !!state.upPctOverbought,
  };
  emitBundleEvent('PRESESSION_BRIEF', bundlePayload);

  // Single-account phone notification — suppressed under the multi-account
  // orchestrator, which sends its own combined PRESESSION_BRIEF (see
  // bundlePayload above) covering all accounts in one condensed push instead
  // of one full-text dump per account.
  if (!HAS_BUNDLE_CONSUMER) {
    const briefMsg = [
      `Engine: ${engineHealthLine}  |  ${contracts}ct  |  News: ${state._newsBlocks?.length || 0}  |  FOMC: ${state.isFOMCDay ? "YES ⚠️" : "No"}`,
      balance != null ? `Balance: $${balance.toFixed(0)}${ddBuffer != null ? `  |  DD buffer: $${ddBuffer}` : ""}` : null,
      state.simulated && profitSoFar != null
        ? `Combine: $${profitSoFar.toFixed(0)} / $${CFG.combineTarget.toFixed(0)}  ($${Math.max(0, CFG.combineTarget - profitSoFar).toFixed(0)} to go)`
        : null,
      `Trend: ${bundlePayload.trendStatus}  |  ${regimeLabel}`,
      volPct != null ? `Vol: ${volPct}% of avg ${volPct >= 120 ? "✅" : volPct >= 80 ? "⚠️" : "🔇"}` : null,
      `AM ${isDST() ? "7:30 MDT" : "6:30 MST"}  |  PM ${isDST() ? "12:00–2:00 PM MDT" : "11:00 AM–1:00 PM MST"}`,
    ].filter(Boolean).join("\n");
    await notify("📊 Pre-session brief", briefMsg, "default");
  }
}

// ─── End-of-day summary ───────────────────────────────────────────────────────
async function endOfDaySummary() {
  const totalTrades = state.dayWins + state.dayLosses;
  const wr          = totalTrades > 0 ? ((state.dayWins / totalTrades) * 100).toFixed(0) : "—";
  const pnlStr      = state.dayPnL >= 0
    ? `+$${state.dayPnL.toFixed(0)}`
    : `-$${Math.abs(state.dayPnL).toFixed(0)}`;

  // Current balance from last account event; peak is the high watermark (display only)
  const bal         = state.balance     ?? state.peakBalance;
  const peak        = state.peakBalance ?? bal;
  const balStr      = bal  != null ? `$${bal.toFixed(0)}`  : "—";
  const peakStr     = peak != null ? `$${peak.toFixed(0)}` : "—";

  // Trailing DD: Topstep rule — balance must stay above (peak − trailDD), except
  // the floor locks at (accountBase − trailDD) once peak first reaches accountBase
  // and never trails further after that — ddBuffer measures distance to the real
  // (possibly locked) floor, not a naive trailDD-minus-drawdown-from-raw-peak.
  // Uses eodPeakBalance, not the raw intraday peak — see note at its persistence
  // functions above (TopstepX's real floor only advances at end-of-day).
  const floorPeakEod = state.eodPeakBalance ?? peak;
  const ddUsed      = floorPeakEod != null && bal != null ? floorPeakEod - bal : null;
  const ddBuffer    = (bal != null && floorPeakEod != null)
    ? Math.max(0, bal - (Math.min(floorPeakEod, CFG.accountBase) - CFG.trailDD))
    : null;
  const ddLine      = ddBuffer != null
    ? `DD used: $${ddUsed.toFixed(0)} / $${CFG.trailDD.toFixed(0)}  (${ddBuffer.toFixed(0)} remaining)`
    : "";

  // Progress line — combine shows target; funded shows total earned on funded account
  const profitSoFar  = bal != null ? Math.max(0, bal - CFG.accountBase) : null;
  const progressLine = profitSoFar != null
    ? (state.simulated
        ? (() => {
            const stillNeeded = Math.max(0, CFG.combineTarget - profitSoFar);
            return stillNeeded <= 0
              ? "🎯 Combine target reached! — check Topstep dashboard"
              : `Combine: $${profitSoFar.toFixed(0)} / $${CFG.combineTarget.toFixed(2)}  ($${stillNeeded.toFixed(2)} to go)`;
          })()
        : `⭐ Funded — total earned: $${profitSoFar.toFixed(0)}`)
    : "";

  let statusLine = "✅ Clean day";
  if (state.haltedToday)            statusLine = "🛑 Halted (daily loss limit hit)";
  else if (state.profitCappedToday) statusLine = state.simulated ? "🏆 Capped (consistency rule)" : "🏆 Great funded day — capped";
  else if (totalTrades === 0)       statusLine = "⬜ No trades today";

  const body = [
    `Trades : ${totalTrades}  (${state.dayWins}W / ${state.dayLosses}L${totalTrades > 0 ? `  ${wr}% WR` : ""})`,
    `Day P&L: ${pnlStr}`,
    `Balance: ${balStr}  (peak: ${peakStr})`,
    ddLine,
    progressLine,
    statusLine,
    `Closed ${mtTimeStr()}`,
  ].filter(Boolean).join("\n");

  console.log(`[EOD] ${body.replace(/\n/g, " | ")}`);
  emitBundleEvent('EOD_SUMMARY', { pnl: +state.dayPnL.toFixed(2), wins: state.dayWins, losses: state.dayLosses, simulated: !!state.simulated, balance: state.balance ?? state.peakBalance ?? null });
  await notify("📈 End of day", body, "default");
}

// ─── Weekly recap ─────────────────────────────────────────────────────────────
async function weeklyRecap() {
  // Read trade log and filter last 7 days
  let trades = [];
  try {
    if (existsSync(TRADE_LOG)) {
      trades = readFileSync(TRADE_LOG, "utf8")
        .split("\n").filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    }
  } catch (e) {
    console.warn("[Weekly] Could not read trade log:", e.message);
  }

  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const week   = trades.filter(t => t.date >= cutoff && !t.voided);

  const wins    = week.filter(t => t.gross_pnl > 0);
  const losses  = week.filter(t => t.gross_pnl < 0);
  const netPnl  = week.reduce((s, t) => s + t.gross_pnl, 0);
  const wr      = week.length ? ((wins.length / week.length) * 100).toFixed(0) : "—";

  // Strategy breakdown
  const byStrat = {};
  for (const t of week) {
    const root = (t.signal ?? "unknown").replace(/_[LS]$/, "");
    if (!byStrat[root]) byStrat[root] = { trades: 0, wins: 0, pnl: 0 };
    byStrat[root].trades++;
    byStrat[root].pnl += t.gross_pnl;
    if (t.gross_pnl > 0) byStrat[root].wins++;
  }
  const stratLines = Object.entries(byStrat)
    .sort(([, a], [, b]) => b.pnl - a.pnl)
    .map(([id, s]) => `  ${id}: ${s.trades}t ${(s.wins/s.trades*100).toFixed(0)}%WR ${s.pnl >= 0 ? "+" : ""}$${s.pnl.toFixed(0)}`)
    .join("\n");

  // Exit slippage + near-miss/close-call stats — same data sources used for the
  // Friday deep-dive review, folded into the standing weekly push (2026-10-11)
  // so every account gets this without anyone needing to ask for it separately.
  const slipVals = week.map(t => t.exit_slip_ticks).filter(v => v != null);
  const avgSlip  = slipVals.length ? (slipVals.reduce((a, b) => a + b, 0) / slipVals.length).toFixed(2) : null;
  const slipLine = avgSlip != null ? `Avg exit slip: ${avgSlip}t (${slipVals.length} trades)` : null;

  let closeCallLine = null;
  try {
    if (existsSync(SL_REVIEW_LOG)) {
      const reviews = readFileSync(SL_REVIEW_LOG, "utf8")
        .split("\n").filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(r => r && r.resolvedAt && r.resolvedAt.slice(0, 10) >= cutoff);
      if (reviews.length) {
        const closeCalls = reviews.filter(r => r.closeCall).length;
        closeCallLine = `Close calls: ${closeCalls}/${reviews.length} (${(closeCalls / reviews.length * 100).toFixed(0)}%) — stops that just barely missed a reversal to TP`;
      }
    }
  } catch (e) {
    console.warn("[Weekly] Could not read SL review log:", e.message);
  }

  const bal     = state.balance     != null ? `$${state.balance.toFixed(0)}`     : "—";
  const peak    = state.peakBalance != null ? `$${state.peakBalance.toFixed(0)}` : "—";
  const targetLine = state.balance != null
    ? (state.simulated
        ? (() => {
            const toTarget = Math.max(0, CFG.combineBalance - state.balance);
            return toTarget <= 0
              ? "🎯 Combine target reached! — check Topstep dashboard"
              : `$${toTarget.toFixed(2)} to combine target ($${CFG.combineBalance.toFixed(2)})`;
          })()
        : `⭐ Funded account — total earned: $${Math.max(0, state.balance - CFG.accountBase).toFixed(0)}`)
    : "";

  const body = [
    `Week: ${week.length} trades  (${wins.length}W / ${losses.length}L  ${wr}% WR)`,
    `Net P&L: ${netPnl >= 0 ? "+" : ""}$${netPnl.toFixed(0)}`,
    `Balance: ${bal}  |  Peak: ${peak}`,
    slipLine,
    closeCallLine,
    targetLine,
    week.length ? `\nBy strategy:\n${stratLines}` : "",
  ].filter(Boolean).join("\n");

  console.log(`[Weekly] ${body.replace(/\n/g, " | ")}`);

  // Save weekly summary to log
  logWeeklySummary({
    week_ending:   new Date().toISOString().slice(0, 10),
    trades:        week.length,
    wins:          wins.length,
    losses:        losses.length,
    wr_pct:        week.length ? +(wins.length / week.length * 100).toFixed(1) : null,
    net_pnl:       +netPnl.toFixed(2),
    balance:       state.balance     ?? null,
    peak_balance:  state.peakBalance ?? null,
    avg_exit_slip_ticks: avgSlip != null ? +avgSlip : null,
    by_strategy:   byStrat,
  });

  emitBundleEvent('WEEKLY_SUMMARY', { pnl: +netPnl.toFixed(2), wins: wins.length, losses: losses.length, trades: week.length, simulated: !!state.simulated });
  await notify("📅 Weekly recap", body, "default");
}

// ─── Minute tick loop ─────────────────────────────────────────────────────────
let lastBar5Min  = -1;   // tracks the 5-min bucket last evaluated (multiples of 5)
let lastBar15Min = -1;
let lastHealthCheckMin = -1;  // tracks the 10-min bucket last checked

async function tick() {
  const now = new Date();
  const hm  = now.getUTCHours() * 100 + now.getUTCMinutes();
  const min = now.getUTCMinutes();
  const sec = now.getUTCSeconds();

  // ── 5m evaluation — confirmed closed bar only ────────────────────────────
  // Evaluates on the final settled bar (includePartialBar=false) so signal
  // conditions match the backtest exactly. Pre-close partial evaluation removed
  // 2026-09-18 — it caused 2-4 tick close differences vs settled bars, making
  // live signals diverge from backtest predictions.
  const bar5Bucket = min - (min % 5); // 0,5,10,...55

  // Fire in first 10 seconds after each 5m boundary (e.g. 13:50:00–13:50:09).
  if (min % 5 === 0 && sec <= 10 && bar5Bucket !== lastBar5Min) {
    lastBar5Min = bar5Bucket;
    // Fetch NQ bars and evaluate/place orders FIRST — reconcilePositions() and
    // fetchESBars() are not inputs to NQ signal evaluation, but used to block
    // ahead of it anyway, adding a full extra sequential REST round-trip
    // between "bar closed" and "order placed." That gap is exactly where price
    // drifts away from the price the signal was based on — measured at an
    // average of ~4 ticks of adverse entry slippage across this week's real
    // fills, enough to meaningfully shrink the real stop distance on a 10t
    // stop. Neither call needs to happen before evaluation, so they're deferred
    // to run after the order is already in, instead of in front of it.
    await fetchBars(300, false, 96).catch(console.error);  // 96h spans Mon AM weekend gap
    runEvaluate();
    if (state.bars.length > 0) checkSlPostMortems(state.bars);
    reconcilePositions().catch(console.error);
    fetchESBars().catch(console.error);
  }

  // ── Post-boot re-evaluate: fires once if a trade closed while engine was down ──
  // Gives the signal a chance to re-enter immediately rather than waiting up to 5 min.
  if (_reEvaluateAfterBoot) {
    _reEvaluateAfterBoot = false;
    console.log("[Boot] 🔁 Post-recovery re-evaluate — checking if signal still valid");
    await Promise.all([fetchBars(300, false), fetchESBars()]).catch(console.error);
    runEvaluate();
    runEvaluate15();
  }

  // ── 15m boundary: refresh 15m bars, evaluate 15m signals ─────────────────
  // 15m bars close at :00, :15, :30, :45 — evaluate right after
  if (min % 15 === 0 && min !== lastBar15Min) {
    lastBar15Min = min;
    await fetchBars15(300).catch(console.error);
    runEvaluate15();
  }

  // Early connectivity check: 13:10 UTC (20 min before AM open, 15 min before
  // the pre-session brief). Catches a dead/stale SignalR hub with enough lead
  // time to force a reconnect and confirm it before trading starts — instead
  // of discovering it in the 13:25 brief with only 5 minutes of buffer.
  if (hm === 1310 && sec < 10 && !state.earlyHealthCheckDone && !isTodayWeekend() && !isTodayHoliday()) {
    state.earlyHealthCheckDone = true;
    const hubOk = state.hub?.state === HubConnectionState.Connected;
    if (state.hubReconnecting) {
      console.log("[Health] ⏭️  Early check (13:10 UTC) — reconnect already in progress via onclose, skipping");
    } else if (!hubOk) {
      console.warn(`[Health] ⚠️  Early check (13:10 UTC) — hub not connected (state=${state.hub?.state}). Forcing reconnect...`);
      await notify("⚠️ Pre-open reconnect", "Hub was down at 13:10 check — forcing reconnect now, 20 min before open.", "high").catch(() => {});
      state.hubReconnecting = true;
      try {
        await stopHubSafely();
        await connectHub();
        const fixed = state.hub?.state === HubConnectionState.Connected;
        console.log(fixed ? "[Health] ✅ Early reconnect successful" : "[Health] ❌ Early reconnect still not connected — will retry via normal reconnect logic");
        await notify(
          fixed ? "✅ Reconnected before open" : "🚨 Still disconnected — check before 13:30",
          fixed ? "Hub reconnected with 20 min to spare." : "Reconnect attempt failed. Manual check needed before AM open.",
          fixed ? "default" : "urgent"
        ).catch(() => {});
      } catch (e) {
        console.error(`[Health] ❌ Early reconnect threw: ${e.message}`);
        await notify("🚨 Reconnect failed before open", `${e.message}\nManual check needed before 13:30 UTC.`, "urgent").catch(() => {});
      } finally {
        state.hubReconnecting = false;
      }
    } else {
      console.log("[Health] ✅ Early check (13:10 UTC) — hub connected, 20 min to open");
    }
  }

  // Periodic hub health check — every 10 min, all day. The 13:10 check above only
  // runs once before the AM open; a GatewayLogout kick (both live accounts share
  // one TopstepX login, so any fresh login on either one can boot the other's hub
  // session — confirmed empirically in the logs, not a bug in our own code) can
  // happen at any time of day. Without this, a kicked hub could sit silently dead
  // for hours with zero real-time order/position/account events until the next
  // day's 13:10 check. Quiet unless it actually finds and fixes a problem.
  if (min % 10 === 0 && sec < 10 && min !== lastHealthCheckMin) {
    lastHealthCheckMin = min;
    const hubOk = state.hub?.state === HubConnectionState.Connected;
    if (state.hubReconnecting) {
      console.log(`[Health] ⏭️  Periodic check (${hm} UTC) — reconnect already in progress via onclose, skipping`);
    } else if (!hubOk) {
      console.warn(`[Health] ⚠️  Periodic check (${hm} UTC) — hub not connected (state=${state.hub?.state}). Forcing reconnect...`);
      state.hubReconnecting = true;
      try {
        await stopHubSafely();
        await connectHub();
        const fixed = state.hub?.state === HubConnectionState.Connected;
        console.log(fixed ? "[Health] ✅ Periodic reconnect successful" : "[Health] ❌ Periodic reconnect still not connected — will retry in 10 min");
        if (fixed) await reconcileMissedTrades().catch(() => {});
        await notify(
          fixed ? "✅ Hub reconnected" : "🚨 Still disconnected",
          fixed ? `Hub was down, reconnected at ${hm} UTC check.` : "Reconnect attempt failed — will retry in 10 min. Check manually if this repeats.",
          fixed ? "default" : "urgent"
        ).catch(() => {});
      } catch (e) {
        console.error(`[Health] ❌ Periodic reconnect threw: ${e.message}`);
      } finally {
        state.hubReconnecting = false;
      }
    }
  }

  // Pre-session brief: 13:25 UTC (5 min before AM open)
  // getUTCSeconds() < 10 prevents double-fire — tick runs every 10s
  if (hm === 1325 && sec < 10 && !state.briefSentToday) {
    state.briefSentToday = true;
    if (isTodayWeekend()) {
      console.log("⛔ WEEKEND — no session today");
    } else if (isTodayHoliday()) {
      console.log("⛔ MARKET CLOSED TODAY (US holiday) — no trading");
    } else {
      await preSessionBrief().catch(console.error);
      if (isTodayEarlyClose()) {
        console.log("⚠️  EARLY CLOSE DAY — AM session only (no PM session today)");
      }
    }
  }

  // End-of-day summary + post-PM reconcile handled below at 20:05 UTC

  // Weekly recap: Friday 20:00 UTC (2:00 PM MDT / 1:00 PM MST), right after the
  // PM session closes — moved from Sunday 2026-10-11 to match the cadence the
  // user asked for ("full report each Friday... after Friday's session closes").
  // Reads the trade log and summarises the past 7 days.
  if (hm === 2000 && sec < 10 && now.getUTCDay() === 5) {
    await weeklyRecap().catch(console.error);
  }

  // Refresh news filter at 13:00 UTC (30 min before AM open)
  if (hm === 1300 && sec < 10) {
    await refreshNewsFilter().catch(console.error);
  }

  // Reset daily counters at session open 13:30 UTC
  if (hm === 1330 && sec < 10) {
    state.prevDayPnL        = state.dayPnL;  // snapshot before zeroing — drives next-day 1ct mode
    if (state.prevDayPnL <= -CFG.badDayThreshold) {
      console.log(`[Risk] ⚠️  Prior day P&L $${state.prevDayPnL.toFixed(0)} — next session capped at 1ct (bad-day protection)`);
    }
    state.dayPnL            = 0;
    writeSharedState(0);
    state.dayWins           = 0;
    state.dayLosses         = 0;
    state.haltedToday       = false;
    state.profitCappedToday  = false;
    state.briefSentToday    = false;
    state.earlyHealthCheckDone = false;
    state.runnerClosePending = false;
    state.consecutiveLosses  = 0;
    state.consecutiveWins   = 0;
    state.cooldownUntil     = 0;
    state.pendingRetry      = null;
    state.mismatchRetryDone = false;
    state.amSessionOpenPrice  = null;
    state.amTrendChecked      = false;
    state.noShortsToday       = false;
    state.noLongsToday        = false;
    state.sessionLongWon      = false;
    state.dayContextRecovered = false; // allow reconcileMissedTrades to re-recover tomorrow
    state.sessionLongCount   = 0;
    state.gapUpDay           = false;

    // Recompute directional persistence gate from ES.txt at each session open
    {
      const { upPct, upCount, comparisons } = computeUpPct();
      state.upPctOverbought = upPct >= 0.8;
      console.log(`[Gate] upPct(10d): ${(upPct * 100).toFixed(0)}% up-days (${upCount}/${comparisons}) — overbought gate: ${state.upPctOverbought ? "🔴 ACTIVE" : "✅ off"}`);
    }
    // If balance hasn't arrived via SignalR yet, pull it from REST so reconciliation has a baseline
    if (state.balance == null) {
      try {
        const data = await apiPost("/api/Account/search", {});
        const acct = data.accounts?.find(a => a.id === state.accountId);
        if (acct?.balance) state.balance = +acct.balance;
      } catch { /* non-fatal */ }
    }
    state.startOfDayBalance = state.balance;  // snapshot for post-session reconciliation
    // This moment IS "end of day" for trailing-DD purposes — today's first trade
    // hasn't happened yet, so state.balance here is yesterday's real close. Only
    // point in the whole day this is allowed to advance (see eodPeakBalance note
    // at boot above).
    if (state.balance != null) {
      state.eodPeakBalance = Math.max(state.eodPeakBalance ?? state.balance, state.balance);
      saveEodPeakBalance(state.eodPeakBalance);
    }
    // Nothing left to recover — the line above already has the authoritative start balance.
    // Found 2026-10-08: leaving this false all day meant the FIRST trade to close (almost
    // always within seconds, via the fast-close/orphan-recovery path) triggered
    // reconcileMissedTrades()'s one-time "first recovery" branch, which recomputed
    // startOfDayBalance from state.balance - tradedPnL — but state.balance hadn't caught
    // up with that same trade's P&L yet (async SignalR push lag), double-subtracting the
    // trade's P&L and knocking the scaling tier down a notch mid-day (3ct->2ct observed).
    state.dayContextRecovered = true;
    // Clear persisted seenTradeIds so today's file starts fresh (yesterday's IDs are irrelevant)
    state.seenTradeIds = new Set();
    saveSeenTradeIds();
    // Clear CONF_REV session state so prior day's push/arm data doesn't bleed into today
    resetConfRevState();
    // Save gates AFTER every field above is cleared — saving mid-reset (before
    // profitCappedToday/haltedToday/etc. are zeroed) would persist yesterday's
    // stale values under today's date, and a restart in that window would
    // silently restore them and block the entire new session.
    saveSessionGates(state);
    console.log(`[Day] ✓ New session — daily counters reset | start balance: $${state.balance?.toFixed(2) ?? 'unknown'}`);
  }

  // Post-AM reconcile: 15:05 UTC (5 min after AM close)
  if (hm === 1505 && sec < 10 && !isTodayWeekend() && !isTodayHoliday()) {
    await reconcileDayPnL("Post-AM").catch(console.error);
  }

  // Post-PM reconcile: 20:05 UTC — runs just before EOD summary
  if (hm === 2005 && sec < 10 && !isTodayWeekend() && !isTodayHoliday()) {
    await reconcileDayPnL("Post-PM").catch(console.error);
    await endOfDaySummary().catch(console.error);
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  TopstepX Engine v1  (ProjectX API)      ║");
  console.log(`║  ${CFG.contractSearch} Futures  |  ${CFG.maxContracts} contracts max              ║`);
  console.log("╚══════════════════════════════════════════╝");

  if (!CFG.userName || !CFG.apiKey) {
    throw new Error("TV_USER and TV_API_KEY must be set in .env — fill in Topstep credentials");
  }

  await login();
  await resolveAccount();
  // Restore gates immediately so profitCappedToday/haltedToday are set before
  // bars load and the first tick fires — avoids the race with reconcileMissedTrades.
  restoreSessionGates(state);
  await resolveContract();
  await resolveESContract();
  // Boot: fetch 30 days of 5m bars (3000 bars, 720h) to seed the ADR20 cache in nq-strategies.js.
  // Periodic 5m bar refreshes use the default 300-bar/48h window — ADR cache persists in module memory.
  await Promise.all([fetchBars(3000, false, 720), fetchBars15(300), fetchESBars()]);  // load all bar feeds in parallel
  await refreshNewsFilter();
  await connectHub();
  // Unconditional — without this, dayPnL starts at 0 in memory on every fresh
  // restart regardless of what already happened today. It previously only got
  // recovered by luck (a stuck activeDirections gate, or SignalR's own
  // reconnect handler), so a clean restart mid-session could silently reset
  // the engine's own profit-cap/DLL tracking to zero while real P&L sat
  // unreconciled — relying entirely on TopstepX's external enforcement as
  // the only backstop.
  await reconcileMissedTrades().catch(e => console.warn("[Boot] reconcileMissedTrades failed:", e.message));
  await recoverOpenPosition().catch(e => console.warn("[Boot] Recovery check failed:", e.message));

  // Compute upPct overbought gate from ES.txt tail (reliable 10-day history)
  {
    const { upPct, upCount, comparisons } = computeUpPct();
    state.upPctOverbought = upPct >= 0.8;
    console.log(`[Gate] Boot upPct(10d): ${(upPct * 100).toFixed(0)}% up-days (${upCount}/${comparisons}) — overbought gate: ${state.upPctOverbought ? "🔴 ACTIVE" : "✅ off"}`);
  }

  // Tick every 10 seconds, aligned to true wall-clock boundaries (:00, :10, :20...)
  // rather than a plain setInterval, which fires 10s after whenever the process
  // happened to boot. With multiple accounts staggered a couple seconds apart at
  // startup (to avoid a login rate limit), a boot-relative setInterval means every
  // account's tick — and therefore every signal evaluation and order submission —
  // permanently inherits that same offset, every single cycle, all day. Measured
  // live on 2026-09-28: the second-started account's bar-fetch landed a consistent
  // ~2s after the first's, tick after tick, correlating with materially worse SL
  // slippage on that account (2.5t avg vs 0.4t) — plausibly because it was reacting
  // to the same signal ~2s later. Self-correcting wall-clock alignment removes the
  // boot-time phase entirely: every account's tick fires within milliseconds of the
  // same real-world instant, regardless of when its process started.
  function scheduleNextTick() {
    const delay = 10_000 - (Date.now() % 10_000);
    setTimeout(async () => {
      await tick().catch(console.error);
      scheduleNextTick();
    }, delay);
  }
  scheduleNextTick();
  await tick();  // run immediately on boot

  console.log("[Boot] ✓ Engine running — waiting for session open");
  // contractId format: "CON.F.US.EP.U26" — extract the short name for the notification
  const contractShort = (state.contractId ?? "").split(".").slice(-2).join("") || CFG.contractSearch;
  await notify("🟢 Engine online", `TopstepX engine started\nAccount: $${state.peakBalance?.toFixed(0)}\nContract: ${contractShort}  |  Max: ${CFG.maxContracts}ct\nAM session opens 7:30 ${isDST() ? "MDT" : "MST"}`, "low");
}

// Retry startup on transient failure — mirrors how the old v9 IB engine handled
// disconnects internally. Exit only on SIGTERM (handled above) or a permanent error.
let _startupAttempt = 0;
(async function startWithRetry() {
  while (true) {
    try {
      await main();
      return; // main() resolved cleanly (shouldn't happen normally)
    } catch (err) {
      _startupAttempt++;
      const delay = Math.min(10_000 * _startupAttempt, 60_000); // 10s, 20s … 60s cap
      console.error(`[FATAL] Startup failed (attempt ${_startupAttempt}): ${err.message}`);
      console.error(`[FATAL] Retrying in ${delay / 1000}s — engine stays alive, no restart needed`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
})();
