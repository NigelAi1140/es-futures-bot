/* ── Matrix rain ──────────────────────────────────────────────────────────── */
const MATRIX_CHARS = "ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789!@#$%&";

(function initRain() {
  const canvas = document.getElementById("rain");
  const ctx    = canvas.getContext("2d");
  let cols, drops;

  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    cols  = Math.floor(canvas.width / 16);
    drops = drops ? drops.slice(0, cols) : [];
    while (drops.length < cols) drops.push(Math.random() * -50);
  }

  resize();
  window.addEventListener("resize", resize);

  function tick() {
    ctx.fillStyle = "rgba(0,0,0,0.04)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let i = 0; i < cols; i++) {
      const r = Math.random();
      ctx.font = "14px monospace";
      if (r < 0.05) {
        ctx.fillStyle = "#00ff41";
      } else if (r < 0.25) {
        ctx.fillStyle = "#00cc33";
      } else {
        ctx.fillStyle = "#003d0f";
      }
      const ch = MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)];
      ctx.fillText(ch, i * 16, drops[i] * 16);

      if (drops[i] * 16 > canvas.height && Math.random() > 0.975) drops[i] = 0;
      drops[i]++;
    }
  }

  setInterval(tick, 50);
})();

/* ── Glitch-reveal ────────────────────────────────────────────────────────── */
function glitchReveal(el, text, { frameMs = 40, speed = 2 } = {}) {
  return new Promise(resolve => {
    const chars = text.split("");
    let done    = 0;

    const frame = () => {
      const buf = chars.map((ch, i) => {
        if (i < done) return ch;
        return MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)];
      }).join("");
      el.textContent = buf;

      done = Math.min(done + speed, chars.length);
      if (done < chars.length) {
        setTimeout(frame, frameMs);
      } else {
        el.textContent = text;
        resolve();
      }
    };
    frame();
  });
}

/* ── State ────────────────────────────────────────────────────────────────── */
const state = {
  accounts:    {},     // name → { pnl: number|null, balance: null, status }
  autoScroll:  true,
  paused:      false,
  logFilter:   "all",
  fullConfig:  null,   // full config object from main, used by settings panel
};

/* ── DOM refs ─────────────────────────────────────────────────────────────── */
const $acctList   = document.getElementById("account-list");
const $log        = document.getElementById("log");
const $connDot    = document.getElementById("conn-dot");
const $trendSt    = document.getElementById("trend-status");
const $stratCt    = document.getElementById("strat-count");
const $contracts  = document.getElementById("contracts");
const $sltp       = document.getElementById("sl-tp");
const $dailyLim   = document.getElementById("daily-limit");
const $profitCap  = document.getElementById("profit-cap");
const $licUser    = document.getElementById("license-user");
const $appVer     = document.getElementById("app-version");
const $chkScroll  = document.getElementById("chk-scroll");
const $totalPnl   = document.getElementById("total-pnl");
const $btnPause   = document.getElementById("btn-pause");

$chkScroll.addEventListener("change", () => { state.autoScroll = $chkScroll.checked; });

/* ── Log ──────────────────────────────────────────────────────────────────── */
const MAX_LOG_LINES = 500;

function appendLog(account, message, { isErr = false } = {}) {
  const now  = new Date();
  const ts   = now.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

  const line = document.createElement("div");
  line.className = "log-line";

  const cls = classifyLine(message, isErr);
  if (cls) line.classList.add(cls);

  const tsPart   = document.createElement("span");
  tsPart.className = "log-ts";
  tsPart.textContent = ts;

  const acctPart = document.createElement("span");
  acctPart.className = "log-acct";
  acctPart.textContent = account ?? "";

  const msgPart  = document.createElement("span");
  msgPart.className = "log-msg";
  msgPart.textContent = message;

  line.append(tsPart, acctPart, msgPart);
  $log.appendChild(line);

  while ($log.children.length > MAX_LOG_LINES) $log.removeChild($log.firstChild);
  if (state.autoScroll) $log.scrollTop = $log.scrollHeight;
}

function classifyLine(msg, isErr) {
  if (isErr)                                    return "is-err";
  if (/Restarting|RESTART/i.test(msg))          return "is-warn";
  if (/limit reached|halted|⛔/i.test(msg))     return "is-warn";
  if (/skipped.*stop.*exceeds/i.test(msg))      return "is-dim";
  if (/LONG|SHORT|ENTRY|FILL/i.test(msg))       return "is-trade";
  if (/WIN|profit|\+\$[0-9]/i.test(msg))        return "is-win";
  if (/LOSS|\-\$[0-9]/i.test(msg))              return "is-loss";
  if (/UPTREND|DOWNTREND|NEUTRAL/i.test(msg))   return "is-trend";
  if (/^\[Debug\]/i.test(msg))                  return "is-dim";
  return "";
}

