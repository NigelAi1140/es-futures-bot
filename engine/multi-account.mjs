#!/usr/bin/env node
// Multi-account orchestrator — runs TopstepX and Alpaca engine instances.
// Each account runs in its own child process with isolated state and credentials.
// If one crashes it auto-restarts without affecting the others.
//
// Usage: node engine/multi-account.mjs
// Config: accounts.json in project root (see accounts.example.json)
// engine_type: "topstepx" (default) | "alpaca"

import { spawn }          from 'child_process';
import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync, existsSync, createWriteStream, mkdirSync, renameSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath }  from 'url';
import dotenv             from 'dotenv';
import axios              from 'axios';

const __dir         = dirname(fileURLToPath(import.meta.url));
const ROOT          = resolve(__dir, '..');
const ENGINE_TSX    = resolve(__dir, 'topstepx-engine.js');
const ENGINE_ALPACA = resolve(__dir, 'alpaca-engine.js');
const CONFIG        = resolve(ROOT, 'accounts.json');
const BASE_ENV      = resolve(ROOT, '.env');
const LOCK_FILE     = resolve(ROOT, 'logs', 'multi-account.lock');

// ── Singleton lockfile guard (atomic) ─────────────────────────────────────────
// Uses O_CREAT|O_EXCL (wx flag) — atomic on all POSIX filesystems.
// No TOCTOU race: if two instances start simultaneously, exactly one wins the
// exclusive create; the other gets EEXIST and checks whether the winner is alive.
mkdirSync(resolve(ROOT, 'logs'), { recursive: true });
const acquireLock = () => {
  try {
    // Atomic exclusive create — fails immediately if file already exists
    const fd = openSync(LOCK_FILE, 'wx');
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Lockfile exists — check if the owning PID is still alive
    const existingPid = parseInt(readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    let alive = true;
    try { process.kill(existingPid, 0); } catch { alive = false; }
    if (alive) {
      console.error(`\n❌  multi-account.mjs is already running (PID ${existingPid}). Exiting to prevent duplicate engines.\n   Delete ${LOCK_FILE} manually if the process is gone.\n`);
      process.exit(1);
    }
    // Stale lockfile — remove and retry the atomic create once
    console.warn(`⚠️  Stale lockfile (PID ${existingPid} is gone) — removing and continuing.`);
    unlinkSync(LOCK_FILE);
    try {
      const fd = openSync(LOCK_FILE, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
    } catch {
      console.error(`\n❌  Concurrent startup race — another instance acquired the lock first. Exiting.\n`);
      process.exit(1);
    }
  }
};
acquireLock();
const removeLock = () => { try { unlinkSync(LOCK_FILE); } catch {} };
process.on('exit', removeLock);

// ── Load base .env (shared settings) ──────────────────────────────────────────
dotenv.config({ path: BASE_ENV });

// ── File logging ───────────────────────────────────────────────────────────────
const LOGS_DIR = resolve(ROOT, 'logs');
mkdirSync(LOGS_DIR, { recursive: true });
const LOG_FILE = resolve(LOGS_DIR, 'multi-account.log');

// Rotate if log exceeds 50 MB
try {
  if (statSync(LOG_FILE).size > 50 * 1024 * 1024) {
    renameSync(LOG_FILE, LOG_FILE.replace('.log', `-${new Date().toISOString().slice(0, 10)}.log`));
  }
} catch { /* file doesn't exist yet */ }

const logStream = createWriteStream(LOG_FILE, { flags: 'a' });

function logLine(text, isError = false) {
  const ts   = new Date().toISOString().replace('T', ' ').slice(0, 23);
  const line = `[${ts}] ${text}\n`;
  logStream.write(line);
  (isError ? process.stderr : process.stdout).write(text + '\n');
}

logLine(`\n🚀  Multi-account orchestrator starting — log: ${LOG_FILE}`);

// ── Load accounts config ───────────────────────────────────────────────────────
if (!existsSync(CONFIG)) {
  console.error(`
❌  accounts.json not found at ${CONFIG}

Create it with this format:
[
  {
    "name":       "Account-1",
    "TV_USER":    "your@email.com",
    "TV_API_KEY": "your-api-key-here",
    "NTFY_CHANNEL": "your-ntfy-channel-1"
  },
  {
    "name":       "Account-2",
    "TV_USER":    "your@email.com",
    "TV_API_KEY": "your-api-key-account-2",
    "NTFY_CHANNEL": "your-ntfy-channel-2"
  }
]

Each account needs its own TV_API_KEY from TopstepX dashboard.
You can use the same TV_USER (email) for all accounts.
`);
  process.exit(1);
}

let accounts;
try {
  accounts = JSON.parse(readFileSync(CONFIG, 'utf8'));
} catch (e) {
  console.error(`❌  Failed to parse accounts.json: ${e.message}`);
  process.exit(1);
}

if (!Array.isArray(accounts) || accounts.length === 0) {
  console.error('❌  accounts.json must be a non-empty array');
  process.exit(1);
}

if (accounts.length > 5) {
  console.warn(`⚠️  accounts.json has ${accounts.length} accounts — limiting to 5`);
  accounts = accounts.slice(0, 5);
}

logLine(`🚀  ${accounts.length} account(s) configured\n`);

// ── Bundled push notifications ─────────────────────────────────────────────────
const NTFY_CHANNEL = (process.env.NTFY_CHANNEL || accounts[0]?.NTFY_CHANNEL || "").trim();

async function notify(title, message, priority = "default") {
  if (!NTFY_CHANNEL) return;
  try {
    await axios.post(`https://ntfy.sh/${NTFY_CHANNEL}`, message, {
      headers: { Title: title, Priority: priority, Tags: "chart_with_upwards_trend" },
      timeout: 5000,
    });
  } catch { }
}

// "50K-Funded"     (ID 25023094) → "[F] 094"
// "100K-Combine-1" (ID 25039916) → "[C] 916"
function makeLabel(account) {
  const suffix = account.ACCOUNT_ID ? String(account.ACCOUNT_ID).slice(-3) : account.name.slice(-3);
  return /[Ff]unded/.test(account.name) ? `[F] ${suffix}` : `[C] ${suffix}`;
}

// Pre-compute labels in accounts order so notifications are always in a consistent order
const accountNames  = accounts.map(a => a.name);
const accountLabels = Object.fromEntries(accounts.map(a => [a.name, makeLabel(a)]));

// Label column width for alignment
const LCOL = Math.max(...Object.values(accountLabels).map(l => l.length));
const lpad = (s) => s.padEnd(LCOL);

// When multiple engines share the same underlying ACCOUNT_ID (e.g. NQ + ES on the same
// Topstep account), EOD/Weekly notifications would show duplicate rows with identical
// balances. primaryReporters contains only the first engine per unique ACCOUNT_ID so
// those bundles show 2 rows (one per real account) instead of 4.
const _seenIds = new Set();
const primaryReporters = new Set(
  accounts.filter(a => {
    if (!a.ACCOUNT_ID || _seenIds.has(a.ACCOUNT_ID)) return false;
    _seenIds.add(a.ACCOUNT_ID);
    return true;
  }).map(a => a.name)
);

// ── Event aggregator ───────────────────────────────────────────────────────────
// Each bundleable event type has a time window. When an event arrives, start the
// timer. If all accounts report before the timer fires, send immediately.
// Non-reported accounts are shown with a "—" row so the user can spot gaps.

const BUNDLE_WINDOW = {
  TRADE_ENTERED:    10_000,   // wait up to 10s for all accounts to get the signal
  TRADE_CLOSED:     30_000,   // exits can stagger if fills differ slightly
  TREND_FILTER:     10_000,   // same bar on all accounts — should arrive together
  PRESESSION_BRIEF: 90_000,   // accounts can spread 30s apart — 90s ensures all arrive
  EOD_SUMMARY:     120_000,   // 2 min — all should fire same scheduled minute
  WEEKLY_SUMMARY:  120_000,
};

const pending = new Map(); // type → { events: Map<accountName, data>, timer }

function addEvent(accountName, eventData) {
  const { type } = eventData;
  if (!BUNDLE_WINDOW[type]) return;

  if (!pending.has(type)) pending.set(type, { events: new Map(), timer: null });
  const bundle = pending.get(type);

  bundle.events.set(accountName, eventData);
  if (bundle.timer) clearTimeout(bundle.timer);

  if (bundle.events.size >= accounts.length) {
    flushBundle(type);
  } else {
    bundle.timer = setTimeout(() => flushBundle(type), BUNDLE_WINDOW[type]);
  }
}

function flushBundle(type) {
  const bundle = pending.get(type);
  if (!bundle || bundle.events.size === 0) return;
  pending.delete(type);

  const eventMap = bundle.events;
  let title, body, priority = "default";

  const row = (name, content) => `${eventMap.has(name) ? content : `⬜ ${lpad(accountLabels[name])} —`}`;

  switch (type) {

    case 'TRADE_ENTERED': {
      const first  = [...eventMap.values()][0];
      const dirStr = first.dir === 'long' ? 'LONG' : 'SHORT';
      const emoji  = first.dir === 'long' ? '📈' : '📉';
      title = `${emoji} ${dirStr} entered — ${first.signal}`;
      body  = accountNames.map(n => {
        const ev = eventMap.get(n);
        return ev
          ? `✅ ${lpad(accountLabels[n])} ${ev.contracts}ct`
          : `⏭  ${lpad(accountLabels[n])} no signal`;
      }).join('\n');
      break;
    }

    case 'TRADE_CLOSED': {
      const evs    = [...eventMap.values()];
      const net    = evs.reduce((s, e) => s + e.pnl, 0);
      const netStr = net >= 0 ? `+$${Math.round(net)}` : `-$${Math.round(Math.abs(net))}`;
      const first  = evs[0];
      const dirStr = first.dir === 'long' ? 'LONG' : 'SHORT';
      title = `${first.win ? '✅' : '❌'} ${dirStr} closed — net ${netStr}`;
      body  = accountNames.map(n => {
        const ev = eventMap.get(n);
        if (!ev) return `⬜ ${lpad(accountLabels[n])} —`;
        const pStr = ev.pnl >= 0 ? `+$${Math.round(ev.pnl)}` : `-$${Math.round(Math.abs(ev.pnl))}`;
        return `${ev.win ? '✅' : '❌'} ${lpad(accountLabels[n])} ${pStr}`;
      }).join('\n');
      break;
    }

    case 'TREND_FILTER': {
      const first = [...eventMap.values()][0];
      const isUp  = first.dir === 'up';
      title = isUp ? `📈 Uptrend day — shorts off` : `📉 Downtrend day — longs off`;
      body  = `AM move ${first.move >= 0 ? '+' : ''}${first.move}pts\n${eventMap.size}/${accounts.length} accounts affected`;
      break;
    }

    case 'PRESESSION_BRIEF': {
      const evs     = [...eventMap.values()];
      const first   = evs[0];
      const hasFOMC = evs.some(e => e.isFOMC);
      const news    = Math.max(...evs.map(e => e.newsBlocks ?? 0));
      const tz      = evs.find(e => e.tz)?.tz ?? "MST";
      const range   = evs.find(e => e.overnightRange != null)?.overnightRange;

      // Trend — all accounts share the same filter
      const trendStatus = evs.find(e => e.trendStatus)?.trendStatus ?? 'PENDING';
      const trendLine =
        trendStatus === 'UPTREND'   ? '📈 UPTREND — shorts suppressed' :
        trendStatus === 'DOWNTREND' ? '📉 DOWNTREND — longs suppressed' :
        trendStatus === 'NEUTRAL'   ? '↔️  NEUTRAL — all signals active' :
                                      `⏳ PENDING — fires ~7:15 AM ${tz}`;

      // Regime: all accounts share the same overnight range calc
      const regimeLine = range != null
        ? (range < 30 ? `🔴 TIGHT ${range}pts — 1ct cap` : range < 50 ? `🟡 NARROW ${range}pts — scaled` : `🟢 WIDE ${range}pts — full size`)
        : 'Range: N/A';

      title = `📊 Pre-session — ${eventMap.size}/${accounts.length} ready`;

      // Per-account rows: contracts, balance, progress
      const acctLines = accountNames.map(n => {
        const ev = eventMap.get(n);
        if (!ev) return `⬜ ${lpad(accountLabels[n])} —`;

        const ctStr  = `${ev.contracts}ct${ev.simulated ? '' : ' ⭐'}`;
        const balStr = ev.balance != null ? ` $${Math.round(ev.balance).toLocaleString()}` : '';

        let progressStr = '';
        if (ev.simulated && ev.profitSoFar != null) {
          const needed = Math.max(0, ev.combineTarget - ev.profitSoFar);
          progressStr = needed <= 0
            ? ' 🎯PASSED'
            : ` +$${Math.round(ev.profitSoFar)} / $${Math.round(ev.combineTarget)}`;
        } else if (!ev.simulated && ev.profitSoFar != null) {
          progressStr = ` earned +$${Math.round(ev.profitSoFar)}`;
        }

        const ddStr = ev.ddBuffer != null ? ` DD:$${ev.ddBuffer}left` : '';

        return `${lpad(accountLabels[n])} ${ctStr}${balStr}${progressStr}${ddStr}`;
      }).join('\n');

      // Streak — use first funded account, or first account
      const streakEv  = evs.find(e => !e.simulated) ?? evs[0];
      const streakStr = streakEv
        ? (streakEv.consecutiveWins  >= 2 ? `🔥 ${streakEv.consecutiveWins}W streak — pressing` :
           streakEv.consecutiveWins  === 1 ? `↑ 1W — building` :
           streakEv.consecutiveLosses >= 2 ? `⚠️ ${streakEv.consecutiveLosses}L streak — 1ct cap` :
           streakEv.consecutiveLosses === 1 ? `↓ 1L — slight pullback` : 'Neutral')
        : 'Neutral';

      body = [
        acctLines,
        '─'.repeat(28),
        `Regime: ${regimeLine}`,
        `Trend:  ${trendLine}`,
        `Streak: ${streakStr}`,
        `News: ${news}  |  FOMC: ${hasFOMC ? 'YES ⚠️' : 'No'}`,
        `AM 7:45 ${tz}  |  PM 12:30–2:00 ${tz}`,
      ].join('\n');
      break;
    }

    case 'EOD_SUMMARY': {
      // Only count each underlying account once — NQ engine is the primary reporter
      // when NQ+ES share the same ACCOUNT_ID (e.g. 50K-Funded and 50K-Funded-ES3).
      const primaryEvs = accountNames
        .filter(n => primaryReporters.has(n))
        .map(n => eventMap.get(n))
        .filter(Boolean);
      const net     = primaryEvs.reduce((s, e) => s + e.pnl, 0);
      const netStr  = net >= 0 ? `+$${Math.round(net)}` : `-$${Math.round(Math.abs(net))}`;
      const totalW  = primaryEvs.reduce((s, e) => s + e.wins, 0);
      const totalL  = primaryEvs.reduce((s, e) => s + e.losses, 0);
      const date    = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Phoenix' });
      title = `📊 EOD ${date} — net ${netStr}`;
      const lines   = accountNames.filter(n => primaryReporters.has(n)).map(n => {
        const ev = eventMap.get(n);
        if (!ev) return `⬜ ${lpad(accountLabels[n])} —`;
        const pStr = ev.pnl >= 0 ? `+$${Math.round(ev.pnl)}` : `-$${Math.round(Math.abs(ev.pnl))}`;
        return `${ev.pnl >= 0 ? '✅' : '❌'} ${lpad(accountLabels[n])} ${pStr}`;
      });
      body = [...lines, '─'.repeat(24), `Net ${netStr}  |  ${totalW}W ${totalL}L`].join('\n');
      break;
    }

    case 'WEEKLY_SUMMARY': {
      // Same dedup as EOD_SUMMARY — one row per underlying account.
      const primaryEvs = accountNames
        .filter(n => primaryReporters.has(n))
        .map(n => eventMap.get(n))
        .filter(Boolean);
      const net    = primaryEvs.reduce((s, e) => s + e.pnl, 0);
      const netStr = net >= 0 ? `+$${Math.round(net)}` : `-$${Math.round(Math.abs(net))}`;
      const totalW = primaryEvs.reduce((s, e) => s + e.wins, 0);
      const totalL = primaryEvs.reduce((s, e) => s + e.losses, 0);
      const wkEnd  = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Phoenix' });
      title = `📅 Weekly recap — ending ${wkEnd}`;
      const lines  = accountNames.filter(n => primaryReporters.has(n)).map(n => {
        const ev = eventMap.get(n);
        if (!ev) return `⬜ ${lpad(accountLabels[n])} —`;
        const pStr = ev.pnl >= 0 ? `+$${Math.round(ev.pnl)}` : `-$${Math.round(Math.abs(ev.pnl))}`;
        return `${ev.pnl >= 0 ? '✅' : '❌'} ${lpad(accountLabels[n])} ${pStr}`;
      });
      body = [...lines, '─'.repeat(24), `Net ${netStr}  |  ${totalW}W ${totalL}L`].join('\n');
      break;
    }

    default: return;
  }

  notify(title, body, priority).catch(() => {});
}

// ── Per-process state ──────────────────────────────────────────────────────────
const procs = new Map(); // name → { proc, restarts, lastStart }

const RESTART_DELAY_MS  = 10_000;  // wait 10s before restarting a crashed engine
const MAX_RESTARTS      = 20;      // give up after 20 restarts (likely config error)

// Pad account label for aligned log output
const maxLen = Math.max(...accounts.map(a => a.name.length));
const pad    = (name) => `[${name.padEnd(maxLen)}]`;

function startAccount(account) {
  const { name, engine_type, TV_USER, TV_API_KEY, ALPACA_KEY, ALPACA_SECRET, NTFY_CHANNEL, ...extras } = account;
  const isAlpaca = engine_type === "alpaca";

  if (isAlpaca) {
    if (!ALPACA_KEY || !ALPACA_SECRET) {
      logLine(`${pad(name)} ❌  Missing ALPACA_KEY or ALPACA_SECRET — skipping`, true);
      return;
    }
  } else {
    if (!TV_USER || !TV_API_KEY) {
      logLine(`${pad(name)} ❌  Missing TV_USER or TV_API_KEY — skipping`, true);
      return;
    }
  }

  const entry = procs.get(name) || { restarts: 0, lastStart: 0 };
  if (entry.restarts >= MAX_RESTARTS) {
    logLine(`${pad(name)} ❌  Exceeded ${MAX_RESTARTS} restarts — giving up`, true);
    return;
  }

  // Merge base env + account overrides
  const env = isAlpaca
    ? {
        ...process.env,
        ALPACA_KEY,
        ALPACA_SECRET,
        ...(NTFY_CHANNEL ? { NTFY_CHANNEL } : {}),
        ...extras,
        ACCOUNT_LABEL: name,
        MULTI_ACCOUNT: "1",
      }
    : {
        ...process.env,
        TV_USER,
        TV_API_KEY,
        ...(NTFY_CHANNEL ? { NTFY_CHANNEL } : {}),
        ...extras,
        ACCOUNT_LABEL: name,
        MULTI_ACCOUNT: "1",
      };

  const engineScript = isAlpaca ? ENGINE_ALPACA : ENGINE_TSX;

  // Pre-spawn safety check: verify no live engine lockfile exists for this account.
  // Catches the case where a prior supervisor crashed and left an orphaned engine running.
  const accountId  = account.ACCOUNT_ID || account.TV_USER || name;
  const safeId     = String(accountId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  const engineLock = resolve(LOGS_DIR, `engine-${safeId}.lock`);
  if (existsSync(engineLock)) {
    const existingPid = parseInt(readFileSync(engineLock, 'utf8').trim(), 10);
    let alive = true;
    try { process.kill(existingPid, 0); } catch { alive = false; }
    if (alive) {
      logLine(`${pad(name)} ❌  Engine already running (PID ${existingPid} per lockfile) — skipping spawn to prevent duplicate`, true);
      return;
    }
    logLine(`${pad(name)} ⚠️  Stale engine lockfile (PID ${existingPid} gone) — removing before spawn`);
    try { unlinkSync(engineLock); } catch {}
  }

  logLine(`${pad(name)} ▶  Starting ${isAlpaca ? "Alpaca" : "TopstepX"} engine (restart #${entry.restarts})`);

  const proc = spawn('node', [engineScript], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,  // own process group — PM2 SIGINT to orchestrator won't kill children
  });

  entry.proc      = proc;
  entry.lastStart = Date.now();
  procs.set(name, entry);

  // Prefix every stdout/stderr line with the account label
  const prefix = (line) => `${pad(name)} ${line}`;

  proc.stdout.on('data', (buf) => {
    buf.toString().split('\n').filter(Boolean).forEach(l => {
      if (l.startsWith('[BUNDLE] ')) {
        try { addEvent(name, JSON.parse(l.slice(9))); } catch { logLine(prefix(l)); }
      } else {
        logLine(prefix(l));
      }
    });
  });
  proc.stderr.on('data', (buf) => {
    buf.toString().split('\n').filter(Boolean).forEach(l => logLine(prefix(l), true));
  });

  proc.on('exit', (code, signal) => {
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    logLine(`${pad(name)} ⚠️  Engine exited (${reason})`, true);

    if (shutdownInProgress) {
      logLine(`${pad(name)} ✅  Supervisor shutting down — not restarting`);
      return;
    }

    entry.restarts++;
    const delay = RESTART_DELAY_MS * Math.min(entry.restarts, 6); // exponential backoff up to ~60s
    logLine(`${pad(name)} 🔄  Restarting in ${delay/1000}s (attempt ${entry.restarts}/${MAX_RESTARTS})`);
    setTimeout(() => startAccount(account), delay);
  });

  proc.on('error', (err) => {
    logLine(`${pad(name)} ❌  Process error: ${err.message}`, true);
  });
}

// ── Launch all accounts ────────────────────────────────────────────────────────
// Stagger starts by 3s to avoid API rate limits on simultaneous logins
accounts.forEach((account, idx) => {
  setTimeout(() => startAccount(account), idx * 2000);
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────
let shutdownInProgress = false;
const shutdown = (sig) => {
  shutdownInProgress = true;
  logLine(`\n📴  ${sig} received — shutting down all engines...\n`);
  removeLock();
  for (const [name, entry] of procs) {
    if (entry.proc && !entry.proc.killed) {
      logLine(`${pad(name)} 🛑  Stopping`);
      entry.proc.kill('SIGTERM');
    }
  }
  setTimeout(() => process.exit(0), 1200); // under PM2's 1600ms kill_timeout — prevents SIGKILL mid-shutdown
};

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Kill all children on unexpected crash — prevents orphaned engines
process.on('uncaughtException', (err) => {
  logLine(`\n💥  Uncaught exception — killing all engines before exit: ${err.message}`, true);
  for (const [, entry] of procs) {
    try { if (entry.proc && !entry.proc.killed) entry.proc.kill('SIGTERM'); } catch {}
  }
  setTimeout(() => process.exit(1), 2000);
});
process.on('unhandledRejection', (reason) => {
  logLine(`\n💥  Unhandled rejection — killing all engines before exit: ${reason}`, true);
  for (const [, entry] of procs) {
    try { if (entry.proc && !entry.proc.killed) entry.proc.kill('SIGTERM'); } catch {}
  }
  setTimeout(() => process.exit(1), 2000);
});

// ── Status heartbeat every 30 min ─────────────────────────────────────────────
setInterval(() => {
  const running = [...procs.entries()].filter(([,e]) => e.proc && !e.proc.killed);
  logLine(`\n📊  Heartbeat — ${running.length}/${accounts.length} engines running`);
  for (const [name, entry] of procs) {
    const alive = entry.proc && !entry.proc.killed;
    logLine(`  ${alive ? '🟢' : '🔴'} ${name.padEnd(maxLen)}  restarts: ${entry.restarts}`);
  }
  logLine('');
}, 30 * 60 * 1000);
