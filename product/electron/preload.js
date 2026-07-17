/**
 * Preload — exposes a safe, typed API from main to renderer via contextBridge.
 * Node.js never runs directly in the renderer.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("bot", {
  // Window controls
  minimize: ()      => ipcRenderer.send("window-minimize"),
  close:    ()      => ipcRenderer.send("window-close"),

  // Config
  getConfig:      ()     => ipcRenderer.invoke("get-config"),
  saveConfig:     (cfg)  => ipcRenderer.invoke("save-config", cfg),
  verifyLicense:  (key)  => ipcRenderer.invoke("verify-license", key),
  setupComplete:  ()     => ipcRenderer.send("setup-complete"),
  openExternal:   (url)  => ipcRenderer.send("open-external", url),

  // Engine control
  pauseAll:  () => ipcRenderer.invoke("pause-all"),
  resumeAll: () => ipcRenderer.invoke("resume-all"),

  // Event listeners (renderer subscribes to main process events)
  on: (channel, fn) => {
    const allowed = [
      "license-ok", "license-invalid", "config-loaded",
      "engine-log", "engine-exit", "trade-event",
      "pnl-update", "balance-update", "account-halted",
      "trend-update", "update-available",
      "engine-paused", "engine-resumed",
    ];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_, ...args) => fn(...args));
    }
  },

  off: (channel, fn) => ipcRenderer.removeListener(channel, fn),
});
