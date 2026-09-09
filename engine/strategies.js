// V10 Strategy Signal Evaluator — Quant-Rebuilt V3
// Walk-forward methodology: IS=2020-21, Val=2022-23, OOS=2024-26
//
// V3 vs V2 (gate-realistic backtest, 1 contract):
//   $/yr:   V3 $19,225  vs  V2 $2,924    (+$16,301/yr)
//   MaxDD:  V3 -$10,700 vs  V2 -$22,688  (53% lower drawdown)
//   OOS:    V3 +$63,800 vs  V2 -$5,813   (2024-2026, 2.5 years)
//   Sharpe: V3 1.16     vs  V2 0.26
//
// 7 signals — per-signal TP/stop optimized on VAL set:
//   DONCH15_L  15t/72t — 15-bar Donchian breakout, above EMA200
//   VOLBO_L     6t/12t — volume spike up bar, above EMA200
//   VOLBO_S     6t/12t — volume spike down bar, below EMA200
//   EMA21_PULL_L 6t/16t — EMA21 pullback bounce, above EMA200
//   BO10_S      8t/24t — Donchian 10-bar break below, below EMA200
//   3BAR_BEAR_S 10t/64t — 2 bull bars + reversal bear, ranging or downtrend
//   KELT_L     15t/48t — Keltner(EMA21+ATR14) lower-band bounce, above EMA200

import {
  rsi, ema, emaSeries, atr, highestHighPrev, lowestLowPrev, volumeSMA, adx,
} from "./indicators.js";

// Session windows in UTC (MST = UTC-7):
//   AM: 13:15–15:00  (6:15–8:00 AM MST, pre/open hour)
//   PM: 18:00–19:00  (11:00–12:00 PM MST, power hour — longs also allowed: PM gate removed in V3)
const AM_START = 1315, AM_END = 1500;
const PM_START = 1800, PM_END = 1900;

const inSession = (barTime) => {
  const d = new Date(barTime * 1000);
  const hm = d.getUTCHours() * 100 + d.getUTCMinutes();
  return (hm >= AM_START && hm < AM_END) || (hm >= PM_START && hm < PM_END);
};

