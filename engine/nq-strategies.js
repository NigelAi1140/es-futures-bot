// NQ Strategy Signal Evaluator
// NQ-native strategies for the NQ futures engine (SYMBOL=NQ).
// Backtest: NQ.txt 2020-2026, 5m bars, 2 contracts, gate-realistic (1 trade at a time).
//
// NQ_DONCHIAN_BO_L/S — 20-bar Donchian channel breakout
//   Long:  close breaks above 20-bar high, vol > 1.5x avg, c > EMA50, c > EMA200
//   Short: close breaks below 20-bar low,  vol > 1.5x avg, c < EMA50, c < EMA200
//   TP: 110t ($550/ct) | Stop: 40t ($200/ct)
//   Backtest (2020-2026, 5m, NQ session): L 11.2/mo 36%WR +$19,729/yr MaxDD -$12,100
//                                         S 11.2/mo 34%WR +$14,043/yr MaxDD -$11,900
//   NOTE: 40t stop = $400/2ct risk. NOT enabled — DONCH15_L covers similar setup at lower risk.
//
// NQ_BB_SQUEEZE_L/S — Bollinger Band expansion breakout
//   Fires when BB is expanding (not contracting), price closes above/below band, vol > 1.2x avg
//   Long:  above upper band after prior close < upper band, c > EMA200
//   Short: below lower band after prior close > lower band, c < EMA200
//   TP: 110t ($550/ct) | Stop: 10t ($50/ct) — tight stop, high R:R (11:1)
//   Backtest (2020-2026, 5m, NQ session): L 13.6/mo 16%WR +$15,886/yr MaxDD -$5,700
//                                         S 13.8/mo 20%WR +$23,171/yr MaxDD -$4,600
//   OOS    (2024-2026, 5m):               L 11.7/mo 20%WR +$20,000/yr MaxDD -$3,000
//                                         S 13.0/mo 29%WR +$37,967/yr MaxDD -$2,000 ✓
//   Fills the 19:00-20:00 UTC gap (PM2 hour) not covered by ES-session strategies.
//
// NQ tick structure: $5/tick, 0.25pt tick size → 100t = 25pts = $500/ct

import { ema, adx, bollingerBands, highestHighPrev, lowestLowPrev, volumeSMA } from "./indicators.js";

const AM_START = 1330, AM_END = 1500;
const PM_START = 1800, PM_END = 2000;

const inSession = (barTime) => {
  const d = new Date(barTime * 1000);
  const hm = d.getUTCHours() * 100 + d.getUTCMinutes();
  return (hm >= AM_START && hm < AM_END) || (hm >= PM_START && hm < PM_END);
};

