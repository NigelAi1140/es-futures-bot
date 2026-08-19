/**
 * ES Forward-Test Logger
 * ─────────────────────────────────────────────────────────────────
 * Runs V3 signals on live ES bar data pulled from TopstepX.
 * Simulates trade outcomes (stop/TP). NEVER places any orders.
 * Runs alongside the live NQ bot as a zero-risk parallel market.
 *
 * ES tick: 0.25pt = $12.50/tick/contract
 * Stop: 13t ($162.50) | TP: 42t ($525)
 * Session: AM 13:45-15:00 UTC + PM 18:30-20:30 UTC
 *
 * Log files:
 *   logs/es-forward-test.log         — human-readable daily log
 *   logs/es-forward-test-trades.json — machine-readable trade records
 *
 * Run:  node engine/es-forward-test.mjs
 * PM2:  pm2 start engine/es-forward-test.mjs --name es-forward-test
 */

import axios          from "axios";
import { evaluate, evaluateExtended } from "./strategies.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir    = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dir, "..", "logs");
if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

const LOG_TXT  = join(LOGS_DIR, "es-forward-test.log");
const LOG_JSON = join(LOGS_DIR, "es-forward-test-trades.json");

const REST   = "https://api.topstepx.com";
const USER   = process.env.TV_USER    || "nicholas11morris@gmail.com";
const APIKEY = process.env.TV_API_KEY || "j7aI2WhpXbtRKe3KNkyHWfNNMwtTecQRPpNIkzTr9N4=";

const TICK_SIZE = 0.25;
const TICK_VAL  = 12.50;   // ES: $50/pt × 0.25pt/tick
const STOP_T    = 13;       // ticks
const TP_T      = 42;       // ticks

// Session windows (UTC) — mirrors live engine
const inSession = (t) => {
  const hm = new Date(t * 1000).getUTCHours() * 100 + new Date(t * 1000).getUTCMinutes();
  return (hm >= 1345 && hm < 1500) || (hm >= 1830 && hm < 1900);
};

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
  const d = await apiPost("/api/Contract/search", { searchText: "ES", live: false });
  const contracts = (d.contracts || []).filter(c => c.id?.startsWith("CON.F.US.EP"));
  if (!contracts.length) throw new Error("No ES contract found");
  contracts.sort((a, b) => a.id.localeCompare(b.id));
  const contract = contracts[0];
  log(`✓ Contract: ${contract.id} (${contract.name})`);
  return contract.id;
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

// ── Paper trade tracker ───────────────────────────────────────────────────────
const openTrades = new Map();
let lastDate  = null;
let dayPnL    = 0;
let dayTrades = 0;
let dayWins   = 0;
let totalPnL  = 0;
let totalTrades = 0;
let totalWins   = 0;

function resetDay(date) {
  if (lastDate === date) return;
  if (lastDate) {
    log(`📊 Day closed [${lastDate}] trades=${dayTrades} wins=${dayWins}/${dayTrades} P&L=$${dayPnL.toFixed(0)} | cumulative=$${totalPnL.toFixed(0)}`);
  }
  openTrades.clear();
  dayPnL = 0; dayTrades = 0; dayWins = 0;
  lastDate = date;
}

function checkOpenTrades(bar) {
  for (const [sid, t] of openTrades.entries()) {
    let result = null;
    if (t.side === "long") {
      if (bar.low  <= t.stopPx) result = -(STOP_T * TICK_VAL);
      else if (bar.high >= t.tpPx)  result =  (TP_T   * TICK_VAL);
    } else {
      if (bar.high >= t.stopPx) result = -(STOP_T * TICK_VAL);
      else if (bar.low  <= t.tpPx)  result =  (TP_T   * TICK_VAL);
    }
    if (result !== null) {
      const outcome = result > 0 ? "✅ TP" : "❌ SL";
      dayPnL += result; totalPnL += result;
      dayTrades++; totalTrades++;
      if (result > 0) { dayWins++; totalWins++; }
      const wr = totalTrades ? (100 * totalWins / totalTrades).toFixed(1) : "0.0";
      log(`${outcome} ${t.side.toUpperCase()} ${sid} @ ${t.side === "long" ? t.stopPx : t.tpPx} → $${result >= 0 ? "+" : ""}${result} | day=$${dayPnL.toFixed(0)} | total=$${totalPnL.toFixed(0)} WR:${wr}%`);
      logTrade({ time: new Date().toISOString(), signal: sid, side: t.side, entry: t.entry, result, dayPnL, totalPnL });
      openTrades.delete(sid);
    }
  }
}

function openTrade(sig, bar) {
  if (openTrades.has(sig.id)) return;
  const isLong = sig.side === "long";
  const entry  = bar.close;
  const stopPx = isLong ? entry - STOP_T * TICK_SIZE : entry + STOP_T * TICK_SIZE;
  const tpPx   = isLong ? entry + TP_T   * TICK_SIZE : entry - TP_T   * TICK_SIZE;
  openTrades.set(sig.id, { side: sig.side, entry, stopPx, tpPx });
  log(`📋 [ES FWD] ${sig.id} ${sig.side.toUpperCase()} @ $${entry.toFixed(2)} | stop $${stopPx.toFixed(2)} | TP $${tpPx.toFixed(2)}`);
}

// ── Main poll loop ────────────────────────────────────────────────────────────
let   bars        = [];
let   lastBarTime = 0;
let   contractId  = null;

async function poll() {
  try {
    const fresh = await fetchBars(contractId);
    if (!fresh || fresh.length < 2) return;

    // Integrate new bars
    for (const b of fresh) {
      if (b.time > lastBarTime) {
        bars.push(b);
        if (bars.length > 300) bars.shift();
        lastBarTime = b.time;

        const date = new Date(b.time * 1000).toISOString().slice(0, 10);
        resetDay(date);
        checkOpenTrades(b);

        if (!inSession(b.time)) continue;
        if (bars.length < 215)  continue;

        const sigs = [...evaluate(bars), ...evaluateExtended(bars)];
        for (const sig of sigs) {
          if (!openTrades.has(sig.id)) openTrade(sig, b);
        }
      }
    }
  } catch (e) {
    log(`⚠ poll error: ${e.message}`);
  }
}

async function main() {
  log("═══════════════════════════════════════════");
  log("  ES Forward Test — V3 signals, no orders  ");
  log("═══════════════════════════════════════════");
  await login();
  contractId = await resolveContract();

  // Initial bar load
  const initial = await fetchBars(contractId);
  if (initial) {
    bars = initial.slice(-300);
    lastBarTime = bars.at(-1)?.time ?? 0;
    log(`Loaded ${bars.length} historical bars`);
  }

  // Poll every 60s (new 5m bar lands roughly on the minute)
  setInterval(poll, 60_000);
  log("Polling every 60s — watching for ES signals");
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
