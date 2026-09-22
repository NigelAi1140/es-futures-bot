/**
 * PM_VWAP_S Forward Test — paper trade monitor
 * ─────────────────────────────────────────────────────────────────
 * Signal benched from live bot 2026-09-21 due to 35% WR in current regime.
 * This script paper-trades it in isolation to track recovery.
 * NEVER places real orders.
 *
 * Signal: NQ PM session (18:00–20:00 UTC / 12:00–2:00 PM MDT)
 *   Fire when close is >= 15 ticks ABOVE PM VWAP → short
 *   TP = 28t ($140/ct), SL = 8t ($40/ct), 1 trade/day max
 *
 * Log files:
 *   logs/pm-vwap-s-forward-test.log         — human-readable daily log
 *   logs/pm-vwap-s-forward-test-trades.json — machine-readable trade records
 */
import axios from "axios";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir    = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dir, "..", "logs");
if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

const LOG_TXT  = join(LOGS_DIR, "pm-vwap-s-forward-test.log");
const LOG_JSON = join(LOGS_DIR, "pm-vwap-s-forward-test-trades.json");

const REST = "https://api.topstepx.com";

// Read credentials from accounts.json (same source as main engine)
const ACCOUNTS_PATH = join(__dir, "..", "accounts.json");
if (!existsSync(ACCOUNTS_PATH)) { console.error("accounts.json not found"); process.exit(1); }
const accounts = JSON.parse(readFileSync(ACCOUNTS_PATH, "utf8"));
const acct = Object.values(accounts)[0];
const USER   = acct.TV_USER;
const APIKEY = acct.TV_API_KEY;

if (!USER || !APIKEY) {
  console.error("TV_USER / TV_API_KEY missing in accounts.json");
  process.exit(1);
}

const TICK     = 0.25;
const TICK_VAL = 20;    // NQ: $20/tick/contract
const SL_T     = 8;
const TP_T     = 28;
const DEV_T    = 15;    // ticks above VWAP to trigger
const PM_START = 1800;  // UTC hhmm
const PM_END   = 2000;

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

// ── TopstepX API ──────────────────────────────────────────────────────────────
let token = null;

async function apiPost(path, body = {}, retries = 3) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.post(`${REST}${path}`, body, { headers, timeout: 15_000 });
      return res.data;
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

async function login() {
  const res = await apiPost("/api/Auth/loginKey", { userName: USER, apiKey: APIKEY });
  if (!res.success) throw new Error(`Login failed: ${res.errorMessage}`);
  token = res.token;
}

async function getContractId() {
  const res = await apiPost("/api/Contract/search", { searchText: "NQ", live: true });
  if (!res.success || !res.contracts?.length) return null;
  // Pick front-month NQ futures
  const nq = res.contracts
    .filter(c => c.name?.startsWith("NQ") && c.id?.includes("ENQ"))
    .sort((a, b) => a.id.localeCompare(b.id));
  return nq[0]?.id ?? null;
}

async function fetchBars(contractId, limitHours = 4) {
  const now   = new Date();
  const start = new Date(now - limitHours * 60 * 60 * 1000);
  const res   = await apiPost("/api/History/retrieveBars", {
    contractId,
    live:             true,
    startTime:        start.toISOString(),
    endTime:          now.toISOString(),
    unit:             2,   // Minute
    unitNumber:       5,   // 5m bars
    limit:            200,
    includePartialBar: false,
  });
  if (!res.success) throw new Error(`fetchBars failed: ${res.errorMessage}`);
  return (res.bars || [])
    .map(b => ({
      time:  new Date(b.t).getTime() / 1000,
      open:  +b.o, high: +b.h, low: +b.l, close: +b.c, vol: b.v,
      hm:    (() => { const d = new Date(b.t); return d.getUTCHours() * 100 + d.getUTCMinutes(); })(),
    }))
    .sort((a, b) => a.time - b.time);
}

