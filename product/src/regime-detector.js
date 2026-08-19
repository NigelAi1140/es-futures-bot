/**
 * Regime Detector — classifies the current ES market regime as BULL, BEAR, or NEUTRAL.
 * Used by the weekly self-analysis to auto-flip the active strategy set.
 *
 * Regime is determined from daily ES bars (last 20 trading days):
 *   BULL  → price above EMA20, positive 10-day trend, more up-days than down
 *   BEAR  → price below EMA20, negative 10-day trend, more down-days
 *   NEUTRAL → mixed signals (trade structure-based strategies only)
 *
 * Strategy sets: each regime enables the strategies that are structurally
 * correct for that market condition. LIQ_SWEEP_S fires regardless of regime
 * (it trades a price-action pattern, not a trend direction).
 */

// ── Strategy sets per regime ──────────────────────────────────────────────────
// Only includes strategies that are in the engine's ACTIVE_STRATEGIES list.
// Strategies omitted from a set are disabled for that regime.
export const REGIME_SETS = {
  BULL: {
    // Uptrend: longs that need price > EMA200 will fire; shorts silenced by EMA200 gate.
    EMAPB_L:         true,
    RSI2_L:          true,
    DONCHIAN_BO_L:   true,   // breakout long — best in bull momentum
    BB_SQ_L:         true,   // squeeze breakout — 39.3% WR, 2.32:1 R:R
    VWAP_RECLAIM_L:  true,   // VWAP reclaim — 41.4% WR, +$5,188/4.5yr, consistent all regimes
    EMAPB_S:         false,  // needs price < EMA200 → silent in bull
    RSI2_S:          false,  // needs price < EMA200 → silent in bull
    "3BAR_BEAR_S":   false,  // needs price < EMA200 → silent in bull
  },
  BEAR: {
    // Downtrend: shorts fire; longs won't.
    EMAPB_S:         true,
    RSI2_S:          true,
    "3BAR_BEAR_S":   true,
    EMAPB_L:         false,  // needs price > EMA200 → rare in bear
    RSI2_L:          false,  // needs price > EMA200 → rare in bear
    DONCHIAN_BO_L:   false,  // breakout long in bear = buying into downtrend
    BB_SQ_L:         false,  // needs price > EMA200 → self-filters in bear; disable anyway
    VWAP_RECLAIM_L:  false,  // needs price > EMA200 → silent in bear
  },
  NEUTRAL: {
    // Choppy: enable both sides, skip DONCHIAN (whipsaw in chop).
    EMAPB_L:         true,
    RSI2_L:          true,
    RSI2_S:          true,
    EMAPB_S:         true,
    "3BAR_BEAR_S":   true,
    BB_SQ_L:         true,   // EMA200 gate self-selects direction; OK in NEUTRAL
    VWAP_RECLAIM_L:  true,   // EMA200 gate self-selects; works in NEUTRAL
    DONCHIAN_BO_L:   false,
  },
};

// Simple EMA computation
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let val = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < values.length; i++) val = values[i] * k + val * (1 - k);
  return val;
}

/**
 * Detect regime from an array of daily OHLCV bars (sorted ascending by time).
 * Returns { regime, score, bullPoints, bearPoints, reasons, strategies, summary }
 */
