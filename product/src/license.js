/**
 * License verification — email-based subscription check via proxy server.
 *
 * Flow:
 *   1. Load subscriber email from config
 *   2. POST to verification server (which holds the Gumroad API key server-side)
 *   3. Bind to this machine on first activation
 *   4. Re-verify every 24h — cancelled subscriptions stop working at next restart
 */

import crypto  from "crypto";
import os      from "os";
import { writeFileSync } from "fs";

// ── Verification server ───────────────────────────────────────────────────────
// Cloudflare Worker that checks Gumroad subscriber status without exposing the
// seller's API token in the distributed binary.
const VERIFY_URL  = "https://nigelbot-verify.thankful-alphabet.workers.dev/verify";
const RECHECK_MS  = 24 * 60 * 60 * 1000;

// ── Dev mode bypass ───────────────────────────────────────────────────────────
// Set DEV_LICENSE=1 in env to skip verification entirely (for local testing).
// This flag is stripped out before distribution — never shipped in the binary.
const DEV_MODE = process.env.DEV_LICENSE === "1";

// ── Machine fingerprint ───────────────────────────────────────────────────────
function machineId() {
  const raw = [os.hostname(), os.platform(), os.cpus()[0]?.model ?? ""].join("|");
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 20);
}

// ── Main verify export ────────────────────────────────────────────────────────
// readOnly=true skips machine binding — use during setup to check subscription only
export async function verifyLicense(config, configPath, { readOnly = false } = {}) {
  if (DEV_MODE) {
    return { valid: true, email: "dev@local", plan: "Developer" };
  }

  const email = config.license?.email?.trim().toLowerCase();
  if (!email) {
    return { valid: false, reason: "No email found in config.json — run setup.js first." };
  }

  let data;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(VERIFY_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ email, deviceId: readOnly ? undefined : machineId() }),
        signal:  AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      data = await res.json();
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (lastErr) {
    return {
      valid:  false,
      reason: `Could not reach verification server (${lastErr.message}).\n` +
              `     Check your internet connection and try again.\n` +
              `     If the problem persists, contact support.`,
    };
  }

  if (!data.valid) {
    return { valid: false, reason: data.reason ?? "No active subscription found for this email." };
  }

  if (!readOnly) {
    // Machine binding — bind on first activation, reject on mismatch
    const currentMachine = machineId();
    const storedMachine  = config._machineId;

    if (!storedMachine) {
      config._machineId = currentMachine;
      writeFileSync(configPath, JSON.stringify(config, null, 2));
    } else if (storedMachine !== currentMachine) {
      return {
        valid:  false,
        reason: "This subscription is registered to a different machine.\n" +
                "     Contact support at nigelbot.gumroad.com to transfer.",
      };
    }
  }

  return {
    valid: true,
    email: data.email,
    plan:  data.plan,
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
  timer.unref();
}