export const evaluate = (bars, opts = {}) => {
  if (bars.length < 210) return [];

  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const b3   = bars[bars.length - 3]; // 2 bars ago

  if (!inSession(last.time)) return [];

  const closes = bars.map(b => b.close);

  // Core indicators
  const r14    = rsi(closes, 14);
  const e21    = ema(closes, 21);
  const e21Ser = emaSeries(closes, 21);
  const e21Prv = e21Ser[e21Ser.length - 2]; // EMA21 on previous bar
  const e200   = ema(closes, 200);
  const a14    = atr(bars.slice(-150), 14);  // ATR14 for Keltner + sizing

  // ADX — trend strength. Threshold 18 (lower than V2's 25; V3 signals have own quality gates)
  const adx14  = adx(bars.slice(-150), 14);
  const inTrend = adx14 > 18;

  const aboveEMA = last.close > e200;

  // Lookback levels
  const hi15   = highestHighPrev(bars, 15);
  const lo10   = lowestLowPrev(bars, 10);
  const volAvg = volumeSMA(bars, 20);

  // Keltner lower band (EMA21 - 1.5×ATR14)
  const kcDnNow  = (e21 && a14) ? e21 - 1.5 * a14 : null;
  const kcDnPrev = (() => {
    const s = bars.slice(0, -1);
    if (s.length < 150) return null;
    const cls = s.map(b => b.close);
    const eP  = ema(cls, 21);
    const aP  = atr(s.slice(-150), 14);
    return (eP && aP) ? eP - 1.5 * aP : null;
  })();

  const signals = [];
  const c = last.close;

  // ── 1. DONCH15_L — Donchian 15-bar breakout long ──────────────────────────────
  // First close above the prior 15-bar high. Above EMA200 (bull market), RSI not overbought.
  // Backtest (NQ 2020-2026, 5m/1m, 2ct): 31% WR  +$90,900 total  +$14/tr
  // Fixed TP 18t / Stop 6t (3:1 R:R) — trail exit was cutting winners short.
  if (hi15 && prev.close <= hi15 && c > hi15 && aboveEMA && r14 > 40) {
    signals.push({ id: "DONCH15_L", side: "long", price: c, stopTicks: 6, tpTicks: 18 });
  }

  // ── 2. VOLBO_L — Volume breakout long ─────────────────────────────────────────
  // >2× average volume, up bar, closes above previous close, above EMA200.
  // RSI 35-75: avoids deeply oversold (contra-trend) and overbought (exhausted) entries.
  // VAL: 49% WR vs 33% BE. Fires ~61/yr.
  if (volAvg && last.volume > volAvg * 2 &&
      c > last.open && c > prev.close &&
      aboveEMA && r14 > 35 && r14 < 75) {
    signals.push({ id: "VOLBO_L", side: "long", price: c, stopTicks: 6, tpTicks: 12 });
  }

  // ── 3. VOLBO_S — Volume breakdown short ───────────────────────────────────────
  // >2× average volume, down bar, closes below previous close, below EMA200.
  // RSI < 65: avoids extremely oversold entries where bounce risk is elevated.
  // VAL: 55% WR vs 33% BE. Fires ~84/yr.
  if (volAvg && last.volume > volAvg * 2 &&
      c < last.open && c < prev.close &&
      !aboveEMA && r14 < 65) {
    signals.push({ id: "VOLBO_S", side: "short", price: c, stopTicks: 6, tpTicks: 12 });
  }

  // ── 4. EMA21_PULL_L — EMA21 pullback long ────────────────────────────────────
  // In established uptrend: prior bar dipped to/below EMA21, current bar closes back above.
  // Classic "buy the 21 EMA" institutional setup. ADX>18 confirms trend is real.
  // RSI 30-65: avoids extremely oversold and overbought. Fires ~227/yr, 31% WR vs 27% BE.
  if (e21Prv && e21 &&
      prev.low <= e21Prv && c > e21 && c > prev.close &&
      aboveEMA && inTrend && r14 > 30 && r14 < 65) {
    signals.push({ id: "EMA21_PULL_L", side: "long", price: c, stopTicks: 6, tpTicks: 16 });
  }

  // ── 5. BO10_S — Donchian 10-bar breakdown short ───────────────────────────────
  // First close below the prior 10-bar low. Below EMA200 (bear market), trend confirmed.
  // Captures momentum breakdowns in downtrends. Fires ~213/yr, 28% WR vs 25% BE.
  if (lo10 && prev.close >= lo10 && c < lo10 && !aboveEMA && inTrend) {
    signals.push({ id: "BO10_S", side: "short", price: c, stopTicks: 8, tpTicks: 24 });
  }

  // ── 6. 3BAR_BEAR_S — Two-bull-bar reversal short ─────────────────────────────
  // Two consecutive bullish bars (retail longs piling in), then a bearish bar that:
  //   - closes below its own open
  //   - closes below both prior bullish bars' closes (confirms rejection)
  // Requires either low ADX (ranging = reversal fertile) or below EMA200 (bear market).
  // VAL: 20% WR vs 14% BE. Fires ~337/yr at 10t stop / 64t TP — R:R carries it.
  if (bars.length >= 4 &&
      b3.close > b3.open &&                      // bar 2 ago: bullish
      prev.close > prev.open &&                   // bar 1 ago: bullish
      c < last.open &&                            // current: bearish
      c < prev.close && c < b3.close &&           // closes below both prior
      (adx14 < 25 || !aboveEMA)) {               // ranging or downtrend context
    signals.push({ id: "3BAR_BEAR_S", side: "short", price: c, stopTicks: 10, tpTicks: 64 });
  }

  // ── 7. KELT_L — Keltner lower-band bounce long ───────────────────────────────
  // Prior bar closed BELOW lower Keltner (EMA21 - 1.5×ATR14) = overextended down.
  // Current bar closes back ABOVE lower Keltner = mean reversion entry.
  // Above EMA200 only (avoids knife-catching in bear markets). RSI>25 (not deeply oversold).
  // VAL: 30% WR vs 24% BE. Fires ~57/yr.
  if (kcDnPrev && kcDnNow &&
      prev.close <= kcDnPrev && c > kcDnNow &&
      aboveEMA && r14 > 25) {
    signals.push({ id: "KELT_L", side: "long", price: c, stopTicks: 15, tpTicks: 48 });
  }

  // Annotate with signal-bar high/low for engine stop placement
  for (const sig of signals) { sig.barHigh = last.high; sig.barLow = last.low; }

  return signals;
};

// Extended evaluator — V3 uses only the core AM/PM session windows.
// Kept for engine compatibility; returns empty.
export const evaluateExtended = (_bars) => [];

// Diagnostic — indicator values for current bar
export const debug = (bars) => {
  if (bars.length < 210) return { error: "not enough bars" };
  const closes = bars.map(b => b.close);
  return {
    bar:      bars[bars.length - 1],
    inSession: inSession(bars[bars.length - 1].time),
    rsi14:    rsi(closes, 14),
    ema21:    ema(closes, 21),
    ema200:   ema(closes, 200),
    atr14:    atr(bars.slice(-150), 14),
    adx14:    adx(bars.slice(-150), 14),
    high15:   highestHighPrev(bars, 15),
    low10:    lowestLowPrev(bars, 10),
    volSMA20: volumeSMA(bars, 20),
  };
};
