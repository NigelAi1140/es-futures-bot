/**
 * Fetch 1-minute bar history for all non-ES/NQ markets from TopstepX API.
 * Paginates back quarterly contract by contract from current until no data.
 * Saves: YM.txt, RTY.txt, CL.txt, GC.txt, 6E.txt, ZB.txt, ZN.txt
 */
import axios from "axios";
import { writeFileSync, existsSync, readFileSync, appendFileSync } from "fs";

const REST = "https://api.topstepx.com";
const USER = "nicholas11morris@gmail.com";
const KEY  = "j7aI2WhpXbtRKe3KNkyHWfNNMwtTecQRPpNIkzTr9N4=";

// Quarterly month codes in order
const QTR_MONTHS = ["H", "M", "U", "Z"]; // Mar, Jun, Sep, Dec

// Market configs: label, product code, tick size, and which quarter months apply
// GC uses Dec/Jun/Feb/Aug; for simplicity use all quarters and skip empty ones
const MARKETS = [
  { label: "YM",  prefix: "CON.F.US.YM"  },
  { label: "RTY", prefix: "CON.F.US.RTY" },
  { label: "CL",  prefix: "CON.F.US.CLE" },
  { label: "GC",  prefix: "CON.F.US.GCE" },
  { label: "6E",  prefix: "CON.F.US.EU6" },
  { label: "ZB",  prefix: "CON.F.US.USA" },
  { label: "ZN",  prefix: "CON.F.US.TYA" },
];

const STOP_YEAR  = 2020;  // don't go before Jan 2020
const RATE_DELAY = 500;   // ms between API calls

let token = null;
async function apiPost(path, body = {}, retries = 3) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.post(`${REST}${path}`, body, { headers, timeout: 15000 });
      return res.data;
    } catch (err) {
      if (err.response?.status === 429 && attempt < retries) {
        const wait = 2000 * (attempt + 1);
        process.stdout.write(`  Rate limited — waiting ${wait/1000}s...\n`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      throw err;
    }
  }
}

function formatLine(b) {
  const d = new Date(b.time * 1000);
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dy = String(d.getUTCDate()).padStart(2, "0");
  const yr = d.getUTCFullYear();
  const hr = String(d.getUTCHours()).padStart(2, "0");
  const mn = String(d.getUTCMinutes()).padStart(2, "0");
  return `${mo}/${dy}/${yr},${hr}:${mn},${b.open},${b.high},${b.low},${b.close},${b.volume}`;
}

// Build list of quarterly contract IDs from now back to STOP_YEAR
function buildContractList(prefix) {
  const now = new Date();
  const contracts = [];
  for (let yr = now.getFullYear(); yr >= STOP_YEAR; yr--) {
    for (let qi = QTR_MONTHS.length - 1; qi >= 0; qi--) {
      const m = QTR_MONTHS[qi];
      const yy = String(yr).slice(2);
      // Skip future contracts
      const qMonth = [2,5,8,11][qi]; // 0-indexed months for H,M,U,Z
      if (yr === now.getFullYear() && qMonth > now.getMonth()) continue;
      contracts.push({ id: `${prefix}.${m}${yy}`, label: `${m}${yy}` });
    }
  }
  return contracts;
}

// Authenticate
process.stdout.write("Authenticating with TopstepX...\n");
const authData = await apiPost("/api/Auth/loginKey", { userName: USER, apiKey: KEY });
if (!authData.success) throw new Error(`Auth failed: ${authData.errorMessage}`);
token = authData.token;
process.stdout.write("✓ Authenticated\n\n");

