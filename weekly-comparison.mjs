/**
 * Weekly backtest vs actual comparison
 * Runs every Friday at 3:07 PM MST after market close.
 *
 * 1. Updates bar data from TopstepX API (appends missing bars to NQ.txt / ES.txt)
 * 2. Runs the engine-accurate backtest restricted to Mon–Fri of the current week
 * 3. Parses actual trades from logs/trades.jsonl for the same window
 * 4. Prints a side-by-side comparison and sends a push notification
 */

import { createReadStream, readFileSync, existsSync } from "fs";
import { createInterface }  from "readline";
import { execFileSync }     from "child_process";
import { evaluate }         from "./engine/strategies.js";
import { evaluateNQ }       from "./engine/nq-strategies.js";

// ── Week bounds (Mon 00:00 UTC → Fri 23:59 UTC) ───────────────────────────────
const now     = new Date();
const dow     = now.getUTCDay(); // 0=Sun ... 5=Fri ... 6=Sat
const daysSinceMon = (dow === 0 ? 6 : dow - 1);
const weekMon = new Date(now);
weekMon.setUTCDate(now.getUTCDate() - daysSinceMon);
weekMon.setUTCHours(0, 0, 0, 0);
const weekFri = new Date(weekMon);
weekFri.setUTCDate(weekMon.getUTCDate() + 4);
weekFri.setUTCHours(23, 59, 59, 999);

const WEEK_START = weekMon.toISOString().slice(0, 10);
const WEEK_END   = weekFri.toISOString().slice(0, 10);

console.log(`\nWeekly comparison  ${WEEK_START} → ${WEEK_END}\n`);

// ── Update bar data ───────────────────────────────────────────────────────────
for (const script of ["fetch-nq-history.mjs", "fetch-es-history.mjs"]) {
  process.stdout.write(`Fetching ${script}... `);
  try {
    execFileSync("node", [script], { stdio: ["ignore", "ignore", "pipe"], timeout: 120_000 });
    console.log("done");
  } catch (err) {
    // Non-fatal — CSV may already be current enough
    console.log(`skipped (${err.message.split("\n")[0]})`);
  }
}

// ── Account configs (must mirror accounts.json + backtest-engine-accurate.mjs) ─
const ACCOUNTS = [
  {
    label:        "NQ",
    file:         "NQ.txt",
    contractPfx:  ["ENQ"],
    tickVal:      5.00,
    tickSz:       0.25,
    maxCt:        2,
    maxStopTicks: 40,
    cfgTpTicks:   110,
    dailyLimit:   450,
    enabled:      new Set(["DONCH15_L","3BAR_BEAR_S"]),
    evalFn:       (slice) => [...evaluate(slice), ...evaluateNQ(slice)],
  },
  {
    label:        "ES",
    file:         "ES.txt",
    contractPfx:  ["EP"],
    tickVal:      12.50,
    tickSz:       0.25,
    maxCt:        2,
    maxStopTicks: 25,
    cfgTpTicks:   48,
    dailyLimit:   450,
    enabled:      new Set(["EMA21_PULL_L","VOLBO_L","KELT_L"]),
    evalFn:       (slice) => evaluate(slice),
  },
];

// ── Bar loading ───────────────────────────────────────────────────────────────
async function loadBars(filename, fromDate, toDate) {
  const fromTs = new Date(fromDate + "T00:00:00Z").getTime() / 1000;
  const toTs   = new Date(toDate   + "T23:59:59Z").getTime() / 1000;

  const bars1m = [];
  await new Promise(r => {
    const rl = createInterface({ input: createReadStream(filename), crlfDelay: Infinity });
    rl.on("line", line => {
      if (!line.trim()) return;
      const p = line.split(",");
      if (p.length < 6) return;
      const [mo, dy, yr] = p[0].split("/");
      const [hr, mn]     = p[1].split(":");
      const ts = Date.UTC(+yr, +mo - 1, +dy, +hr, +mn) / 1000;
      if (ts < fromTs - 86400 * 30) return; // keep a 30-day lead-in for indicator warmup
      if (ts > toTs) return;
      bars1m.push({ time: ts, open: +p[2], high: +p[3], low: +p[4], close: +p[5] });
    });
    rl.on("close", r);
  });

  bars1m.sort((a, b) => a.time - b.time);

  // Aggregate to 5m
  const b5 = new Map();
  for (const b of bars1m) {
    const t5 = Math.floor(b.time / 300) * 300;
    if (!b5.has(t5)) {
      b5.set(t5, { time: t5, open: b.open, high: b.high, low: b.low, close: b.close });
    } else {
      const a = b5.get(t5);
      if (b.high > a.high) a.high = b.high;
      if (b.low  < a.low)  a.low  = b.low;
      a.close = b.close;
    }
  }
  return [...b5.values()].sort((a, b) => a.time - b.time);
}

