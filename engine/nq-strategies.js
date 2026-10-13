// NQ Strategy Signal Evaluator — Portfolio V5.7 (combined WF2 — 2026-09-21)
// Combined walk-forward (10 signals, Jan–Sep 2026, 37 weeks) — $115,012 vs $65,406 baseline (+76%).
// Changes from V5.6:
//   4. TIGHT_VWAP_AM added  — AM/PM VWAP fade at 12–24t deviation band, TP 56t
//   5. HILOW_REJ_AM added   — session H/L rejection (new extreme + close back inside), TP 84t
//   6. MOM_EXHAUST_AM added — 4-bar consecutive momentum fade, TP 76t
//   7. PULLBACK_AM added    — 15t initial move + 8-16t pullback re-entry, TP 20t
// Prior changes (V5.6):
//   1. OB_FADE DISABLED — 9% WR after 22 live-forward trades
//   2. AM_VWAP_FADE_L threshold ≤-40t → ≤-25t
//   3. FIRST30_FADE TP 40t → 76t
// Next re-opt: end of December 2026.
//
// Signal ID                Gate     Stop  TP    Session
// NQ_OB_FADE_S/L           DISABLED (WF2: 9% WR, killed at week 7)
// NQ_AM_VWAP_FADE_L        S        6t   72t   AM 13:30–15:00 UTC  VWAP dev ≤-25t
// NQ_AM_VWAP_FADE_S        S        6t   72t   AM 13:30–15:00 UTC  VWAP dev ≥15t
// NQ_ADR_FADE_S            S        6t   80t   AM                  move ≥35% ADR from open
// NQ_14H_REV_S             SINGLE   6t   80t   AM 14:00+ UTC       move ≥25t above AM open
// NQ_FIRST30_FADE_L/S      S        6t   76t   AM 14:00+           close breaks prior AM range
// NQ_PM_VWAP_FADE_S        S        6t   48t   PM 18:00–20:00 UTC  VWAP dev ≥15t
// NQ_OVERNIGHT_TRAP_S      S        6t   80t   AM 13:30–14:00 UTC  gap up ≥20t, fade < open
// NQ_TIGHT_VWAP_AM_L/S     S        6t   56t   AM+PM              VWAP dev 12–24t band
// NQ_HILOW_REJ_AM_L/S      S        6t   84t   AM                 new session H/L rejected (close back inside)
// NQ_MOM_EXHAUST_AM_L/S    S        6t   76t   AM                 4 consecutive bars same direction → fade
// NQ_PULLBACK_AM_L/S       S        6t   20t   AM                 15t move + 8–16t pullback re-entry
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
const _tightVwapFiredL = new Set();
const _tightVwapFiredS = new Set();
const _hilowRejFiredL  = new Set();
const _hilowRejFiredS  = new Set();
const _momExhFiredL    = new Set();
const _momExhFiredS    = new Set();
const _pullbackFiredL  = new Set();
const _pullbackFiredS  = new Set();

