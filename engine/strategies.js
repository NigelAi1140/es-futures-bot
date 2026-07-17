// v9 Strategy Signal Evaluator
// Replicates the 7 strategies from strategy.pine in JavaScript.
// Called on every bar close. Returns array of triggered signals: [{id, side, price}, ...]

import {
  rsi, sessionVWAP, ema, emaSeries, atr, stoch, stochSeries,
  heikinAshiSeries, highestHighPrev, lowestLowPrev, volumeSMA, adx,
  bollingerBands, macdHistSeries
} from "./indicators.js";

// Session windows in UTC:
//   AM: 1330-1500 = 7:30-9:00 AM MT  (open — all strategies)
//   PM: 1800-2000 = 12:00-2:00 PM MT (power hour — shorts only, longs blocked)
// PM note: afternoon has bearish bias — AVWAP_L and EMAPB_L disabled in PM (0% / 14% WR)
const AM_START = 1330, AM_END = 1500;
const PM_START = 1800, PM_END = 2000;

const inSession = (barTime) => {
  const d = new Date(barTime * 1000);
  const hm = d.getUTCHours() * 100 + d.getUTCMinutes();
  return (hm >= AM_START && hm < AM_END) || (hm >= PM_START && hm < PM_END);
};

const isPM = (barTime) => {
  const d = new Date(barTime * 1000);
  const hm = d.getUTCHours() * 100 + d.getUTCMinutes();
  return hm >= PM_START && hm < PM_END;
};