export const evaluateNQ = (bars) => {
  if (bars.length < 210) return [];

  const last = bars[bars.length - 1];
  if (!inSession(last.time)) return [];

  const closes = bars.map(b => b.close);
  const signals = [];

  const e50  = ema(closes, 50);
  const e200 = ema(closes, 200);

  // 20-bar Donchian channel (excludes current bar — highestHighPrev/lowestLowPrev use prev bars only)
  const hi20 = highestHighPrev(bars, 20);
  const lo20 = lowestLowPrev(bars, 20);
  if (hi20 === null || lo20 === null) return [];

  const volAvg20 = volumeSMA(bars, 20);
  if (!volAvg20) return [];

  const prev = bars[bars.length - 2];
  const c   = last.close;
  const vol = last.volume;

  // NQ_DONCHIAN_BO_L: breakout long above 20-bar high
  if (c > hi20 && vol > 1.5 * volAvg20 && c > e50 && c > e200) {
    signals.push({
      id:      "NQ_DONCHIAN_BO_L",
      side:    "long",
      price:   c,
      tpTicks: 110,   // 27.5pts = $550/ct — optimized 2026-08-01 (vs 100t: +$728/yr)
    });
  }

  // NQ_DONCHIAN_BO_S: breakout short below 20-bar low
  if (c < lo20 && vol > 1.5 * volAvg20 && c < e50 && c < e200) {
    signals.push({
      id:       "NQ_DONCHIAN_BO_S",
      side:     "short",
      price:    c,
      tpTicks:  110,   // 27.5pts = $550/ct — optimized 2026-08-01 (vs 100t: +$728/yr)
    });
  }

  // ─── NQ BB_SQUEEZE_L / NQ_BB_SQUEEZE_S ───────────────────────────────────
  // BB expansion breakout: fires when BB is expanding (not contracting) and price
  // closes above/below the band for the first time, with volume confirmation.
  // Tight 10t stop ($50/ct) — most trades are stopped quickly; 21%WR, avg win $483.
  const bbNow  = bollingerBands(closes.slice(-30), 20, 2);
  const bbPrev = bollingerBands(closes.slice(-31, -1), 20, 2);
  if (bbNow && bbPrev && volAvg20) {
    const bbNowW  = bbNow.upper  - bbNow.lower;
    const bbPrevW = bbPrev.upper - bbPrev.lower;
    const contracting = bbNowW < bbPrevW * 0.9;  // BB squeezing — wait for expansion

    if (!contracting && vol > volAvg20 * 1.2) {
      if (c > bbNow.upper && prev.close < bbNow.upper && c > e200) {
        signals.push({
          id:        "NQ_BB_SQUEEZE_L",
          side:      "long",
          price:     c,
          tpTicks:   110,   // $550/ct
          stopTicks: 10,    // $50/ct tight stop — overrides CFG.stopTicks=40
        });
      }
      if (c < bbNow.lower && prev.close > bbNow.lower && c < e200) {
        signals.push({
          id:        "NQ_BB_SQUEEZE_S",
          side:      "short",
          price:     c,
          tpTicks:   110,   // $550/ct
          stopTicks: 10,    // $50/ct tight stop — overrides CFG.stopTicks=40
        });
      }
    }
  }

  // ─── NQ_VWAP_TOUCH_L / NQ_VWAP_TOUCH_S ──────────────────────────────────────
  // Three-VWAP scalp: price departs VWAP by ≥10t, returns to it with a volume spike.
  // Fires on whichever VWAP (Day/London/US session) triggers first per direction.
  // Gate: Thu/Fri only — Mon–Wed showed negative expectancy in 2022-2026 backtest.
  // Stop: 10t ($50/ct)  TP: 12t ($60/ct)  WR: 60% Thu/Fri (2022-2026, 2ct NQ)
  // Volume proxy: current bar ≥ 1.4× 20-bar session avg (Bookmap absorption stand-in)
  do {
    const dow = new Date(last.time * 1000).getUTCDay();
    if (dow !== 4 && dow !== 5) break; // Thu=4, Fri=5 only

    // Volume spike: compare against last 20 session bars
    const sessionVols = bars
      .filter(b => { const bh = new Date(b.time*1000).getUTCHours()*100 + new Date(b.time*1000).getUTCMinutes(); return (bh >= 1330 && bh < 1500) || (bh >= 1800 && bh < 2000); })
      .slice(-20);
    const volAvgSess = sessionVols.length > 5 ? sessionVols.reduce((s, b) => s + b.volume, 0) / sessionVols.length : 0;
    if (volAvgSess === 0 || last.volume < volAvgSess * 1.4) break;

    // ADX trend filter
    const adxVal = adx(bars.slice(-80), 14);
    if (!adxVal || adxVal < 25) break;

    // EMA200 slope for directional bias
    const e200     = ema(closes, 200);
    const e200prev = ema(closes.slice(0, -5), 200);
    if (!e200 || !e200prev) break;
    const biasLong = e200 > e200prev;

    // VWAP anchor timestamps for today
    const todayMidnight = (() => { const t = new Date(last.time*1000); t.setUTCHours(0,0,0,0); return t.getTime()/1000; })();
    const anchors = [
      { label: 'day',    ts: (() => { const t = new Date(last.time*1000); t.setUTCHours(23,0,0,0); if (t.getTime()/1000 > last.time) t.setUTCDate(t.getUTCDate()-1); return t.getTime()/1000; })() },
      { label: 'london', ts: todayMidnight + 8*3600 },
      { label: 'us',     ts: todayMidnight + 13*3600 + 30*60 },
    ];

    const TICK_SZ = 0.25, TOUCH_T = 2, DEPART_T = 10;
    const prev = bars[bars.length - 2];
    if (!prev) break;

    for (const { label, ts } of anchors) {
      if (ts > last.time) continue; // anchor not reached yet

      // Compute VWAP from anchor
      let pv = 0, vv = 0;
      for (const b of bars) {
        if (b.time < ts) continue;
        const tp = (b.high + b.low + b.close) / 3;
        pv += tp * b.volume; vv += b.volume;
      }
      if (vv === 0) continue;
      const vwapVal = pv / vv;

      // Touch detection: last bar within TOUCH_T ticks, prev bar outside
      const lastDist = (last.close - vwapVal) / TICK_SZ;
      const prevDist = (prev.close - vwapVal) / TICK_SZ;
      if (Math.abs(lastDist) > TOUCH_T) continue;
      if (Math.abs(prevDist) <= TOUCH_T) continue; // prev also at VWAP — no clear cross

      const isLong = prevDist < -TOUCH_T; // came from below → long bounce
      if (isLong && !biasLong)  continue;
      if (!isLong && biasLong)  continue;

      // Departure check: price must have moved ≥ DEPART_T ticks from VWAP before returning
      const anchorBars = bars.filter(b => b.time >= ts && b.time < last.time);
      const maxDep = anchorBars.reduce((mx, b) => Math.max(mx, Math.abs(b.close - vwapVal) / TICK_SZ), 0);
      if (maxDep < DEPART_T) continue;

      // First-touch check: no prior touch in this direction since anchor
      let priorTouch = false;
      for (let k = 1; k < anchorBars.length; k++) {
        const bk = anchorBars[k], bkp = anchorBars[k-1];
        const bkDist  = Math.abs(bk.close  - vwapVal) / TICK_SZ;
        const bkpDist = (bkp.close - vwapVal) / TICK_SZ;
        const bkDir   = bkpDist < -TOUCH_T ? true : bkpDist > TOUCH_T ? false : null;
        if (bkDist <= TOUCH_T && bkDir === isLong) { priorTouch = true; break; }
      }
      if (priorTouch) continue;

      signals.push({
        id:        isLong ? "NQ_VWAP_TOUCH_L" : "NQ_VWAP_TOUCH_S",
        side:      isLong ? "long" : "short",
        price:     last.close,
        tpTicks:   12,
        stopTicks: 10,
        _vwap:     label, // diagnostic only
      });
      break; // one signal per bar (first VWAP that qualifies)
    }
  } while (false);

  return signals;
};
