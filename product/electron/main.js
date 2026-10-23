/**
 * Electron main process — app lifecycle, window management, engine orchestration.
 *
 * Flow:
 *   1. Check for config.json → show setup window if missing
 *   2. Verify license
 *   3. Open main dashboard window
 *   4. Spawn one engine child process per account
 *   5. Pipe engine output to renderer via IPC
 */

import { app, BrowserWindow, ipcMain, shell } from "electron";
import { spawn }            from "child_process";
import { existsSync, readFileSync, mkdirSync, appendFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath }    from "url";

import { loadConfig, saveConfig } from "../src/config.js";
import { verifyLicense, startLicenseWatchdog } from "../src/license.js";
import { detectRegime, fetchDailyBars, REGIME_SETS } from "../src/regime-detector.js";
import updaterPkg from "electron-updater";
const { autoUpdater } = updaterPkg;

// Disable GPU acceleration — prevents GPU cache permission errors on Windows
app.disableHardwareAcceleration();

// Prevent multiple instances — second launch focuses the existing window instead
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on("second-instance", () => {
  if (mainWin) {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.focus();
  }
});

const __dir          = dirname(fileURLToPath(import.meta.url));
const ROOT           = resolve(__dir, "..");
const ENGINE         = resolve(ROOT, "../engine/topstepx-engine.js");
const ENGINE_ALPACA  = resolve(ROOT, "../engine/alpaca-engine.js");
const IS_DEV    = process.env.DEV_LICENSE === "1";
const IS_PKG    = app.isPackaged;

// When packaged, config.json lives in the user-writable app data directory
// (~/Library/Application Support/ES Futures Bot on macOS, %APPDATA%\ES Futures Bot on Windows).
// In dev, it stays alongside the source in product/config.json.
const CONFIG_PATH = IS_PKG
  ? join(app.getPath("userData"), "config.json")
  : resolve(ROOT, "config.json");

// Daily engine log files, kept outside the app bundle (userData) when packaged
// so they survive auto-updates instead of getting wiped with the old resources dir.
const LOGS_DIR = IS_PKG
  ? join(app.getPath("userData"), "logs")
  : resolve(ROOT, "../logs");
if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

function logToFile(accountName, line, isErr = false) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const path = join(LOGS_DIR, `engine-${day}.log`);
    const ts = new Date().toISOString();
    appendFileSync(path, `[${ts}] [${accountName}]${isErr ? " [ERR]" : ""} ${line}\n`);
  } catch { /* non-fatal — never let logging itself break the engine */ }
}

// ── Window references ─────────────────────────────────────────────────────────
let mainWin   = null;
let setupWin  = null;

// ── Engine process tracking ───────────────────────────────────────────────────
const procs = new Map();  // name → { proc, restarts, paused }
const RESTART_DELAY  = 10_000;
const MAX_RESTARTS   = 20;
let activeConfig     = null;

// Current live NQ strategy set (matches nq-strategies.js V5.5 / the real
// ENABLED_STRATEGIES used on our own accounts). Both the setup wizard's
// strategy checkboxes (STRAT_LIST in setup.html) and config.default.json's
// "strategies" key only ever listed the old ES strategy set — so selecting
// NQ as the market never produced a working strategy list, and every NQ
// account got "disabled by user config" for literally every NQ_ strategy
// with no way to fix it from the app (2026-10-03). This fallback: if the
// account is trading NQ and the configured strategy set doesn't contain any
// actual NQ strategy name, use this default instead of sending the engine a
// list that matches nothing. Fixes every existing broken install too, not
// just new ones, without requiring the user to redo setup.
const NQ_DEFAULT_STRATEGIES = [
  "NQ_AM_VWAP_FADE_S", "NQ_ADR_FADE_S", "NQ_14H_REV_S",
  "NQ_FIRST30_FADE_S", "NQ_OVERNIGHT_TRAP_S", "NQ_PM_VWAP_FADE_S",
];

// ── Create main dashboard window ──────────────────────────────────────────────
let _bootScheduled = false; // guard against duplicate regime/update intervals