for (const mkt of MARKETS) {
  process.stdout.write(`\n${"=".repeat(60)}\nMarket: ${mkt.label}\n${"=".repeat(60)}\n`);

  const outFile = `./${mkt.label}.txt`;
  // Start fresh for each market
  writeFileSync(outFile, "");

  const contracts = buildContractList(mkt.prefix);
  process.stdout.write(`Checking ${contracts.length} quarterly contracts back to ${STOP_YEAR}...\n`);

  let totalBars = 0;
  let allBars = [];

  for (const contract of contracts) {
    process.stdout.write(`\n  Contract: ${contract.id}\n`);

    // Probe first — check if this contract has any data at all
    const probe = await apiPost("/api/History/retrieveBars", {
      contractId: contract.id,
      live: false,
      startTime:  new Date(Date.now() - 200 * 24 * 3600 * 1000).toISOString(),
      endTime:    new Date().toISOString(),
      unit: 2, unitNumber: 1, limit: 5, includePartialBar: false,
    });

    if (!probe.success || !probe.bars?.length) {
      process.stdout.write(`    No data — skipping\n`);
      await new Promise(r => setTimeout(r, RATE_DELAY));
      continue;
    }

    // Full paginated fetch for this contract
    const newestBar = probe.bars.reduce((a, b) => new Date(b.t) > new Date(a.t) ? b : a);
    const oldestBar = probe.bars.reduce((a, b) => new Date(b.t) < new Date(a.t) ? b : a);
    process.stdout.write(`    Has data. Fetching all bars...\n`);

    let cursorEnd = new Date(); // start from now, paginate back
    const contractBars = [];
    let iterations = 0;
    const MAX_ITER = 120;
    let hitBottom = false;

    while (iterations++ < MAX_ITER) {
      const startTime = new Date(cursorEnd.getTime() - 35 * 24 * 60 * 60 * 1000);

      const data = await apiPost("/api/History/retrieveBars", {
        contractId: contract.id,
        live: false,
        startTime:  startTime.toISOString(),
        endTime:    cursorEnd.toISOString(),
        unit: 2, unitNumber: 1, limit: 1000, includePartialBar: false,
      });

      if (!data.success || !data.bars?.length) {
        process.stdout.write(`    No more bars at cursor ${cursorEnd.toISOString().slice(0,10)}\n`);
        break;
      }

      const chunk = data.bars
        .map(b => ({
          time:   new Date(b.t).getTime() / 1000,
          open:   +b.o, high: +b.h, low: +b.l, close: +b.c, volume: b.v ?? 0,
        }))
        .sort((a, b) => a.time - b.time);

      const oldest = chunk[0];
      const newest = chunk[chunk.length - 1];
      process.stdout.write(`    [${iterations}] ${chunk.length} bars: ${new Date(oldest.time*1000).toISOString().slice(0,10)} → ${new Date(newest.time*1000).toISOString().slice(0,10)}\n`);

      contractBars.push(...chunk);

      // Stop if we've hit Jan 2020
      if (oldest.time < new Date(`${STOP_YEAR}-01-01`).getTime() / 1000) {
        process.stdout.write(`    Reached ${STOP_YEAR} stop point\n`);
        hitBottom = true;
        break;
      }

      cursorEnd = new Date(oldest.time * 1000 - 60 * 1000);
      await new Promise(r => setTimeout(r, RATE_DELAY));
    }

    if (contractBars.length > 0) {
      const sorted = contractBars.sort((a, b) => a.time - b.time);
      allBars.push(...sorted);
      process.stdout.write(`    ✓ ${sorted.length} bars from ${contract.id}\n`);
      totalBars += sorted.length;
    }

    if (hitBottom) break; // reached STOP_YEAR, no need to go further
    await new Promise(r => setTimeout(r, RATE_DELAY));
  }

  // Deduplicate, sort, write
  const unique = Array.from(
    new Map(allBars.map(b => [b.time, b])).values()
  ).sort((a, b) => a.time - b.time);

  const lines = unique.map(formatLine);
  writeFileSync(outFile, lines.join("\n"));

  const first = unique[0] ? new Date(unique[0].time*1000).toISOString().slice(0,10) : "n/a";
  const last  = unique[unique.length-1] ? new Date(unique[unique.length-1].time*1000).toISOString().slice(0,10) : "n/a";
  process.stdout.write(`\n✅ ${mkt.label}: ${unique.length} bars written (${first} → ${last})\n`);
}

process.stdout.write("\n\nAll markets fetched.\n");
