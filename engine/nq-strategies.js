// NQ Strategy Signal Evaluator — Portfolio V5.5 (regime overfit 2026-09-20)
// Optimized on Jun–Sep 2026 (last 3 months) for Oct–Dec 2026 deployment.
// Optimizer: greedy per-signal sweep, thresholds × {6,8,10,12}t SL × {16..80}t TP.
// Next re-opt: end of December 2026 (re-run on Sep–Dec window).
//   - OB_FADE_S: surge ≥10t (was 15t), SL 12t (was 8t), TP 80t (was 64t)
//   - AM_VWAP_FADE_S: dev ≥15t (was 25t), SL 6t, TP 72t (was 64t)
//   - ADR_FADE_S: move ≥35% ADR (was 60%), SL 6t, TP 80t (was 40t)
//   - 14H_REV_S: ≥25t above AM open (was 40t), SL 6t, TP 80t (was 64t)
//   - FIRST30_FADE_S: SL 6t (was 8t), TP 40t unchanged
//   - PM_VWAP_FADE_S: dev ≥15t (was 25t), SL 6t, TP 48t (was 64t)
//   - OVERNIGHT_TRAP_S: gap ≥20t (was 50t), SL 6t, TP 80t (was 64t)
//   - SESSION_HIGH_FAIL_S: DISABLED (negative in Jun–Sep 2026)
// Long fades (OB/VWAP/ADR/FIRST30/PM_L) tombstoned in topstepx-engine.js 2026-09-14.
//
// Signal ID                Gate     Stop  TP   Session
// NQ_OB_FADE_S             S       12t   80t  AM 13:30 bar        opening bar surge ≥10t
// NQ_AM_VWAP_FADE_S        S        6t   72t  AM 13:30–15:00 UTC  VWAP dev ≥15t
// NQ_ADR_FADE_S            S        6t   80t  AM                  move ≥35% ADR from open
// NQ_14H_REV_S             SINGLE   6t   80t  AM 14:00+ UTC       move ≥25t above AM open
// NQ_FIRST30_FADE_S        S        6t   40t  AM 14:00+           close breaks prior AM high
// NQ_PM_VWAP_FADE_S        S        6t   48t  PM 18:00–20:00 UTC  VWAP dev ≥15t
// NQ_OVERNIGHT_TRAP_S      S        6t   80t  AM 13:30–14:00 UTC  gap up ≥20t, fade < open
// NQ_SESSION_HIGH_FAIL_S   DISABLED (negative Jun–Sep 2026)

const TICK        = 0.25;
const AM_OPEN_HM  = 1330;
const AM_CLOSE_HM = 1500;
const PM_OPEN_HM  = 1800;
const PM_CLOSE_HM = 2000;

// ── Per-day gate sets (cleared by resetConfRevState at daily reset) ───────────
const _amVwapFiredL    = new Set();
const _amVwapFiredS    = new Set();
const _adrFiredL       = new Set();
const _adrFiredS       = new Set();
const _14hRevDate      = new Set(); // SINGLE gate — 1 trade/day regardless of direction
const _first30FiredL   = new Set();
const _first30FiredS   = new Set();
const _pmVwapFiredL    = new Set();
const _pmVwapFiredS    = new Set();
const _obFiredL        = new Set();
const _obFiredS        = new Set();
const _onTrapFiredS    = new Set();
const _sesHFFailFiredS = new Set();

// ── Persistent cross-session state ────────────────────────────────────────────
// Survives bar-window resets; cleared only on process restart.
const _adrDayCache  = new Map(); // date → { hi, lo } of that day's AM session
const _amHighPerDay = new Map(); // date → max bar-high seen in AM session (for SESSION_HIGH_FAIL_S)

