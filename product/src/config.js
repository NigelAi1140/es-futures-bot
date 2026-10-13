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
// ES support removed entirely 2026-10-03 — TopstepX side is NQ-only now, so the
// old V3 ES strategy ids are stale too. Also purges two wrong/stale NQ ids that
// were in the old NQ default list (NQ_14H_REV was missing its _S suffix;
// NQ_ADR_EXHAUST_S never existed in the real strategy set) so an existing
// config with those bogus keys gets cleaned up, not just topped up around them.
// Strip from all config locations so upgraded configs don't try to enable dead code.
const REMOVED_STRATEGIES = [
  // Original removals
  "AVWAP_L", "LIQ_SWEEP_S", "AVWAP_S",
  // V2 → V3 migration (v1.1.41)
  "EMAPB_L", "EMAPB_S", "RSI2_L", "RSI2_S", "DONCHIAN_BO_L",
  "BB_SQ_L", "VWAP_RECLAIM_L", "EMAXPB_L", "EMAXPB_S", "EMA50_PB_L",
  "EMAFAN_S", "BB_FADE_L", "STOCH_L", "STOCH_S", "KELT_S",
  "ORB_L", "INSIDE_BAR_BO_L", "INSIDE_BAR_BO_S",
  // ES support removed (v1.2.27)
  "DONCH15_L", "VOLBO_L", "VOLBO_S", "EMA21_PULL_L", "BO10_S", "3BAR_BEAR_S", "KELT_L",
  // Wrong/stale NQ ids from the old V5.3 default list (v1.2.27)
  "NQ_14H_REV", "NQ_ADR_EXHAUST_S",
  // Disabled at the strategy-code level since V5.6 (9% WR, killed at week 7) —
  // never actually emits a signal regardless of being "enabled" here.
  "NQ_OB_FADE_S",
];

// ES support removed 2026-10-03 — no top-level default strategies anymore,
// only the NQ set below.
const DEFAULT_ON_STRATEGIES = {};

// Current live NQ strategy set (matches nq-strategies.js / ENABLED_STRATEGIES
// on the real accounts) — default on when NQ market is active. Corrected
// 2026-10-03: the previous list was V5.3-era, had a wrong id, a nonexistent
// id, and was missing half the currently active strategies.
const NQ_DEFAULT_ON_STRATEGIES = {
  NQ_AM_VWAP_FADE_S:    true,
  NQ_ADR_FADE_S:        true,
  NQ_14H_REV_S:         true,
  NQ_FIRST30_FADE_S:    true,
  NQ_OVERNIGHT_TRAP_S:  true,
  NQ_TIGHT_VWAP_AM_L:   true,
  NQ_TIGHT_VWAP_AM_S:   true,
  NQ_HILOW_REJ_AM_L:    true,
  NQ_HILOW_REJ_AM_S:    true,
  NQ_MOM_EXHAUST_AM_L:  true,
  NQ_MOM_EXHAUST_AM_S:  true,
  NQ_PULLBACK_AM_L:     true,
  NQ_PULLBACK_AM_S:     true,
  NQ_PM_VWAP_FADE_S:    true,
};

/**
 * Apply forward-migrations to a merged config object in place.
 * Returns true if anything changed (so the caller can persist the fix).
 */