// ── Backtest for the week ─────────────────────────────────────────────────────
function runWeekBacktest(bars, cfg) {
  const { tickVal, tickSz, maxCt, maxStopTicks, cfgTpTicks, dailyLimit, enabled, evalFn } = cfg;
  const weekStartTs = new Date(WEEK_START + "T00:00:00Z").getTime() / 1000;
  const weekEndTs   = new Date(WEEK_END   + "T23:59:59Z").getTime() / 1000;

  const trades     = [];
  const byDay      = {};
  let open         = null;
  let dayDate      = null;
  let dayPnL       = 0;
  let haltedToday  = false;
  let dayDirs      = new Set();

  for (let i = 215; i < bars.length; i++) {
    const bar  = bars[i];
    if (bar.time < weekStartTs || bar.time > weekEndTs) continue;

    const d    = new Date(bar.time * 1000);
    const date = d.toISOString().slice(0, 10);

    if (date !== dayDate) {
      if (dayDate) byDay[dayDate] = dayPnL;
      dayDate = date; dayPnL = 0; haltedToday = false; dayDirs = new Set();
      open = null;
    }

    if (open) {
      let result = null;
      if (open.isLong) {
        if (bar.high >= open.tpPx)   result =  open.tpTicks * tickVal * maxCt;
        if (bar.low  <= open.stopPx) result = -open.riskTicks * tickVal * maxCt;
      } else {
        if (bar.low  <= open.tpPx)   result =  open.tpTicks * tickVal * maxCt;
        if (bar.high >= open.stopPx) result = -open.riskTicks * tickVal * maxCt;
      }

      if (result !== null) {
        dayPnL += result;
        trades.push({ date, sig: open.sigId, isLong: open.isLong, pnl: result });
        if (dayPnL <= -dailyLimit) haltedToday = true;
        open = null;
      }
    }

    if (haltedToday || open) continue;

    const slice = bars.slice(Math.max(0, i - 300), i + 1);
    const sigs  = evalFn(slice);
    if (!sigs.length) continue;

    for (const sig of sigs) {
      const dir = sig.side;
      if (!enabled.has(sig.id)) continue;
      if (dayDirs.has(dir)) continue;

      const isLong   = dir === "long";
      const fill     = bar.close;
      const barLow   = sig.barLow  ?? fill;
      const barHigh  = sig.barHigh ?? fill;
      const sigStop  = sig.stopTicks ?? maxStopTicks;
      const sigTp    = sig.tpTicks   ?? cfgTpTicks;

      const totalRiskTicks = isLong
        ? Math.round((fill - barLow) / tickSz) + sigStop
        : Math.round((barHigh - fill) / tickSz) + sigStop;

      if (totalRiskTicks > maxStopTicks) continue;

      const stopPx = isLong ? barLow - sigStop * tickSz : barHigh + sigStop * tickSz;
      const tpPx   = isLong ? fill + sigTp * tickSz : fill - sigTp * tickSz;

      dayDirs.add(dir);
      open = { sigId: sig.id, isLong, fill, stopPx, tpPx, riskTicks: totalRiskTicks, tpTicks: sigTp };
      break;
    }
  }
  if (dayDate) byDay[dayDate] = dayPnL;

  return { trades, byDay };
}

// ── Parse actual trades ───────────────────────────────────────────────────────
function loadActualTrades(contractPfixes) {
  const path = "logs/trades.jsonl";
  if (!existsSync(path)) return { trades: [], byDay: {} };

  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const trades = [];
  const byDay  = {};

  for (const line of lines) {
    let t;
    try { t = JSON.parse(line); } catch { continue; }
    if (!t.date || t.date < WEEK_START || t.date > WEEK_END) continue;
    if (t.signal === "RECOVERED" || t.signal === "unknown") continue;
    if (!contractPfixes.some(pfx => (t.contract || "").startsWith(pfx))) continue;
    if (t.voided) continue;

    trades.push({ date: t.date, sig: t.signal, isLong: t.direction === "LONG", pnl: t.gross_pnl });
    byDay[t.date] = (byDay[t.date] || 0) + t.gross_pnl;
  }

  return { trades, byDay };
}

// ── Format helpers ────────────────────────────────────────────────────────────
function pnlStr(n) { return n >= 0 ? `+$${Math.round(n)}` : `-$${Math.round(Math.abs(n))}`; }

function sigBreakdown(trades) {
  const m = {};
  for (const t of trades) {
    if (!m[t.sig]) m[t.sig] = { trades: 0, wins: 0, pnl: 0 };
    m[t.sig].trades++;
    if (t.pnl > 0) m[t.sig].wins++;
    m[t.sig].pnl += t.pnl;
  }
  return m;
}

