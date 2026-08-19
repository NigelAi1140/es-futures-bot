/**
 * Post-bundle patcher for topstepx-engine.js
 *
 * Wraps SignalR's optional-package dynamic-require calls in try-catch so the
 * engine doesn't crash when the Electron packaged app can't resolve ws,
 * tough-cookie, eventsource, etc. at runtime.
 *
 * Also adds a WebSocket global fallback (Node 22 has built-in WebSocket).
 *
 * Run automatically after `npm run bundle`.
 */

import { readFileSync, writeFileSync } from "fs";

const FILE = new URL("../dist-engine/topstepx-engine.js", import.meta.url).pathname;

let src = readFileSync(FILE, "utf8");
const original = src;

// ── Patch 1: ws / eventsource — wrap each line in try-catch ──────────────────
// These throw "Dynamic require not supported" in ESM context.
src = src.replace(
  `          webSocketModule = requireFunc("ws");`,
  `          try { webSocketModule = requireFunc("ws"); } catch (_re) {}`
);
src = src.replace(
  `          eventSourceModule = requireFunc("eventsource");`,
  `          try { eventSourceModule = requireFunc("eventsource"); } catch (_re) {}`
);

// ── Patch 2: WebSocket fallback — use Node 22 built-in when ws failed ─────────
// Original: only uses webSocketModule (null when require failed)
// Patched:  falls back to globalThis.WebSocket (available in Node 22 / Electron 31)
src = src.replace(
  `        } else if (Utils_1.Platform.isNode && !options.WebSocket) {
          if (webSocketModule) {
            options.WebSocket = webSocketModule;
          }
        }`,
  `        } else if (Utils_1.Platform.isNode && !options.WebSocket) {
          options.WebSocket = webSocketModule || (typeof WebSocket !== "undefined" ? WebSocket : void 0);
        }`
);

// ── Patch 3: tough-cookie / node-fetch / fetch-cookie — wrap in try-catch ─────
// Falls back to the native global fetch (available in Node 18+ / Electron 28+).
// Cookie jar is optional; we only use Bearer token auth, never cookies.
src = src.replace(
  `          const requireFunc = typeof __webpack_require__ === "function" ? __non_webpack_require__ : __require;
          this._jar = new (requireFunc("tough-cookie")).CookieJar();
          if (typeof fetch === "undefined") {
            this._fetchType = requireFunc("node-fetch");
          } else {
            this._fetchType = fetch;
          }
          this._fetchType = requireFunc("fetch-cookie")(this._fetchType, this._jar);`,
  `          try {
            const requireFunc = typeof __webpack_require__ === "function" ? __non_webpack_require__ : __require;
            this._jar = new (requireFunc("tough-cookie")).CookieJar();
            if (typeof fetch === "undefined") {
              this._fetchType = requireFunc("node-fetch");
            } else {
              this._fetchType = fetch;
            }
            this._fetchType = requireFunc("fetch-cookie")(this._fetchType, this._jar);
          } catch (_re) {
            this._fetchType = typeof fetch !== "undefined" ? fetch.bind(globalThis) : void 0;
          }`
);

// ── Verify patches applied (check that new guard text exists) ─────────────────
// We check for the replacement strings, NOT absence of originals (originals may
// appear as substrings inside the replacement try-blocks).
const checks = [
  { find: `try { webSocketModule = requireFunc("ws"); } catch (_re) {}`, label: "ws try-catch" },
  { find: `try { eventSourceModule = requireFunc("eventsource"); } catch (_re) {}`, label: "eventsource try-catch" },
  { find: `webSocketModule || (typeof WebSocket !== "undefined" ? WebSocket : void 0)`, label: "WebSocket fallback" },
  { find: `} catch (_re) {\n            this._fetchType = typeof fetch !== "undefined"`, label: "tough-cookie try-catch" },
];

let failed = false;
for (const { find, label } of checks) {
  if (!src.includes(find)) {
    console.error(`  ✗  patch-bundle: FAILED — "${label}" replacement not found`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}

writeFileSync(FILE, src, "utf8");
console.log("  ✓  patch-bundle: SignalR dynamic-require guards applied");
