/**
 * Config loader — reads config.json, validates values, merges defaults.
 * Includes a migration layer so old configs update cleanly across versions.
 */

import { readFileSync, existsSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join }  from "path";

const __dir       = dirname(fileURLToPath(import.meta.url));
const PRODUCT_DIR = join(__dir, "..");
const DEFAULT_CONFIG_PATH = join(PRODUCT_DIR, "config.json");
const DEFAULT_PATH = join(PRODUCT_DIR, "config.default.json");

// Maintained for CLI / dev usage; main.js overrides via the path parameter when packaged.
export function getConfigPath() { return DEFAULT_CONFIG_PATH; }

export function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  if (!existsSync(configPath)) {
    throw new Error(
      "config.json not found.\n" +
      "     Run the setup wizard first:  node setup.js"
    );
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    throw new Error("config.json is not valid JSON — check for missing commas or brackets.");
  }

  const defaults = JSON.parse(readFileSync(DEFAULT_PATH, "utf8"));
  const cfg = deepMerge(defaults, raw);

  // Run migration BEFORE validation — fixes old values that would fail validation
  // and saves them back to disk so the next load is clean.
  const changed = migrateConfig(cfg);
  if (changed) {
    try {
      writeFileSync(configPath, JSON.stringify(cfg, null, 2));
      console.log("[Config] Migrated config to current version.");
    } catch {
      // non-fatal — migration still applies in memory this session
    }
  }

  try {
    validateConfig(cfg);
  } catch (err) {
    throw new Error(
      `Config validation failed: ${err.message}\n` +
      `     Fix the value in config.json, or delete it to re-run setup.`
    );
  }

  return { config: cfg, configPath };
}

// ── Migration ─────────────────────────────────────────────────────────────────
// V2 strategies removed in v1.1.41 (V3 quant rebuild — replaced by 7 new signals).
// Strip from all config locations so upgraded configs don't try to enable dead code.
const REMOVED_STRATEGIES = [
  // Original removals
  "AVWAP_L", "LIQ_SWEEP_S", "AVWAP_S",
  // V2 → V3 migration (v1.1.41)
  "EMAPB_L", "EMAPB_S", "RSI2_L", "RSI2_S", "DONCHIAN_BO_L",
  "BB_SQ_L", "VWAP_RECLAIM_L", "EMAXPB_L", "EMAXPB_S", "EMA50_PB_L",
  "EMAFAN_S", "BB_FADE_L", "STOCH_L", "STOCH_S", "KELT_S",
  "ORB_L", "INSIDE_BAR_BO_L", "INSIDE_BAR_BO_S",
];

// V3 strategies added in v1.1.41 — enable by default in any upgraded config.
const DEFAULT_ON_STRATEGIES = {
  DONCH15_L:    true,
  VOLBO_L:      true,
  VOLBO_S:      true,
  EMA21_PULL_L: true,
  BO10_S:       true,
  "3BAR_BEAR_S": true,
  KELT_L:       true,
};

/**
 * Apply forward-migrations to a merged config object in place.
 * Returns true if anything changed (so the caller can persist the fix).
 */
function migrateConfig(cfg) {
  let changed = false;

  // v1.1.19: stopMode "trail" was overriding all strategy-level fixed stops.
  // Correct value is null (let each strategy decide).
  if (cfg.trading?.stopMode === "trail") {
    cfg.trading.stopMode = null;
    changed = true;
  }

  // v1.1.19: regime block added.
  if (!cfg.regime || typeof cfg.regime !== "object") {
    cfg.regime = { auto: true, current: "NEUTRAL", lastCheck: null };
    changed = true;
  }
  if (cfg.regime.auto === undefined)    { cfg.regime.auto = true;      changed = true; }
  if (cfg.regime.current === undefined) { cfg.regime.current = "NEUTRAL"; changed = true; }

  // v1.1.19: notifications block — ensure enabled field exists.
  if (!cfg.notifications || typeof cfg.notifications !== "object") {
    cfg.notifications = { enabled: false, ntfyChannel: "" };
    changed = true;
  }
  if (cfg.notifications.enabled === undefined) { cfg.notifications.enabled = false; changed = true; }

  // All versions: strip removed strategies from top-level strategies map.
  if (cfg.strategies && typeof cfg.strategies === "object") {
    for (const id of REMOVED_STRATEGIES) {
      if (id in cfg.strategies) { delete cfg.strategies[id]; changed = true; }
    }
    // Add new active strategies if not yet present.
    for (const [id, val] of Object.entries(DEFAULT_ON_STRATEGIES)) {
      if (!(id in cfg.strategies)) { cfg.strategies[id] = val; changed = true; }
    }
  }

  // All versions: strip removed strategies from per-account strategy overrides.
  if (Array.isArray(cfg.broker?.accounts)) {
    for (const acc of cfg.broker.accounts) {
      if (!acc.strategies || typeof acc.strategies !== "object") continue;
      for (const id of REMOVED_STRATEGIES) {
        if (id in acc.strategies) { delete acc.strategies[id]; changed = true; }
      }
    }
  }

  return changed;
}

// ── Validation ────────────────────────────────────────────────────────────────
function validateConfig(cfg) {
  const t       = cfg.trading;
  const isAlpaca = cfg.broker?.type === "alpaca";

  check(t.contracts,        1, 10,    "trading.contracts");
  check(t.stopLossTicks,    5, 20,    "trading.stopLossTicks");
  check(t.maxStopTicks,    10, 60,    "trading.maxStopTicks");
  check(t.takeProfitTicks, 20, 100,   "trading.takeProfitTicks");
  check(t.trailTicks,       4, 20,    "trading.trailTicks");
  check(t.dailyLossLimit,  10, 50000, "trading.dailyLossLimit");
  check(t.dailyProfitCap,  10, 50000, "trading.dailyProfitCap");

  if (isAlpaca) {
    if (!cfg.broker?.alpacaKey)    throw new Error("broker.alpacaKey is required for Alpaca paper trading.");
    if (!cfg.broker?.alpacaSecret) throw new Error("broker.alpacaSecret is required for Alpaca paper trading.");
  } else {
    if (!cfg.broker?.username)   throw new Error("broker.username is required — add your TopstepX email.");
    if (!cfg.broker?.apiKey)     throw new Error("broker.apiKey is required — add your TopstepX API key.");
    if (!cfg.broker?.accounts?.length) throw new Error("broker.accounts must have at least one account.");

    for (let i = 0; i < cfg.broker.accounts.length; i++) {
      const acc = cfg.broker.accounts[i];
      if (!acc.name) acc.name = `Account-${i + 1}`;
    }
  }

  if (t.maxStopTicks < t.stopLossTicks) {
    throw new Error(`trading.maxStopTicks (${t.maxStopTicks}) must be >= stopLossTicks (${t.stopLossTicks})`);
  }

  const trendUp = cfg.trendFilter?.uptrendThreshold;
  const trendDn = cfg.trendFilter?.downtrendThreshold;
  if (trendUp != null) check(trendUp, 3, 30, "trendFilter.uptrendThreshold");
  if (trendDn != null) check(trendDn, 3, 30, "trendFilter.downtrendThreshold");
}

function check(val, min, max, name) {
  if (typeof val !== "number" || val < min || val > max) {
    throw new Error(`${name} must be a number between ${min} and ${max} (got ${val})`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof base[k] === "object") {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function saveConfig(cfg, configPath = DEFAULT_CONFIG_PATH) {
  writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}