function clearLog() { $log.innerHTML = ""; }
window.clearLog = clearLog;

/* ── Log filter ───────────────────────────────────────────────────────────── */
function setFilter(filter) {
  state.logFilter = filter;
  $log.className = filter === "all" ? "" : `filter-${filter}`;

  document.querySelectorAll(".filter-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.filter === filter);
  });

  if (state.autoScroll) $log.scrollTop = $log.scrollHeight;
}
window.setFilter = setFilter;

/* ── Total P&L ────────────────────────────────────────────────────────────── */
function refreshTotalPnl() {
  const values = Object.values(state.accounts)
    .map(a => a.pnl)
    .filter(p => typeof p === "number");

  if (!values.length) { $totalPnl.textContent = "—"; $totalPnl.className = "total-pnl-v"; return; }

  const total = values.reduce((s, v) => s + v, 0);
  const sign  = total >= 0 ? "+" : "";
  $totalPnl.textContent = `${sign}$${Math.round(total).toLocaleString()}`;
  $totalPnl.className   = "total-pnl-v " + (total >= 0 ? "pos" : "neg");
}

/* ── Account cards ────────────────────────────────────────────────────────── */
function getOrCreateCard(name) {
  let card = document.getElementById(`acct-${CSS.escape(name)}`);
  if (!card) {
    card = document.createElement("div");
    card.id        = `acct-${CSS.escape(name)}`;
    card.className = "acct-card";
    card.innerHTML = `
      <div class="acct-name">
        <span class="dot dot-off" id="dot-${CSS.escape(name)}"></span>
        <span>${name}</span>
      </div>
      <div class="acct-row"><span class="k">PnL</span><span class="v" id="pnl-${CSS.escape(name)}">—</span></div>
      <div class="acct-row"><span class="k">Balance</span><span class="v" id="bal-${CSS.escape(name)}">—</span></div>
      <div class="acct-status" id="st-${CSS.escape(name)}">STARTING...</div>
    `;
    $acctList.appendChild(card);
    state.accounts[name] = { pnl: null, balance: null, status: "starting" };
  }
  return card;
}

function updateAccountPnl(name, pnlStr) {
  getOrCreateCard(name);
  const el = document.getElementById(`pnl-${CSS.escape(name)}`);
  if (!el) return;
  el.textContent = pnlStr;
  const isPos = pnlStr.startsWith("+") || (!pnlStr.startsWith("-") && pnlStr !== "—");
  el.classList.toggle("pos", isPos && pnlStr !== "—");
  el.classList.toggle("neg", pnlStr.startsWith("-"));

  // Parse numeric value for total P&L
  const num = parseFloat(pnlStr.replace(/[^0-9.\-+]/g, ""));
  if (!isNaN(num)) {
    if (!state.accounts[name]) state.accounts[name] = {};
    state.accounts[name].pnl = pnlStr.startsWith("-") ? -Math.abs(num) : Math.abs(num);
    refreshTotalPnl();
  }
}

function updateAccountBalance(name, balance) {
  getOrCreateCard(name);
  const el = document.getElementById(`bal-${CSS.escape(name)}`);
  if (el) el.textContent = `$${balance}`;
}

function setAccountStatus(name, status) {
  getOrCreateCard(name);
  const card   = document.getElementById(`acct-${CSS.escape(name)}`);
  const dotEl  = document.getElementById(`dot-${CSS.escape(name)}`);
  const stEl   = document.getElementById(`st-${CSS.escape(name)}`);
  if (!card) return;

  card.classList.remove("active", "trading", "halted");
  if (dotEl) dotEl.className = "dot";

  if (status === "trading") {
    card.classList.add("trading");
    dotEl?.classList.add("dot-on");
    if (stEl) { stEl.textContent = "TRADING"; stEl.className = "acct-status trading"; }
  } else if (status === "halted") {
    card.classList.add("halted");
    dotEl?.classList.add("dot-err");
    if (stEl) { stEl.textContent = "HALTED"; stEl.className = "acct-status halted"; }
  } else {
    card.classList.add("active");
    dotEl?.classList.add("dot-on");
    if (stEl) { stEl.textContent = "ACTIVE"; stEl.className = "acct-status"; }
  }
}

