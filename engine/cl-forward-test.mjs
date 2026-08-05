/**
 * CL Forward-Test Logger
 * ─────────────────────────────────────────────────────────────────
 * Runs V3 signals on live CL bar data. Logs every signal and
 * simulates trade outcomes (stop/TP). NEVER places any orders.
 * Completely isolated from live NQ accounts.
 *
 * Config tracked:
 *   Signals:  all 7 V3 signals (to capture full picture)
 *   Session:  13:15-19:00 UTC (same as research best window)
 *   Stops/TP: ATR-normalized (V3 calibration ratios)
 *
 * Log files:
 *   logs/cl-forward-test.log       — human-readable daily log
 *   logs/cl-forward-test-trades.json — machine-readable trade records
 *
 * Run: node engine/cl-forward-test.mjs
 * PM2: pm2 start engine/cl-forward-test.mjs --name cl-forward-test
 */
import axios         from "axios";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir    = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dir, "..", "logs");
if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

const LOG_TXT        = join(LOGS_DIR, "cl-forward-test.log");
const LOG_JSON       = join(LOGS_DIR, "cl-forward-test-trades.json");
const NQ_STATE_PATH  = join(LOGS_DIR, "nq-state.json");

// Priority-stack gate: CL only fires when NQ dayPnL > -$300
// Backtest result: best Sharpe (0.69) at -$300 gate. See backtest-priority-stack.mjs.
const NQ_GATE_THRESHOLD  = -300;

// CL daily loss limit — halt sim trading for the rest of the day once hit
// Set to $300 (~2 full stop-outs). Tune after 4+ weeks of forward test data.
const CL_DAILY_LOSS_LIMIT = -300;

const REST  = "https://api.topstepx.com";
const USER  = process.env.TV_USER  || "nicholas11morris@gmail.com";
const APIKEY= process.env.TV_API_KEY || "j7aI2WhpXbtRKe3KNkyHWfNNMwtTecQRPpNIkzTr9N4=";

const TICK_SZ  = 0.01;
const TICK_VAL = 10.00;

// ATR-normalized stops derived from V3 ES calibration ratios.
// DONCH15_L excluded: backtest 2026-07-09→08-04 showed 0 wins from 12 attempts
// on CL (-$3,150 drag). Signal is NQ-optimized and misfires on oil's
// shorter intraday trend legs. All other signals retained.
const SIGS = {
  VOLBO_L:      { side:"long",  atrStop:0.375, atrTP:0.75 },
  VOLBO_S:      { side:"short", atrStop:0.375, atrTP:0.75 },
  EMA21_PULL_L: { side:"long",  atrStop:0.375, atrTP:1.00 },
  BO10_S:       { side:"short", atrStop:0.50,  atrTP:1.50 },
  "3BAR_BEAR_S":{ side:"short", atrStop:0.625, atrTP:4.00 },
  KELT_L:       { side:"long",  atrStop:0.94,  atrTP:3.00 },
};

// Session window: AM 13:15-15:00 UTC + PM 18:00-19:00 UTC
const inSession = (t) => {
  const hm = new Date(t * 1000).getUTCHours() * 100 + new Date(t * 1000).getUTCMinutes();
  return (hm >= 1315 && hm < 1500) || (hm >= 1800 && hm < 1900);
};

// ── Logging ───────────────────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
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

