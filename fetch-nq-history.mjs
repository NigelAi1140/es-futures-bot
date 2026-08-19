/**
 * Fetch missing NQ bar history from TopstepX API and append to NQ.txt
 * Same backward-pagination approach as fetch-es-history.mjs
 */
import axios from "axios";
import { appendFileSync, readFileSync } from "fs";

const REST_BASE = "https://api.topstepx.com";
const API_KEY   = "j7aI2WhpXbtRKe3KNkyHWfNNMwtTecQRPpNIkzTr9N4=";
const USER      = "nicholas11morris@gmail.com";

const CONTRACTS = [
  { id: "CON.F.US.ENQ.M26", label: "ENQM26 (Jun)", stopBefore: "2026-06-19T00:00:00Z" },
  { id: "CON.F.US.ENQ.U26", label: "ENQU26 (Sep)", stopBefore: null },
];

let token = null;
async function apiPost(path, body = {}, retries = 3) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.post(`${REST_BASE}${path}`, body, { headers });
      return res.data;
    } catch (err) {
      if (err.response?.status === 429 && attempt < retries) {
        const wait = 2000 * (attempt + 1);
        process.stdout.write(`  Rate limited — waiting ${wait/1000}s...\n`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

process.stdout.write("Authenticating...\n");
const authData = await apiPost("/api/Auth/loginKey", { userName: USER, apiKey: API_KEY });
if (!authData.success) throw new Error(`Auth failed: ${authData.errorMessage}`);
token = authData.token;
process.stdout.write("✓ Authenticated\n\n");

// Find last timestamp in NQ.txt
process.stdout.write("Reading NQ.txt last bar...\n");
let lastTsInFile = 0;
{
  const lines = readFileSync("./NQ.txt", "utf8").trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const p = lines[i].split(",");
    if (p.length < 6) continue;
    const [mo, dy, yr] = p[0].split("/");
    const [hr, mn] = p[1].split(":");
    lastTsInFile = Date.UTC(+yr, +mo - 1, +dy, +hr, +mn) / 1000;
    break;
  }
}
process.stdout.write(`  Last bar in NQ.txt: ${new Date(lastTsInFile * 1000).toISOString()}\n\n`);

const STOP_TS = lastTsInFile;

function formatLine(b) {
  const d = new Date(b.time * 1000);
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dy = String(d.getUTCDate()).padStart(2, "0");
  const yr = d.getUTCFullYear();
  const hr = String(d.getUTCHours()).padStart(2, "0");
  const mn = String(d.getUTCMinutes()).padStart(2, "0");
  return `${mo}/${dy}/${yr},${hr}:${mn},${b.open},${b.high},${b.low},${b.close},${b.volume}`;
}

let totalNew = 0;

for (const contract of CONTRACTS) {
  process.stdout.write(`\nFetching ${contract.label}: ${contract.id}\n`);

  let cursorEnd = contract.stopBefore
    ? new Date(Math.min(new Date(contract.stopBefore).getTime(), Date.now()))
    : new Date();

  const contractBars = [];
  let iterations = 0;

  while (iterations++ < 80) {
    const startTime = new Date(cursorEnd.getTime() - 30 * 24 * 60 * 60 * 1000);

    const data = await apiPost("/api/History/retrieveBars", {
      contractId:        contract.id,
      live:              false,
      startTime:         startTime.toISOString(),
      endTime:           cursorEnd.toISOString(),
      unit:              2,
      unitNumber:        1,
      limit:             1000,
      includePartialBar: false,
    });

    if (!data.success || !data.bars?.length) {
      process.stdout.write(`  No more bars (cursor: ${cursorEnd.toISOString()})\n`);
      break;
    }

    const chunk = data.bars
      .map(b => ({ time: new Date(b.t).getTime() / 1000, open: +b.o, high: +b.h, low: +b.l, close: +b.c, volume: b.v ?? 0 }))
      .sort((a, b) => a.time - b.time);

    const oldest = chunk[0], newest = chunk[chunk.length - 1];
    process.stdout.write(`  [${iterations}] ${chunk.length} bars: ${new Date(oldest.time*1000).toISOString().slice(0,16)} → ${new Date(newest.time*1000).toISOString().slice(0,16)}\n`);

    const newBars = chunk.filter(b => b.time > STOP_TS);
    contractBars.push(...newBars);

    if (oldest.time <= STOP_TS) {
      process.stdout.write(`  Reached stop point\n`);
      break;
    }

    cursorEnd = new Date(oldest.time * 1000 - 60 * 1000);
    await new Promise(r => setTimeout(r, 600));
  }

  if (contractBars.length > 0) {
    const sorted = contractBars.sort((a, b) => a.time - b.time);
    appendFileSync("./NQ.txt", "\n" + sorted.map(formatLine).join("\n"));
    process.stdout.write(`  ✅ Written ${sorted.length} new bars\n`);
    totalNew += sorted.length;
  }
  process.stdout.write(`  Total from ${contract.label}: ${contractBars.length} new bars\n`);
}

process.stdout.write(`\n✅ Done — ${totalNew} total new NQ bars appended\n`);
