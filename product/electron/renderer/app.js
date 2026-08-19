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

let _settingsAccounts = [];  // working copy of broker.accounts while settings panel is open

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
  if (/Calendar fetch failed/i.test(msg))       return "is-warn";
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

  const isAlpaca = state.fullConfig?.broker?.type === "alpaca";
  const meterWrap = document.getElementById("pass-meter-wrap");
  const paperBadge = document.getElementById("paper-mode-badge");
  if (meterWrap)  meterWrap.hidden  = isAlpaca;
  if (paperBadge) paperBadge.hidden = !isAlpaca;

  // Update REC labels for Alpaca (MES scale) vs TopstepX (ES scale)
  document.querySelectorAll("[data-rec-topstep]").forEach(el => {
    el.textContent = isAlpaca ? el.dataset.recAlpaca : el.dataset.recTopstep;
  });

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
    setStopMode(t.stopMode ?? null);

    setCheck("cfg-trend-enabled", f.enabled ?? true);
    setValue("cfg-trend-up",  f.uptrendThreshold);
    setValue("cfg-trend-dn",  f.downtrendThreshold);

    const rfEl = document.getElementById("cfg-regime-filter");
    if (rfEl) rfEl.value = t.regimeFilter ?? "auto";
    // Build strategy toggles
    const container = document.getElementById("settings-strategies");
    container.innerHTML = "";
    for (const [name, enabled] of Object.entries(s)) {
      const label = document.createElement("label");
      label.className = "strat-row";
      label.innerHTML = `<input type="checkbox" data-strat="${name}"${enabled ? " checked" : ""}> ${name}`;
      label.querySelector("input").addEventListener("change", updatePassMeter);
      container.appendChild(label);
    }
  }

  // Accounts section (TopstepX only)
  const acctSection = document.getElementById("settings-accounts-section");
  if (acctSection) acctSection.style.display = isAlpaca ? "none" : "";
  if (!isAlpaca && cfg) renderAccountsList(cfg.broker?.accounts ?? []);

  // NTFY channel
  const ntfyEl = document.getElementById("cfg-ntfy");
  if (ntfyEl) ntfyEl.value = cfg?.notifications?.ntfyChannel ?? "";

  document.getElementById("settings-msg").textContent = "";
  overlay.removeAttribute("hidden");
  updatePassMeter();
}
window.openSettings = openSettings;

function resetToRecommended() {
  const isAlpaca = state.fullConfig?.broker?.type === "alpaca";
  setValue("cfg-daily-loss", isAlpaca ? 140  : 1400);
  setValue("cfg-profit-cap", isAlpaca ? 200  : 2000);
  setValue("cfg-contracts",  isAlpaca ? 1    : 1);
  setValue("cfg-trail",      8);
  setValue("cfg-stop",       10);
  setValue("cfg-max-stop",   20);
  setValue("cfg-tp",         48);
  setStopMode(null);
  setValue("cfg-trend-up",   10);
  setValue("cfg-trend-dn",   6);
  document.getElementById("cfg-trend-enabled").checked = true;
  const rfEl = document.getElementById("cfg-regime-filter");
  if (rfEl) rfEl.value = "auto";
  updatePassMeter();
}

function closeSettings() {
  document.getElementById("overlay-settings").setAttribute("hidden", "");
}
window.closeSettings = closeSettings;

function renderAccountsList(accounts) {
  _settingsAccounts = accounts.map(a => ({ ...a }));
  const list = document.getElementById("settings-accounts-list");
  if (!list) return;
  list.innerHTML = "";
  _settingsAccounts.forEach((acct, i) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:4px";
    row.innerHTML = `<span style="flex:1;font-size:11px;color:var(--green-hi);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${acct.name}">${acct.name}</span><span style="font-size:10px;color:var(--green-lo)">${acct.type}</span><button style="background:none;border:1px solid var(--green-lo);color:var(--green-lo);padding:1px 6px;cursor:pointer;font-size:11px" onclick="removeSettingsAccount(${i})">×</button>`;
    list.appendChild(row);
  });
  // Reset add-row state
  const addRow = document.getElementById("acct-add-row");
  const addBtn = document.getElementById("btn-add-acct");
  if (addRow) addRow.style.display = "none";
  if (addBtn) addBtn.style.display = "";
}