// ── Indicators ────────────────────────────────────────────────────────────────
const ema = (arr, len) => {
  if (arr.length < len) return null;
  const k = 2/(len+1);
  let e = arr.slice(0,len).reduce((s,x)=>s+x,0)/len;
  for (let i=len; i<arr.length; i++) e = arr[i]*k+e*(1-k);
  return e;
};
const rsi = (closes, len=14) => {
  if (closes.length < len+1) return null;
  let g=0,l=0;
  for (let i=1; i<=len; i++) { const d=closes[i]-closes[i-1]; if(d>=0)g+=d; else l-=d; }
  let ag=g/len,al=l/len;
  for (let i=len+1; i<closes.length; i++) {
    const d=closes[i]-closes[i-1];
    ag=(ag*(len-1)+(d>=0?d:0))/len; al=(al*(len-1)+(d<0?-d:0))/len;
  }
  return al===0?100:100-100/(1+ag/al);
};
const adxFn = (bars, len=14) => {
  if (bars.length < len+1) return null;
  const trs=[],pdms=[],ndms=[];
  for (let i=1; i<bars.length; i++) {
    const b=bars[i],p=bars[i-1];
    trs.push(Math.max(b.high-b.low,Math.abs(b.high-p.close),Math.abs(b.low-p.close)));
    const up=b.high-p.high, dn=p.low-b.low;
    pdms.push(up>dn&&up>0?up:0); ndms.push(dn>up&&dn>0?dn:0);
  }
  let atr=trs.slice(0,len).reduce((a,x)=>a+x,0)/len;
  let pdm=pdms.slice(0,len).reduce((a,x)=>a+x,0)/len;
  let ndm=ndms.slice(0,len).reduce((a,x)=>a+x,0)/len;
  for (let i=len; i<trs.length; i++) {
    atr=(atr*(len-1)+trs[i])/len; pdm=(pdm*(len-1)+pdms[i])/len; ndm=(ndm*(len-1)+ndms[i])/len;
  }
  if (!atr) return 0;
  const pdi=100*pdm/atr, ndi=100*ndm/atr;
  return (pdi+ndi)===0?0:100*Math.abs(pdi-ndi)/(pdi+ndi);
};
const atrFn = (bars, len=14) => {
  if (bars.length < len+1) return null;
  let s=0;
  for (let i=1; i<=len; i++) {
    const b=bars[bars.length-i],pb=bars[bars.length-i-1];
    s+=Math.max(b.high-b.low,Math.abs(b.high-pb.close),Math.abs(b.low-pb.close));
  }
  return s/len;
};

function evaluate(bars) {
  if (bars.length < 215) return [];
  const last=bars.at(-1), prev=bars.at(-2);
  const b3=bars.at(-3), b4=bars.at(-4);
  const c=last.close;
  const closes=bars.map(b=>b.close), highs=bars.map(b=>b.high), lows=bars.map(b=>b.low);
  const vols=bars.map(b=>b.volume);

  const e200=ema(closes,200), e21=ema(closes,21), e21Prv=ema(closes.slice(0,-1),21);
  const r14=rsi(closes,14), adx14=adxFn(bars,14), atr14=atrFn(bars,14);
  if (!e200||!e21||r14===null||adx14===null||!atr14) return [];

  const aboveEMA=c>e200, inTrend=adx14>18;
  const lo10=Math.min(...lows.slice(-11,-1));
  const volAvg=vols.length>=21?vols.slice(-21,-1).reduce((a,x)=>a+x,0)/20:null;
  const kcDnNow=e21-1.5*atr14, kcDnPrev=e21Prv?e21Prv-1.5*atr14:null;

  const sigs=[];
  if (volAvg&&last.volume>volAvg*2&&c>last.open&&c>prev.close&&aboveEMA&&r14>35&&r14<75) sigs.push("VOLBO_L");
  if (volAvg&&last.volume>volAvg*2&&c<last.open&&c<prev.close&&!aboveEMA&&r14<65) sigs.push("VOLBO_S");
  if (e21Prv&&prev.low<=e21Prv&&c>e21&&c>prev.close&&aboveEMA&&inTrend&&r14>30&&r14<65) sigs.push("EMA21_PULL_L");
  if (lo10&&prev.close>=lo10&&c<lo10&&!aboveEMA&&inTrend) sigs.push("BO10_S");
  if (b4&&b3&&b3.close>b3.open&&prev.close>prev.open&&c<last.open&&c<prev.close&&c<b3.close&&(adx14<25||!aboveEMA)) sigs.push("3BAR_BEAR_S");
  if (kcDnPrev&&prev.close<=kcDnPrev&&c>kcDnNow&&aboveEMA&&r14>25) sigs.push("KELT_L");
  return sigs;
}

// ── Priority-stack gate ───────────────────────────────────────────────────────
// Returns { gated: bool, nqDayPnL: number|null, reason: string }
function checkNQGate() {
  try {
    if (!existsSync(NQ_STATE_PATH)) return { gated: false, nqDayPnL: null, reason: "no-state-file (ungated)" };
    const s = JSON.parse(readFileSync(NQ_STATE_PATH, "utf8"));
    const today = new Date().toISOString().slice(0, 10);
    if (s.date !== today) return { gated: false, nqDayPnL: null, reason: `stale-state (${s.date}, ungated)` };
    const gated = s.dayPnL <= NQ_GATE_THRESHOLD;
    return { gated, nqDayPnL: s.dayPnL, reason: gated ? `NQ dayPnL $${s.dayPnL} ≤ gate $${NQ_GATE_THRESHOLD}` : `NQ dayPnL $${s.dayPnL} OK` };
  } catch {
    return { gated: false, nqDayPnL: null, reason: "read-error (ungated)" };
  }
}