function createMainWindow() {
  const isMac = process.platform === "darwin";
  mainWin = new BrowserWindow({
    width:  960,
    height: 640,
    minWidth:  800,
    minHeight: 560,
    frame:           false,
    titleBarStyle:   isMac ? "hiddenInset" : "hidden",
    trafficLightPosition: isMac ? { x: 12, y: 10 } : undefined,
    backgroundColor: "#000000",
    show:            false,
    webPreferences: {
      preload:          resolve(__dir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  mainWin.loadFile(resolve(__dir, "renderer/index.html"));

  mainWin.once("ready-to-show", () => mainWin.show());

  mainWin.on("closed", () => {
    shutdownEngines();
    mainWin = null;
  });

  mainWin.webContents.once("did-finish-load", async () => {
    let config;
    try {
      ({ config } = loadConfig(CONFIG_PATH));
    } catch (err) {
      mainWin?.webContents.send("license-invalid", "Config load failed — please reinstall.");
      return;
    }

    const license = await verifyLicense(config, CONFIG_PATH);

    if (!license.valid) {
      mainWin?.webContents.send("license-invalid", license.reason);
      return;
    }

    mainWin?.webContents.send("license-ok", license.email, {
      daysLeft:     license.daysLeft    ?? null,
      isTrial:      license.isTrial     ?? false,
      isFreeLoader: license.isFreeLoader ?? false,
    });
    mainWin?.webContents.send("config-loaded", {
      accounts:    config.broker.type === "alpaca"
        ? ["Alpaca-Paper"]
        : (config.broker.accounts ?? []).filter(a => a.id).map(a => a.name),
      broker:      { type: config.broker.type ?? "topstepx",
                     alpacaKey: config.broker.alpacaKey ?? "",
                     alpacaSecret: config.broker.alpacaSecret ?? "" },
      trading:     config.trading,
      strategies:  config.strategies,
      trendFilter: config.trendFilter,
      market:      config.market ?? "es",
    });

    startLicenseWatchdog(config, CONFIG_PATH, (reason) => {
      mainWin?.webContents.send("license-invalid", reason);
    });

    if (!_bootScheduled) {
      _bootScheduled = true;
      if (IS_PKG) {
        setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 15_000);
        setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 60 * 60 * 1000);
      }
      scheduleRegimeChecks();
    }

    launchEngines(config);
  });
}

// ── Create setup wizard window ────────────────────────────────────────────────
function createSetupWindow() {
  setupWin = new BrowserWindow({
    width:  680,
    height: 680,
    resizable:       false,
    frame:           false,
    titleBarStyle:   process.platform === "darwin" ? "hiddenInset" : "hidden",
    trafficLightPosition: process.platform === "darwin" ? { x: 12, y: 10 } : undefined,
    backgroundColor: "#000000",
    show:            false,
    webPreferences: {
      preload:          resolve(__dir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  setupWin.loadFile(resolve(__dir, "renderer/setup.html"));
  setupWin.once("ready-to-show", () => {
    setupWin.show();
    if (IS_PKG) setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5_000);
  });
  setupWin.on("closed", () => { setupWin = null; });
}

// ── App ready ─────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Launch on system startup — survives reboots and power cuts
  app.setLoginItemSettings({ openAtLogin: true });

  if (!existsSync(CONFIG_PATH)) {
    createSetupWindow();
    return;
  }

  // Verify config is parseable; fall back to setup wizard if not
  try {
    loadConfig(CONFIG_PATH);
  } catch (err) {
    createSetupWindow();
    return;
  }

  createMainWindow();
});

app.on("window-all-closed", () => {
  shutdownEngines();
  if (process.platform !== "darwin") app.quit();
});

// Force-kill all engine processes before the app exits so the installer
// can overwrite files without getting "file in use" on Windows.
app.on("before-quit", () => {
  for (const [, entry] of procs) {
    if (entry.proc && !entry.proc.killed) {
      try { entry.proc.kill("SIGKILL"); } catch {}
    }
  }
});

app.on("activate", () => {
  if (!mainWin && !setupWin) {
    existsSync(CONFIG_PATH) ? createMainWindow() : createSetupWindow();
  }
});

// ── Engine orchestration ──────────────────────────────────────────────────────
function launchEngines(config) {
  activeConfig = config;
  if (config.broker.type === "alpaca") {
    startAlpacaEngine(config);
  } else {
    // One TopstepX login allows one live API session, so only ONE account can run (a second engine kicks
    // the first one off and both place orders). Multi-account was removed 2026-10-17; the first account wins.
    const runnable = config.broker.accounts.filter(a => a.id);
    if (runnable.length > 1) console.warn(`[Engine] ${runnable.length} accounts configured — only "${runnable[0].name}" will run.`);
    runnable.slice(0, 1).forEach((acc, i) => {
      setTimeout(() => startAccount(acc, config), i * 2000);
    });
  }
}

function startAlpacaEngine(config) {
  const name  = "Alpaca-Paper";
  const entry = procs.get(name) ?? { restarts: 0, paused: false };
  if (entry.paused || entry.restarts >= MAX_RESTARTS) return;

  const t = config.trading;
  const f = config.trendFilter;

  const env = {
    ...process.env,
    ALPACA_KEY:         config.broker.alpacaKey   ?? "",
    ALPACA_SECRET:      config.broker.alpacaSecret ?? "",
    ALPACA_PAPER:       "true",
    SYMBOL:             config.broker.alpacaSymbol ?? "SPY",
    MAX_CONTRACTS:      String(t.contracts),
    STOP_MODE:          t.stopMode ?? "trail",
    STOP_LOSS_TICKS:    String(t.stopLossTicks),
    TAKE_PROFIT_TICKS:  String(t.takeProfitTicks),
    TRAIL_TICKS:        String(t.trailTicks),
    DAILY_LOSS_LIMIT:   String(Math.round(t.dailyLossLimit / 10)),  // SPY paper uses 1/10 scale
    DAILY_PROFIT_CAP:   String(Math.round(t.dailyProfitCap  / 10)),
    ATR_MIN_FILTER:     String(t.atrMinFilter),
    TREND_UP_PTS:       String(f.uptrendThreshold),
    TREND_DN_PTS:       String(f.downtrendThreshold),
    MULTI_ACCOUNT:      "1",
    ACCOUNT_LABEL:      name,
    ...(config.notifications?.enabled && config.notifications?.ntfyChannel ? { NTFY_CHANNEL: config.notifications.ntfyChannel } : {}),
  };

  const nodeBin = IS_PKG ? process.execPath : process.argv0;
  const nodeEnv = IS_PKG ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : env;
  const proc    = spawn(nodeBin, [ENGINE_ALPACA], { env: nodeEnv, stdio: ["ignore","pipe","pipe"] });
  entry.proc    = proc;
  procs.set(name, entry);

  const emit = (line) => {
    mainWin?.webContents.send("engine-log", { account: name, line });
    logToFile(name, line);
    const pnlMatch = line.match(/P&L.*?(-?\$[\d,.]+)/);
    const balMatch = line.match(/balance=\$([0-9,.]+)/);
    if (pnlMatch) mainWin?.webContents.send("pnl-update",     { account: name, pnl:     pnlMatch[1] });
    if (balMatch) mainWin?.webContents.send("balance-update",  { account: name, balance: balMatch[1] });
  };
  proc.stdout.on("data", buf => buf.toString().split("\n").filter(Boolean).forEach(emit));
  proc.stderr.on("data", buf => buf.toString().split("\n").filter(Boolean).forEach(l => {
    mainWin?.webContents.send("engine-log", { account: name, line: l, isErr: true });
    logToFile(name, l, true);
  }));
  proc.on("close", (code, signal) => {
    mainWin?.webContents.send("engine-exit", { account: name, code, signal });
    if (entry.paused || code === 0) return;
    entry.restarts++;
    const delay = RESTART_DELAY * Math.min(entry.restarts, 6);
    setTimeout(() => startAlpacaEngine(config), delay);
  });
}

// Topstep Maximum Loss Limit (trailing, end of day) and Combine profit target by account size.
const SIZE_MLL = { 50000: { trailDD: 2000, target: 3000 }, 100000: { trailDD: 3000, target: 6000 }, 150000: { trailDD: 4500, target: 9000 } };
// Copy trading: the smallest account you copy to caps contracts and daily loss (same numbers as the Settings recommendations).
const COPY_CAP = { 50000: { contracts: 2, lossLimit: 750 }, 100000: { contracts: 5, lossLimit: 1500 }, 150000: { contracts: 8, lossLimit: 2250 } };
function copyCap(t) { return t?.copyTrading && COPY_CAP[Number(t.smallestAccountSize)] ? COPY_CAP[Number(t.smallestAccountSize)] : null; }
function acctSizeFor(account, t) {
  const m = String(account?.name ?? "").match(/(\d+)\s*K/i), k = m ? parseInt(m[1], 10) * 1000 : 0;
  if (SIZE_MLL[k]) return k;
  if (SIZE_MLL[Number(t?.accountSize)]) return Number(t.accountSize);
  return 50000;
}

function startAccount(account, config) {
  const entry = procs.get(account.name) ?? { restarts: 0, paused: false };
  if (entry.paused)              return;
  if (entry.restarts >= MAX_RESTARTS) return;
  // Never spawn a second engine for an account whose engine is still alive.
  if (entry.proc && entry.proc.exitCode === null && entry.proc.signalCode === null && !entry.proc.killed) return;

  const t = config.trading;
  const f = config.trendFilter;
  const stratSource = account.strategies ?? config.strategies;
  let enabledStrats = Object.entries(stratSource)
    .filter(([, v]) => v).map(([k]) => k).join(",");
  if (!NQ_DEFAULT_STRATEGIES.some(id => enabledStrats.includes(id))) {
    enabledStrats = NQ_DEFAULT_STRATEGIES.join(",");
  }

  const env = {
    ...process.env,
    TV_USER:            config.broker.username,
    TV_API_KEY:         config.broker.apiKey,
    ACCOUNT_ID:         account.id ?? "",
    SYMBOL:             config.market === "nq" ? "NQ" : (config.broker.symbol ?? "ES"),
    MARKET:             config.market ?? "es",
    MAX_CONTRACTS:      String(copyCap(t) ? Math.min(t.contracts, copyCap(t).contracts) : t.contracts),
    SCALE_EDGE_DAY_CAP:           t.scaleEdgeDayCap ? "1" : "0",
    SCALE_EDGE_DAY_CAP_CONTRACTS: String(t.scaleEdgeDayCapContracts ?? 2),
    SCALE_EDGE_DAY_CAP_ALL:       "1",   // Combine accounts too, not just funded
    STOP_MODE:          t.stopMode ?? "trail",
    STOP_LOSS_TICKS:    String(t.stopLossTicks),
    MAX_STOP_TICKS:     String(t.maxStopTicks),
    TAKE_PROFIT_TICKS:  String(t.takeProfitTicks),
    TRAIL_TICKS:        String(t.trailTicks),
    DAILY_LOSS_LIMIT:   String(copyCap(t) ? Math.min(t.dailyLossLimit, copyCap(t).lossLimit) : t.dailyLossLimit),
    DAILY_PROFIT_CAP:   String(t.dailyProfitCap),
    ATR_MIN_FILTER:     String(t.atrMinFilter),
    TREND_FILTER:       f.enabled ? "1" : "0",
    TREND_UP_PTS:       String(f.uptrendThreshold),
    TREND_DN_PTS:       String(f.downtrendThreshold),
    REGIME_FILTER:        t.regimeFilter ?? "auto",
    FUNDED_START_BALANCE: String(t.fundedStartBalance ?? 0),
    FORCE_FIXED_STOP_TICKS: String(t.forceFixedStopTicks ?? 12),  // same 12-tick stop as the personal engine (was the engine's 10-tick default); config.default.json forceFixedStopTicks
    // Account size drives the Maximum Loss Limit math in the engine (floor, cushion, warnings). Without these the engine
    // assumed a 100K account for everyone. Size comes from the account name ("50K"/"100K"/"150K"), else the saved setting,
    // else 50K (the smallest MLL = the most conservative).
    ...(() => { const sz = acctSizeFor(account, t), m = SIZE_MLL[sz]; return { ACCOUNT_BASE: String(sz), TRAIL_DD: String(m.trailDD), COMBINE_TARGET: String(m.target) }; })(),
    ENABLED_STRATEGIES:   enabledStrats,
    MULTI_ACCOUNT:      "1",
    PARENT_PID:         String(process.pid),
    YIELD_SESSION:      "1",   // don't fight the user for the TopstepX login while idle (see engine comment)
    ACCOUNT_IDX:        "0",   // exactly one account runs, so its stagger index is always 0 (silences the engine's label-parsing warning)
    ACCOUNT_LABEL:      account.name,
    ...(config.notifications?.enabled && config.notifications?.ntfyChannel ? { NTFY_CHANNEL: config.notifications.ntfyChannel } : {}),
  };

  const nodeBin = IS_PKG ? process.execPath : process.argv0;
  const nodeEnv = IS_PKG ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : env;
  const proc = spawn(nodeBin, [ENGINE], { env: nodeEnv, stdio: ["ignore","pipe","pipe"] });

  entry.proc = proc;
  procs.set(account.name, entry);

  const emit = (line) => {
    if (!line.startsWith("[BUNDLE]")) {
      mainWin?.webContents.send("engine-log", { account: account.name, line });
      logToFile(account.name, line);

      // Parse structured events for the dashboard
      const tradeMatch  = line.match(/\[(?:Order|Trade)\].*?(LONG|SHORT).*?(\d+)ct/);
      const pnlMatch    = line.match(/P&L.*?(-?\$[\d,.]+)/);
      const balMatch    = line.match(/balance=\$([0-9,.]+)/);
      const haltMatch   = line.match(/Daily loss limit.*hit|profit cap.*reached/);
      const trendMatch  = line.match(/\[Trend\].*(UPTREND|DOWNTREND|NEUTRAL)/);

      if (tradeMatch)  mainWin?.webContents.send("trade-event",   { account: account.name, dir: tradeMatch[1], size: tradeMatch[2] });
      if (pnlMatch)    mainWin?.webContents.send("pnl-update",    { account: account.name, pnl: pnlMatch[1] });
      if (balMatch)    mainWin?.webContents.send("balance-update", { account: account.name, balance: balMatch[1] });
      if (haltMatch)   mainWin?.webContents.send("account-halted", { account: account.name });
      if (trendMatch)  mainWin?.webContents.send("trend-update",  { account: account.name, trend: trendMatch[1] });
    }
  };

  proc.stdout.on("data", buf => buf.toString().split("\n").filter(Boolean).forEach(emit));
  proc.stderr.on("data", buf => buf.toString().split("\n").filter(Boolean).forEach(l => {
    mainWin?.webContents.send("engine-log", { account: account.name, line: l, isErr: true });
    logToFile(account.name, l, true);
    if (l.includes("[FATAL]")) entry.lastFatal = l.replace("[FATAL]", "").trim();
  }));

  proc.on("close", (code, signal) => {
    mainWin?.webContents.send("engine-exit", { account: account.name, code, signal });
    if (entry.paused) return;
    if (code === 0) return;

    // Auth/config errors won't fix themselves — stop retrying immediately
    const fatal = entry.lastFatal ?? "";
    if (fatal.match(/Login failed|API key|credentials|loginKey|No tradeable account|TV_USER/i)) {
      mainWin?.webContents.send("engine-log", {
        account: account.name,
        line: `❌ Fatal error: ${fatal}`,
        isErr: true,
      });
      mainWin?.webContents.send("engine-log", {
        account: account.name,
        line: `❌ Check your API key and username in Settings, then restart.`,
        isErr: true,
      });
      mainWin?.webContents.send("engine-exit", { account: account.name, code: "fatal", fatal });
      return;
    }

    entry.restarts++;
    const delay = RESTART_DELAY * Math.min(entry.restarts, 6);
    mainWin?.webContents.send("engine-log", {
      account: account.name,
      line: `Restarting in ${delay/1000}s... (${entry.restarts}/${MAX_RESTARTS})`,
    });
    setTimeout(() => startAccount(account, config), delay);
  });
}

function shutdownEngines() {
  for (const [, entry] of procs) {
    if (entry.proc && !entry.proc.killed) entry.proc.kill("SIGTERM");
  }
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
// ── Auto-updater events ───────────────────────────────────────────────────────
autoUpdater.autoDownload = true;  // download silently as soon as update found

const broadcast = (channel, payload) => {
  mainWin?.webContents.send(channel, payload);
  setupWin?.webContents.send(channel, payload);
};

autoUpdater.on("update-available", (info) => {
  broadcast("update-downloading", { version: info.version });
});

autoUpdater.on("download-progress", (progress) => {
  broadcast("update-progress", { percent: Math.round(progress.percent) });
});

autoUpdater.on("update-downloaded", (info) => {
  broadcast("update-ready", { version: info.version });
  // Auto-install after 30s so the user sees the notification, then restarts automatically
  setTimeout(() => autoUpdater.quitAndInstall(true, true), 30_000);
});

ipcMain.on("install-update", () => {
  autoUpdater.quitAndInstall(true, true);
});

// ── Window controls ───────────────────────────────────────────────────────────
ipcMain.on("window-minimize", () => mainWin?.minimize());
ipcMain.on("window-close",    () => { shutdownEngines(); app.quit(); });

ipcMain.handle("save-config", async (_, configData) => {
  try {
    saveConfig(configData, CONFIG_PATH);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("verify-license", async (_, email) => {
  const config = { license: { email }, _machineId: "" };
  return verifyLicense(config, null, { readOnly: true });
});

ipcMain.on("setup-complete", () => {
  setupWin?.close();
  createMainWindow();
});

ipcMain.on("open-external", (_, url) => shell.openExternal(url));

ipcMain.handle("search-accounts", async (_, { username, apiKey }) => {
  try {
    const BASE = "https://api.topstepx.com";
    const authRes = await fetch(`${BASE}/api/Auth/loginKey`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userName: username, apiKey }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!authRes.ok) throw new Error(`Auth failed (${authRes.status})`);
    const { token } = await authRes.json();

    const acctRes = await fetch(`${BASE}/api/Account/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    });
    if (!acctRes.ok) throw new Error(`Account search failed (${acctRes.status})`);
    const data = await acctRes.json();

    return {
      ok: true,
      accounts: (data.accounts ?? []).map(a => ({
        id:        String(a.id),
        name:      a.name,
        balance:   a.balance,
        canTrade:  a.canTrade,
        isFunded:  !a.simulated || /^EXPRESS/i.test(a.name ?? ""),
        last4:     String(a.id).slice(-4),
        nameLast4: (a.name ?? "").replace(/^.*-/, "").slice(-4),
      })),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("get-version", () => app.getVersion());
ipcMain.handle("get-config",  () => activeConfig);

ipcMain.handle("export-trades", async () => {
  try {
    const logsDir  = IS_PKG ? join(process.resourcesPath, "logs") : resolve(ROOT, "../logs");
    const jsonlPath = join(logsDir, "trades.jsonl");
    if (!existsSync(jsonlPath)) return { ok: false, error: "No trade history found yet." };

    const lines = readFileSync(jsonlPath, "utf8").trim().split("\n").filter(Boolean);
    if (!lines.length) return { ok: false, error: "Trade log is empty." };

    const records = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    const headers = ["date","time_mt","contract","signal","direction","contracts","entry_price","exit_price","gross_pnl","day_pnl_after","balance_after"];
    const rows = records.map(r => headers.map(h => {
      const v = r[h] ?? "";
      return typeof v === "string" && v.includes(",") ? `"${v}"` : v;
    }).join(","));

    const csv = [headers.join(","), ...rows].join("\n");
    return { ok: true, csv, count: records.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Rolling 7-day window ending today — replaces the old manual date-range
// picker so a user can just hit one button instead of picking two dates.
ipcMain.handle("export-logs-week", async () => {
  try {
    const end = new Date().toISOString().slice(0, 10);
    const start = new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const files = readdirSync(LOGS_DIR)
      .filter(f => /^engine-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .map(f => ({ f, day: f.slice(7, 17) }))
      .filter(({ day }) => day >= start && day <= end)
      .sort((a, b) => a.day.localeCompare(b.day));
    if (!files.length) return { ok: false, error: "No logs found for this week yet." };
    const text = files
      .map(({ f, day }) => `===== ${day} =====\n` + readFileSync(join(LOGS_DIR, f), "utf8"))
      .join("\n");
    return { ok: true, text, days: files.length, start, end };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("clear-logs", async () => {
  try {
    const files = readdirSync(LOGS_DIR).filter(f => /^engine-\d{4}-\d{2}-\d{2}\.log$/.test(f));
    let freedBytes = 0;
    for (const f of files) {
      const p = join(LOGS_DIR, f);
      try { freedBytes += statSync(p).size; } catch {}
      try { unlinkSync(p); } catch {}
    }
    return { ok: true, count: files.length, freedMB: (freedBytes / (1024 * 1024)).toFixed(1) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Regime detection ──────────────────────────────────────────────────────────
async function runRegimeCheck({ manual = false } = {}) {
  try {
    const bars = await fetchDailyBars();
    const result = detectRegime(bars);

    // Load fresh config so we don't overwrite concurrent changes
    const { config } = loadConfig(CONFIG_PATH);
    const prevRegime = config.regime?.current ?? "NEUTRAL";
    const regimeChanged = result.regime !== prevRegime;

    // Auto-update strategies if regime switched
    if (regimeChanged || manual) {
      config.strategies = { ...config.strategies, ...result.strategies };
      config.regime = {
        auto:      config.regime?.auto ?? true,
        current:   result.regime,
        lastCheck: new Date().toISOString(),
        previous:  prevRegime,
      };
      saveConfig(config, CONFIG_PATH);
      activeConfig = config;

      // Restart engines with new strategy set
      if (regimeChanged) {
        for (const [, entry] of procs) {
          entry.paused = false;
          entry.restarts = 0;
          if (entry.proc && !entry.proc.killed) entry.proc.kill("SIGTERM");
        }
        setTimeout(() => launchEngines(activeConfig), 3000);
      }

      // Send NTFY notification if channel configured
      const ntfy = config.notifications?.enabled && config.notifications?.ntfyChannel;
      if (ntfy && regimeChanged) {
        const enabledStrats = Object.entries(result.strategies)
          .filter(([, v]) => v).map(([k]) => k).join(", ");
        fetch(`https://ntfy.sh/${ntfy}`, {
          method: "POST",
          body: `Regime → ${result.regime}\n${result.tenDayPct >= 0 ? "+" : ""}${result.tenDayPct.toFixed(1)}% (10-day)\nNow trading: ${enabledStrats}`,
          headers: { Title: `ES Bot: ${prevRegime} → ${result.regime}`, Priority: "default" },
        }).catch(() => {});
      }
    }

    // Broadcast to renderer
    const payload = {
      regime:     result.regime,
      prev:       prevRegime,
      changed:    regimeChanged,
      bullPoints: result.bullPoints,
      bearPoints: result.bearPoints,
      reasons:    result.reasons,
      price:      result.price,
      ema20:      result.ema20,
      tenDayPct:  result.tenDayPct,
      strategies: result.strategies,
      lastCheck:  new Date().toISOString(),
    };
    broadcast("regime-update", payload);
    return { ok: true, ...payload };
  } catch (e) {
    broadcast("regime-update", { ok: false, error: e.message });
    return { ok: false, error: e.message };
  }
}

ipcMain.handle("run-regime-check", (_, opts) => runRegimeCheck(opts ?? {}));

// Schedule regime check: on startup (delay 30s) + every Monday at 6 AM MT (13:00 UTC)
function scheduleRegimeChecks() {
  // Startup check
  setTimeout(() => runRegimeCheck(), 30_000);

  // Daily check — fires every hour, runs the actual check only on Monday 13:00 UTC
  setInterval(() => {
    const now = new Date();
    const dow = now.getUTCDay();   // 1 = Monday
    const h   = now.getUTCHours();
    const m   = now.getUTCMinutes();
    if (dow === 1 && h === 13 && m < 5) runRegimeCheck();
  }, 5 * 60 * 1000); // poll every 5 min
}

ipcMain.handle("pause-all", () => {
  for (const [, entry] of procs) {
    entry.paused = true;
    if (entry.proc && !entry.proc.killed) entry.proc.kill("SIGTERM");
  }
  mainWin?.webContents.send("engine-paused");
  return { ok: true };
});

ipcMain.handle("resume-all", () => {
  try {
    const { config } = loadConfig(CONFIG_PATH);
    activeConfig = config;
    for (const [, entry] of procs) {
      entry.paused = false;
      entry.restarts = 0;
    }
    launchEngines(activeConfig);
    mainWin?.webContents.send("engine-resumed");
    mainWin?.webContents.send("config-loaded", {
      accounts:    activeConfig.broker.type === "alpaca"
        ? ["Alpaca-Paper"]
        : (activeConfig.broker.accounts ?? []).filter(a => a.id).map(a => a.name),
      broker:      { type: activeConfig.broker.type ?? "topstepx",
                     alpacaKey: activeConfig.broker.alpacaKey ?? "",
                     alpacaSecret: activeConfig.broker.alpacaSecret ?? "" },
      trading:     activeConfig.trading,
      strategies:  activeConfig.strategies,
      trendFilter: activeConfig.trendFilter,
      market:      activeConfig.market ?? "es",
    });
    return { ok: true };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});