// ── Push notification ─────────────────────────────────────────────────────────
async function notify(title, body) {
  try {
    const { default: axios } = await import("axios");
    const cfg = JSON.parse(readFileSync("config.json", "utf8"));
    await axios.post("https://api.pushover.net/1/messages.json", {
      token: cfg.PUSHOVER_APP_TOKEN, user: cfg.PUSHOVER_USER_KEY,
      title, message: body, priority: 0,
    });
  } catch { /* notifications are best-effort */ }
}

// ── Main ──────────────────────────────────────────────────────────────────────
const pushLines = [];
let totalBtPnL  = 0;
let totalActPnL = 0;

for (const acct of ACCOUNTS) {
  if (!existsSync(acct.file)) {
    console.log(`${acct.label}: ${acct.file} not found, skipping\n`);
    continue;
  }

  process.stdout.write(`Loading ${acct.label} bars... `);
  const bars = await loadBars(acct.file, WEEK_START, WEEK_END);
  console.log(`${bars.length} 5m bars in window`);

  const btResult  = runWeekBacktest(bars, acct);
  const actResult = loadActualTrades(acct.contractPfx);

  const btPnL     = btResult.trades.reduce((s, t) => s + t.pnl, 0);
  const actPnL    = actResult.trades.reduce((s, t) => s + t.pnl, 0);
  const btBySig   = sigBreakdown(btResult.trades);
  const actBySig  = sigBreakdown(actResult.trades);
  totalBtPnL  += btPnL;
  totalActPnL += actPnL;

  console.log(`\n${"─".repeat(62)}`);
  console.log(`  ${acct.label}  |  Backtest: ${pnlStr(btPnL)}  |  Actual: ${pnlStr(actPnL)}`);
  console.log(`${"─".repeat(62)}`);

  // Day-by-day
  const allDays = [...new Set([...Object.keys(btResult.byDay), ...Object.keys(actResult.byDay)])].sort();
  if (allDays.length) {
    console.log(`  Day         Backtest    Actual      Δ`);
    for (const d of allDays) {
      const bt  = btResult.byDay[d]  ?? null;
      const act = actResult.byDay[d] ?? null;
      const delta = (bt !== null && act !== null) ? pnlStr(act - bt) : "—";
      const day = new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
      console.log(`  ${day.padEnd(12)} ${(bt !== null ? pnlStr(bt) : "—").padStart(8)}    ${(act !== null ? pnlStr(act) : "—").padStart(8)}    ${delta}`);
    }
  } else {
    console.log("  No signal trades this week in either backtest or actual logs.");
  }

  // Signal breakdown
  const allSigs = [...new Set([...Object.keys(btBySig), ...Object.keys(actBySig)])].sort();
  if (allSigs.length) {
    console.log(`\n  Signal           BT Trades  BT P&L     Act Trades  Act P&L`);
    for (const s of allSigs) {
      const b = btBySig[s]  || { trades: 0, wins: 0, pnl: 0 };
      const a = actBySig[s] || { trades: 0, wins: 0, pnl: 0 };
      const bStr = b.trades ? `${b.trades}t ${b.wins}W ${pnlStr(b.pnl)}` : "—";
      const aStr = a.trades ? `${a.trades}t ${a.wins}W ${pnlStr(a.pnl)}` : "—";
      console.log(`  ${s.padEnd(16)} ${bStr.padEnd(14)} ${aStr}`);
    }
  }
  console.log();

  // Push notification line per account
  const actWins   = actResult.trades.filter(t => t.pnl > 0).length;
  const actLosses = actResult.trades.filter(t => t.pnl < 0).length;
  pushLines.push(`${acct.label}  BT ${pnlStr(btPnL)}  |  Act ${pnlStr(actPnL)}  ${actWins}W${actLosses}L`);
}

// Totals
console.log(`${"═".repeat(62)}`);
console.log(`  TOTAL  |  Backtest: ${pnlStr(totalBtPnL)}  |  Actual: ${pnlStr(totalActPnL)}`);
console.log(`${"═".repeat(62)}\n`);

// Push
const wkEnd  = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Phoenix" });
const title  = `📅 Weekly ${WEEK_START.slice(5)} BT ${pnlStr(totalBtPnL)} vs Act ${pnlStr(totalActPnL)}`;
const body   = [...pushLines, "─".repeat(24), `Net  BT ${pnlStr(totalBtPnL)} | Act ${pnlStr(totalActPnL)}`].join("\n");
await notify(title, body);
console.log("Push notification sent.\n");