// ── TopstepX API ──────────────────────────────────────────────────────────────
let token = null;
async function apiPost(path, body={}, retries=3) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  for (let attempt=0; attempt<=retries; attempt++) {
    try {
      const res = await axios.post(`${REST}${path}`, body, { headers, timeout:15000 });
      return res.data;
    } catch(err) {
      if (attempt<retries) { await new Promise(r=>setTimeout(r,2000*(attempt+1))); continue; }
      throw err;
    }
  }
}

async function login() {
  const d = await apiPost("/api/Auth/loginKey", { userName: USER, apiKey: APIKEY });
  if (!d.success) throw new Error(`Auth failed: ${d.errorMessage}`);
  token = d.token;
  log("✓ Authenticated with TopstepX");
  // Re-auth every 22h
  setTimeout(login, 22*60*60*1000);
}

async function resolveContract() {
  const d = await apiPost("/api/Contract/search", { searchText: "CL", live: false });
  const contracts = (d.contracts || []).filter(c => c.id?.startsWith("CON.F.US.CLE"));
  if (!contracts.length) throw new Error("No CL contract found");
  // Pick the nearest expiry
  contracts.sort((a,b) => a.id.localeCompare(b.id));
  const contract = contracts[0];
  log(`✓ Contract: ${contract.id} (${contract.name})`);
  return contract.id;
}

async function fetchBars(contractId) {
  const now   = new Date();
  const start = new Date(now - 72*60*60*1000); // 72h back for enough warm-up bars
  const d = await apiPost("/api/History/retrieveBars", {
    contractId,
    live: false,
    startTime: start.toISOString(),
    endTime:   now.toISOString(),
    unit:      2,    // Minute
    unitNumber:5,    // 5m bars
    limit:     350,
    includePartialBar: false,
  });
  if (!d.success) { log(`⚠ fetchBars failed: ${d.errorMessage}`); return null; }
  return d.bars
    .map(b => ({ time:new Date(b.t).getTime()/1000, open:+b.o, high:+b.h, low:+b.l, close:+b.c, volume:b.v }))
    .sort((a,b)=>a.time-b.time);
}

// ── Paper trade tracker ───────────────────────────────────────────────────────
// openTrades: Map<signalId, { side, entry, stopPx, tpPx, stopTicks, tpTicks, openTime, atr }>
const openTrades = new Map();
const gate       = new Set(); // "long" | "short"
let   lastDate   = null;
let   dayPnL     = 0;
let   dayTrades  = 0;
let   dayWins    = 0;
let   dayLosses  = 0;   // consecutive intraday loss count
let   totalPnL   = 0;
let   totalTrades= 0;
let   totalWins  = 0;

// After 2 losses in a day, shut down new entries for that day.
// Backtest 2026-07-09→08-04: this alone cut losses from -$2,470 → -$370.
const CL_MAX_DAY_LOSSES = 2;

function resetDay(date) {
  if (lastDate && lastDate !== date) {
    log(`📊 Day closed [${lastDate}] trades=${dayTrades} wins=${dayWins} P&L=$${dayPnL.toFixed(0)} | cumulative=$${totalPnL.toFixed(0)}`);
  }
  gate.clear();
  openTrades.clear();
  dayPnL=0; dayTrades=0; dayWins=0; dayLosses=0;
  lastDate=date;
}

function checkOpenTrades(bars) {
  for (const [sid, t] of openTrades.entries()) {
    const bar = bars.at(-1);
    let result = null;

    if (t.side==="long") {
      if (bar.low  <= t.stopPx) result = -t.stopTicks * TICK_VAL;
      else if (bar.high >= t.tpPx) result = t.tpTicks * TICK_VAL;
    } else {
      if (bar.high >= t.stopPx) result = -t.stopTicks * TICK_VAL;
      else if (bar.low  <= t.tpPx)  result = t.tpTicks * TICK_VAL;
    }

    if (result !== null) {
      const outcome = result > 0 ? "✅ TP" : "❌ SL";
      dayPnL   += result; totalPnL   += result;
      dayTrades++; totalTrades++;
      if (result>0) { dayWins++; totalWins++; } else { dayLosses++; }
      const totalWR = totalTrades ? (100*totalWins/totalTrades).toFixed(1) : "0.0";
      log(`${outcome} ${t.side.toUpperCase()} ${sid} @ ${t.entry.toFixed(2)} → ${result>0?"+":""}$${result.toFixed(0)} | day=$${dayPnL.toFixed(0)} | total=$${totalPnL.toFixed(0)} WR:${totalWR}%`);
      logTrade({
        timestamp: new Date().toISOString(),
        date:      lastDate,
        signal:    sid,
        side:      t.side,
        entry:     t.entry,
        stopPx:    t.stopPx,
        tpPx:      t.tpPx,
        result,
        outcome:   result>0 ? "TP" : "SL",
        atr:       t.atr,
        openTime:  t.openTime,
        closeTime: bar.time,
      });
      gate.delete(t.side);
      openTrades.delete(sid);
    }
  }
}