function migrateConfig(cfg) {
  let changed = false;

  // market field — NQ only since ES support was removed (v1.2.27). Force to
  // "nq" regardless of any stale saved value, not just when missing.
  if (cfg.market !== "nq") {
    cfg.market = "nq";
    changed = true;
  }

  // NQ strategies — add defaults if not present. No longer gated on market
  // being "nq" since that's forced above; always applies now.
  if (cfg.strategies && typeof cfg.strategies === "object") {
    for (const [id, val] of Object.entries(NQ_DEFAULT_ON_STRATEGIES)) {
      if (!(id in cfg.strategies)) { cfg.strategies[id] = val; changed = true; }
    }
  }

  // v1.2.14: autoScaling toggle — cushion-based sizing vs. fixed contracts.
  // Default true so upgraded configs keep today's behavior unless the user opts out.
  if (cfg.trading && cfg.trading.autoScaling === undefined) {
    cfg.trading.autoScaling = true;
    changed = true;
  }

  // v1.2.31: match our own account's locked stop model (2026-09-28) — a hard
  // fixed-tick stop that never moves, not a native trailing stop. Supersedes the
  // old v1.1.19 migration below (which forced stopMode to null "to let each
  // strategy decide") — that null then fell through main.js's own
  // `t.stopMode ?? "trail"` default on every single spawn regardless, so every
  // existing install — including a family member's real funded account — has
  // actually been running STOP_MODE=trail (8t) this whole time, never the fixed
  // model either of us intended. Force both fields unconditionally; this isn't a
  // user preference to preserve, it's correcting an unintended default.
  if (cfg.trading && (cfg.trading.stopMode !== "fixed" || cfg.trading.forceFixedStopTicks == null)) {
    cfg.trading.stopMode = "fixed";
    cfg.trading.forceFixedStopTicks = 11;
    changed = true;
  }
  // v1.2.35: 11→12, matching our own account's current (still provisional,
  // weekly-reviewed) value — user explicitly wants the product on the same
  // live number we're running, not just the model. This is a one-time catch-up
  // bump for installs already migrated to 11 above; expect this specific value
  // to keep moving as it's reviewed most Fridays — don't treat 12 as settled.
  if (cfg.trading && cfg.trading.forceFixedStopTicks === 11) {
    cfg.trading.forceFixedStopTicks = 12;
    changed = true;
  }
  // Capped at 60, not 150 — validateConfig() enforces maxStopTicks <= 60 and
  // throws otherwise, which is exactly what just broke every v1.2.31 install on
  // first load after update (confirmed 2026-10-09 against a real "Config load
  // failed" screen). 60 is still far more headroom than the fixed 11t stop ever needs.
  if (cfg.trading && cfg.trading.maxStopTicks === 20) {
    cfg.trading.maxStopTicks = 60;
    changed = true;
  }

  // v1.2.33: "Max Contracts" now acts as a real ceiling on every auto-scaling
  // path (previously only some of them — see ACCOUNT_BASE/maxContracts notes in
  // main.js and topstepx-engine.js). The old factory default of 1 would now
  // silently cap every existing install's auto-scaling at 1ct forever instead of
  // leaving it unused like before. Bump stale defaults up to the real per-size
  // ceiling (trueAccountMaxContracts() clamps it down further anyway, so this is
  // "don't additionally restrict," not "trade bigger than TopstepX allows").
  if (cfg.trading && cfg.trading.contracts === 1) {
    cfg.trading.contracts = 15;
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

  // v1.2.33: backfill account.size for accounts added before this field existed
  // (every existing install) — see ACCOUNT_BASE note in main.js's env builder.
  // Best-effort from the account name; stays null (shown as "size?" in Settings,
  // defaulting the engine to its 100K fallback) when nothing recognizable is found,
  // same as a brand-new account the auto-detect in Settings couldn't place either.
  if (Array.isArray(cfg.broker?.accounts)) {
    for (const acc of cfg.broker.accounts) {
      if (acc.size !== undefined) continue;
      const m = /(\d{2,3})\s*K/i.exec(acc.name || "");
      if (m) {
        const n = parseInt(m[1], 10) * 1000;
        const sizes = [50000, 100000, 150000];
        acc.size = sizes.reduce((best, s) => Math.abs(s - n) < Math.abs(best - n) ? s : best, sizes[0]);
      } else {
        acc.size = null;
      }
      changed = true;
    }
  }

  return changed;
}

// ── Validation ────────────────────────────────────────────────────────────────
function validateConfig(cfg) {
  const t       = cfg.trading;
  const isAlpaca = cfg.broker?.type === "alpaca";

  check(t.contracts,        1, 15,    "trading.contracts");
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