export function detectRegime(dailyBars) {
  if (!dailyBars || dailyBars.length < 15) {
    return {
      regime: "NEUTRAL",
      score: 0, bullPoints: 0, bearPoints: 0,
      reasons: ["insufficient data — need 15+ daily bars"],
      strategies: REGIME_SETS.NEUTRAL,
      summary: "Neutral (insufficient data)",
    };
  }

  const closes  = dailyBars.map(b => b.close);
  const current = closes[closes.length - 1];

  // Indicator 1: price vs daily EMA20 (≈ 1-min EMA4000 or 5-min EMA200 equivalent at daily level)
  const e20 = ema(closes, Math.min(20, closes.length));
  const e10 = ema(closes, Math.min(10, closes.length));

  // Indicator 2: 10-day price change %
  const tenDayClose = closes[Math.max(0, closes.length - 11)];
  const tenDayPct   = ((current - tenDayClose) / tenDayClose) * 100;

  // Indicator 3: up-day ratio in last 10 days
  const last10 = dailyBars.slice(-10);
  const upDays  = last10.filter(b => b.close > b.open).length;

  // Indicator 4: week-over-week: last 5 days vs prior 5 days
  const last5avg  = closes.slice(-5).reduce((s, v) => s + v, 0) / 5;
  const prior5avg = closes.slice(-10, -5).reduce((s, v) => s + v, 0) / 5;
  const weekTrend = last5avg > prior5avg;

  const reasons = [];
  let bull = 0, bear = 0;

  // Score each indicator
  if (e20 !== null) {
    if (current > e20) {
      bull++;
      reasons.push(`price $${current.toFixed(1)} above EMA20 ($${e20.toFixed(1)}) ↑`);
    } else {
      bear++;
      reasons.push(`price $${current.toFixed(1)} below EMA20 ($${e20.toFixed(1)}) ↓`);
    }
  }

  if (e10 !== null) {
    if (current > e10) { bull++; reasons.push(`above EMA10 ($${e10.toFixed(1)}) ↑`); }
    else               { bear++; reasons.push(`below EMA10 ($${e10.toFixed(1)}) ↓`); }
  }

  if (tenDayPct > 1.0)       { bull++; reasons.push(`+${tenDayPct.toFixed(1)}% over 10 days ↑`); }
  else if (tenDayPct < -1.0) { bear++; reasons.push(`${tenDayPct.toFixed(1)}% over 10 days ↓`); }
  else                        { reasons.push(`${tenDayPct.toFixed(1)}% over 10 days (flat)`); }

  if (upDays >= 7)      { bull++; reasons.push(`${upDays}/10 up-days (bullish breadth) ↑`); }
  else if (upDays <= 3) { bear++; reasons.push(`${upDays}/10 up-days (bearish breadth) ↓`); }
  else                   { reasons.push(`${upDays}/10 up-days (mixed)`); }

  if (weekTrend)  { bull++; reasons.push(`last 5 days avg > prior 5 days (weekly momentum up) ↑`); }
  else            { bear++; reasons.push(`last 5 days avg < prior 5 days (weekly momentum down) ↓`); }

  // Determine regime: need 4+ of 5 signals to call directional
  let regime;
  if (bull >= 4)      regime = "BULL";
  else if (bear >= 4) regime = "BEAR";
  else                regime = "NEUTRAL";

  const enabledCount  = Object.values(REGIME_SETS[regime]).filter(Boolean).length;
  const strategyNames = Object.entries(REGIME_SETS[regime])
    .filter(([, v]) => v).map(([k]) => k).join(", ");

  const summary =
    `${regime} (${bull} bull / ${bear} bear signals)\n` +
    `ES $${current.toFixed(1)} | EMA20 $${e20?.toFixed(1) ?? "—"} | 10-day ${tenDayPct >= 0 ? "+" : ""}${tenDayPct.toFixed(1)}%\n` +
    `Active strategies (${enabledCount}): ${strategyNames}`;

  return {
    regime,
    score: bull - bear,
    bullPoints: bull,
    bearPoints: bear,
    reasons,
    strategies:    REGIME_SETS[regime],
    summary,
    price:         current,
    ema20:         e20,
    tenDayPct,
    upDays,
  };
}

/**
 * Fetch ~30 daily ES bars from Yahoo Finance (no auth required).
 * Returns array of { time, open, high, low, close, volume } sorted ascending.
 */
export async function fetchDailyBars() {
  const url = "https://query2.finance.yahoo.com/v8/finance/chart/ES=F?interval=1d&range=2mo";
  const res  = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Yahoo Finance returned ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error("Unexpected Yahoo Finance response format");

  const ts     = result.timestamp ?? [];
  const quote  = result.indicators?.quote?.[0] ?? {};
  const opens  = quote.open   ?? [];
  const highs  = quote.high   ?? [];
  const lows   = quote.low    ?? [];
  const closes = quote.close  ?? [];
  const vols   = quote.volume ?? [];

  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (closes[i] == null) continue;
    bars.push({
      time:   ts[i],
      open:   opens[i]  ?? closes[i],
      high:   highs[i]  ?? closes[i],
      low:    lows[i]   ?? closes[i],
      close:  closes[i],
      volume: vols[i]   ?? 0,
    });
  }
  return bars.sort((a, b) => a.time - b.time);
}
