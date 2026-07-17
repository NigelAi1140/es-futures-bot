/**
 * Version check — compares running version against latest GitHub release.
 * Non-blocking: runs in background, prints notice if update available.
 */

import { VERSION } from "./display.js";

// Set this to your GitHub repo before distributing
const GITHUB_REPO = "NigelAi1140/es-futures-bot";
const RELEASES_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

function parseVersion(v) {
  return (v ?? "").replace(/^v/, "").split(".").map(Number);
}

function isNewer(latest, current) {
  const [la, lb, lc] = parseVersion(latest);
  const [ca, cb, cc] = parseVersion(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

export async function checkForUpdate() {
  try {
    const res = await fetch(RELEASES_URL, {
      headers: { "User-Agent": "es-futures-bot" },
      signal:  AbortSignal.timeout(5_000),
    });
    if (!res.ok) return;

    const data = await res.json();
    const latest = data.tag_name ?? data.name;

    if (isNewer(latest, VERSION)) {
      console.log("");
      console.log("  \x1b[33m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m");
      console.log(`  \x1b[33m  Update available: v${VERSION} → ${latest}\x1b[0m`);
      console.log(`  \x1b[33m  Download at your Gumroad purchase page\x1b[0m`);
      console.log("  \x1b[33m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m");
      console.log("");
    }
  } catch {
    // Non-fatal — silently skip if no network or repo not set up yet
  }
}