/* ── Pause / Resume ───────────────────────────────────────────────────────── */
async function togglePause() {
  if (!window.bot) return;

  if (!state.paused) {
    await window.bot.pauseAll();
  } else {
    $btnPause.textContent = "▶ RESUME";
    $btnPause.disabled = true;
    await window.bot.resumeAll();
    $btnPause.disabled = false;
  }
}
window.togglePause = togglePause;

function setPausedUI(paused) {
  state.paused = paused;
  $btnPause.textContent = paused ? "▶ RESUME" : "⏸ PAUSE";
  $btnPause.classList.toggle("is-paused", paused);
}

/* ── Settings panel ───────────────────────────────────────────────────────── */
function openSettings() {
  const overlay = document.getElementById("overlay-settings");

  // Populate from state.fullConfig if available, else from current sidebar values
  const cfg = state.fullConfig;
  if (cfg) {
    const t = cfg.trading ?? {};
    const f = cfg.trendFilter ?? {};
    const s = cfg.strategies ?? {};

    setValue("cfg-daily-loss", t.dailyLossLimit);
    setValue("cfg-profit-cap", t.dailyProfitCap);
    setValue("cfg-contracts",  t.contracts);
    setValue("cfg-stop",       t.stopLossTicks);
    setValue("cfg-max-stop",   t.maxStopTicks);
    setValue("cfg-tp",         t.takeProfitTicks);
    setValue("cfg-trail",      t.trailTicks);

    setCheck("cfg-trend-enabled", f.enabled ?? true);
    setValue("cfg-trend-up",  f.uptrendThreshold);
    setValue("cfg-trend-dn",  f.downtrendThreshold);

    // Build strategy toggles
    const container = document.getElementById("settings-strategies");
    container.innerHTML = "";
    for (const [name, enabled] of Object.entries(s)) {
      const label = document.createElement("label");
      label.className = "strat-row";
      label.innerHTML = `<input type="checkbox" data-strat="${name}"${enabled ? " checked" : ""}> ${name}`;
      container.appendChild(label);
    }
  }

  document.getElementById("settings-msg").textContent = "";
  overlay.removeAttribute("hidden");
}
window.openSettings = openSettings;

function closeSettings() {
  document.getElementById("overlay-settings").setAttribute("hidden", "");
}
window.closeSettings = closeSettings;

async function saveSettings() {
  if (!window.bot) return;

  const btn = document.getElementById("btn-save-cfg");
  const msg = document.getElementById("settings-msg");

  btn.disabled = true;
  msg.textContent = "Saving...";
  msg.style.color = "var(--green-lo)";

  // Read form values
  const trading = {
    ...(state.fullConfig?.trading ?? {}),
    dailyLossLimit:  numVal("cfg-daily-loss"),
    dailyProfitCap:  numVal("cfg-profit-cap"),
    contracts:       numVal("cfg-contracts"),
    stopLossTicks:   numVal("cfg-stop"),
    maxStopTicks:    numVal("cfg-max-stop"),
    takeProfitTicks: numVal("cfg-tp"),
    trailTicks:      numVal("cfg-trail"),
  };

  const trendFilter = {
    ...(state.fullConfig?.trendFilter ?? {}),
    enabled:             document.getElementById("cfg-trend-enabled").checked,
    uptrendThreshold:    numVal("cfg-trend-up"),
    downtrendThreshold:  numVal("cfg-trend-dn"),
  };

  const strategies = {};
  document.querySelectorAll("#settings-strategies input[data-strat]").forEach(el => {
    strategies[el.dataset.strat] = el.checked;
  });

  const newConfig = { ...state.fullConfig, trading, trendFilter, strategies };

  try {
    const saveResult = await window.bot.saveConfig(newConfig);
    if (!saveResult?.ok) throw new Error(saveResult?.error ?? "Save failed");

    msg.textContent = "Saved. Restarting engines...";
    msg.style.color = "var(--amber)";

    // Pause existing engines, then resume (main reloads config from disk)
    await window.bot.pauseAll();
    await new Promise(r => setTimeout(r, 1500));
    await window.bot.resumeAll();

    msg.textContent = "Done. Engines restarted with new settings.";
    msg.style.color = "var(--green-hi)";

    setTimeout(closeSettings, 1800);
  } catch(e) {
    msg.textContent = `Error: ${e.message}`;
    msg.style.color = "var(--red)";
  }

  btn.disabled = false;
}
window.saveSettings = saveSettings;

