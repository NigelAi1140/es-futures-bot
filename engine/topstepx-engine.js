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
import { HubConnectionBuilder, HttpTransportType, LogLevel } from "@microsoft/signalr";
import dotenv from "dotenv";
import { evaluate, evaluateExtended } from "./strategies.js";
import { evaluateNQ } from "./nq-strategies.js";
import { atr } from "./indicators.js";
import { appendFileSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));

// Shared state file — read by cl-forward-test.mjs to gate signals
const SHARED_STATE_PATH = join(__dir, "..", "logs", "nq-state.json");
function writeSharedState(dayPnL) {
  try {
    const logsDir = join(__dir, "..", "logs");
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    writeFileSync(SHARED_STATE_PATH, JSON.stringify({
      date:      new Date().toISOString().slice(0, 10),
      dayPnL:    +dayPnL.toFixed(2),
      updatedAt: new Date().toISOString(),
    }));
  } catch { /* non-fatal — CL bot falls back to ungated if file missing */ }
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
const LOGS_DIR    = resolve(__dir, "../logs");
const TRADE_LOG   = resolve(LOGS_DIR, "trades.jsonl");   // one JSON object per line
const WEEKLY_LOG  = resolve(LOGS_DIR, "weekly.jsonl");   // weekly summaries

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
    await axios.post(`https://ntfy.sh/${NTFY_CHANNEL}`, message, {
      headers: {
        Title:    title,
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
// Stagger entry per account so all 4 combines don't hit the same tick simultaneously.
// Combine-1 → 0ms, Combine-2 → 2500ms, Combine-3 → 5000ms, Combine-4 → 7500ms.
const ACCOUNT_LABEL  = process.env.ACCOUNT_LABEL ?? "";
const ACCOUNT_IDX    = Math.max(0, (parseInt(ACCOUNT_LABEL.replace(/\D/g, "").slice(-1)) || 1) - 1);
const ENTRY_STAGGER_MS = ACCOUNT_IDX * 2500;
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
const ACTIVE_STRATEGIES = ["DONCH15_L","VOLBO_L","VOLBO_S","EMA21_PULL_L","BO10_S","3BAR_BEAR_S","KELT_L","NQ_BB_SQUEEZE_L","NQ_BB_SQUEEZE_S","NQ_DONCHIAN_BO_L","NQ_DONCHIAN_BO_S","NQ_VWAP_TOUCH_L","NQ_VWAP_TOUCH_S"];
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
  stopTicks:      parseInt(process.env.STOP_LOSS_TICKS   || "10"),
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
  trailDDWarn:     2000,   // warn at $2,000 drawdown (buffer from $2,500 trailing EOD DD)
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
    // ── Active V3 signals (none paused) ──
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
// NQ tick: $5/tick, 0.25pt. Default stop=40t ($200/ct), TP=110t ($550/ct).
// CFG.stopTicks=40 is the default — NQ_BB_SQUEEZE overrides to 10t via sig.stopTicks.
// Portfolio (2020-2026): Donchian L+S $12,870/yr + BB_SQUEEZE L+S $15,521/yr = $15,896/yr combined
//   23.7 tr/mo | 31%WR | max DD -$4,580 | positive every year 2020-2026
if (CFG.contractSearch === "NQ") {
  CFG.tickValue  = 5.00;        // $5/tick vs ES $12.50
  CFG.tpTicks    = 110;         // 27.5pt TP default for NQ strategies (optimized 2026-08-01)
  CFG.stopTicks  = 40;          // 10pt fixed stop (40t @ $5 = $200/ct)
  // maxStopTicks: accounts.json MAX_STOP_TICKS=40 takes priority; only fall back to 60 if unset.
  // Hardcoding 60 here was overriding the accounts.json cap, defeating the safety fix.
  if (!process.env.MAX_STOP_TICKS) CFG.maxStopTicks = 60;
  // Trail ticks unchanged (8t trail still applies if any NQ strategy uses trail mode)
  // Clear ES-specific V2 tombstones from pausedStrategies, then re-apply ENABLED_STRATEGIES
  // filter for NQ-specific signals (NQ_BB_SQUEEZE_L/S). Without the re-apply, the
  // ENABLED_STRATEGIES whitelist has no effect on NQ accounts.
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
  dailyProfitCap: 2500,   // no consistency rule on funded — lock in big days at $2,500
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

  activeDirections:   new Set(),    // "long" | "short" — direction gate (SHARED by 5m + 15m)
  openTrades:         new Map(),    // orderId → { signalId, isLong }
  seenTradeIds:       new Set(),    // trade IDs already processed via SignalR (dedup guard)

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
  haltedToday:        false,
  profitCappedToday:  false,
  runnerClosePending: false,  // true once runner-close market order has been sent (dedup guard)
  balance:            null,   // live account balance (updated on every account event)
  startOfDayBalance:  null,   // balance at 13:30 UTC reset — used for API reconciliation
  peakBalance:        null,
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
};

// ─── REST helpers ─────────────────────────────────────────────────────────────
async function apiPost(path, body = {}) {
  const headers = state.token
    ? { Authorization: `Bearer ${state.token}` }
    : {};
  const res = await axios.post(`${REST_BASE}${path}`, body, { headers });
  return res.data;
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

  // Re-auth 90 minutes before token likely expires (tokens typically last 24h)
  setTimeout(login, 22 * 60 * 60 * 1000);
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
  state.peakBalance = acct.balance;
  state.simulated   = acct.simulated ?? true;
  state.tickValue   = CFG.tickValue;

  // ── Auto-apply funded account settings ───────────────────────────────────
  // TopstepX Express Funded accounts stay simulated:true in the API even when funded.
  // Detect funded state by: simulated:false OR account name starts with "EXPRESS".
  const isFunded = !state.simulated || /^EXPRESS/i.test(acct.name ?? "");
  if (isFunded) {
    Object.assign(CFG, CFG_FUNDED);
    console.log(`[Account] 🎉 FUNDED ACCOUNT detected — applying funded settings:`);
    console.log(`[Account]    maxContracts=${CFG.maxContracts}ct | dailyProfitCap=$${CFG.dailyProfitCap}`);
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
async function fetchBars(limit = 300, partial = false) {
  const now   = new Date();
  const start = new Date(now - 48 * 60 * 60 * 1000); // 48h back for overnight range

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

// ─── SignalR Hub ──────────────────────────────────────────────────────────────
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
  state.hub.on("GatewayLogout",       () => console.log("[Hub] Server sent GatewayLogout — session ended by TopstepX"));

  state.hub.onreconnected(() => {
    console.log("[Hub] Reconnected — re-subscribing");
    subscribeHub().catch(console.error);
    // Recover any trade close events that were dropped during the disconnect window
    reconcileMissedTrades().catch(console.error);
  });

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

  // Mark this trade ID as seen so reconcileMissedTrades() won't re-process it
  const tradeId = trade.id ?? trade.tradeId ?? null;
  if (tradeId != null) state.seenTradeIds.add(String(tradeId));

  // Skip voided trades — platform can void fills on bad ticks; voided P&L must not count
  if (trade.voided) {
    console.log(`[Trade] ⚠️  Voided trade — skipping P&L (gross pnl would have been $${pnl?.toFixed(2)})`);
    return;
  }

  // Entry fills arrive as pnl=0 events; also a genuine breakeven close has pnl=0.
  // We handle both: entry fills have no signalId context we care about; a real $0 close
  // is so rare it is safe to log and return without updating the streak.
  if (pnl === 0) {
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
    entry_price:    trade.entryPrice  ?? null,
    exit_price:     trade.exitPrice   ?? trade.price ?? null,
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
      `Day P&L: $${state.dayPnL.toFixed(0)}  |  Streak: ${state.consecutiveWins}W\nNext size: ${ct}ct`,
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
      `Day P&L: $${state.dayPnL.toFixed(0)}  |  Streak: ${state.consecutiveLosses}L\nNext size: ${ct}ct`,
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
      const inAM  = hm >= 1345 && hm < 1455;   // 5 min buffer before AM close at 15:00
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

// ─── Event: Account (balance update) ─────────────────────────────────────────
function onAccountEvent(acct) {
  if (!acct || acct.balance == null) return;
  const bal = +acct.balance;
  state.balance = bal;
  if (state.peakBalance === null) state.peakBalance = bal;
  if (bal > state.peakBalance) state.peakBalance = bal;
  // Auto-capture starting balance on first connect so cushion scaling works
  // without requiring the user to enter it manually (FUNDED_START_BALANCE=-1 means auto)
  if (CFG.fundedStartBalance < 0 && state.autoStartBalance == null) {
    state.autoStartBalance = bal;
    console.log(`[Account] Auto-detected starting balance: $${bal.toFixed(2)} — cushion scaling active`);
  }

  const drawdown = state.peakBalance - bal;
  if (drawdown >= CFG.trailDDWarn) {
    console.log(`[Risk] ⚠️  Trailing drawdown $${drawdown.toFixed(2)} from peak — Topstep limit is $2,000!`);
    notify("⚠️ Drawdown warning!", `Down $${drawdown.toFixed(0)} from peak\nTopstep trailing limit: $2,000 — getting close!`, "urgent").catch(()=>{});
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

function calcContracts() {
  // ── Layer 0: Funded account cushion-based auto-scaling ────────────────────
  // Activated when FUNDED_START_BALANCE >= 0 (use -1 or omit to disable).
  // TopstepX API returns profit above funded start, not full equity, so
  // state.balance IS the cushion — no subtraction needed.
  // Ladder: <$2K=1ct | $2K=2ct | $4K=3ct | $6K=4ct | $8K+=5ct
  let base = CFG.maxContracts;
  const startBal = CFG.fundedStartBalance >= 0 ? CFG.fundedStartBalance : state.autoStartBalance ?? null;
  if (startBal != null && state.balance != null) {
    const cushion = state.balance - startBal;
    let cushionMax;
    if      (cushion >= 8000) cushionMax = 5;
    else if (cushion >= 6000) cushionMax = 4;
    else if (cushion >= 4000) cushionMax = 3;
    else if (cushion >= 2000) cushionMax = 2;
    else                      cushionMax = 1;
    base = Math.min(CFG.maxContracts, cushionMax);
  }

  // ── Layer 0b: ATR volatility boost ───────────────────────────────────────
  // Backtest 2022-2026: ATR 2.5+ = 25%WR / +$50/tr. ATR 2.0-2.5 = 31%WR / +$106/tr.
  // When market has real range, press size by 1ct — volatility is the edge's fuel.
  const curATR = currentATR();
  if (curATR !== null && curATR >= 2.5) base = Math.min(CFG.maxContracts, base + 1);

  // ── Layer 0c: Thursday edge boost ────────────────────────────────────────
  // Thursday AM shorts: 37.1%WR / +$123/tr — highest-edge session across all days.
  // Overall Thursday: 27.2%WR / +$42/tr / +$2,028/yr. Add 1ct to capitalise.
  if (new Date().getUTCDay() === 4) base = Math.min(CFG.maxContracts, base + 1);

  // ── Layer 1: Overnight range regime ───────────────────────────────────────
  const range = calcOvernightRange();
  let regimeMult = 1.0;
  if (range != null) {
    if (range < 30)      regimeMult = 0.50;  // TIGHT  🔴 — choppy expected
    else if (range < 50) regimeMult = 0.75;  // NARROW 🟡 — below average
    // else WIDE 🟢 — full size
  }

  // ── Layer 2: Win/loss streak confidence ───────────────────────────────────
  // Capitalise on what's working; pull back when it isn't
  let streakMult = 1.0;
  if (state.consecutiveWins >= 3 && state.dayPnL > 0) {
    streakMult = 1.50;   // 3+ wins and in profit today — press the edge
  } else if (state.consecutiveWins >= 1) {
    streakMult = 1.25;   // momentum building
  } else if (state.consecutiveLosses >= 2) {
    streakMult = 0.50;   // something not working — cut size in half
  } else if (state.consecutiveLosses >= 1) {
    streakMult = 0.75;   // one loss — slight reduction
  }

  // ── Layer 3: ATR thin-market cap ─────────────────────────────────────────
  // Very low ATR = unusually thin/choppy market (holiday-adjacent, pre-news freeze).
  // Cap at 1ct regardless of streak/regime — backtest shows these days underperform.
  const sessionATR = calcSessionOpenATR();
  const thinMarket = sessionATR !== null && sessionATR < 3.0;

  // ── Layer 4: Prior-day bad-day protection ─────────────────────────────────
  // If the previous session lost ≥ CFG.badDayThreshold, cap next morning at 1ct.
  // Prevents compounding a bad day with a full-size run the next morning while
  // confidence and edge are potentially degraded. Resets after one full session.
  const badPriorDay = state.prevDayPnL <= -CFG.badDayThreshold;

  // ── Combined (all hard caps take priority over streak/regime) ─────────────
  if (thinMarket || badPriorDay) return 1;
  return Math.max(1, Math.min(base, Math.round(base * regimeMult * streakMult)));
}

function calcContractsVerbose() {
  // Same as calcContracts but returns a description for the brief
  let base = CFG.maxContracts;
  const startBal = CFG.fundedStartBalance >= 0 ? CFG.fundedStartBalance : state.autoStartBalance ?? null;
  if (startBal != null && state.balance != null) {
    const cushion = state.balance - startBal;
    let cushionMax;
    if      (cushion >= 8000) cushionMax = 5;
    else if (cushion >= 6000) cushionMax = 4;
    else if (cushion >= 4000) cushionMax = 3;
    else if (cushion >= 2000) cushionMax = 2;
    else                      cushionMax = 1;
    base = Math.min(CFG.maxContracts, cushionMax);
  }
  const curATRv = currentATR();
  if (curATRv !== null && curATRv >= 2.5) base = Math.min(CFG.maxContracts, base + 1);
  if (new Date().getUTCDay() === 4) base = Math.min(CFG.maxContracts, base + 1);
  const range = calcOvernightRange();
  let regimeMult = 1.0, regimeLabel = "🟢 WIDE";
  if (range != null) {
    if (range < 30)      { regimeMult = 0.50; regimeLabel = "🔴 TIGHT"; }
    else if (range < 50) { regimeMult = 0.75; regimeLabel = "🟡 NARROW"; }
  }
  let streakMult = 1.0, streakLabel = "neutral";
  if (state.consecutiveWins >= 3 && state.dayPnL > 0)  { streakMult = 1.50; streakLabel = `${state.consecutiveWins}W streak 🔥`; }
  else if (state.consecutiveWins >= 1)                  { streakMult = 1.25; streakLabel = `${state.consecutiveWins}W streak ↑`; }
  else if (state.consecutiveLosses >= 2)                { streakMult = 0.50; streakLabel = `${state.consecutiveLosses}L streak ⚠️`; }
  else if (state.consecutiveLosses >= 1)                { streakMult = 0.75; streakLabel = `${state.consecutiveLosses}L streak ↓`; }
  const sessionATR = calcSessionOpenATR();
  const thinMarket = sessionATR !== null && sessionATR < 3.0;
  const badPriorDay = state.prevDayPnL <= -CFG.badDayThreshold;
  if (thinMarket)  regimeLabel += `  ⚠️ THIN ATR(${sessionATR.toFixed(2)}) — capped 1ct`;
  if (badPriorDay) regimeLabel += `  ⚠️ BAD PRIOR DAY ($${state.prevDayPnL.toFixed(0)}) — capped 1ct`;
  const contracts = (thinMarket || badPriorDay)
    ? 1
    : Math.max(1, Math.min(base, Math.round(base * regimeMult * streakMult)));
  return { contracts, regimeLabel, streakLabel, regimeMult, streakMult };
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
  if (stopType === "fixed" && tradeOpts.barHigh != null && tradeOpts.barLow != null && tradeOpts.sigPrice != null) {
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

        // No protective orders on the book → bracket wasn't placed
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

  const stopDesc   = stopType === "trail" ? `Trail ${stopTicks}t` : `Stop ${stopTicks}t`;
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
  if (!trade || trade.protected) return;
  trade.protected = true;  // prevent double-placement on duplicate events

  const { isLong, contracts, signalId, stopTicks, tpTicks, stopType, barHigh, barLow } = trade;
  const closeSide = isLong ? OrderSide.Ask : OrderSide.Bid;  // close = opposite of entry

  // Persist open trade state so a restart can recover signal/direction/entry price
  persistOpenTrade({
    entryOrderId, signalId, isLong, contracts, fillPrice,
    stopTicks, tpTicks, stopType, openedAt: Date.now(),
  });

  // Stop order — trailing or fixed depending on which layer placed the entry
  // For fixed stop: use signal bar high/low + stopTicks if available (matches backtest model).
  // Falls back to fillPrice ± stopTicks if bar context wasn't stored.
  const initialStopPrice = (() => {
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
    // Partial or total failure — alert urgently
    const failMsg = [
      !slOk ? `❌ Stop FAILED: ${slDataFinal.errorMessage}` : `✅ Stop placed`,
      !tpOk ? `❌ TP FAILED: ${tpData.errorMessage}`   : `✅ TP placed`,
    ].join("\n");
    notify(`⚠️ Protective order issue — ${signalId}`, failMsg, "urgent").catch(()=>{});
    console.error(`[Order] ⚠️  Protective order partially failed for ${signalId} — check position manually!`);
  }

  // ── Track for OCO (cancel survivor when the other fills) ──────────────────
  if (slId) state.openTrades.set(slId, { signalId, isLong, contracts, isProtective: true, pairedWith: tpId });
  if (tpId) state.openTrades.set(tpId, { signalId, isLong, contracts, isProtective: true, pairedWith: slId });

  // Update persisted state with real bracket order IDs so recoverOpenPosition can restore
  // state.openTrades by exact orderId — eliminates RECOVERED classification after restarts
  persistOpenTrade({ entryOrderId, signalId, isLong, contracts, fillPrice,
    stopTicks, tpTicks, stopType, slId: slId || null, tpId: tpId || null });
}

// ─── Boot: open-position recovery ────────────────────────────────────────────
// Called once at startup. If the engine died while a position was open, restores
// engine state and verifies/replaces protective orders so the trade stays managed.
// If the position already closed while we were down, sets a flag so the next
// signal evaluate fires immediately (instead of waiting for the next 5m boundary).
let _reEvaluateAfterBoot = false;

async function recoverOpenPosition() {
  const persisted = loadPersistedOpenTrade();
  if (!persisted) return;

  // Check what the API actually has open right now
  const posData = await apiPost("/api/Position/searchOpen", { accountId: state.accountId });
  if (!posData.success) return;
  const openPositions = (posData.positions ?? []).filter(p => (p.size ?? 0) !== 0);

  if (openPositions.length === 0) {
    // Position closed while engine was down — reconcileMissedTrades will log it.
    // Set flag so tick() runs evaluate immediately after boot rather than waiting
    // for the next 5-minute boundary, giving the signal a chance to re-enter.
    console.log(`[Boot] Persisted trade found but position is flat — will reconcile and re-evaluate immediately`);
    _reEvaluateAfterBoot = true;
    return;
  }

  // Position is still live — restore engine state so we keep managing it
  const openPos  = openPositions[0];
  const posIsLong = openPos.type === 1;  // PositionType: 1=Long, 2=Short

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
    // Brackets were lost — re-place them now
    console.warn(`[Boot] ⚠️  No protective orders found — re-placing SL/TP`);
    notify(`⚠️ Re-placing brackets`, `${persisted.signalId} lost protection on restart — placing now`, "urgent").catch(() => {});
    if (persisted.fillPrice) {
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
  try {
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const data = await apiPost("/api/Trade/search", {
      accountId:      state.accountId,
      startTimestamp: since,
    });
    if (!data.success) return;
    const trades = data.trades ?? data.items ?? [];

    // Restore context from persisted state file if available (written on each entry fill)
    const persisted = loadPersistedOpenTrade();

    // Collect entry fills (pnl=0) keyed by side+size for matching against closes
    const entryFills = [];
    for (const trade of trades) {
      const pnl = trade.profitAndLoss ?? 0;
      if (pnl === 0) entryFills.push(trade);
    }

    for (const trade of trades) {
      const tid = String(trade.id ?? trade.tradeId ?? "");
      if (!tid || state.seenTradeIds.has(tid)) continue;
      const pnl = trade.profitAndLoss ?? 0;
      if (pnl === 0) { state.seenTradeIds.add(tid); continue; } // entry fill — skip

      // Try to recover direction from persisted file or from matching entry fill
      let signalId   = "RECOVERED";
      let isLong     = null;
      let entryPrice = null;

      if (persisted && !persisted._used) {
        // Persisted state matches this close if it was opened today and not yet consumed
        signalId   = persisted.signalId;
        isLong     = persisted.isLong;
        entryPrice = persisted.fillPrice ?? null;
        persisted._used = true;
        console.warn(`[Recovery] ♻️  Restored context from disk: ${signalId} ${isLong ? "LONG" : "SHORT"} entry@${entryPrice}`);
      } else {
        // Fall back: match by opposite-side entry fill with same size within the same 2h window
        const closeSize = trade.size ?? trade.contracts;
        const closeSide = trade.side;  // 1=Bid(buy-to-close=SHORT), 2=Ask(sell-to-close=LONG)
        const matchEntry = entryFills.find(e =>
          (e.size ?? e.contracts) === closeSize &&
          e.side !== closeSide
        );
        if (matchEntry) {
          isLong     = (matchEntry.side === 1);  // Bid entry = LONG
          entryPrice = matchEntry.price ?? null;
          console.warn(`[Recovery] ♻️  Matched entry fill: ${isLong ? "LONG" : "SHORT"} entry@${entryPrice}`);
        }
      }

      const dirLabel = isLong === true ? "LONG" : isLong === false ? "SHORT" : "?";
      console.warn(`[Recovery] ♻️  Replaying missed trade ${tid} — P&L $${pnl.toFixed(2)} ${signalId} ${dirLabel}`);

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
  } catch (e) {
    console.warn("[Recovery] Could not fetch missed trades:", e.message);
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
    } else {
      console.log(`[PnL] ✓ ${label} reconcile — balance $${realBalance.toFixed(2)} | day P&L $${realDayPnL.toFixed(2)} (in sync)`);
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
  const inRange = (hm >= 1300 && hm < 1530) || (hm >= 1800 && hm < 2030);
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
  // AM session: 13:45–15:00 UTC (skip first 15 min of RTH — opening range chaos)
  // PM session: 18:30–19:00 UTC (strategies.js PM_END=1900; 18:00–18:30 is lunch lull)
  const inAM = hm >= 1345 && hm < 1500;
  const inPM = hm >= 1830 && hm < 1900 && !state.isFOMCDay && !isTodayEarlyClose();
  if (!inAM && !inPM) return;

  // Monday PM filter: Mon PM has 0%WR longs / 5.3%WR shorts (-$6,175 net, 4.5yr) — skip PM entirely
  if (inPM && now.getUTCDay() === 1) return;
  // Gap-up PM filter: gap-up days (AM open >1pt above prior close) have 9.9%WR in PM (-$82/tr, 4.5yr)
  if (inPM && state.gapUpDay) return;

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
  }

  let signals;
  try {
    const isNQ = CFG.contractSearch === "NQ";
    const mainSigs = isNQ ? evaluateNQ(state.bars) : evaluate(state.bars);
    const extSigs  = isNQ ? [] : evaluateExtended(state.bars);  // MARKET_STRUCT_S + DAY_BREAK_FAIL_S (ES only)
    signals = [...mainSigs, ...extSigs];
    if (CFG.regimeFilter === "bull") signals = signals.filter(s => s.side === "long");
    else if (CFG.regimeFilter === "bear") signals = signals.filter(s => s.side === "short");
  } catch (err) {
    console.error("[Strategy] Error:", err.message);
    return;
  }

  if (signals.length === 0) {
    const hm2 = new Date().getUTCHours() * 100 + new Date().getUTCMinutes();
    console.log(`[Strategy] ${hm2} UTC — evaluated ${state.bars.length} bars, 0 signals`);
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
    if (inAM && state.noShortsToday && dir === "short") continue;
    // noLongsToday gate: bypass once if the first long already won (momentum confirmation)
    if (inAM && state.noLongsToday && dir === "long") {
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
    if (state.activeDirections.has(dir)) continue;  // direction gate (same direction already open)

    // Hedge gate: long and short can run simultaneously (separate independent gates).
    // Both AVWAP_L and 3BAR_BEAR_S can hold positions at the same time — they fire
    // under different market conditions and are not correlated.

    // Claim direction before async placeEntry to prevent double entry
    state.activeDirections.add(dir);
    if (dir === "long") state.sessionLongCount++;
    placeEntry(sig.id, dir === "long", contracts, {
      stopTicks: sig.stopTicks ?? CFG.stopTicks,  // per-strategy stop override
      tpTicks:   sig.tpTicks   ?? CFG.tpTicks,   // per-strategy TP override from strategies.js
      stopType:  "fixed",
      barHigh:   sig.barHigh,
      barLow:    sig.barLow,
      sigPrice:  sig.price,
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

  const inAM = hm >= 1345 && hm < 1500;
  const inPM = hm >= 1830 && hm < 1900 && !state.isFOMCDay && !isTodayEarlyClose();
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
    if (state.noShortsToday && dir === "short") return false;
    if (state.noLongsToday && dir === "long") {
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
    placeEntry(sig.id, dir === "long", contracts, {
      stopTicks: CFG15m.stopTicks,
      tpTicks:   sig.tpTicks ?? CFG15m.tpTicks,   // per-strategy TP override from strategies.js
      stopType:  CFG15m.stopType,
      tf:        "15m",
    }).catch(err => {
      console.error("[Order] 15m entry error:", err.message);
      state.activeDirections.delete(dir);
    });
  }
}

// ─── Pre-session brief ────────────────────────────────────────────────────────
async function preSessionBrief() {
  const range  = calcOvernightRange();
  const { contracts, regimeLabel, streakLabel, regimeMult, streakMult } = calcContractsVerbose();
  const dayPnL = state.dayPnL;

  const accountMode = state.simulated
    ? (() => {
        const profit = state.balance != null ? Math.max(0, state.balance - CFG.accountBase) : null;
        const needed = profit != null ? Math.max(0, CFG.combineTarget - profit) : null;
        return needed != null
          ? (needed <= 0 ? `Account mode        : 🎯 COMBINE PASSED — check Topstep dashboard` : `Account mode        : Combine  $${profit.toFixed(0)} / $${CFG.combineTarget.toFixed(2)}  ($${needed.toFixed(2)} to go)`)
          : `Account mode        : Combine`;
      })()
    : `Account mode        : ⭐ FUNDED  |  Daily profit cap: $${CFG.dailyProfitCap}  |  Max: ${CFG.maxContracts}ct`;

  const lines = [
    ``,
    `━━━ PRE-SESSION BRIEF ${new Date().toUTCString()} ━━━`,
    accountMode,
    `ES Overnight Range  : ${range != null ? range.toFixed(2) + " pts" : "N/A"}`,
    `Regime filter       : ${regimeLabel.padEnd(12)} (${(regimeMult * 100).toFixed(0)}%)`,
    `Streak filter       : ${streakLabel.padEnd(20)} (${(streakMult * 100).toFixed(0)}%)`,
    `Contracts today     : ${contracts} / ${CFG.maxContracts} max`,
    `Day P&L             : ${dayPnL >= 0 ? "+" : ""}$${dayPnL.toFixed(2)}`,
    `Consec. wins        : ${state.consecutiveWins} | Consec. losses: ${state.consecutiveLosses}`,
    `Peak balance        : ${state.peakBalance != null ? "$" + state.peakBalance.toFixed(2) : "N/A"}`,
    `Trail DD limit      : $${CFG.trailDD.toFixed(0)} EOD-trail (warning at -$${CFG.trailDDWarn})`,
    `Daily loss limit    : $${CFG.dailyLossLimit} | Halted: ${state.haltedToday}`,
    CFG.contractSearch === "NQ"
      ? `5m strategies (V3)  : NQ mode — V3 signals with NQ CFG stops (40t/110t default)`
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
    `AM session          : ${isDST() ? "7:45–9:00 MDT" : "6:45–8:00 MST"} (13:45-15:00 UTC)`,
    `PM session          : ${state.isFOMCDay ? "⛔ DISABLED (FOMC day)" : isTodayEarlyClose() ? "⛔ DISABLED (early close)" : `${isDST() ? "12:30–1:00 PM MDT" : "11:30 AM–12:00 PM MST"} (18:30-19:00 UTC)`}`,
    `Trend filter        : ${state.noShortsToday ? "📈 UPTREND — shorts suppressed" : state.noLongsToday ? "📉 DOWNTREND — longs suppressed" : state.amTrendChecked ? "→ Neutral — all signals active" : "⏳ Pending (fires at 14:15 UTC)"}`,
    `Overbought gate     : ${state.upPctOverbought ? "🔴 ACTIVE — trending strats suppressed (8+/10 days up)" : "✅ Off"}`,
    `News blocks today   : ${(state._newsBlocks?.length || 0)} Tier-1 event(s)`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
  ];
  console.log(lines.join("\n"));

  const balance    = state.balance     ?? state.peakBalance ?? null;
  const peak       = state.peakBalance ?? balance;
  const ddUsed     = peak != null && balance != null ? Math.max(0, peak - balance) : null;
  const ddBuffer   = ddUsed != null ? Math.max(0, 2000 - ddUsed) : null;
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
  };
  emitBundleEvent('PRESESSION_BRIEF', bundlePayload);

  // Single-account phone notification
  const briefMsg = [
    `Regime: ${regimeLabel}  |  ${contracts}ct / ${CFG.maxContracts}ct max`,
    `Streak: ${streakLabel}`,
    balance != null ? `Balance: $${balance.toFixed(0)}${ddBuffer != null ? `  |  DD buffer: $${ddBuffer}` : ""}` : null,
    state.simulated && profitSoFar != null
      ? `Combine: $${profitSoFar.toFixed(0)} / $${CFG.combineTarget.toFixed(0)}  ($${Math.max(0, CFG.combineTarget - profitSoFar).toFixed(0)} to go)`
      : null,
    `News: ${state._newsBlocks?.length || 0}  |  FOMC: ${state.isFOMCDay ? "YES ⚠️" : "No"}`,
    `Trend: ${bundlePayload.trendStatus}`,
    `AM 7:45 ${bundlePayload.tz}  |  PM 12:30–2:00`,
  ].filter(Boolean).join("\n");
  await notify("📊 Pre-session brief", briefMsg, "default");
}

// ─── End-of-day summary ───────────────────────────────────────────────────────
async function endOfDaySummary() {
  const totalTrades = state.dayWins + state.dayLosses;
  const wr          = totalTrades > 0 ? ((state.dayWins / totalTrades) * 100).toFixed(0) : "—";
  const pnlStr      = state.dayPnL >= 0
    ? `+$${state.dayPnL.toFixed(0)}`
    : `-$${Math.abs(state.dayPnL).toFixed(0)}`;

  // Current balance from last account event; peak is the high watermark
  const bal         = state.balance     ?? state.peakBalance;
  const peak        = state.peakBalance ?? bal;
  const balStr      = bal  != null ? `$${bal.toFixed(0)}`  : "—";
  const peakStr     = peak != null ? `$${peak.toFixed(0)}` : "—";

  // Trailing DD: Topstep rule — balance must stay above (peak − $2,000)
  const ddUsed      = peak != null && bal != null ? peak - bal : null;
  const ddBuffer    = ddUsed != null ? Math.max(0, 2000 - ddUsed) : null;
  const ddLine      = ddBuffer != null
    ? `DD used: $${ddUsed.toFixed(0)} / $2,000  (${ddBuffer.toFixed(0)} remaining)`
    : "";

  // Progress line — combine shows target; funded shows total earned on funded account
  const profitSoFar  = bal != null ? Math.max(0, bal - 50000) : null;
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
    by_strategy:   byStrat,
  });

  emitBundleEvent('WEEKLY_SUMMARY', { pnl: +netPnl.toFixed(2), wins: wins.length, losses: losses.length, trades: week.length, simulated: !!state.simulated });
  await notify("📅 Weekly recap", body, "default");
}

// ─── Minute tick loop ─────────────────────────────────────────────────────────
let lastBar5Min  = -1;   // tracks the 5-min bucket last evaluated (multiples of 5)
let lastBar15Min = -1;

async function tick() {
  const now = new Date();
  const hm  = now.getUTCHours() * 100 + now.getUTCMinutes();
  const min = now.getUTCMinutes();
  const sec = now.getUTCSeconds();

  // ── 5m evaluation — pre-close (primary) + post-close (fallback) ───────────
  // Bucket maps both the 4th-minute pre-close AND the 0th-minute post-close of
  // the same 5-min bar to one key — preventing double-evaluation of the same bar.
  // Formula: Math.floor((min+1)/5)*5 % 60 → e.g. min=49→50, min=50→50, min=59→0, min=0→0
  const bar5Bucket = (Math.floor((min + 1) / 5) * 5) % 60;

  // Pre-close: last 10 seconds of the 4th minute (e.g. 13:49:50–13:49:59).
  // includePartialBar=true returns the nearly-complete bar so signals fire ~10s
  // before the bar officially closes — entries land at a tighter price.
  if (min % 5 === 4 && sec >= 50 && bar5Bucket !== lastBar5Min) {
    lastBar5Min = bar5Bucket;
    await fetchBars(300, true).catch(console.error);   // near-final bar
    await reconcilePositions().catch(console.error);
    runEvaluate();
  }

  // Post-close fallback: first 10 seconds after bar close (e.g. 13:50:00–13:50:09).
  // includePartialBar=false — only fires if the pre-close tick was missed or the
  // API hadn't published the bar yet. Direction gate prevents any double-trade.
  if (min % 5 === 0 && sec <= 10 && bar5Bucket !== lastBar5Min) {
    lastBar5Min = bar5Bucket;
    await fetchBars(300, false).catch(console.error);  // confirmed closed bar
    await reconcilePositions().catch(console.error);
    runEvaluate();
  }

  // ── Post-boot re-evaluate: fires once if a trade closed while engine was down ──
  // Gives the signal a chance to re-enter immediately rather than waiting up to 5 min.
  if (_reEvaluateAfterBoot) {
    _reEvaluateAfterBoot = false;
    console.log("[Boot] 🔁 Post-recovery re-evaluate — checking if signal still valid");
    await fetchBars(300, false).catch(console.error);
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

  // Pre-session brief: 13:25 UTC (5 min before AM open)
  // getUTCSeconds() < 10 prevents double-fire — tick runs every 10s
  if (hm === 1325 && sec < 10) {
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

  // Weekly recap: Sunday 20:00 UTC (2:00 PM MDT / 1:00 PM MST)
  // Reads the trade log and summarises the past 7 days
  if (hm === 2000 && sec < 10 && now.getUTCDay() === 0) {
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
    state.runnerClosePending = false;
    state.consecutiveLosses  = 0;
    state.consecutiveWins   = 0;
    state.cooldownUntil     = 0;
    state.pendingRetry      = null;
    state.mismatchRetryDone = false;
    state.amSessionOpenPrice = null;
    state.amTrendChecked     = false;
    state.noShortsToday      = false;
    state.noLongsToday       = false;
    state.sessionLongWon     = false;
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
  console.log(`║  ES Futures  |  ${CFG.maxContracts} contracts max              ║`);
  console.log("╚══════════════════════════════════════════╝");

  if (!CFG.userName || !CFG.apiKey) {
    throw new Error("TV_USER and TV_API_KEY must be set in .env — fill in Topstep credentials");
  }

  await login();
  await resolveAccount();
  await resolveContract();
  await Promise.all([fetchBars(300), fetchBars15(300)]);  // load both timeframes in parallel
  await refreshNewsFilter();
  await connectHub();
  await recoverOpenPosition().catch(e => console.warn("[Boot] Recovery check failed:", e.message));

  // Compute upPct overbought gate from ES.txt tail (reliable 10-day history)
  {
    const { upPct, upCount, comparisons } = computeUpPct();
    state.upPctOverbought = upPct >= 0.8;
    console.log(`[Gate] Boot upPct(10d): ${(upPct * 100).toFixed(0)}% up-days (${upCount}/${comparisons}) — overbought gate: ${state.upPctOverbought ? "🔴 ACTIVE" : "✅ off"}`);
  }

  // Tick every 10 seconds — needed to reliably hit the pre-close window (last 10s of each bar)
  setInterval(() => tick().catch(console.error), 10_000);
  await tick();  // run immediately on boot

  console.log("[Boot] ✓ Engine running — waiting for session open");
  // contractId format: "CON.F.US.EP.U26" — extract the short name for the notification
  const contractShort = (state.contractId ?? "").split(".").slice(-2).join("") || CFG.contractSearch;
  await notify("🟢 Engine online", `TopstepX engine started\nAccount: $${state.peakBalance?.toFixed(0)}\nContract: ${contractShort}  |  Max: ${CFG.maxContracts}ct\nAM session opens 7:45 ${isDST() ? "MDT" : "MST"}`, "low");
}

main().catch(err => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
