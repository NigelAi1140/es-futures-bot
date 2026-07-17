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
import { existsSync }       from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath }    from "url";

import { loadConfig, saveConfig } from "../src/config.js";
import { verifyLicense, startLicenseWatchdog } from "../src/license.js";
import { checkForUpdate }   from "../src/updater.js";

const __dir     = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dir, "..");
const ENGINE    = resolve(ROOT, "../engine/topstepx-engine.js");
const IS_DEV    = process.env.DEV_LICENSE === "1";
const IS_PKG    = app.isPackaged;

// ── Window references ─────────────────────────────────────────────────────────
let mainWin   = null;
let setupWin  = null;

// ── Engine process tracking ───────────────────────────────────────────────────
const procs = new Map();  // name → { proc, restarts, paused }
const RESTART_DELAY  = 10_000;
const MAX_RESTARTS   = 20;
let activeConfig     = null;

// ── Create main dashboard window ──────────────────────────────────────────────
function createMainWindow() {
  mainWin = new BrowserWindow({
    width:  960,
    height: 640,
    minWidth:  800,
    minHeight: 560,
    frame:           false,   // custom title bar
    titleBarStyle:   "hidden",
    backgroundColor: "#000000",
    show:            false,
    webPreferences: {
      preload:          resolve(__dir, "preload.js"),
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
}

// ── Create setup wizard window ────────────────────────────────────────────────
function createSetupWindow() {
  setupWin = new BrowserWindow({
    width:  680,
    height: 680,
    resizable:       false,
    frame:           false,
    titleBarStyle:   "hidden",
    backgroundColor: "#000000",
    show:            false,
    webPreferences: {
      preload:          resolve(__dir, "preload.js"),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  setupWin.loadFile(resolve(__dir, "renderer/setup.html"));
  setupWin.once("ready-to-show", () => setupWin.show());
  setupWin.on("closed", () => { setupWin = null; });
}

// ── App ready ─────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  const configPath = resolve(ROOT, "config.json");

  if (!existsSync(configPath)) {
    createSetupWindow();
    return;
  }

  let config;
  try {
    ({ config } = loadConfig());
  } catch (err) {
    createSetupWindow();
    return;
  }

  // License check before showing the window
  const license = await verifyLicense(config, configPath);

  createMainWindow();

  mainWin.webContents.once("did-finish-load", async () => {
    if (!license.valid) {
      mainWin.webContents.send("license-invalid", license.reason);
      return;
    }

    mainWin.webContents.send("license-ok", license.email);
    mainWin.webContents.send("config-loaded", {
      accounts:   config.broker.accounts.map(a => a.name),
      trading:    config.trading,
      strategies: config.strategies,
      trendFilter: config.trendFilter,
    });

    startLicenseWatchdog(config, configPath, (reason) => {
      mainWin?.webContents.send("license-invalid", reason);
    });

    checkForUpdate().then(update => {
      if (update) mainWin?.webContents.send("update-available", update);
    });

    launchEngines(config);
  });
});

app.on("window-all-closed", () => {
  shutdownEngines();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (!mainWin && !setupWin) {
    const configPath = resolve(ROOT, "config.json");
    existsSync(configPath) ? createMainWindow() : createSetupWindow();
  }
});

// ── Engine orchestration ──────────────────────────────────────────────────────
function launchEngines(config) {
  activeConfig = config;
  config.broker.accounts.forEach((acc, i) => {
    setTimeout(() => startAccount(acc, config), i * 2000);
  });
}

function startAccount(account, config) {
  const entry = procs.get(account.name) ?? { restarts: 0, paused: false };
  if (entry.paused)              return;
  if (entry.restarts >= MAX_RESTARTS) return;

  const t = config.trading;
  const f = config.trendFilter;
  const enabledStrats = Object.entries(config.strategies)
    .filter(([, v]) => v).map(([k]) => k).join(",");

  const env = {
    ...process.env,
    TV_USER:            config.broker.username,
    TV_API_KEY:         account.apiKey,
    SYMBOL:             config.broker.symbol ?? "ES",
    MAX_CONTRACTS:      String(t.contracts),
    STOP_LOSS_TICKS:    String(t.stopLossTicks),
    MAX_STOP_TICKS:     String(t.maxStopTicks),
    TAKE_PROFIT_TICKS:  String(t.takeProfitTicks),
    TRAIL_TICKS:        String(t.trailTicks),
    DAILY_LOSS_LIMIT:   String(t.dailyLossLimit),
    DAILY_PROFIT_CAP:   String(t.dailyProfitCap),
    ATR_MIN_FILTER:     String(t.atrMinFilter),
    TREND_FILTER:       f.enabled ? "1" : "0",
    TREND_UP_PTS:       String(f.uptrendThreshold),
    TREND_DN_PTS:       String(f.downtrendThreshold),
    ENABLED_STRATEGIES: enabledStrats,
    MULTI_ACCOUNT:      "1",
    ACCOUNT_LABEL:      account.name,
    ...(config.notifications?.ntfyChannel ? { NTFY_CHANNEL: config.notifications.ntfyChannel } : {}),
  };

  const nodeBin = IS_PKG ? process.execPath : process.argv0;
  const proc = spawn(nodeBin, [ENGINE], { env, stdio: ["ignore","pipe","pipe"] });

  entry.proc = proc;
  procs.set(account.name, entry);

  const emit = (line) => {
    if (!line.startsWith("[BUNDLE]")) {
      mainWin?.webContents.send("engine-log", { account: account.name, line });

      // Parse structured events for the dashboard
      const tradeMatch  = line.match(/\[(?:Order|Trade)\].*?(LONG|SHORT).*?(\d+)ct/);
      const pnlMatch    = line.match(/P&L.*?(\$[\d,.+-]+)/);
      const balMatch    = line.match(/balance=\$([0-9,.]+)/);
      const haltMatch   = line.match(/Daily loss limit|profit cap.*reached/);
      const trendMatch  = line.match(/\[Trend\].*(UPTREND|DOWNTREND|NEUTRAL)/);

      if (tradeMatch)  mainWin?.webContents.send("trade-event",   { account: account.name, dir: tradeMatch[1], size: tradeMatch[2] });
      if (pnlMatch)    mainWin?.webContents.send("pnl-update",    { account: account.name, pnl: pnlMatch[1] });
      if (balMatch)    mainWin?.webContents.send("balance-update", { account: account.name, balance: balMatch[1] });
      if (haltMatch)   mainWin?.webContents.send("account-halted", { account: account.name });
      if (trendMatch)  mainWin?.webContents.send("trend-update",  { account: account.name, trend: trendMatch[1] });
    }
  };

  proc.stdout.on("data", buf => buf.toString().split("\n").filter(Boolean).forEach(emit));
  proc.stderr.on("data", buf => buf.toString().split("\n").filter(Boolean).forEach(l =>
    mainWin?.webContents.send("engine-log", { account: account.name, line: l, isErr: true })
  ));

  proc.on("exit", (code, signal) => {
    mainWin?.webContents.send("engine-exit", { account: account.name, code, signal });
    if (entry.paused) return;
    if (code === 0) return;
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
ipcMain.on("window-minimize", () => mainWin?.minimize());
ipcMain.on("window-close",    () => { shutdownEngines(); app.quit(); });

ipcMain.handle("save-config", async (_, configData) => {
  try {
    saveConfig(configData);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("verify-license", async (_, key) => {
  const config = { license: { key }, _machineId: "" };
  const configPath = resolve(ROOT, "config.json");
  return verifyLicense(config, configPath);
});

ipcMain.on("setup-complete", () => {
  setupWin?.close();
  createMainWindow();
});

ipcMain.on("open-external", (_, url) => shell.openExternal(url));

ipcMain.handle("get-config", () => activeConfig);

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
    const { config } = loadConfig();
    activeConfig = config;
    for (const [, entry] of procs) {
      entry.paused = false;
      entry.restarts = 0;
    }
    launchEngines(activeConfig);
    mainWin?.webContents.send("engine-resumed");
    mainWin?.webContents.send("config-loaded", {
      accounts:    activeConfig.broker.accounts.map(a => a.name),
      trading:     activeConfig.trading,
      strategies:  activeConfig.strategies,
      trendFilter: activeConfig.trendFilter,
    });
    return { ok: true };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});
