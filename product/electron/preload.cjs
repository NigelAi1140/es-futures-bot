/**
 * Preload — exposes a safe, typed API from main to renderer via contextBridge.
 * Uses CommonJS require() — Electron preload scripts run outside the ESM context.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bot", {
  // Platform info
  platform:   process.platform,
  getVersion: () => ipcRenderer.invoke("get-version"),

  // Window controls
  minimize: ()      => ipcRenderer.send("window-minimize"),
  close:    ()      => ipcRenderer.send("window-close"),

  // Config
  getConfig:        ()      => ipcRenderer.invoke("get-config"),
  saveConfig:       (cfg)   => ipcRenderer.invoke("save-config", cfg),
  verifyLicense:    (key)   => ipcRenderer.invoke("verify-license", key),
  searchAccounts:   (data)  => ipcRenderer.invoke("search-accounts", data),
  setupComplete:    ()      => ipcRenderer.send("setup-complete"),
  openExternal:     (url)   => ipcRenderer.send("open-external", url),

  // Engine control
  pauseAll:      () => ipcRenderer.invoke("pause-all"),
  resumeAll:     () => ipcRenderer.invoke("resume-all"),

  // Auto-updater
  installUpdate: () => ipcRenderer.send("install-update"),

  // Event listeners (renderer subscribes to main process events)
  on: (channel, fn) => {
    const allowed = [
      "license-ok", "license-invalid", "config-loaded",
      "engine-log", "engine-exit", "trade-event",
      "pnl-update", "balance-update", "account-halted",
      "trend-update", "update-available",
      "update-downloading", "update-progress", "update-ready",
      "engine-paused", "engine-resumed",
    ];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_, ...args) => fn(...args));
    }
  },

  off: (channel, fn) => ipcRenderer.removeListener(channel, fn),
});