export const evaluate = (bars, opts = {}) => {
  // Need at least 200 bars for EMA200
  if (bars.length < 210) return [];

  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];

  if (!inSession(last.time)) return [];

  const closes = bars.map(b => b.close);
  const highs  = bars.map(b => b.high);
  const lows   = bars.map(b => b.low);
  const vols   = bars.map(b => b.volume);

  // Indicators
  const r14 = rsi(closes, 14);
  const r2  = rsi(closes, 2);
  const v   = sessionVWAP(bars);
  const e13 = ema(closes, 13);
  const e9Series  = emaSeries(closes, 9);
  const e9  = e9Series[e9Series.length - 1];
  const e20Series = emaSeries(closes, 20);
  const e21 = ema(closes, 21);
  const e21Series = emaSeries(closes, 21);
  const e21Prev5 = e21Series[e21Series.length - 6];  // 5 bars ago
  const e50Series = emaSeries(closes, 50);
  const e50 = e50Series[e50Series.length - 1];
  const e50Prev6 = e50Series[e50Series.length - 7]; // 6 bars ago = 30min slope proxy
  const e200 = ema(closes, 200);
  const e20 = e20Series[e20Series.length - 1];
  // ATR needs many Wilder smoothing steps to converge (Pine uses full history).
  // Use last 150 bars (~12h of 5m data) so we get 130 smoothing steps instead of 9.
  const a20 = atr(bars.slice(-150), 20);
  // ADX(14) — trend-strength filter. Same 150-bar slice for convergence.
  // 17yr backtest: ADX>20 converts AVWAP_S from $4/tr → $31/tr and EMAPB_S from $7/tr → $35/tr.
  // NOTE: Do NOT apply to KELT_S or STOCH_S — ADX filter hurts those (they have own momentum gates).
  const adx14 = adx(bars.slice(-150), 14);
  const trendingMarket = adx14 > 20;
  // 30m trend proxy: EMA50 declining over last 6 × 5m bars (= 30 min).
  // Used to filter KELT_S: $13/tr → $78/tr in 17yr backtest (102 vs 544 trades, higher quality).
  const trend30mDn = e50Prev6 !== undefined && e50 < e50Prev6;
  const kcUp = e20 + 1.5 * a20;
  const kcDn = e20 - 1.5 * a20;
  const kcUpPrev = (() => {
    const slice = bars.slice(0, -1);
    if (slice.length < 150) return null;
    return ema(slice.map(b => b.close), 20) + 1.5 * atr(slice.slice(-150), 20);
  })();
  const kcDnPrev = (() => {
    const slice = bars.slice(0, -1);
    if (slice.length < 150) return null;
    return ema(slice.map(b => b.close), 20) - 1.5 * atr(slice.slice(-150), 20);
  })();

  // const ha = heikinAshiSeries(bars); // HA_FLIP cut — not needed

  const stochArr = stochSeries(bars, 14);
  const k_now  = stochArr[stochArr.length - 1];
  const k_prev = stochArr[stochArr.length - 2];
  // %D = SMA(3) of %K
  const d_now  = (stochArr[stochArr.length - 1] + stochArr[stochArr.length - 2] + stochArr[stochArr.length - 3]) / 3;
  const d_prev = (stochArr[stochArr.length - 2] + stochArr[stochArr.length - 3] + stochArr[stochArr.length - 4]) / 3;

  const hi20 = highestHighPrev(bars, 20);
  const lo20 = lowestLowPrev(bars, 20);
  const volAvg = volumeSMA(bars, 20);

  const signals = [];
  const c    = last.close;
  const pmBar = isPM(last.time); // afternoon session — longs suppressed

  // ─── 1. AVWAP — VWAP touch + reclaim, EMA13>EMA50, RSI 35-55 / 45-65 ───
  // Volume filter tested and REVERTED: removed trades had 58% WR (+$1,450 P&L) —
  // the filter was cutting winners, costing $6,025 net for only 1% WR gain.
  const touchVup = last.low <= v && c > v;
  const touchVdn = last.high >= v && c < v;
  if (!pmBar && touchVup && e13 > e50 && r14 > 35 && r14 < 55) {
    signals.push({ id: "AVWAP_L", side: "long", price: c });  // AM only (AVWAP_L paused in CFG — ADX filter not needed)
  }
  if (trendingMarket && touchVdn && e13 < e50 && r14 > 45 && r14 < 65) {
    signals.push({ id: "AVWAP_S", side: "short", price: c }); // AM + PM — ADX>20 filter: $4/tr → $31/tr (17yr)
  }

  // ─── 2. EMAPB — EMA200 trend + EMA21 rising + pullback + reversal candle ───
  const risingUp = e21 > e21Prev5;
  const risingDn = e21 < e21Prev5;
  const bullCdl = c > last.open && c > prev.close;
  const bearCdl = c < last.open && c < prev.close;
  const nearE21Up = last.low <= e21 && c > e21;
  const nearE21Dn = last.high >= e21 && c < e21;
  if (!pmBar && c > e200 && e21 > e50 && risingUp && nearE21Up && bullCdl && r14 > 40 && r14 < 60) {
    signals.push({ id: "EMAPB_L", side: "long", price: c });  // AM only (EMAPB_L paused in CFG)
  }
  if (trendingMarket && c < e200 && e21 < e50 && risingDn && nearE21Dn && bearCdl && r14 > 40 && r14 < 60) {
    signals.push({ id: "EMAPB_S", side: "short", price: c }); // AM + PM — ADX>20 filter: $7/tr → $35/tr (17yr)
  }

  // ─── 3. RSI2 — extreme RSI(2) + EMA200 + VWAP confluence ───
  // PM block on both legs: backtest shows 38% WR / -$25 in PM vs 75% WR / +$600 in AM.
  // Same pattern as AVWAP_L and EMAPB_L — afternoon session kills the edge.
  if (!pmBar && r2 < 5 && c > e200 && c > v) {
    signals.push({ id: "RSI2_L", side: "long", price: c });   // AM only
  }
  if (!pmBar && r2 > 95 && c < e200 && c < v) {
    signals.push({ id: "RSI2_S", side: "short", price: c });  // AM only (insufficient PM data anyway)
  }

  // ─── 4. VOLBO — PAUSED (poor WR across all live periods — filtered in CFG.pausedStrategies) ───
  const volSpike = last.volume > volAvg * 1.5;
  if (c > hi20 && volSpike && c > e200) signals.push({ id: "VOLBO_L", side: "long",  price: c });
  if (c < lo20 && volSpike && c < e200) signals.push({ id: "VOLBO_S", side: "short", price: c });

  // ─── 5. KELTNER ───
  // KELT_S: added 30m trend filter (trend30mDn) — 17yr: $13/tr → $78/tr (reduces to ~6 trades/yr, high quality)
  if (kcDnPrev && prev.close < kcDnPrev && c > kcDn && c > e200 && r14 > 30) signals.push({ id: "KELT_L", side: "long",  price: c });
  if (kcUpPrev && prev.close > kcUpPrev && c < kcUp && c < e200 && r14 < 70 && trend30mDn) signals.push({ id: "KELT_S", side: "short", price: c });

  // ─── 6. EMAXPB — EMA9/20 death cross pullback short ───
  // EMA9 crossed below EMA20 (death cross) within the last 8 bars, then price
  // pulls back up to EMA9 and gets rejected (bearish bar closing below EMA9).
  // Conditions: below EMA200, EMA9 < EMA20, ADX>20, ATR>=2 (engine-level filter).
  // 17yr backtest: 1,322 trades · 41% WR · +$74k · $56/trade (ADX>20 on).
  // Pre-2020: –$5k (weak). 2020+: +$79k, 42% WR (strong trending markets).
  // Added 2026-06-13 for combine forward-data collection.
  const emaxpbCrossedDn = (() => {
    const len = e9Series.length;
    for (let k = 1; k <= 8; k++) {
      if (len - k - 1 < 0) break;
      if (e9Series[len - k] < e20Series[len - k] && e9Series[len - k - 1] >= e20Series[len - k - 1]) return true;
    }
    return false;
  })();
  const emaxpbRejection = last.high >= e9 && c < e9 && c < prev.close;
  if (trendingMarket && emaxpbCrossedDn && emaxpbRejection && c < e200 && e9 < e20) {
    signals.push({ id: "EMAXPB_S", side: "short", price: c });
  }

  // ─── 7. EMAFAN — EMA9/20/50 bearish stack + bearish bar ───
  // All three EMAs stacked in downtrend order (e9 < e20 < e50), bearish bar, below EMA200.
  // 17yr: 1,608 trades · 38% WR · +$50,700 · $32/tr (ADX>20 on). 13/17 years positive.
  // Distinct from EMAPB (which looks at EMA21 pullback) — this fires on momentum continuation
  // when trend is fully aligned across 3 timeframes. Added 2026-06-13.
  const emaFanBear = e9 < e20 && e20 < e50;
  if (trendingMarket && emaFanBear && c < last.open && c < prev.close && c < e200 && r14 > 40 && r14 < 65) {
    signals.push({ id: "EMAFAN_S", side: "short", price: c });
  }

  // ─── 8. BB_SQ_L — Bollinger Band squeeze + expansion long ───
  // When BBs compress (width < 0.5%) then price breaks above upper BB with trend confirmation.
  // First legit long strategy found: 17yr (ADX + 30m slope up) = 2,108 trades · 43% WR · +$109,500 · $52/tr.
  // Not fired in PM session (longs suppressed in afternoon).
  const bbNow  = bollingerBands(closes, 20, 2.0);
  const bbPrev = bollingerBands(closes.slice(0, -1), 20, 2.0);
  const bbSqueeze = bbPrev && bbPrev.widthPct < 0.5;
  const bbBreakout = bbNow && c > bbNow.upper;
  const trend30mUp = e50Prev6 !== undefined && e50 > e50Prev6;
  if (!pmBar && trendingMarket && bbSqueeze && bbBreakout && c > e200 && trend30mUp) {
    signals.push({ id: "BB_SQ_L", side: "long", price: c });
  }

  // ─── 9. 3BAR_BEAR_S — three consecutive lower bearish bars in downtrend ───
  // Three bearish bars each closing below the prior, below EMA200, ADX>20, ATR≥2.
  // No RSI filter — testing showed RSI actually hurts performance.
  // 17yr (8t/40t model, no RSI): 3375 trades · 46%WR · +$112k · $33/tr.
  // Strongly positive 2020-2026 (63%WR in 2025, 63%WR in 2026). Pre-2018 negative (regime).
  // 81% overlap with EMAFAN_S — direction gate handles double-signal on same bar.
  // Added 2026-06-13 for forward data collection.
  const bar3ago = bars[bars.length - 3];
  const threeBarBear = bar3ago.close < bar3ago.open && prev.close < prev.open && c < last.open &&
                       c < prev.close && prev.close < bar3ago.close;
  if (trendingMarket && threeBarBear && c < e200) {
    signals.push({ id: "3BAR_BEAR_S", side: "short", price: c });
  }

  // ─── 10. E200_REJ_S — EMA200 rejection candle ───
  // Previous bar poked above EMA200 but closed back below it (rejection).
  // Current bar follows through downward. ADX>25 (stronger trend confirmation), RSI 40-65.
  // 17yr (8t/40t model): 243 trades · 41%WR · +$5,338 · $22/tr. Consistently positive 2020-2026.
  // Low frequency (~14/yr) — clean, high-conviction setup. Added 2026-06-13.
  const e200RejPrev = prev.high >= e200 && prev.close < e200;
  if (adx14 > 25 && e200RejPrev && c < prev.close && c < e200 && r14 > 40 && r14 < 65) {
    signals.push({ id: "E200_REJ_S", side: "short", price: c });
  }

  // ─── 11. MACD_FAN_S — MACD histogram cross below zero + EMA bearish fan ───
  // MACD hist crosses from positive to negative on current bar, inside an already-established
  // downtrend (EMA fan: e9 < e20 < e50), below EMA200, ADX>20.
  // 17yr: 99 trades · 55% WR · +$15,375 · $155/tr — highest quality signal found.
  // ~6 trades/year but extraordinary per-trade quality.
  const macdHist = macdHistSeries(closes);
  const macdHistNow  = macdHist[macdHist.length - 1];
  const macdHistPrev = macdHist[macdHist.length - 2];
  const macdCrossedDn = !isNaN(macdHistNow) && !isNaN(macdHistPrev) && macdHistPrev >= 0 && macdHistNow < 0;
  if (trendingMarket && macdCrossedDn && emaFanBear && c < e200 && r14 > 40 && r14 < 65) {
    signals.push({ id: "MACD_FAN_S", side: "short", price: c });
  }

  // ─── 10. TRAP_S — Trapped longs (2-bar rally + bearish engulf in downtrend) ───
  // Two consecutive bullish bars lure longs in, then a bearish bar erases both (opens above
  // 2nd bull bar's close, closes below 1st bull bar's open). Trapped buyers exit = momentum.
  // 17yr loose: 251 trades · 43% WR · +$19,250 · $77/tr (ADX>20).
  const b3 = bars[bars.length - 3];
  const b2 = bars[bars.length - 2];
  const twoBarRally = b3.close > b3.open && b2.close > b2.open;
  const bearEngulf   = last.open >= b2.close && c < b3.open;
  if (trendingMarket && twoBarRally && bearEngulf && c < e200) {
    signals.push({ id: "TRAP_S", side: "short", price: c });
  }

  // ─── 13. LIQ_SWEEP_S — Liquidity sweep of 10-bar swing high + rejection ───
  // ICT/SMC stop-hunt pattern: price wicks 4+ ticks above recent swing high (takes out buy stops),
  // then closes 4+ ticks below that level (sellers absorb all the swept liquidity).
  // 9yr (2018-2026, 8t/40t model): 1152t · 58%WR · $73/tr · $9,357/yr. No losing years.
  // Tight conditions (4t sweep + 4t close below) make this genuinely high-conviction.
  const swingHigh10 = (() => {
    let h = -Infinity;
    for (let k = bars.length - 11; k < bars.length - 1; k++) h = Math.max(h, bars[k].high);
    return h;
  })();
  if (trendingMarket && last.high >= swingHigh10 + 4 * 0.25 && c <= swingHigh10 - 4 * 0.25 &&
      c < last.open && c < e200) {
    signals.push({ id: "LIQ_SWEEP_S", side: "short", price: c });
  }

  // ─── 14. PDH_REJ_S — Prior day high rejection ───
  // Prior Day High is a key institutional reference level. Price approaches PDH from below,
  // wicks into or above it, but closes below it (distribution at supply zone).
  // 9yr (2018-2026): 747t · 47%WR · $43/tr · $3,565/yr. Strong 2022-2026 (60-67%WR).
  const lastDate = new Date(last.time * 1000).toISOString().slice(0, 10);
  let pdhHigh = -Infinity, pdhDate = null;
  for (let k = bars.length - 2; k >= 0; k--) {
    const d = new Date(bars[k].time * 1000).toISOString().slice(0, 10);
    if (d === lastDate) continue; // skip today
    if (pdhDate === null) pdhDate = d;
    if (d !== pdhDate) break; // only prior day
    if (bars[k].high > pdhHigh) pdhHigh = bars[k].high;
  }
  // Bar tagged PDH (high within 2 ticks) but closed below it (rejection candle)
  if (trendingMarket && pdhHigh > -Infinity && last.high >= pdhHigh - 0.5 &&
      c < pdhHigh && c < last.open && c < e200) {
    signals.push({ id: "PDH_REJ_S", side: "short", price: c });
  }

  // ─── 15. ORB_FAIL_S — Opening Range Breakout failure (bull trap) ───
  // Opening Range = first 30 min of RTH (9:30-10:00 AM ET).
  // Bull trap: price breaks above ORB high then closes back inside range on a bearish bar.
  // = trapped longs from the false breakout become forced sellers (institutional setup).
  // 9yr (2018-2026): 2147t · 52%WR · $63/tr · $14,942/yr. Best strategy found to date.
  // ORB in UTC: EDT (Apr-Nov) = 13:30-14:00, EST (Nov-Mar) = 14:30-15:00.
  const orbBars = (() => {
    const barsForToday = [];
    for (let k = bars.length - 2; k >= 0; k--) {
      const bt = new Date(bars[k].time * 1000);
      if (bt.toISOString().slice(0, 10) !== lastDate) break;
      const h = bt.getUTCHours(), m = bt.getUTCMinutes();
      // EDT: 13:30-13:55 UTC | EST: 14:30-14:55 UTC
      if ((h === 13 && m >= 30) || (h === 14 && m >= 30 && m <= 55)) {
        barsForToday.push(bars[k]);
      }
    }
    return barsForToday;
  })();
  if (orbBars.length >= 3) { // need at least 3 bars of ORB to be meaningful
    const orbHigh = Math.max(...orbBars.map(b => b.high));
    const orbEndTime = Math.max(...orbBars.map(b => b.time));
    if (last.time > orbEndTime + 300 && // current bar must be after ORB ended
        last.high > orbHigh && c < orbHigh && c < last.open && c < e200) {
      signals.push({ id: "ORB_FAIL_S", side: "short", price: c });
    }
  }

  // ─── 16. FAILED_AUCTION_S — Prior day high acceptance + crash ───
  // Market auction theory: 3+ consecutive bars accept above prior day high (price tests supply zone).
  // Current bar crashes back below PDH = trapped longs exit = momentum short.
  // 9yr (2018-2026): 510t · 54%WR · $68/tr · $3,843/yr. 2022: 73%WR, 2025: 70%WR.
  const pdhForAuction = (() => {
    const lastDate2 = new Date(last.time * 1000).toISOString().slice(0, 10);
    let pDate = null, pHigh = -Infinity;
    for (let k = bars.length - 2; k >= 0; k--) {
      const d = new Date(bars[k].time * 1000).toISOString().slice(0, 10);
      if (d === lastDate2) continue;
      if (pDate === null) pDate = d;
      if (d !== pDate) break;
      if (bars[k].high > pHigh) pHigh = bars[k].high;
    }
    return pHigh;
  })();
  if (pdhForAuction > -Infinity) {
    let acceptance = 0;
    for (let k = bars.length - 6; k < bars.length - 1; k++) {
      if (k >= 0 && bars[k].low > pdhForAuction) acceptance++;
    }
    if (acceptance >= 3 && c < pdhForAuction && c < last.open && trendingMarket) {
      signals.push({ id: "FAILED_AUCTION_S", side: "short", price: c });
    }
  }

  // ─── 17. SESSION_HIGH_FAIL_S — PM pokes above AM session high then closes below ───
  // AM session (approx 13:45-15:00 UTC) establishes the day's first high.
  // PM session (18:30-20:00 UTC) breaks above AM high, luring breakout buyers.
  // Then closes back below AM high = PM bear trap. Trapped PM breakout buyers = sellers.
  // 9yr: 142t · 61%WR · $110/tr · $1,728/yr. ZERO losing years across all 9.
  const amSessionHigh = (() => {
    const lastDate3 = new Date(last.time * 1000).toISOString().slice(0, 10);
    let h = -Infinity;
    for (let k = bars.length - 2; k >= 0; k--) {
      const bt = new Date(bars[k].time * 1000);
      if (bt.toISOString().slice(0, 10) !== lastDate3) break;
      const hm = bt.getUTCHours() * 100 + bt.getUTCMinutes();
      // EDT: 13:45-15:00 UTC | EST: 14:45-16:00 UTC (covers both)
      if ((hm >= 1345 && hm < 1500) || (hm >= 1445 && hm < 1600)) {
        if (bars[k].high > h) h = bars[k].high;
      }
    }
    return h;
  })();
  if (amSessionHigh > -Infinity && isPM(last.time) && c < e200) {
    if (last.high > amSessionHigh && c < amSessionHigh && c < last.open && trendingMarket) {
      signals.push({ id: "SESSION_HIGH_FAIL_S", side: "short", price: c });
    }
  }

  // ─── 18. EXHST_S — Momentum exhaustion: widest bar in N bars closes in bottom 15% ───
  // A bar becomes the widest range bar in last 20 bars (climactic buying push upward)
  // but closes in the BOTTOM 15% of its own range AND follows 2 bullish bars.
  // = exhaustion top: maximum participation, then bears overwhelm at the extreme.
  // 9yr: 191t · 53%WR · $76/tr · $1,606/yr. Rare but very high quality.
  const recentMaxRange = (() => {
    let m = 0;
    for (let k = bars.length - 21; k < bars.length - 1; k++) if (k >= 0) m = Math.max(m, bars[k].high - bars[k].low);
    return m;
  })();
  const exhstRange = last.high - last.low;
  const exhstClosePct = exhstRange > 0 ? (c - last.low) / exhstRange : 0.5;
  const exhstAtr = a20; // already computed above
  if (exhstRange > recentMaxRange && exhstClosePct <= 0.15 && exhstRange >= exhstAtr * 2.5 &&
      prev.close > prev.open && bars[bars.length - 3].close > bars[bars.length - 3].open &&
      c < e200 && adx14 > 15) {
    signals.push({ id: "EXHST_S", side: "short", price: c });
  }

  // ─── 19. VOL_CLIMAX_S — Volume climax reversal (blow-off top) ───
  // Top 3% volume bar (extreme participation), range > 2.5×ATR (wide range), close in bottom 15%
  // of bar's own range (sellers overwhelm the buying spike). Bears own end of bar.
  // 9yr (p97, 2018-2026): 1047t · 57%WR · $78/tr · $9,090/yr. Institutional absorption signal.
  const vol100 = bars.slice(-100).map(b => b.volume || 0).slice().sort((a, b) => a - b);
  const volP97 = vol100[Math.floor(vol100.length * 0.97)];
  const lastRange = last.high - last.low;
  const lastClosePct = lastRange > 0.01 ? (c - last.low) / lastRange : 0.5;
  if (lastRange >= a20 * 2.5 && lastClosePct <= 0.15 && (last.volume || 0) >= volP97 &&
      c < e200 && adx14 > 15) {
    signals.push({ id: "VOL_CLIMAX_S", side: "short", price: c });
  }

  // ─── 20. GAP_FAIL_S — Overnight gap down, failed 50% fill ───
  // Gap down = today's first bar open < prior day's last bar close by 4+ ticks.
  // Price rallies intraday, reaches 50% of the gap (half-fill), then fails bearishly.
  // = gap is "real" (not just noise) and bears defend it at the 50% retracement.
  // 9yr (2018-2026): 1652t · 45%WR · $35/tr · $6,343/yr. Works across all market regimes.
  const gapInfo = (() => {
    const todayDate = new Date(last.time * 1000).toISOString().slice(0, 10);
    let firstTodayIdx = bars.length - 1;
    while (firstTodayIdx > 0 && new Date(bars[firstTodayIdx - 1].time * 1000).toISOString().slice(0, 10) === todayDate) {
      firstTodayIdx--;
    }
    if (firstTodayIdx === 0 || firstTodayIdx >= bars.length) return null;
    return { todayOpen: bars[firstTodayIdx].open, priorClose: bars[firstTodayIdx - 1].close };
  })();
  if (gapInfo && gapInfo.priorClose) {
    const gapDown = gapInfo.priorClose - gapInfo.todayOpen;
    if (gapDown >= 1.0) { // 4 ticks × 0.25 = 1pt minimum gap
      const fill50 = gapInfo.todayOpen + gapDown * 0.50;
      if (last.high >= fill50 && c < fill50 && c < last.open && c < e200 && adx14 > 15) {
        signals.push({ id: "GAP_FAIL_S", side: "short", price: c });
      }
    }
  }

  // ─── 21. OVERNIGHT_HIGH_S — RTH sweep of overnight high then reversal ───
  // Overnight session (20:00 UTC prev day → 13:30 UTC today) establishes a high.
  // When RTH price pokes above that high but closes back below = trapped breakout buyers.
  // Professional ES traders watch overnight highs as key reference levels.
  // 9yr: 122t · 61%WR · $117/tr · $1,589/yr. Positive 8/9 years (only -$88 in 2019).
  const overnightHigh = (() => {
    const lastDate4 = new Date(last.time * 1000).toISOString().slice(0, 10);
    let h = -Infinity;
    for (let k = bars.length - 2; k >= 0; k--) {
      const bt = new Date(bars[k].time * 1000);
      const bDate = bt.toISOString().slice(0, 10);
      const bH = bt.getUTCHours();
      // Stop if we've gone past relevant overnight window (>24h back)
      if (bDate < lastDate4 && bH < 20) break;
      // Include: today pre-RTH (before 14:00 UTC) or yesterday post-close (after 20:00 UTC)
      const todayPre  = bDate === lastDate4 && bH < 14;
      const yestPost  = bDate !== lastDate4 && bH >= 20;
      if ((todayPre || yestPost) && bars[k].high > h) h = bars[k].high;
    }
    return h;
  })();
  if (overnightHigh > -Infinity && c < e200 && trendingMarket &&
      last.high > overnightHigh && c < overnightHigh && c < last.open) {
    signals.push({ id: "OVERNIGHT_HIGH_S", side: "short", price: c });
  }

  // ─── 22. RSI_FAIL_S — Wilder's original RSI Failure Swing ───
  // The correct Wilder concept (not "RSI > 70"): RSI peaks above 70 (peak A), pulls back
  // below 70 (trough B), rallies but can't exceed A (peak C < A), then breaks below B.
  // = Confirmed momentum exhaustion. Different from simple overbought/oversold.
  // 9yr: 334t · 47%WR · $41/tr · $1,538/yr. Positive every year. ~37 trades/yr.
  const rsiFailCheck = (() => {
    if (bars.length < 60) return false;
    const N = 14, startIdx2 = Math.max(0, bars.length - 60);
    const cls = closes.slice(startIdx2);
    let g = 0, l = 0;
    for (let j = 1; j <= N; j++) { const d = cls[j]-cls[j-1]; if(d>=0)g+=d; else l-=d; }
    let ag=g/N, al=l/N;
    const rs = new Array(N+1).fill(null);
    rs[N] = al===0 ? 100 : 100-100/(1+ag/al);
    for (let j = N+1; j < cls.length; j++) {
      const d=cls[j]-cls[j-1]; ag=(ag*(N-1)+(d>=0?d:0))/N; al=(al*(N-1)+(d<0?-d:0))/N;
      rs.push(al===0 ? 100 : 100-100/(1+ag/al));
    }
    const rsiWin = rs.slice(-40);
    let peakA=-Infinity, troughB=Infinity, peakC=-Infinity, phase=0;
    for (let j = 0; j < rsiWin.length - 1; j++) {
      const r = rsiWin[j]; if (r===null || isNaN(r)) continue;
      if (phase===0 && r>70) { peakA=r; phase=1; }
      else if (phase===1) { if (r<troughB) troughB=r; if (troughB<70 && r>troughB+3) phase=2; }
      if (phase===2) { if (r>peakC) peakC=r; else if (r<peakC-2 && peakC<peakA-2) phase=3; }
    }
    const rNow = rsiWin[rsiWin.length-1];
    return phase >= 2 && peakC < peakA-2 && typeof rNow==='number' && rNow < troughB;
  })();
  if (rsiFailCheck && c < last.open && c < e200 && trendingMarket) {
    signals.push({ id: "RSI_FAIL_S", side: "short", price: c });
  }

  // ─── 11. HA_FLIP — CUT (0/5 forward, biggest drag -$1420 week of 2026-05-11) ───
  // Removed permanently — no VWAP/EMA confluence, fires too frequently, 0 wins.

  // ─── 9. STOCH — %K crosses %D in 25/75 zones + EMA200 trend ───
  // Widened from 20/80 → 25/75 to increase signal frequency.
  // Backtest: only 10 trades in 2 months at 75% WR — strong edge but fires rarely.
  const stochBullCross = k_prev <= d_prev && k_now > d_now && k_now < 25;
  const stochBearCross = k_prev >= d_prev && k_now < d_now && k_now > 75;
  if (stochBullCross && c > e200) {
    signals.push({ id: "STOCH_L", side: "long", price: c });
  }
  if (stochBearCross && c < e200) {
    signals.push({ id: "STOCH_S", side: "short", price: c });
  }

  // ─── 23. BODY_ENGULF_S — Bearish body engulfing candle (LOW PRIORITY — gap filler) ───
  // MUST stay at END so high-quality signals get direction gate priority.
  // Portfolio +57% additive when placed last (2022-2026: $8,233/yr vs $5,255/yr baseline).
  // Standalone 2020+: 46%WR · $34/tr.
  {
    const beBodySize = last.open - c;
    const prevBodySize2 = Math.abs(bars[bars.length - 2].close - bars[bars.length - 2].open);
    if (
      last.open > bars[bars.length - 2].close &&
      c < bars[bars.length - 2].open &&
      c < last.open &&
      beBodySize >= prevBodySize2 * 0.8 &&
      c < e200 &&
      trendingMarket
    ) {
      signals.push({ id: "BODY_ENGULF_S", side: "short", price: c });
    }
  }

  // ─── 24. BEARISH_FVG_S — Fair Value Gap fill rejection (LOW PRIORITY — gap filler) ───
  // ICT concept: bearish imbalance (bars[k-2].low > bars[k].high) = fast sell zone.
  // When price rallies back INTO the gap and closes inside/below it = trapped longs.
  // MUST stay at END. Standalone (2020+): 88%WR · $303/tr (rare in portfolio context).
  for (let k = bars.length - 6; k >= bars.length - 62; k--) {
    if (k < 2) break;
    const bk0 = bars[k - 2], bk2 = bars[k];
    if (bk0.low <= bk2.high) continue;
    const fvgLow = bk2.high;
    const fvgHigh = bk0.low;
    if (last.high >= fvgLow && c < fvgHigh && c < last.open && c < e200 && trendingMarket) {
      signals.push({ id: "BEARISH_FVG_S", side: "short", price: c });
      break;
    }
  }

  // ─── DONCHIAN_BO_L — 20-bar channel breakout long ────────────────────────────
  // Price closes above the highest high of the prior 20 bars with above-avg volume.
  // EMA50 trend confirm. No EMA200 requirement (differentiates from VOLBO).
  // Gate-realistic backtest 2022-2026: 46%WR, +$5,825 net (345 trades).
  if (c > hi20 && last.volume > volAvg * 1.5 && c > e50) {
    signals.push({ id: "DONCHIAN_BO_L", side: "long", price: c });
  }

  // ─── INSIDE_BAR_BO — volatility compression then expansion ───────────────────
  // 2+ consecutive inside bars (each within prior bar's range) then a close
  // outside the compression zone with above-avg volume + EMA50 trend confirm.
  // Gate-realistic backtest 2022-2026: 53%WR long, 40%WR short, +$5,425 net combined.
  {
    const ibb1 = bars[bars.length - 2];
    const ibb2 = bars[bars.length - 3];
    const ibb3 = bars[bars.length - 4];
    if (ibb1 && ibb2 && ibb3) {
      const inside1 = ibb1.high <= ibb2.high && ibb1.low >= ibb2.low;
      const inside2 = ibb2.high <= ibb3.high && ibb2.low >= ibb3.low;
      if (inside1 && inside2) {
        const cmpHigh = Math.max(ibb3.high, ibb2.high, ibb1.high);
        const cmpLow  = Math.min(ibb3.low,  ibb2.low,  ibb1.low);
        const volOk   = last.volume > volAvg * 1.3;
        if (volOk && c > cmpHigh && c > e50) signals.push({ id: "INSIDE_BAR_BO_L", side: "long",  price: c });
        if (volOk && c < cmpLow  && c < e50) signals.push({ id: "INSIDE_BAR_BO_S", side: "short", price: c });
      }
    }
  }

  // Annotate all signals with signal-bar high/low for precise fixed-stop placement in engine
  for (const sig of signals) { sig.barHigh = last.high; sig.barLow = last.low; }

  return signals;
};

