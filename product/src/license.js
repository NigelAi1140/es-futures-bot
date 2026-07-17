/**
 * License verification — Gumroad API + machine binding.
 *
 * Flow:
 *   1. Load license key from config
 *   2. Verify against Gumroad API
 *   3. Check machine ID matches (binding prevents key sharing)
 *   4. Cache a short-lived session token in memory
 *   5. Re-verify every 24h — revoked licenses stop working at next restart
 */

import crypto  from "crypto";
import os      from "os";
import { readFileSync, writeFileSync, existsSync } from "fs";

// ── Set this to your Gumroad product permalink before distributing ────────────
const GUMROAD_PRODUCT = "es-futures-bot";
const VERIFY_URL      = "https://api.gumroad.com/v2/licenses/verify";
const RECHECK_MS      = 24 * 60 * 60 * 1000;  // re-verify every 24h

// ── Dev mode bypass ───────────────────────────────────────────────────────────
// Set DEV_LICENSE=1 in env to skip Gumroad check entirely (for local testing).
// This flag is stripped out before distribution — never shipped in the binary.
const DEV_MODE = process.env.DEV_LICENSE === "1";

// ── Machine fingerprint ───────────────────────────────────────────────────────
function machineId() {
  const raw = [os.hostname(), os.platform(), os.cpus()[0]?.model ?? ""].join("|");
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 20);
}

// ── Gumroad API call ──────────────────────────────────────────────────────────
async function callGumroad(licenseKey, incrementUses = false) {
  const params = new URLSearchParams({
    product_permalink:   GUMROAD_PRODUCT,
    license_key:         licenseKey.trim(),
    increment_uses_count: String(incrementUses),
  });

  const res = await fetch(VERIFY_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    params.toString(),
    signal:  AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`License server returned ${res.status}`);
  return await res.json();
}

// ── Main verify export ────────────────────────────────────────────────────────
export async function verifyLicense(config, configPath) {
  if (DEV_MODE) {
    return { valid: true, email: "dev@local", plan: "Developer" };
  }

  const key = config.license?.key?.trim();
  if (!key) {
    return { valid: false, reason: "No license key found in config.json — run setup.js first." };
  }

  // Check Gumroad
  let data;
  try {
    data = await callGumroad(key);
  } catch (err) {
    return { valid: false, reason: `Could not reach license server: ${err.message}` };
  }

  if (!data.success) {
    return { valid: false, reason: data.message ?? "License key is invalid or expired." };
  }

  // Check subscription is still active (Gumroad sets subscription_ended_at when cancelled)
  const purchase = data.purchase;
  if (purchase?.subscription_ended_at) {
    const ended = new Date(purchase.subscription_ended_at);
    if (ended < new Date()) {
      return { valid: false, reason: "Your subscription has ended. Renew at the download page." };
    }
  }

  // Machine binding — bind on first use, reject on mismatch
  const currentMachine = machineId();
  const storedMachine  = config._machineId;

  if (!storedMachine) {
    // First activation — bind to this machine and increment use count
    config._machineId = currentMachine;
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    await callGumroad(key, true).catch(() => {});  // increment; non-fatal if it fails
  } else if (storedMachine !== currentMachine) {
    return {
      valid:  false,
      reason: "This license is registered to a different machine.\n" +
              "     Contact support to transfer your license.",
    };
  }

  return {
    valid: true,
    email: purchase?.email ?? "unknown",
    plan:  purchase?.variants_and_quantity ?? "Standard",
  };
}

// ── Periodic re-check (call once bot is running) ──────────────────────────────
export function startLicenseWatchdog(config, configPath, onRevoked) {
  const check = async () => {
    const result = await verifyLicense(config, configPath).catch(() => ({ valid: false, reason: "Network error" }));
    if (!result.valid) {
      onRevoked(result.reason);
    }
  };
  const timer = setInterval(check, RECHECK_MS);
  timer.unref();  // don't keep process alive just for this
}