// ── Signal evaluation ─────────────────────────────────────────────────────────
// Returns { fired: true, entry } when PM_VWAP_S triggers, else null
function evalPMVwapS(bars) {
  let pv = 0, vol = 0;
  for (const b of bars) {
    if (b.hm < PM_START || b.hm >= PM_END) continue;
    const tp3 = (b.high + b.low + b.close) / 3;
    pv  += tp3 * b.vol;
    vol += b.vol;
  }
  if (vol === 0) return null;
  const vwap = pv / vol;
  const last = [...bars].reverse().find(b => b.hm >= PM_START && b.hm < PM_END);
  if (!last) return null;
  const dev = (last.close - vwap) / TICK;
  return dev >= DEV_T ? { fired: true, entry: last.close, vwap, dev } : null;
}

// ── Paper trade simulator ─────────────────────────────────────────────────────
// Looks at subsequent bars on the same date and resolves TP/SL/EOD
function simTrade(bars, entryBar, entryPrice, contractId) {
  const entryDate = new Date(entryBar.time * 1000).toISOString().slice(0, 10);
  const tp    = entryPrice - TP_T * TICK;
  const stop  = entryPrice + SL_T * TICK;
  const entryIdx = bars.findIndex(b => b.time === entryBar.time);

  for (let i = entryIdx + 1; i < bars.length; i++) {
    const b    = bars[i];
    const date = new Date(b.time * 1000).toISOString().slice(0, 10);
    if (date !== entryDate || b.hm >= PM_END) {
      // EOD — exit at open of next bar
      const exitPx = b.open;
      const pnl    = (entryPrice - exitPx) / TICK * TICK_VAL - 9;
      return { result: "EOD", exitPrice: exitPx, pnl };
    }
    if (b.low  <= tp)   return { result: "TP",   exitPrice: tp,   pnl:  TP_T * TICK_VAL - 9 };
    if (b.high >= stop) return { result: "SL",   exitPrice: stop, pnl: -SL_T * TICK_VAL - 9 };
  }
  return null; // still open
}

// ── State ─────────────────────────────────────────────────────────────────────
let firedDate   = null; // only one trade per calendar day
let openTrade   = null; // { entryBar, entryPrice, contractId }
let contractId  = null;

// ── Main loop ─────────────────────────────────────────────────────────────────
async function tick() {
  const now = new Date();
  const hm  = now.getUTCHours() * 100 + now.getUTCMinutes();
  const today = now.toISOString().slice(0, 10);

  // Only run during or just after PM session
  if (hm < PM_START - 30 || hm > PM_END + 60) return;

  try {
    if (!token) await login();

    if (!contractId) {
      contractId = await getContractId();
      if (!contractId) { log("[Contract] No live NQ contract found — market closed?"); return; }
      log(`[Contract] ${contractId}`);
    }

    const bars = await fetchBars(contractId);
    if (!bars.length) return;

    // Resolve open trade
    if (openTrade) {
      const result = simTrade(bars, openTrade.entryBar, openTrade.entryPrice);
      if (result) {
        const pnl = result.pnl;
        log(`[Trade] ${result.result} @ ${result.exitPrice.toFixed(2)} — P&L: $${pnl.toFixed(0)}`);
        logTrade({
          date:       today,
          signal:     "NQ_PM_VWAP_FADE_S",
          entryPrice: openTrade.entryPrice,
          exitPrice:  result.exitPrice,
          result:     result.result,
          pnl,
          vwap:       openTrade.vwap,
          devTicks:   openTrade.dev,
        });
        openTrade = null;
      }
      return;
    }

    // Look for new entry
    if (firedDate === today) return;

    const sig = evalPMVwapS(bars);
    if (!sig) return;

    firedDate  = today;
    openTrade  = { entryBar: bars.at(-1), entryPrice: sig.entry, vwap: sig.vwap, dev: sig.dev };
    log(`[Signal] PM_VWAP_S fired — entry=${sig.entry.toFixed(2)} vwap=${sig.vwap.toFixed(2)} dev=${sig.dev.toFixed(1)}t`);
    log(`[Trade]  Short @ ${sig.entry.toFixed(2)} | TP=${(sig.entry - TP_T * TICK).toFixed(2)} SL=${(sig.entry + SL_T * TICK).toFixed(2)}`);

  } catch (e) {
    if (e.response?.status === 401) { token = null; }
    log(`[Error] ${e.message}`);
  }
}

// Run every 5 minutes
log("[Boot] PM_VWAP_S forward test started");
tick();
setInterval(tick, 5 * 60 * 1000);