// Extended evaluator — structural strategies that work across the full US trading day.
// MARKET_STRUCT_S and DAY_BREAK_FAIL_S fire primarily during midday (15:00-18:30 UTC)
// which the strict AM/PM session windows miss. Covers 13:30-20:00 UTC (full US day).
// Call alongside evaluate() and merge results. Engine must apply pausedStrategies to combined list.
export const evaluateExtended = (bars) => {
  if (bars.length < 210) return [];
  const last = bars[bars.length - 1];
  const d = new Date(last.time * 1000);
  const hm = d.getUTCHours() * 100 + d.getUTCMinutes();
  if (hm < 1330 || hm >= 2000) return [];   // full US trading day only

  const signals = [];
  const closes = bars.map(b => b.close);
  const e200 = ema(closes, 200);
  if (!e200) return [];
  const c = last.close;
  const adx14v = adx(bars.slice(-150), 14);
  const trendingMarket = adx14v > 20;

  // ─── 25. MARKET_STRUCT_S — Sustained lower-highs + swing low break ───
  // Established downtrend (≥20 of 29 bars making lower highs) + break below swing low.
  // Extended session standalone 2022-2026: 59%WR · $85/tr · $10,270/yr (all 5yr positive).
  {
    const recent30 = bars.slice(-30);
    let lhCount30 = 0;
    for (let k = 1; k < recent30.length; k++) {
      if (recent30[k].high < recent30[k - 1].high) lhCount30++;
    }
    if (lhCount30 >= 20 && c < e200 && trendingMarket && c < last.open) {
      let msSwingLow = Infinity;
      for (let k = recent30.length - 4; k >= recent30.length - 20; k--) {
        if (recent30[k] && recent30[k - 1] && recent30[k + 1] &&
            recent30[k].low < recent30[k - 1].low && recent30[k].low < recent30[k + 1].low) {
          msSwingLow = Math.min(msSwingLow, recent30[k].low);
        }
      }
      if (msSwingLow !== Infinity && c < msSwingLow) {
        signals.push({ id: "MARKET_STRUCT_S", side: "short", price: c });
      }
    }
  }

  // ─── 27. EXHAUST_CONT_S — 5-of-6 lower closes + shrinking ranges + new low ───
  // Downtrend with 5 of last 6 bars making lower closes AND bar sizes shrinking (momentum fading).
  // Current bar makes new recent low anyway = brief exhaustion pause resumes.
  // Trapped shorts who covered the pause get re-trapped on the continuation.
  // Portfolio 2022-2026: 54%WR · $224/tr · +$8,100/yr marginal. Best new signal found.
  {
    const win7 = bars.slice(-7);
    let lowerCloses = 0;
    for (let k = 1; k < win7.length; k++) {
      if (win7[k].close < win7[k - 1].close) lowerCloses++;
    }
    if (lowerCloses >= 5 && c < last.open && trendingMarket && c < e200) {
      const rangeRecent = bars.slice(-4, -1).reduce((s, b) => s + (b.high - b.low), 0) / 3;
      const rangePrior  = bars.slice(-7, -4).reduce((s, b) => s + (b.high - b.low), 0) / 3;
      if (rangeRecent < rangePrior) {
        const recentLow = Math.min(...bars.slice(-7, -1).map(b => b.low));
        if (c < recentLow) {
          signals.push({ id: "EXHAUST_CONT_S", side: "short", price: c });
        }
      }
    }
  }

  // ─── 28. PIVOT_R1_S — Floor pivot R1 rejection ───
  // Classic floor trader pivot: R1 = 2×PP - Prior_Low. Price tags R1 from below
  // but closes back under it in a downtrend = distribution at institutional resistance.
  // Portfolio 2018-2026: 38%WR · $128/tr · +$4,322/yr marginal (361 uncontested trades).
  {
    const pvDate = new Date(last.time * 1000).toISOString().slice(0, 10);
    let pvPdH = -Infinity, pvPdL = Infinity, pvPdC = null, pvPday = null;
    for (let k = bars.length - 2; k >= 0; k--) {
      const dd = new Date(bars[k].time * 1000).toISOString().slice(0, 10);
      if (dd === pvDate) continue;
      if (!pvPday) { pvPday = dd; pvPdC = bars[k].close; }
      if (dd !== pvPday) break;
      if (bars[k].high > pvPdH) pvPdH = bars[k].high;
      if (bars[k].low  < pvPdL) pvPdL = bars[k].low;
    }
    if (pvPday && pvPdC !== null && pvPdH > -Infinity) {
      const pvPP = (pvPdH + pvPdL + pvPdC) / 3;
      const pvR1 = 2 * pvPP - pvPdL;
      const R1_ZONE = 3 * 0.25; // within 3 ticks counts as tagged
      if (trendingMarket && c < e200 && c < last.open &&
          last.high >= pvR1 - R1_ZONE && c < pvR1 && c < bars[bars.length - 2].close) {
        signals.push({ id: "PIVOT_R1_S", side: "short", price: c });
      }
    }
  }

  // ─── 29. GAP_ACCEPTED_FADE_S — Gap-up acceptance then failure ───
  // ES opens 4+ ticks above prior close (gap up). Price accepts above prior close for 2+
  // bars (bulls appear in control), then crashes back below = trapped gap buyers exit.
  // Portfolio 2022-2026: 50%WR · $200/tr · +$4,540/yr marginal (clean, selective setup).
  {
    const gaDate = new Date(last.time * 1000).toISOString().slice(0, 10);
    let gaTodayOpen = null, gaPriorClose = null;
    let gaFirstIdx = bars.length - 1;
    for (let k = bars.length - 2; k >= 0; k--) {
      if (new Date(bars[k].time * 1000).toISOString().slice(0, 10) === gaDate) {
        gaFirstIdx = k;
      } else {
        gaPriorClose = bars[k].close;
        break;
      }
    }
    gaTodayOpen = bars[gaFirstIdx].open;
    if (gaTodayOpen && gaPriorClose) {
      const gaGapUp = gaTodayOpen - gaPriorClose;
      if (gaGapUp >= 1.0 && // 4+ ticks gap (1 ES point)
          trendingMarket && c < e200 && c < last.open &&
          bars[bars.length - 2].close > gaPriorClose &&
          bars[bars.length - 3].close > gaPriorClose && // 2+ bar acceptance above prior close
          c < gaPriorClose) {                            // now fails back below prior close
        signals.push({ id: "GAP_ACCEPTED_FADE_S", side: "short", price: c });
      }
    }
  }

  // ─── 26. DAY_BREAK_FAIL_S — Failed prior-day-high breakout ───
  // Prior bar closed ABOVE prior day's high (bullish breakout), current bar closes back
  // below PDH = trapped bulls squeezed out.
  // Extended session standalone 2022-2026: 63%WR · $108/tr · $2,975/yr (all 5yr positive).
  {
    const dbfDate = new Date(last.time * 1000).toISOString().slice(0, 10);
    let dbfPdhHigh = -Infinity, dbfPdhDate2 = null;
    for (let k = bars.length - 2; k >= 0; k--) {
      const d2 = new Date(bars[k].time * 1000).toISOString().slice(0, 10);
      if (d2 === dbfDate) continue;
      if (dbfPdhDate2 === null) dbfPdhDate2 = d2;
      if (d2 !== dbfPdhDate2) break;
      if (bars[k].high > dbfPdhHigh) dbfPdhHigh = bars[k].high;
    }
    const dbfPrev = bars[bars.length - 2];
    if (
      dbfPdhHigh > -Infinity &&
      dbfPrev.close > dbfPdhHigh &&
      c < dbfPdhHigh &&
      c < last.open &&
      c < e200 &&
      trendingMarket
    ) {
      signals.push({ id: "DAY_BREAK_FAIL_S", side: "short", price: c });
    }
  }

  for (const sig of signals) { sig.barHigh = last.high; sig.barLow = last.low; }
  return signals;
};

// Diagnostic — return all indicator values for a given bar set
export const debug = (bars) => {
  if (bars.length < 210) return { error: "not enough bars" };
  const closes = bars.map(b => b.close);
  return {
    bar: bars[bars.length - 1],
    inSession: inSession(bars[bars.length - 1].time),
    rsi14: rsi(closes, 14),
    rsi2: rsi(closes, 2),
    vwap: sessionVWAP(bars),
    ema13: ema(closes, 13),
    ema21: ema(closes, 21),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    atr20: atr(bars.slice(-30), 20),
    stoch: stoch(bars, 14),
    high20: highestHighPrev(bars, 20),
    low20: lowestLowPrev(bars, 20),
    volSMA20: volumeSMA(bars, 20),
  };
};
