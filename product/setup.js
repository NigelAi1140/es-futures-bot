/**
 * First-run setup wizard.
 * Walks the user through license, broker credentials, accounts, and settings.
 * Writes config.json when complete.
 */

import readline from "readline";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join }  from "path";
import { banner, ok, info, warn, fail, label, divider, blank } from "./src/display.js";

const __dir       = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dir, "config.json");
const DEFAULT_PATH = join(__dir, "config.default.json");

// ── Input helpers ─────────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const ask = (q, def) => new Promise(res => {
  const hint = (def != null && def !== "") ? ` \x1b[90m[${def}]\x1b[0m` : "";
  rl.question(`  \x1b[36m?\x1b[0m  ${q}${hint}: `, ans => {
    res(ans.trim() || String(def ?? ""));
  });
});

const askRequired = async (q) => {
  while (true) {
    const ans = await ask(q);
    if (ans) return ans;
    warn("This field is required.");
  }
};

const confirm = (q, def = "y") =>
  ask(q + " (y/n)", def).then(a => a.toLowerCase() === "y");

// ── Main ──────────────────────────────────────────────────────────────────────
banner();
console.log("  Setup Wizard\n");
console.log("  You will need:");
console.log("    · The email you used to subscribe on Gumroad");
console.log("    · Your TopstepX username  (email address)");
console.log("    · One API key from TopstepX — covers all your accounts");
console.log("      → TopstepX platform → Settings → API Keys → Generate");
blank();

// Warn if config already exists
let existing = {};
if (existsSync(CONFIG_PATH)) {
  warn("config.json already exists. Running setup will overwrite it.");
  const keep = await confirm("Continue and overwrite");
  if (!keep) { console.log("\n  Cancelled.\n"); rl.close(); process.exit(0); }
  try { existing = JSON.parse(readFileSync(CONFIG_PATH, "utf8")); } catch {}
  blank();
}

const defaults = JSON.parse(readFileSync(DEFAULT_PATH, "utf8"));
const cfg = JSON.parse(JSON.stringify(defaults));

// ── Step 1: License ───────────────────────────────────────────────────────────
divider();
console.log("  \x1b[1mStep 1 of 5 — Activation\x1b[0m");
blank();
info("Enter the email address you used when you subscribed on Gumroad.");
blank();

cfg.license.email = await askRequired("Gumroad email");
blank();

// ── Step 2: Broker username ───────────────────────────────────────────────────
divider();
console.log("  \x1b[1mStep 2 of 5 — TopstepX Username\x1b[0m");
blank();
info("This is the email you use to log in to TopstepX.");
blank();

cfg.broker.username = await askRequired("TopstepX username (email)");
blank();

// ── Step 3: Accounts ──────────────────────────────────────────────────────────
divider();
console.log("  \x1b[1mStep 3 of 5 — Accounts\x1b[0m");
blank();
info("One API key covers all your accounts (up to 5).");
info("TopstepX allows Funded accounts and Combine accounts.");
info("Funded accounts are always placed first.");
blank();

cfg.broker.apiKey = await askRequired("TopstepX API key");
blank();

cfg.broker.accounts = [];
let accNum = 1;

while (accNum <= 5) {
  const existingAcc = existing.broker?.accounts?.[accNum - 1];
  const defaultName = existingAcc?.name ?? (accNum === 1 ? "Funded 1" : `Combine ${accNum - 1}`);
  const defaultType = existingAcc?.type ?? (accNum === 1 ? "Funded" : "Combine");

  const prompt = accNum === 1
    ? `Account ${accNum} name`
    : `Account ${accNum} name (or press Enter to stop adding)`;

  const name = accNum === 1
    ? await ask(prompt, defaultName)
    : await ask(prompt, "");

  if (!name && accNum > 1) break;

  const typeAns = await ask(`  Type for "${name || defaultName}" — Funded or Combine`, defaultType);
  const type = typeAns.toLowerCase().startsWith("f") ? "Funded" : "Combine";

  cfg.broker.accounts.push({ name: name || defaultName, type });
  blank();
  ok(`Added: ${name || defaultName} (${type})`);
  blank();
  accNum++;
}

