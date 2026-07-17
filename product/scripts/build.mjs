/**
 * Build pipeline:
 *   1. Copy engine files into product/src/engine/
 *   2. Obfuscate all JS source files → build/obfuscated/
 *   3. Compile with pkg → dist/ (Mac arm64, Mac x64, Windows x64)
 *
 * Run: node scripts/build.mjs
 *      node scripts/build.mjs --mac-only
 *      node scripts/build.mjs --win-only
 *      node scripts/build.mjs --no-obfuscate   (faster, for testing)
 */

import { execSync }    from "child_process";
import { existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { resolve, dirname, basename, join } from "path";
import { fileURLToPath } from "url";

const __dir   = dirname(fileURLToPath(import.meta.url));
const ROOT    = resolve(__dir, "..");
const ENGINE  = resolve(ROOT, "../engine");
const BUILD   = resolve(ROOT, "build");
const DIST    = resolve(ROOT, "dist");

const args         = process.argv.slice(2);
const MAC_ONLY     = args.includes("--mac-only");
const WIN_ONLY     = args.includes("--win-only");
const NO_OBFUSCATE = args.includes("--no-obfuscate");

const log  = (msg) => console.log(`  \x1b[36m·\x1b[0m  ${msg}`);
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m  ${msg}`);
const step = (msg) => console.log(`\n\x1b[1m${msg}\x1b[0m`);

console.log("\n\x1b[1mES Futures Bot — Build Pipeline\x1b[0m\n");

// ── Step 1: Clean and prepare dirs ───────────────────────────────────────────
step("1. Preparing build directories");
for (const d of [BUILD, DIST, join(BUILD, "src"), join(BUILD, "src/engine")]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}
ok("Directories ready");

// ── Step 2: Copy engine files ────────────────────────────────────────────────
step("2. Copying engine files");
const engineFiles = ["topstepx-engine.js", "strategies.js", "indicators.js"];
for (const f of engineFiles) {
  const src  = join(ENGINE, f);
  const dest = join(BUILD, "src/engine", f);
  if (!existsSync(src)) { console.error(`  ✗  Missing: ${src}`); process.exit(1); }
  copyFileSync(src, dest);
  log(f);
}

// Update engine-runner.js path to point to bundled engine
const runnerSrc = join(ROOT, "src/engine-runner.js");
const runnerOut = join(BUILD, "src/engine-runner.js");
const runnerCode = readFileSync(runnerSrc, "utf8")
  .replace(
    /resolve\(__dir, ".*?topstepx-engine\.js"\)/,
    `resolve(__dir, "engine/topstepx-engine.js")`
  );
writeFileSync(runnerOut, runnerCode);
ok("Engine runner path updated");

// ── Step 3: Copy product source files ────────────────────────────────────────
step("3. Copying product source");
const srcFiles = readdirSync(join(ROOT, "src")).filter(f => f.endsWith(".js") && f !== "engine-runner.js");
for (const f of srcFiles) {
  copyFileSync(join(ROOT, "src", f), join(BUILD, "src", f));
  log(f);
}
copyFileSync(join(ROOT, "bot.js"),              join(BUILD, "bot.js"));
copyFileSync(join(ROOT, "setup.js"),            join(BUILD, "setup.js"));
copyFileSync(join(ROOT, "config.default.json"), join(BUILD, "config.default.json"));
copyFileSync(join(ROOT, "README.txt"),          join(BUILD, "README.txt"));
ok("Source files copied");

// ── Step 4: Obfuscate ────────────────────────────────────────────────────────
if (!NO_OBFUSCATE) {
  step("4. Obfuscating source");
  const jsFiles = [
    join(BUILD, "bot.js"),
    join(BUILD, "setup.js"),
    ...["license.js","config.js","updater.js","display.js","engine-runner.js"].map(f => join(BUILD, "src", f)),
    ...engineFiles.map(f => join(BUILD, "src/engine", f)),
  ];

  for (const file of jsFiles) {
    execSync(
      `npx javascript-obfuscator ${file} --output ${file} ` +
      `--compact true --string-array true --string-array-encoding base64 ` +
      `--control-flow-flattening false --identifier-names-generator hexadecimal`,
      { cwd: ROOT, stdio: "pipe" }
    );
    log(basename(file));
  }
  ok("Obfuscation complete");
} else {
  step("4. Obfuscation skipped (--no-obfuscate)");
}

// ── Step 5: Generate pkg config ───────────────────────────────────────────────
step("5. Generating pkg config");
const pkgConfig = {
  pkg: {
    assets: ["config.default.json", "README.txt"],
    scripts: ["src/**/*.js"],
  }
};
const buildPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
Object.assign(buildPkg, pkgConfig);
writeFileSync(join(BUILD, "package.json"), JSON.stringify(buildPkg, null, 2));
ok("package.json written to build/");

// ── Step 6: Compile binaries ──────────────────────────────────────────────────
step("6. Compiling binaries");

const targets = [];
if (!WIN_ONLY) targets.push("node20-macos-arm64", "node20-macos-x64");
if (!MAC_ONLY) targets.push("node20-win-x64");

const targetArg = targets.join(",");
log(`Targets: ${targetArg}`);

execSync(
  `npx pkg ${join(BUILD, "bot.js")} --targets ${targetArg} --out-path ${DIST} --compress GZip`,
  { cwd: ROOT, stdio: "inherit" }
);

// Rename Windows binary to have .exe if pkg didn't already
const winOut = join(DIST, "bot-win.exe");
const winRaw = join(DIST, "bot-win");
if (existsSync(winRaw) && !existsSync(winOut)) {
  const { renameSync } = await import("fs");
  renameSync(winRaw, winOut);
}

ok("Binaries compiled");

// ── Done ──────────────────────────────────────────────────────────────────────
console.log("\n\x1b[32m\x1b[1m  Build complete!\x1b[0m\n");
console.log("  Output:");
for (const f of readdirSync(DIST)) {
  const size = (readFileSync(join(DIST, f)).length / 1024 / 1024).toFixed(1);
  console.log(`    ${f.padEnd(30)} ${size} MB`);
}
console.log("");