// ── Main tick ─────────────────────────────────────────────────────────────────
let contractId = null;

async function tick() {
  const bars = await fetchBars(contractId);
  if (!bars || bars.length < 220) { log("⚠ Not enough bars — market closed or thin"); return; }

  const now  = bars.at(-1);
  const date = new Date(now.time*1000).toISOString().slice(0,10);

  if (date !== lastDate) resetDay(date);

  // Check open paper trades against new bars
  if (openTrades.size > 0) checkOpenTrades(bars);

  if (!inSession(now.time)) return;

  // Daily loss limit — halt for the rest of the day
  if (dayPnL <= CL_DAILY_LOSS_LIMIT) {
    log(`⛔ CL daily loss limit hit ($${dayPnL.toFixed(0)}) — halted for today`);
    return;
  }

  // 2-loss/day halt — stop taking new entries after 2 losses
  if (dayLosses >= CL_MAX_DAY_LOSSES) {
    log(`⛔ CL 2-loss halt (${dayLosses} losses today, day P&L $${dayPnL.toFixed(0)}) — no new entries`);
    return;
  }

  const sigs = evaluate(bars);
  if (!sigs.length) return;

  const atr = atrFn(bars, 14);
  if (!atr) return;

  // Priority-stack gate: suppress CL signals if NQ is having a bad day
  const gateCheck = checkNQGate();
  if (gateCheck.gated) {
    log(`⛔ GATED [${gateCheck.reason}] — ${sigs.length} signal(s) suppressed: ${sigs.join(", ")}`);
    return;
  }
  if (gateCheck.nqDayPnL !== null) {
    log(`✅ Gate OK [${gateCheck.reason}]`);
  }

  for (const sid of sigs) {
    const def = SIGS[sid];
    if (gate.has(def.side)) continue;
    if (openTrades.has(sid)) continue;

    gate.add(def.side);

    const stopDist  = atr * def.atrStop;
    const tpDist    = atr * def.atrTP;
    const entry     = now.close;
    const stopPx    = def.side==="long" ? entry-stopDist : entry+stopDist;
    const tpPx      = def.side==="long" ? entry+tpDist   : entry-tpDist;
    const stopTicks = Math.round(stopDist/TICK_SZ);
    const tpTicks   = Math.round(tpDist/TICK_SZ);

    openTrades.set(sid, { side:def.side, entry, stopPx, tpPx, stopTicks, tpTicks, openTime:now.time, atr });

    log(`📍 SIGNAL ${def.side.toUpperCase()} ${sid} @ ${entry.toFixed(2)} | stop=${stopPx.toFixed(2)} (${stopTicks}t=$${(stopTicks*TICK_VAL).toFixed(0)}) tp=${tpPx.toFixed(2)} (${tpTicks}t=$${(tpTicks*TICK_VAL).toFixed(0)}) atr=${atr.toFixed(2)}`);
    logTrade({
      timestamp: new Date().toISOString(),
      date,
      signal:    sid,
      side:      def.side,
      entry,
      stopPx,
      tpPx,
      stopTicks,
      tpTicks,
      atr,
      openTime:  now.time,
      status:    "open",
    });
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
log("═".repeat(60));
log("CL Forward-Test Logger starting (read-only, no orders placed)");
log(`Signals: ${Object.keys(SIGS).join(", ")}`);
log(`Session: AM 13:15-15:00 UTC | PM 18:00-19:00 UTC`);
log(`Tick: $${TICK_VAL}/tick | Min move: $${TICK_SZ}`);
log(`Priority gate: NQ dayPnL must be > $${NQ_GATE_THRESHOLD} — reads ${NQ_STATE_PATH}`);
log(`Filters: daily cap $${-CL_DAILY_LOSS_LIMIT} | 2-loss/day halt | DONCH15_L excluded (0% WR on CL)`);
log("═".repeat(60));

await login();
contractId = await resolveContract();

// Poll every 30 seconds
setInterval(() => tick().catch(e => log(`⚠ Tick error: ${e.message}`)), 30_000);
await tick(); // run immediately on boot

log("✓ Forward test running — polling every 30s");