// Sort: Funded first, then Combine
cfg.broker.accounts.sort((a, b) => (a.type === "Funded" ? -1 : 1) - (b.type === "Funded" ? -1 : 1));

// ── Step 4: Trading settings ──────────────────────────────────────────────────
divider();
console.log("  \x1b[1mStep 4 of 5 — Trading Settings\x1b[0m");
blank();
info("Press Enter to accept the recommended defaults shown in brackets.");
blank();

const ex = existing.trading ?? {};
const t  = cfg.trading;

t.contracts       = parseInt(await ask("Contracts per trade (1–5)",  ex.contracts       ?? 2));
t.stopLossTicks   = parseInt(await ask("Stop loss ticks (8–15)",     ex.stopLossTicks   ?? 10));
t.takeProfitTicks = parseInt(await ask("Take profit ticks (20–60)",  ex.takeProfitTicks ?? 40));
t.dailyLossLimit  = parseInt(await ask("Daily loss limit ($)",       ex.dailyLossLimit  ?? 1400));
t.dailyProfitCap  = parseInt(await ask("Daily profit cap ($)",       ex.dailyProfitCap  ?? 2000));
blank();

// ── Step 5: Strategies ────────────────────────────────────────────────────────
divider();
console.log("  \x1b[1mStep 5 of 5 — Strategies\x1b[0m");
blank();
info("All strategies are on by default. You can change these anytime in config.json.");
blank();

const strategyList = [
  ["AVWAP_L",     "AVWAP Long       — buys VWAP support, strong trend follower"],
  ["3BAR_BEAR_S", "3-Bar Bear Short — short momentum reversal"],
  ["EMAPB_L",     "EMA Pullback Long"],
  ["EMAPB_S",     "EMA Pullback Short"],
  ["RSI2_L",      "RSI2 Long        — oversold bounce"],
  ["RSI2_S",      "RSI2 Short       — overbought reversal"],
];

for (const [id, desc] of strategyList) {
  const def = existing.strategies?.[id] !== false;
  cfg.strategies[id] = await confirm(`  Enable ${desc}`, def ? "y" : "n");
}

// Notifications (optional)
blank();
divider();
blank();
const wantNotifs = await confirm("Set up push notifications via ntfy.sh? (optional — get trade alerts on your phone)");
if (wantNotifs) {
  blank();
  info("Create a free channel at ntfy.sh — pick any name, e.g. 'mybot-alerts'");
  blank();
  cfg.notifications.ntfyChannel = await ask("ntfy.sh channel name", existing.notifications?.ntfyChannel ?? "");
  cfg.notifications.enabled = !!cfg.notifications.ntfyChannel;
}

// ── Write config ──────────────────────────────────────────────────────────────
blank();
divider();
blank();

cfg._machineId = "";  // cleared so it re-binds on first run

writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));

ok("config.json saved successfully.");
blank();

console.log("  \x1b[1mSummary\x1b[0m");
blank();
label("Subscription email:", cfg.license.email);
label("Username:",         cfg.broker.username);
label("API key:",          cfg.broker.apiKey.slice(0, 6) + "••••••");
label("Accounts:",         cfg.broker.accounts.map(a => `${a.name} (${a.type})`).join(", "));
label("Contracts:",        cfg.trading.contracts);
label("Stop / TP:",        `${cfg.trading.stopLossTicks}t / ${cfg.trading.takeProfitTicks}t`);
label("Daily loss limit:", `$${cfg.trading.dailyLossLimit}`);
label("Daily profit cap:", `$${cfg.trading.dailyProfitCap}`);
blank();
info("To start the bot:  node bot.js");
info("To change settings, edit config.json and restart.");
blank();

rl.close();
