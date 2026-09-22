/**
 * Display — Matrix-themed terminal output.
 *
 * Palette  : bright green / medium green / dim green / amber (warn) / red (fatal)
 * Animation: digital rain → glitch-reveal (banner), typewriter (status lines)
 * Rule     : never animate danger signals — warn/fail print immediately
 */

export const VERSION      = "1.1.54";
export const PRODUCT_NAME = "ES FUTURES BOT";

// ── Color tokens ──────────────────────────────────────────────────────────────
export const C = {
  hi:    "\x1b[1;32m",   // bright Matrix green  — borders, title, values
  med:   "\x1b[32m",     // medium green         — body text, subtitles
  lo:    "\x1b[2;32m",   // dim green            — labels, rain trail
  warn:  "\x1b[1;33m",   // amber                — warnings only
  err:   "\x1b[1;31m",   // red                  — fatal errors only
  reset: "\x1b[0m",
  hide:  "\x1b[?25l",    // hide cursor
  show:  "\x1b[?25h",    // show cursor
};

// ── Matrix character set (half-width Katakana + digits + symbols) ─────────────
const MC = "ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789!@#$%&<>";
const rc  = () => MC[Math.floor(Math.random() * MC.length)];

// ── Core helpers ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const out   = (s)  => process.stdout.write(s);
const ln    = (s = "") => process.stdout.write(s + "\n");

// Always restore cursor on exit so the shell isn't left blind
const restoreCursor = () => out(C.show + C.reset);
process.on("exit",   restoreCursor);
process.on("SIGINT", () => { restoreCursor(); process.exit(0); });

// ── Digital rain line ─────────────────────────────────────────────────────────
// Most chars dim, occasional medium and bright highlights for depth.
function rainLine(width) {
  let line = "";
  for (let i = 0; i < width; i++) {
    const r = Math.random();
    line += r < 0.06 ? C.hi : r < 0.25 ? C.med : C.lo;
    line += rc();
  }
  return line + C.reset;
}

// ── Glitch-reveal ─────────────────────────────────────────────────────────────
// Characters resolve left-to-right from random Matrix chars into real text.
// `prefix` and `suffix` (box borders etc.) are printed verbatim each frame.
async function glitchReveal(plainText, { color = C.hi, prefix = "", suffix = "", speed = 3, frameMs = 45 } = {}) {
  const len    = plainText.length;
  const result = Array.from(plainText).map(c => (c === " " ? " " : rc()));
  let resolved = 0;

  out(C.hide);

  while (resolved < len) {
    // Glitch unresolved chars
    for (let j = resolved; j < len; j++) {
      if (plainText[j] !== " ") result[j] = rc();
    }
    out(`\r${prefix}${color}${result.join("")}${C.reset}${suffix}`);
    await sleep(frameMs);

    // Settle next chunk
    const next = Math.min(resolved + speed, len);
    for (let j = resolved; j < next; j++) result[j] = plainText[j];
    resolved = next;
  }

  // Final settled state
  out(`\r${prefix}${color}${plainText}${C.reset}${suffix}\n`);
  out(C.show);
}

// ── Typewriter ────────────────────────────────────────────────────────────────
// Used for status lines. Spaces print instantly; printable chars add a small delay.
async function typeOut(text, charMs = 14) {
  for (const ch of text) {
    out(ch);
    if (ch.trim()) await sleep(charMs);
  }
}

// ── Banner ────────────────────────────────────────────────────────────────────
const BW = 52;  // inner width between the ║ borders

export async function banner() {
  ln();

  // Digital rain cascade — scrolls naturally above the box
  for (let i = 0; i < 6; i++) {
    ln(rainLine(BW + 2));
    await sleep(70);
  }

  // Box top border
  out(C.hi);
  ln("╔" + "═".repeat(BW) + "╗");
  ln("║" + " ".repeat(BW) + "║");
  out(C.reset);

  // Title line — glitch reveal between box borders
  const titleText = PRODUCT_NAME;
  const ver       = `v${VERSION}`;
  const gap       = BW - 4 - titleText.length - ver.length;  // 2-space padding each side
  const titleLine = `  ${titleText}${" ".repeat(Math.max(gap, 1))}${ver}  `;

  await glitchReveal(titleLine, {
    color:  C.hi,
    prefix: C.hi + "║" + C.reset,
    suffix: C.hi + "║" + C.reset,
    speed:  4,
    frameMs: 40,
  });

  // Subtitle — typewriter between borders
  const subText   = "  TOPSTEPX COMBINE TRADER";
  const subPad    = " ".repeat(BW - subText.length);
  out(C.hi + "║" + C.med);
  await typeOut(subText, 22);
  out(subPad + C.hi + "║" + C.reset + "\n");

  // Box bottom
  out(C.hi);
  ln("║" + " ".repeat(BW) + "║");
  ln("╚" + "═".repeat(BW) + "╝");
  out(C.reset + "\n");
}

// ── Status line exports ───────────────────────────────────────────────────────

export async function ok(msg) {
  out(`  ${C.hi}✓${C.reset}  ${C.med}`);
  await typeOut(msg, 12);
  out(C.reset + "\n");
}

export async function info(msg) {
  out(`  ${C.lo}·${C.reset}  ${C.lo}`);
  await typeOut(msg, 10);
  out(C.reset + "\n");
}

// warn and fail are immediate — never animate danger signals
export function warn(msg) {
  ln(`  ${C.warn}⚠${C.reset}  ${C.warn}${msg}${C.reset}`);
}

export function fail(msg) {
  ln(`  ${C.err}✗${C.reset}  ${C.err}${msg}${C.reset}`);
}

export async function section(title) {
  ln();
  await glitchReveal(`  ${title}`, {
    color:   C.hi,
    speed:   5,
    frameMs: 35,
  });
}

export async function label(key, value) {
  const k = String(key).padEnd(22);
  out(`     ${C.lo}${k}${C.reset}${C.hi}`);
  await typeOut(String(value), 9);
  out(C.reset + "\n");
}

export function divider() {
  ln(`  ${C.lo}${"─".repeat(BW - 2)}${C.reset}`);
}

export function blank() {
  ln();
}

// ── Formatters ────────────────────────────────────────────────────────────────

export function fmtPnl(n) {
  const abs = Math.abs(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
  return n >= 0
    ? `${C.hi}+${abs}${C.reset}`
    : `${C.err}-${abs.replace("-", "")}${C.reset}`;
}

export function timestamp() {
  return new Date().toLocaleTimeString("en-US", {
    hour12:   false,
    timeZone: "America/Phoenix",
  });
}