function removeSettingsAccount(i) {
  _settingsAccounts.splice(i, 1);
  renderAccountsList(_settingsAccounts);
}
window.removeSettingsAccount = removeSettingsAccount;

function showAddAccountRow() {
  document.getElementById("acct-add-row").style.display = "flex";
  document.getElementById("btn-add-acct").style.display = "none";
  document.getElementById("acct-add-last4").focus();
}
window.showAddAccountRow = showAddAccountRow;

async function fetchAndAddAccount() {
  const last4Input = document.getElementById("acct-add-last4");
  const msg        = document.getElementById("acct-add-msg");
  const last4 = (last4Input?.value ?? "").trim();
  if (last4.length < 4) { msg.textContent = "Enter 4 digits"; return; }

  msg.textContent = "Searching…";
  try {
    const result = await window.bot.searchAccounts({
      username: state.fullConfig.broker.username,
      apiKey:   state.fullConfig.broker.apiKey,
    });
    if (!result.ok) { msg.textContent = result.error; return; }

    const match = result.accounts.find(a => a.last4 === last4 || a.nameLast4 === last4);
    if (!match) { msg.textContent = "No account with those digits"; return; }
    if (_settingsAccounts.some(a => a.id === match.id)) { msg.textContent = "Already added"; return; }

    _settingsAccounts.push({
      id:         match.id,
      name:       match.name,
      type:       match.isFunded ? "Funded" : "Combine",
      strategies: { ...(state.fullConfig?.strategies ?? {}) },
    });
    renderAccountsList(_settingsAccounts);
  } catch (e) {
    msg.textContent = e.message;
  }
}
window.fetchAndAddAccount = fetchAndAddAccount;