export function resetConfRevState() {
  _amVwapFiredL.clear();
  _amVwapFiredS.clear();
  _adrFiredL.clear();
  _adrFiredS.clear();
  _14hRevDate.clear();
  _first30FiredL.clear();
  _first30FiredS.clear();
  _pmVwapFiredL.clear();
  _pmVwapFiredS.clear();
  _obFiredL.clear();
  _obFiredS.clear();
  _onTrapFiredS.clear();
  _sesHFFailFiredS.clear();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function barHM(ts) {
  const d = new Date(ts * 1000);
  return d.getUTCHours() * 100 + d.getUTCMinutes();
}
function barDate(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

// Session VWAP (typical price weighted) over all bars in today's session window.
function sessionVWAP(bars, today, openHM, closeHM) {
  let pv = 0, v = 0;
  for (const b of bars) {
    if (barDate(b.time) !== today) continue;
    const hm = barHM(b.time);
    if (hm < openHM || hm >= closeHM) continue;
    const tp = (b.high + b.low + b.close) / 3;
    pv += tp * b.volume;
    v  += b.volume;
  }
  return v > 0 ? pv / v : null;
}

// Update the persistent ADR cache from the current bars array.
function _updateADRCache(bars, today) {
  for (const b of bars) {
    const dt = barDate(b.time);
    if (dt >= today) continue;
    const hm = barHM(b.time);
    if (hm < AM_OPEN_HM || hm >= AM_CLOSE_HM) continue;
    if (!_adrDayCache.has(dt)) _adrDayCache.set(dt, { hi: b.high, lo: b.low });
    else { const r = _adrDayCache.get(dt); r.hi = Math.max(r.hi, b.high); r.lo = Math.min(r.lo, b.low); }
  }
}

// 20-day ADR from the persistent cache.
function calcADR20(today) {
  const ranges = [..._adrDayCache.entries()]
    .filter(([dt]) => dt < today)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([, r]) => r.hi - r.lo);
  if (!ranges.length) return null;
  const recent = ranges.slice(-20);
  return recent.reduce((a, x) => a + x, 0) / recent.length;
}

// AM session open price — open of the first bar at or after 13:30 UTC today.
function amSessionOpen(bars, today) {
  for (const b of bars) {
    if (barDate(b.time) === today && barHM(b.time) >= AM_OPEN_HM) return b.open;
  }
  return null;
}

// Last close from any day before today (used by OVERNIGHT_TRAP_S for gap calculation).
function prevDayClose(bars, today) {
  for (let i = bars.length - 1; i >= 0; i--) {
    if (barDate(bars[i].time) < today) return bars[i].close;
  }
  return null;
}

// ── Main evaluator ────────────────────────────────────────────────────────────

export const evaluateNQ = (bars, _esBars = []) => {
  if (bars.length < 20) return [];
  const last  = bars[bars.length - 1];
  const prev  = bars[bars.length - 2]; // previous bar (same or different day)
  const hm    = barHM(last.time);
  const today = barDate(last.time);
  const c     = last.close;

  const inAM = hm >= AM_OPEN_HM && hm < AM_CLOSE_HM;
  const inPM = hm >= PM_OPEN_HM && hm < PM_CLOSE_HM;
  if (!inAM && !inPM) return [];

  _updateADRCache(bars, today);

  // Track AM high for SESSION_HIGH_FAIL_S (persists AM→PM within same day).
  if (inAM) {
    const cur = _amHighPerDay.get(today) ?? -Infinity;
    if (last.high > cur) _amHighPerDay.set(today, last.high);
  }

  const signals = [];

  // ─── NQ_OB_FADE_L / NQ_OB_FADE_S — Opening Bar Fade ─────────────────────────
  // The 13:30 opening 5m bar sometimes makes an extreme move. Fade it.
  // v52-full: short surge ≥15t, TP 48t. Engine starts at 13:45 so check retroactively.
  if (inAM) {
    const needL = !_obFiredL.has(today);
    const needS = !_obFiredS.has(today);
    if (needL || needS) {
      const ob = bars.find(b => barDate(b.time) === today && barHM(b.time) === AM_OPEN_HM);
      if (ob) {
        const move = ob.close - ob.open;
        if (needL && move <= -(20 * TICK)) {
          _obFiredL.add(today);
          signals.push({ id: 'NQ_OB_FADE_L', side: 'long',  price: c, stopTicks: 12, tpTicks: 80, stopType: 'fixed', ignoreTrendFilter: true });
        }
        if (needS && move >= (10 * TICK)) {
          _obFiredS.add(today);
          signals.push({ id: 'NQ_OB_FADE_S', side: 'short', price: c, stopTicks: 12, tpTicks: 80, stopType: 'fixed', ignoreTrendFilter: true });
        }
      }
    }
  }

  // ─── NQ_AM_VWAP_FADE_L / NQ_AM_VWAP_FADE_S — AM Session VWAP Fade ───────────
  // v52-full: short dev ≥25t, TP 48t. 1L+1S per day.
  if (inAM) {
    const vwap = sessionVWAP(bars, today, AM_OPEN_HM, AM_CLOSE_HM);
    if (vwap !== null) {
      const devT = (c - vwap) / TICK;
      if (!_amVwapFiredL.has(today) && devT <= -40) {
        _amVwapFiredL.add(today);
        signals.push({ id: 'NQ_AM_VWAP_FADE_L', side: 'long',  price: c, stopTicks: 6, tpTicks: 72, stopType: 'fixed', ignoreTrendFilter: true });
      }
      if (!_amVwapFiredS.has(today) && devT >= 15) {
        _amVwapFiredS.add(today);
        signals.push({ id: 'NQ_AM_VWAP_FADE_S', side: 'short', price: c, stopTicks: 6, tpTicks: 72, stopType: 'fixed', ignoreTrendFilter: true });
      }
    }
  }

  // ─── NQ_ADR_FADE_L / NQ_ADR_FADE_S — ADR Exhaustion Fade ────────────────────
  // v52-full: ≥60% of 20-day ADR from AM open, TP 32t. 1L+1S per day.
  if (inAM) {
    const adr    = calcADR20(today);
    const amOpen = amSessionOpen(bars, today);
    if (adr !== null && amOpen !== null) {
      const move   = c - amOpen;
      const thresh = adr * 0.35;
      if (!_adrFiredL.has(today) && move <= -thresh) {
        _adrFiredL.add(today);
        signals.push({ id: 'NQ_ADR_FADE_L', side: 'long',  price: c, stopTicks: 6, tpTicks: 80, stopType: 'fixed', ignoreTrendFilter: true });
      }
      if (!_adrFiredS.has(today) && move >= thresh) {
        _adrFiredS.add(today);
        signals.push({ id: 'NQ_ADR_FADE_S', side: 'short', price: c, stopTicks: 6, tpTicks: 80, stopType: 'fixed', ignoreTrendFilter: true });
      }
    }
  }

  // ─── NQ_14H_REV_S — 14:00 UTC Reversal Short ─────────────────────────────────
  // v52-full: short only, ≥40t above AM open after 14:00, TP 32t.
  // SINGLE gate: 1 trade/day total.
  if (inAM && hm >= 1400 && !_14hRevDate.has(today)) {
    const amOpen = amSessionOpen(bars, today);
    if (amOpen !== null) {
      const moveT = (c - amOpen) / TICK;
      if (moveT >= 25) {
        _14hRevDate.add(today);
        signals.push({ id: 'NQ_14H_REV_S', side: 'short', price: c, stopTicks: 6, tpTicks: 80, stopType: 'fixed', ignoreTrendFilter: true });
      } else if (moveT <= -25) {
        // Long side tombstoned — consume the gate so it doesn't fire twice
        _14hRevDate.add(today);
      }
    }
  }

  // ─── NQ_FIRST30_FADE_L / NQ_FIRST30_FADE_S — First-30-Min Range Fade ─────────
  // After 14:00 UTC: close breaks above all prior AM highs → short reversal.
  // v52-full: TP 32t. 1L+1S per day.
  if (inAM && hm >= 1400) {
    const priorAM = bars.filter(b => barDate(b.time) === today && barHM(b.time) >= AM_OPEN_HM && b.time < last.time);
    if (priorAM.length >= 6) {
      const amLow  = Math.min(...priorAM.map(b => b.low));
      const amHigh = Math.max(...priorAM.map(b => b.high));
      if (!_first30FiredL.has(today) && c < amLow) {
        _first30FiredL.add(today);
        signals.push({ id: 'NQ_FIRST30_FADE_L', side: 'long',  price: c, stopTicks: 6, tpTicks: 40, stopType: 'fixed', ignoreTrendFilter: true });
      }
      if (!_first30FiredS.has(today) && c > amHigh) {
        _first30FiredS.add(today);
        signals.push({ id: 'NQ_FIRST30_FADE_S', side: 'short', price: c, stopTicks: 6, tpTicks: 40, stopType: 'fixed', ignoreTrendFilter: true });
      }
    }
  }

  // ─── NQ_OVERNIGHT_TRAP_S — Overnight Gap Trap Short ─────────────────────────
  // AM session gapped up ≥50t vs prior day's close and price has faded back below
  // the AM open → the gap was a bull trap, short the fade. First 30min of AM only.
  // v52-full: TP 48t, fires at most once per day.
  if (inAM && hm <= 1400 && !_onTrapFiredS.has(today)) {
    const amOpen = amSessionOpen(bars, today);
    const pClose = prevDayClose(bars, today);
    if (amOpen !== null && pClose !== null) {
      const gapT = (amOpen - pClose) / TICK;
      if (gapT >= 20 && c < amOpen) {
        _onTrapFiredS.add(today);
        signals.push({ id: 'NQ_OVERNIGHT_TRAP_S', side: 'short', price: c, stopTicks: 6, tpTicks: 80, stopType: 'fixed', ignoreTrendFilter: true });
      }
    }
  }

  // ─── NQ_PM_VWAP_FADE_L / NQ_PM_VWAP_FADE_S — PM Session VWAP Fade ───────────
  // v52-full: short dev ≥25t, TP 48t. 1L+1S per day.
  if (inPM) {
    const vwap = sessionVWAP(bars, today, PM_OPEN_HM, PM_CLOSE_HM);
    if (vwap !== null) {
      const devT = (c - vwap) / TICK;
      if (!_pmVwapFiredL.has(today) && devT <= -40) {
        _pmVwapFiredL.add(today);
        signals.push({ id: 'NQ_PM_VWAP_FADE_L', side: 'long',  price: c, stopTicks: 6, tpTicks: 48, stopType: 'fixed', ignoreTrendFilter: true });
      }
      if (!_pmVwapFiredS.has(today) && devT >= 15) {
        _pmVwapFiredS.add(today);
        signals.push({ id: 'NQ_PM_VWAP_FADE_S', side: 'short', price: c, stopTicks: 6, tpTicks: 48, stopType: 'fixed', ignoreTrendFilter: true });
      }
    }
  }

  // NQ_SESSION_HIGH_FAIL_S — DISABLED V5.5 (negative Jun–Sep 2026, re-evaluate Dec 2026)

  // NQ_BEAR_MOMENTUM_S — disabled 2026-09-18 (SL structurally too wide, r=0.175)

  return signals;
};