function setValue(id, val) {
  const el = document.getElementById(id);
  if (el && val != null) el.value = val;
}

function setCheck(id, val) {
  const el = document.getElementById(id);
  if (el) el.checked = Boolean(val);
}

function numVal(id) {
  return Number(document.getElementById(id)?.value ?? 0);
}

/* ── Bot API events ───────────────────────────────────────────────────────── */
if (window.bot) {
  window.bot.on("license-invalid", (reason) => {
    document.getElementById("license-reason").textContent = reason || "License verification failed.";
    document.getElementById("overlay-license").removeAttribute("hidden");
  });

  window.bot.on("license-ok", (email) => {
    $licUser.textContent = email ?? "";
    document.getElementById("overlay-license").setAttribute("hidden", "");
  });

  window.bot.on("config-loaded", async (cfg) => {
    const t  = cfg.trading    ?? {};
    const s  = cfg.strategies ?? {};
    const tf = cfg.trendFilter ?? {};

    $contracts.textContent = t.contracts ? `${t.contracts}ct` : "—";
    $sltp.textContent      = (t.stopLossTicks && t.takeProfitTicks)
      ? `${t.stopLossTicks}t / ${t.takeProfitTicks}t`
      : "—";
    $dailyLim.textContent  = t.dailyLossLimit  ? `$${t.dailyLossLimit}`  : "—";
    $profitCap.textContent = t.dailyProfitCap  ? `$${t.dailyProfitCap}` : "—";

    const stratCount = Object.values(s).filter(Boolean).length;
    $stratCt.textContent = `${stratCount} active`;

    if (cfg.accounts) {
      cfg.accounts.forEach(name => {
        getOrCreateCard(name);
        setAccountStatus(name, "active");
      });
    }

    // Fetch and store the full config for the settings panel
    try {
      const full = await window.bot.getConfig();
      if (full) state.fullConfig = full;
    } catch {}

    $connDot.className = "dot dot-on";
    appendLog("SYSTEM", "Configuration loaded.", {});
  });

  window.bot.on("engine-log", ({ account, line, isErr }) => {
    appendLog(account, line, { isErr });

    if (/LONG|SHORT|ENTRY|placing order/i.test(line))  setAccountStatus(account, "trading");
    else if (/filled|closed|exit/i.test(line))          setAccountStatus(account, "active");
    else if (/halted|limit reached/i.test(line))        setAccountStatus(account, "halted");
  });

  window.bot.on("pnl-update",    ({ account, pnl })     => updateAccountPnl(account, pnl));
  window.bot.on("balance-update",({ account, balance })  => updateAccountBalance(account, balance));

  window.bot.on("account-halted", ({ account }) => {
    setAccountStatus(account, "halted");
    appendLog(account, "⛔ Account halted — daily limit or profit cap reached.", {});
  });

  window.bot.on("trend-update", ({ account, trend }) => {
    $trendSt.textContent = trend;
    $trendSt.style.color = trend === "UPTREND"   ? "var(--green-hi)"
                         : trend === "DOWNTREND" ? "var(--red)"
                         : "var(--amber)";
    appendLog(account, `[Trend] ${trend}`, {});
  });

  window.bot.on("engine-exit", ({ account, code, signal }) => {
    if (!state.paused) setAccountStatus(account, "active");
    appendLog(account, `Engine exited — code=${code} signal=${signal}`);
  });

  window.bot.on("update-available", ({ version, url }) => {
    appendLog("SYSTEM", `Update available: v${version} — ${url}`, {});
  });

  window.bot.on("engine-paused", () => {
    setPausedUI(true);
    appendLog("SYSTEM", "⏸ All engines paused.", {});
    $connDot.className = "dot dot-warn";
    for (const name of Object.keys(state.accounts)) setAccountStatus(name, "active");
  });

  window.bot.on("engine-resumed", () => {
    setPausedUI(false);
    appendLog("SYSTEM", "▶ Engines resuming...", {});
    $connDot.className = "dot dot-on";
  });
}

/* ── Startup glitch animation ─────────────────────────────────────────────── */
(async function startup() {
  await new Promise(r => setTimeout(r, 300));

  const titleEl = document.querySelector(".title-name");
  if (titleEl) await glitchReveal(titleEl, "ES FUTURES BOT", { speed: 3, frameMs: 35 });

  const verEl = document.getElementById("app-version");
  if (verEl) {
    await new Promise(r => setTimeout(r, 200));
    await glitchReveal(verEl, verEl.textContent, { speed: 2, frameMs: 50 });
  }
})();