function setStopMode(mode) {
  document.getElementById("stop-fields-trail").style.display = mode === "trail" ? "" : "none";
  document.getElementById("stop-fields-fixed").style.display = mode === "fixed" ? "" : "none";
  document.querySelectorAll(".smp-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
  updatePassMeter();
}
window.setStopMode = setStopMode;

// ── Pass rate estimator ────────────────────────────────────────────────────────
// Baseline 88.8% from V4 3-year ES backtest with recommended settings.
// Each deviation from the recommended config is penalised based on observed
// backtest sensitivity. Score is clamped to [38, 95].
// REC updated 2026-07-23: stop 13t / TP 42t / trendUp 15pt (backtest sweep optimum)
const REC = { contracts: 2, stop: 13, maxStop: 20, tp: 42, trail: 8,
              trendUp: 15, trendDn: 6, lossLimit: 1400, profitCap: 2000 };

function updatePassMeter() {
  if (state.fullConfig?.broker?.type === "alpaca") return;
  let score = 88.8;

  const contracts  = numVal("cfg-contracts")  || REC.contracts;
  const stop       = numVal("cfg-stop")       || REC.stop;
  const maxStop    = numVal("cfg-max-stop")   || REC.maxStop;
  const tp         = numVal("cfg-tp")         || REC.tp;
  const trail      = numVal("cfg-trail")      || REC.trail;
  const stopMode   = document.querySelector(".smp-btn.active")?.dataset.mode ?? null;
  const trendOn    = document.getElementById("cfg-trend-enabled")?.checked ?? true;
  const trendUp    = numVal("cfg-trend-up")   || REC.trendUp;
  const trendDn    = numVal("cfg-trend-dn")   || REC.trendDn;
  const lossLimit  = numVal("cfg-daily-loss") || REC.lossLimit;
  const profitCap  = numVal("cfg-profit-cap") || REC.profitCap;

  // Fixed stop: slightly lower pass rate than trail (trail exits faster on losers)
  if (stopMode === "fixed") score -= 3.5;

  // Contracts: every extra contract above 2 raises drawdown risk
  if (contracts > 2) score -= (contracts - 2) * 5.5;
  if (contracts > 4) score -= (contracts - 4) * 4;   // steeper above 4

  // Stop loss: sweet spot 11–15t; too tight = whipsawed; too loose = bigger losers
  if (stop < 8)  score -= (8  - stop) * 3.5;
  if (stop > 15) score -= (stop - 15) * 2.0;

  // Max stop: should be ~1.5x stop
  if (maxStop < stop * 1.5) score -= 4;
  if (maxStop > 30)         score -= (maxStop - 30) * 0.8;

  // Take profit: sweet spot 38–48t
  if (tp < 30) score -= (30 - tp) * 2.2;
  if (tp > 55) score -= (tp - 55) * 1.0;

  // Trail: too tight = stopped out too early
  if (trail < 6)  score -= (6  - trail) * 2.5;
  if (trail > 12) score -= (trail - 12) * 1.0;

  // Trend filter: biggest single edge — disabling it loses ~8–10%
  if (!trendOn) score -= 9.5;
  else {
    if (trendUp > 18) score -= (trendUp - 18) * 1.0;
    if (trendUp < 7)  score -= (7 - trendUp)  * 1.5;
    if (trendDn > 9)  score -= (trendDn - 9)  * 1.5;
    if (trendDn < 4)  score -= (4 - trendDn)  * 1.0;
  }

  // Strategies: only penalise if more than half are disabled
  let activeStrats = 0;
  document.querySelectorAll("#settings-strategies input[data-strat]").forEach(el => {
    if (el.checked) activeStrats++;
  });
  const totalStrats = document.querySelectorAll("#settings-strategies input[data-strat]").length || 6;
  const disabledRatio = totalStrats > 0 ? (totalStrats - activeStrats) / totalStrats : 0;
  if (disabledRatio > 0.5) score -= (disabledRatio - 0.5) * 30;

  // Risk limits: too wide = prop firm disqualification risk
  if (lossLimit > 1450) score -= (lossLimit - 1450) / 100 * 3;
  if (profitCap < 1500) score -= 3;

  score = Math.max(38, Math.min(95, score));

  const pctEl  = document.getElementById("pass-pct");
  const barEl  = document.getElementById("pass-bar");
  if (!pctEl || !barEl) return;

  const tier = score >= 80 ? "good" : score >= 65 ? "warn" : "bad";
  pctEl.textContent = score.toFixed(1) + "%";
  pctEl.className = "pass-meter-pct" + (tier === "good" ? "" : ` ${tier}`);
  barEl.style.width = score + "%";
  barEl.className = "pass-meter-bar-fill" + (tier === "good" ? "" : ` ${tier}`);
}
window.updatePassMeter = updatePassMeter;

async function saveSettings() {
  if (!window.bot) return;

  const btn = document.getElementById("btn-save-cfg");
  const msg = document.getElementById("settings-msg");

  btn.disabled = true;
  msg.textContent = "Saving...";
  msg.style.color = "var(--green-lo)";

  // Read form values
  const activeMode = document.querySelector(".smp-btn.active")?.dataset.mode ?? "trail";
  const trading = {
    ...(state.fullConfig?.trading ?? {}),
    stopMode:        activeMode,
    dailyLossLimit:  numVal("cfg-daily-loss"),
    dailyProfitCap:  numVal("cfg-profit-cap"),
    contracts:       numVal("cfg-contracts"),
    stopLossTicks:   numVal("cfg-stop"),
    maxStopTicks:    numVal("cfg-max-stop"),
    takeProfitTicks: numVal("cfg-tp"),
    trailTicks:      numVal("cfg-trail"),
    regimeFilter:        document.getElementById("cfg-regime-filter")?.value ?? "auto",
    fundedStartBalance:  -1,  // auto-detected on first connect — no longer a manual field
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

  // Accounts (TopstepX only)
  const isAlpacaSave = state.fullConfig?.broker?.type === "alpaca";
  if (!isAlpacaSave && _settingsAccounts.length > 0) {
    newConfig.broker = { ...newConfig.broker, accounts: _settingsAccounts };
  }

  // NTFY channel
  const ntfyVal = (document.getElementById("cfg-ntfy")?.value ?? "").trim();
  newConfig.notifications = { ...(newConfig.notifications ?? {}), ntfyChannel: ntfyVal, enabled: !!ntfyVal };

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

  window.bot.on("license-ok", (email, sub) => {
    $licUser.textContent = email ?? "";
    document.getElementById("overlay-license").setAttribute("hidden", "");

    const $days = document.getElementById("license-days");
    if (!$days || !sub) return;

    if (sub.isFreeLoader) {
      $days.textContent  = "∞ — Free Loader Edition 🎭";
      $days.style.color  = "var(--green-hi)";
      $days.style.display = "block";
    } else if (sub.daysLeft != null) {
      const label = sub.isTrial
        ? `${sub.daysLeft}d left in free trial`
        : `${sub.daysLeft}d left in billing period`;
      $days.textContent   = label;
      $days.style.color   = sub.daysLeft <= 3 ? "#ff4444" : sub.daysLeft <= 7 ? "#ffaa00" : "var(--text-dim)";
      $days.style.display = "block";
    }
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
    else if (/halted|limit reached/i.test(line) && !/halted:\s*false/i.test(line)) setAccountStatus(account, "halted");
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

  // Auto-updater UI
  const $updateBar  = document.getElementById("update-bar");
  const $updateText = document.getElementById("update-bar-text");
  const $updateProg = document.getElementById("update-bar-progress");
  const $updateFill = document.getElementById("update-bar-fill");
  const $updateBtn  = document.getElementById("update-bar-btn");

  window.bot.on("update-downloading", ({ version }) => {
    $updateBar.hidden  = false;
    $updateText.textContent = `⬡ DOWNLOADING UPDATE v${version}…`;
    $updateProg.hidden = false;
  });

  window.bot.on("update-progress", ({ percent }) => {
    $updateFill.style.width = `${percent}%`;
  });

  window.bot.on("update-ready", ({ version }) => {
    $updateText.textContent = `⬡ UPDATE v${version} READY — reopen app after installing`;
    $updateProg.hidden = true;
    $updateBtn.style.display = "block";
    appendLog("SYSTEM", `Update v${version} downloaded — click to install, then reopen the app.`, {});
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

  window.bot.on("regime-update", (data) => {
    const badge = document.getElementById("regime-badge");
    if (!badge) return;
    if (!data.ok && data.error) {
      badge.textContent = "? REGIME";
      badge.style.opacity = "0.4";
      appendLog("SYSTEM", `⚠ Regime check failed: ${data.error}`, {});
      return;
    }
    const icons = { BULL: "🟢", BEAR: "🔴", NEUTRAL: "⚪" };
    const icon = icons[data.regime] ?? "⚪";
    badge.textContent = `${icon} ${data.regime}`;
    badge.style.opacity = data.regime === "NEUTRAL" ? "0.6" : "1";
    badge.title = `${data.regime} — ${data.bullPoints ?? 0} bull / ${data.bearPoints ?? 0} bear signals\nES $${data.price?.toFixed(1) ?? "—"} | 10-day ${data.tenDayPct >= 0 ? "+" : ""}${data.tenDayPct?.toFixed(1) ?? "—"}%\nClick to re-check`;
    if (data.changed) {
      appendLog("SYSTEM", `📊 Regime: ${data.prev} → ${data.regime} | ${(data.reasons ?? []).join("; ")}`, {});
    }
  });
}

/* ── Intro sequence ───────────────────────────────────────────────────────── */
const INTRO_SEEN_KEY = 'matrixBotIntroSeen';
let _pillTimers = [];
let _introResolve = null;

function _iSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function _iType(text, speed = 65) {
  const el = document.getElementById('intro-text');
  for (const ch of text) { el.textContent += ch; await _iSleep(speed); }
}

async function _iErase(speed = 40) {
  const el = document.getElementById('intro-text');
  while (el.textContent.length > 0) {
    el.textContent = el.textContent.slice(0, -1);
    await _iSleep(speed);
  }
}

function _startPillCanvas(cvId, fgColor, bgHex) {
  const cv = document.getElementById(cvId);
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const CHARS = 'ｦｧｨｩｺｻｼｽｾﾀﾁ01アイｳｴﾂﾃ10ｵｶｷ'.split('');
  const fs = 6, cols = Math.ceil(W / fs);
  const drops = Array.from({ length: cols }, () => Math.random() * -(H / fs) * 2);
  ctx.fillStyle = bgHex;
  ctx.fillRect(0, 0, W, H);
  const tid = setInterval(() => {
    ctx.globalAlpha = 0.13;
    ctx.fillStyle = bgHex;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
    ctx.fillStyle = fgColor;
    ctx.font = `${fs}px monospace`;
    for (let i = 0; i < drops.length; i++) {
      ctx.fillText(CHARS[Math.floor(Math.random() * CHARS.length)], i * fs, drops[i] * fs);
      if (++drops[i] * fs > H) drops[i] = Math.random() * -(H / fs);
    }
  }, 50);
  _pillTimers.push(tid);
}

async function pickPill(color) {
  const pills = document.getElementById('intro-pills');
  pills.style.pointerEvents = 'none';
  _pillTimers.forEach(clearInterval);
  _pillTimers = [];
  pills.style.transition = 'opacity 0.35s';
  pills.style.opacity = '0';
  document.getElementById('intro-sub').style.opacity = '0';
  await _iSleep(380);
  await _iErase(32);

  if (color === 'red') {
    await _iType('GOOD CHOICE.', 74);
    await _iSleep(480);
    await _iErase(36);
    await _iType('WELCOME TO THE REAL.', 60);
    await _iSleep(1400);
    localStorage.setItem(INTRO_SEEN_KEY, '1');
    const ov = document.getElementById('overlay-intro');
    ov.style.opacity = '0';
    await _iSleep(920);
    ov.style.display = 'none';
    _introResolve?.();
  } else {
    await _iType('THE MATRIX HAS YOU.', 66);
    await _iSleep(620);
    await _iErase(36);
    await _iType('GOODBYE.', 78);
    await _iSleep(1300);
    window.bot?.close();
    await _iSleep(8000);
  }
}
window.pickPill = pickPill;

async function runIntro() {
  const ov = document.getElementById('overlay-intro');
  ov.style.opacity = '1';
  ov.style.display = 'flex';
  await _iSleep(600);

  await _iType('HELLO.', 82);
  await _iSleep(780);
  await _iErase(46);
  await _iSleep(340);

  await _iType('WAKE UP.', 74);
  await _iSleep(720);
  await _iErase(44);
  await _iSleep(320);

  await _iType('ARE YOU IN THE RIGHT PLACE?', 56);
  await _iSleep(280);

  const sub = document.getElementById('intro-sub');
  sub.textContent = 'ONE PILL CHANGES EVERYTHING.';
  await _iSleep(30);
  sub.style.opacity = '1';
  await _iSleep(680);

  const pills = document.getElementById('intro-pills');
  await _iSleep(30);
  pills.style.opacity = '1';
  pills.style.pointerEvents = 'auto';

  _startPillCanvas('cv-blue', '#4488ff', '#00001a');
  _startPillCanvas('cv-red',  '#ff3322', '#1a0000');

  // Block until red pill is picked (blue pill closes the window)
  return new Promise(resolve => { _introResolve = resolve; });
}

/* ── Startup glitch ───────────────────────────────────────────────────────── */
async function _startupGlitch() {
  await _iSleep(300);
  const titleEl = document.querySelector(".title-name");
  if (titleEl) await glitchReveal(titleEl, "ES FUTURES BOT", { speed: 3, frameMs: 35 });
  const verEl = document.getElementById("app-version");
  if (verEl) {
    const raw = await window.bot.getVersion().catch(() => "?");
    const v   = `v${raw}`;
    verEl.textContent = v;
    await _iSleep(200);
    await glitchReveal(verEl, v, { speed: 2, frameMs: 50 });
  }
}

(async function main() {
  if (!localStorage.getItem(INTRO_SEEN_KEY)) {
    await runIntro();
    // runIntro resolves when overlay is hidden (red pill path) or never (blue pill)
    await _startupGlitch();
  } else {
    await _startupGlitch();
  }
})();
