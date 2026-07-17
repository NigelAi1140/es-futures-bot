#!/usr/bin/env node
// Multi-account orchestrator — runs up to 5 independent TopstepX engine instances
// Each account runs in its own child process with isolated state and credentials.
// If one crashes it auto-restarts without affecting the others.
//
// Usage: node engine/multi-account.mjs
// Config: accounts.json in project root (see accounts.example.json)

import { spawn }          from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath }  from 'url';
import dotenv             from 'dotenv';
import axios              from 'axios';

const __dir      = dirname(fileURLToPath(import.meta.url));
const ROOT       = resolve(__dir, '..');
const ENGINE     = resolve(__dir, 'topstepx-engine.js');
const CONFIG     = resolve(ROOT, 'accounts.json');
const BASE_ENV   = resolve(ROOT, '.env');

// ── Load base .env (shared settings) ──────────────────────────────────────────
dotenv.config({ path: BASE_ENV });

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

console.log(`\n🚀  Multi-account orchestrator starting — ${accounts.length} account(s)\n`);

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
      const evs   = [...eventMap.values()];
      const first = evs[0];
      const hasFOMC = evs.some(e => e.isFOMC);
      const news  = Math.max(...evs.map(e => e.newsBlocks ?? 0));
      title = `📊 Pre-session — ${eventMap.size}/${accounts.length} accounts ready`;
      const ctLines = accountNames.map(n => {
        const ev = eventMap.get(n);
        return ev
          ? `${lpad(accountLabels[n])} ${ev.contracts}ct${ev.simulated ? '' : ' ⭐'}`
          : `${lpad(accountLabels[n])} —`;
      }).join('\n');
      body = `${ctLines}\nNews: ${news}  |  FOMC: ${hasFOMC ? 'YES ⚠️' : 'No'}\nAM opens 7:45 MST`;
      break;
    }

    case 'EOD_SUMMARY': {
      const evs     = [...eventMap.values()];
      const net     = evs.reduce((s, e) => s + e.pnl, 0);
      const netStr  = net >= 0 ? `+$${Math.round(net)}` : `-$${Math.round(Math.abs(net))}`;
      const totalW  = evs.reduce((s, e) => s + e.wins, 0);
      const totalL  = evs.reduce((s, e) => s + e.losses, 0);
      const date    = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Phoenix' });
      title = `📊 EOD ${date} — net ${netStr}`;
      const lines   = accountNames.map(n => {
        const ev = eventMap.get(n);
        if (!ev) return `⬜ ${lpad(accountLabels[n])} —`;
        const pStr = ev.pnl >= 0 ? `+$${Math.round(ev.pnl)}` : `-$${Math.round(Math.abs(ev.pnl))}`;
        return `${ev.pnl >= 0 ? '✅' : '❌'} ${lpad(accountLabels[n])} ${pStr}`;
      });
      body = [...lines, '─'.repeat(24), `Net ${netStr}  |  ${totalW}W ${totalL}L`].join('\n');
      break;
    }

    case 'WEEKLY_SUMMARY': {
      const evs    = [...eventMap.values()];
      const net    = evs.reduce((s, e) => s + e.pnl, 0);
      const netStr = net >= 0 ? `+$${Math.round(net)}` : `-$${Math.round(Math.abs(net))}`;
      const totalW = evs.reduce((s, e) => s + e.wins, 0);
      const totalL = evs.reduce((s, e) => s + e.losses, 0);
      const wkEnd  = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Phoenix' });
      title = `📅 Weekly recap — ending ${wkEnd}`;
      const lines  = accountNames.map(n => {
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
  const { name, TV_USER, TV_API_KEY, NTFY_CHANNEL, ...extras } = account;

  if (!TV_USER || !TV_API_KEY) {
    console.error(`${pad(name)} ❌  Missing TV_USER or TV_API_KEY — skipping`);
    return;
  }

  const entry = procs.get(name) || { restarts: 0, lastStart: 0 };
  if (entry.restarts >= MAX_RESTARTS) {
    console.error(`${pad(name)} ❌  Exceeded ${MAX_RESTARTS} restarts — giving up`);
    return;
  }

  // Merge base env + account overrides
  const env = {
    ...process.env,          // inherits SYMBOL, STOP_LOSS_TICKS, etc. from base .env
    TV_USER,
    TV_API_KEY,
    ...(NTFY_CHANNEL ? { NTFY_CHANNEL } : {}),
    ...extras,               // any extra per-account overrides (MAX_CONTRACTS, etc.)
    ACCOUNT_LABEL: name,     // passed to engine for log prefixing
    MULTI_ACCOUNT: "1",      // tells engine to emit [BUNDLE] events instead of sending ntfy
  };

  console.log(`${pad(name)} ▶  Starting engine (restart #${entry.restarts})`);

  const proc = spawn('node', [ENGINE], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  entry.proc      = proc;
  entry.lastStart = Date.now();
  procs.set(name, entry);

  // Prefix every stdout/stderr line with the account label
  const prefix = (line) => `${pad(name)} ${line}`;

  proc.stdout.on('data', (buf) => {
    buf.toString().split('\n').filter(Boolean).forEach(l => {
      if (l.startsWith('[BUNDLE] ')) {
        try { addEvent(name, JSON.parse(l.slice(9))); } catch { console.log(prefix(l)); }
      } else {
        console.log(prefix(l));
      }
    });
  });
  proc.stderr.on('data', (buf) => {
    buf.toString().split('\n').filter(Boolean).forEach(l => console.error(prefix(l)));
  });

  proc.on('exit', (code, signal) => {
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    console.warn(`${pad(name)} ⚠️  Engine exited (${reason})`);

    if (code === 0) {
      console.log(`${pad(name)} ✅  Clean exit — not restarting`);
      return;
    }

    entry.restarts++;
    const delay = RESTART_DELAY_MS * Math.min(entry.restarts, 6); // exponential backoff up to ~60s
    console.log(`${pad(name)} 🔄  Restarting in ${delay/1000}s (attempt ${entry.restarts}/${MAX_RESTARTS})`);
    setTimeout(() => startAccount(account), delay);
  });

  proc.on('error', (err) => {
    console.error(`${pad(name)} ❌  Process error: ${err.message}`);
  });
}

// ── Launch all accounts ────────────────────────────────────────────────────────
// Stagger starts by 3s to avoid API rate limits on simultaneous logins
accounts.forEach((account, idx) => {
  setTimeout(() => startAccount(account), idx * 2000);
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────
const shutdown = (sig) => {
  console.log(`\n📴  ${sig} received — shutting down all engines...\n`);
  for (const [name, entry] of procs) {
    if (entry.proc && !entry.proc.killed) {
      console.log(`${pad(name)} 🛑  Stopping`);
      entry.proc.kill('SIGTERM');
    }
  }
  setTimeout(() => process.exit(0), 3000);
};

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ── Status heartbeat every 30 min ─────────────────────────────────────────────
setInterval(() => {
  const running = [...procs.entries()].filter(([,e]) => e.proc && !e.proc.killed);
  console.log(`\n📊  Heartbeat — ${running.length}/${accounts.length} engines running`);
  for (const [name, entry] of procs) {
    const alive = entry.proc && !entry.proc.killed;
    console.log(`  ${alive ? '🟢' : '🔴'} ${name.padEnd(maxLen)}  restarts: ${entry.restarts}`);
  }
  console.log('');
}, 30 * 60 * 1000);
