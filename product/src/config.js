/**
 * Config loader — reads config.json, validates values, merges defaults.
 */

import { readFileSync, existsSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join }  from "path";

const __dir       = dirname(fileURLToPath(import.meta.url));
const PRODUCT_DIR = join(__dir, "..");
const CONFIG_PATH = join(PRODUCT_DIR, "config.json");
const DEFAULT_PATH = join(PRODUCT_DIR, "config.default.json");

export function getConfigPath() { return CONFIG_PATH; }

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      "config.json not found.\n" +
      "     Run the setup wizard first:  node setup.js"
    );
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    throw new Error("config.json is not valid JSON — check for missing commas or brackets.");
  }

  const defaults = JSON.parse(readFileSync(DEFAULT_PATH, "utf8"));
  const cfg = deepMerge(defaults, raw);

  validateConfig(cfg);
  return { config: cfg, configPath: CONFIG_PATH };
}

// ── Validation ────────────────────────────────────────────────────────────────
function validateConfig(cfg) {
  const t = cfg.trading;

  check(t.contracts,        1, 10,   "trading.contracts");
  check(t.stopLossTicks,    5, 20,   "trading.stopLossTicks");
  check(t.maxStopTicks,    10, 60,   "trading.maxStopTicks");
  check(t.takeProfitTicks, 20, 100,  "trading.takeProfitTicks");
  check(t.trailTicks,       4, 20,   "trading.trailTicks");
  check(t.dailyLossLimit,  100, 5000, "trading.dailyLossLimit");
  check(t.dailyProfitCap,  100, 5000, "trading.dailyProfitCap");

  if (!cfg.broker?.username)   throw new Error("broker.username is required — add your TopstepX email.");
  if (!cfg.broker?.accounts?.length) throw new Error("broker.accounts must have at least one account.");

  for (let i = 0; i < cfg.broker.accounts.length; i++) {
    const acc = cfg.broker.accounts[i];
    if (!acc.apiKey) throw new Error(`broker.accounts[${i}] (${acc.name ?? "unnamed"}) is missing apiKey.`);
    if (!acc.name)   acc.name = `Account-${i + 1}`;
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

export function saveConfig(cfg) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