// ── Persistent cross-session state ────────────────────────────────────────────
// Survives bar-window resets; cleared only on process restart.
const _adrDayCache    = new Map(); // date → { hi, lo } of that day's AM session
const _amHighPerDay   = new Map(); // date → max bar-high seen in AM session (for SESSION_HIGH_FAIL_S)
const _amSessionHi    = new Map(); // date → running session high (for HILOW_REJ_AM)
const _amSessionLo    = new Map(); // date → running session low  (for HILOW_REJ_AM)
const _pbStage        = new Map(); // date → { stage:'wait'|'up'|'dn', peak, prevClose } (PULLBACK_AM)

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
  _tightVwapFiredL.clear();
  _tightVwapFiredS.clear();
  _hilowRejFiredL.clear();
  _hilowRejFiredS.clear();
  _momExhFiredL.clear();
  _momExhFiredS.clear();
  _pullbackFiredL.clear();
  _pullbackFiredS.clear();
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

  // ─── NQ_OB_FADE_L / NQ_OB_FADE_S — DISABLED V5.6 ────────────────────────────
  // WF2 walk-forward (Jan–Sep 2026): 9% WR after 22 trades, disabled at week 7.
  // Re-evaluate after 3 months of live data with new params.

  // ─── NQ_AM_VWAP_FADE_L / NQ_AM_VWAP_FADE_S — AM Session VWAP Fade ───────────
  // v52-full: short dev ≥25t, TP 48t. 1L+1S per day.
  if (inAM) {
    const vwap = sessionVWAP(bars, today, AM_OPEN_HM, AM_CLOSE_HM);
    if (vwap !== null) {
      const devT = (c - vwap) / TICK;
      if (!_amVwapFiredL.has(today) && devT <= -25) {
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
        signals.push({ id: 'NQ_FIRST30_FADE_L', side: 'long',  price: c, stopTicks: 6, tpTicks: 76, stopType: 'fixed', ignoreTrendFilter: true });
      }
      if (!_first30FiredS.has(today) && c > amHigh) {
        _first30FiredS.add(today);
        signals.push({ id: 'NQ_FIRST30_FADE_S', side: 'short', price: c, stopTicks: 6, tpTicks: 76, stopType: 'fixed', ignoreTrendFilter: true });
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

  // ─── NQ_TIGHT_VWAP_AM_L / NQ_TIGHT_VWAP_AM_S — Tight VWAP Band Fade ─────────
  // Fires at 12–24t VWAP deviation (below the existing AM_VWAP threshold of 25t).
  // AM and PM sessions. 1L + 1S per session. TP 56t, stop 6t.
  if (inAM || inPM) {
    const tvOpenHM  = inAM ? AM_OPEN_HM : PM_OPEN_HM;
    const tvCloseHM = inAM ? AM_CLOSE_HM : PM_CLOSE_HM;
    const tvVwap = sessionVWAP(bars, today, tvOpenHM, tvCloseHM);
    if (tvVwap !== null) {
      const devT = (c - tvVwap) / TICK;
      // Band: 12–24t (at 25t+ the existing AM/PM_VWAP_FADE takes over)
      if (!_tightVwapFiredS.has(today) && devT >= 12 && devT < 24) {
        _tightVwapFiredS.add(today);
        signals.push({ id: 'NQ_TIGHT_VWAP_AM_S', side: 'short', price: c, stopTicks: 6, tpTicks: 56, stopType: 'fixed', ignoreTrendFilter: true });
      }
      if (!_tightVwapFiredL.has(today) && devT <= -12 && devT > -24) {
        _tightVwapFiredL.add(today);
        signals.push({ id: 'NQ_TIGHT_VWAP_AM_L', side: 'long',  price: c, stopTicks: 6, tpTicks: 56, stopType: 'fixed', ignoreTrendFilter: true });
      }
    }
  }

  // ─── NQ_HILOW_REJ_AM_L / NQ_HILOW_REJ_AM_S — Session H/L Rejection ──────────
  // New session high/low but close prints back inside prior bar's range → rejection.
  // 1L + 1S per day. TP 84t, stop 6t.
  if (inAM) {
    const prevHi = (!isNaN(prev.high))  ? prev.high : c;
    const prevLo = (!isNaN(prev.low))   ? prev.low  : c;
    // Snapshot PREVIOUS session extreme before updating with this bar
    const prevSessionHi = _amSessionHi.get(today);
    const prevSessionLo = _amSessionLo.get(today);
    // Update running session hi/lo with current bar
    if (prevSessionHi === undefined || last.high >= prevSessionHi) _amSessionHi.set(today, last.high);
    if (prevSessionLo === undefined || last.low  <= prevSessionLo) _amSessionLo.set(today, last.low);
    // New session high = this bar's high exceeds previous session high, AND close rejected back below prior bar's high
    if (!_hilowRejFiredS.has(today) && prevSessionHi !== undefined && last.high > prevSessionHi && c < prevHi) {
      _hilowRejFiredS.add(today);
      signals.push({ id: 'NQ_HILOW_REJ_AM_S', side: 'short', price: c, stopTicks: 6, tpTicks: 84, stopType: 'fixed', ignoreTrendFilter: true });
    }
    // New session low = this bar's low exceeds previous session low, AND close rejected back above prior bar's low
    if (!_hilowRejFiredL.has(today) && prevSessionLo !== undefined && last.low < prevSessionLo && c > prevLo) {
      _hilowRejFiredL.add(today);
      signals.push({ id: 'NQ_HILOW_REJ_AM_L', side: 'long',  price: c, stopTicks: 6, tpTicks: 84, stopType: 'fixed', ignoreTrendFilter: true });
    }
  }

  // ─── NQ_MOM_EXHAUST_AM_L / NQ_MOM_EXHAUST_AM_S — 4-Bar Momentum Exhaustion ───
  // 4 consecutive bars in same direction → fade next bar. 1L + 1S per day. TP 76t, stop 6t.
  if (inAM && bars.length >= 5) {
    const b1 = bars[bars.length - 5];
    const b2 = bars[bars.length - 4];
    const b3 = bars[bars.length - 3];
    const b4 = bars[bars.length - 2]; // prev bar (confirmed close)
    if (barDate(b1.time) === today && barDate(b2.time) === today &&
        barDate(b3.time) === today && barDate(b4.time) === today) {
      const up4 = b2.close > b1.close && b3.close > b2.close && b4.close > b3.close;
      const dn4 = b2.close < b1.close && b3.close < b2.close && b4.close < b3.close;
      if (up4 && !_momExhFiredS.has(today)) {
        _momExhFiredS.add(today);
        signals.push({ id: 'NQ_MOM_EXHAUST_AM_S', side: 'short', price: c, stopTicks: 6, tpTicks: 76, stopType: 'fixed', ignoreTrendFilter: true });
      }
      if (dn4 && !_momExhFiredL.has(today)) {
        _momExhFiredL.add(today);
        signals.push({ id: 'NQ_MOM_EXHAUST_AM_L', side: 'long',  price: c, stopTicks: 6, tpTicks: 76, stopType: 'fixed', ignoreTrendFilter: true });
      }
    }
  }

  // ─── NQ_PULLBACK_AM_L / NQ_PULLBACK_AM_S — Initial Move + Pullback Re-entry ───
  // 15t+ initial move from AM open, then 8–16t pullback, re-enter in trend direction.
  // 1L + 1S per day. TP 20t, stop 6t.
  if (inAM) {
    const amOpen = amSessionOpen(bars, today);
    if (amOpen !== null) {
      const st = _pbStage.get(today) ?? { stage: 'wait' };
      const moveT = (c - amOpen) / TICK;
      if (st.stage === 'wait') {
        if (moveT >= 15)       { st.stage = 'up'; st.peak = c; _pbStage.set(today, st); }
        else if (moveT <= -15) { st.stage = 'dn'; st.peak = c; _pbStage.set(today, st); }
      } else if (st.stage === 'up') {
        if (c > st.peak) { st.peak = c; _pbStage.set(today, st); }
        const pullT = (st.peak - c) / TICK;
        if (pullT >= 8 && pullT <= 16 && !_pullbackFiredL.has(today)) {
          _pullbackFiredL.add(today);
          signals.push({ id: 'NQ_PULLBACK_AM_L', side: 'long',  price: c, stopTicks: 6, tpTicks: 20, stopType: 'fixed', ignoreTrendFilter: true });
        }
      } else if (st.stage === 'dn') {
        if (c < st.peak) { st.peak = c; _pbStage.set(today, st); }
        const pullT = (c - st.peak) / TICK;
        if (pullT >= 8 && pullT <= 16 && !_pullbackFiredS.has(today)) {
          _pullbackFiredS.add(today);
          signals.push({ id: 'NQ_PULLBACK_AM_S', side: 'short', price: c, stopTicks: 6, tpTicks: 20, stopType: 'fixed', ignoreTrendFilter: true });
        }
      }
    }
  }

  return signals;
};
