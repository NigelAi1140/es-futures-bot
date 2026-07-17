// Indicators — pure-functional implementations matching Pine v9 exactly.
// All take a `bars` array (oldest → newest) where each bar = {time, open, high, low, close, volume}.

// Simple Moving Average
export const sma = (values, length) => {
  if (values.length < length) return null;
  let sum = 0;
  for (let i = values.length - length; i < values.length; i++) sum += values[i];
  return sum / length;
};

// Exponential Moving Average — seeded with SMA of first `length` values
export const ema = (values, length) => {
  if (values.length < length) return null;
  const k = 2 / (length + 1);
  let e = sma(values.slice(0, length), length);
  for (let i = length; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
};

// EMA series — returns array of same length as input (NaN for warmup)
export const emaSeries = (values, length) => {
  const out = new Array(values.length).fill(NaN);
  if (values.length < length) return out;
  const k = 2 / (length + 1);
  let e = sma(values.slice(0, length), length);
  out[length - 1] = e;
  for (let i = length; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
};

// Wilder's RSI — matches Pine's ta.rsi() exactly
export const rsi = (closes, length = 14) => {
  if (closes.length < length + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= length; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gains += ch; else losses -= ch;
  }
  let avgG = gains / length;
  let avgL = losses / length;
  for (let i = length + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch >= 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgG = (avgG * (length - 1) + g) / length;
    avgL = (avgL * (length - 1) + l) / length;
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
};

// VWAP — anchored to start of regular trading session each day.
// Resets when bar's date (UTC) changes to a new day.
// Uses (high + low + close) / 3 weighted by volume.
export const sessionVWAP = (bars) => {
  // Find start of current day in UTC
  if (!bars.length) return null;
  const lastDay = new Date(bars[bars.length - 1].time * 1000).toISOString().slice(0, 10);
  let cumPV = 0, cumV = 0;
  for (const b of bars) {
    const d = new Date(b.time * 1000).toISOString().slice(0, 10);
    if (d !== lastDay) continue;
    const tp = (b.high + b.low + b.close) / 3;
    cumPV += tp * b.volume;
    cumV += b.volume;
  }
  return cumV > 0 ? cumPV / cumV : null;
};

// ATR — Average True Range, Wilder's
export const atr = (bars, length = 14) => {
  if (bars.length < length + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  // Wilder's smoothing — start with simple average
  let a = trs.slice(0, length).reduce((s, x) => s + x, 0) / length;
  for (let i = length; i < trs.length; i++) {
    a = (a * (length - 1) + trs[i]) / length;
  }
  return a;
};

// Stochastic %K (raw) — 0-100
export const stoch = (bars, length = 14) => {
  if (bars.length < length) return null;
  const window = bars.slice(-length);
  let hi = -Infinity, lo = Infinity;
  for (const b of window) {
    if (b.high > hi) hi = b.high;
    if (b.low < lo) lo = b.low;
  }
  if (hi === lo) return 50;
  const c = window[window.length - 1].close;
  return ((c - lo) / (hi - lo)) * 100;
};

// Stochastic %K series for crossover detection
export const stochSeries = (bars, length = 14) => {
  const out = new Array(bars.length).fill(NaN);
  for (let i = length - 1; i < bars.length; i++) {
    const window = bars.slice(i - length + 1, i + 1);
    let hi = -Infinity, lo = Infinity;
    for (const b of window) {
      if (b.high > hi) hi = b.high;
      if (b.low < lo) lo = b.low;
    }
    if (hi === lo) { out[i] = 50; continue; }
    out[i] = ((window[window.length - 1].close - lo) / (hi - lo)) * 100;
  }
  return out;
};

// Heikin-Ashi candle for bar at index i, given prior HA values
// Returns {haOpen, haClose}
export const heikinAshiSeries = (bars) => {
  const out = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const haClose = (b.open + b.high + b.low + b.close) / 4;
    let haOpen;
    if (i === 0) haOpen = (b.open + b.close) / 2;
    else haOpen = (out[i - 1].haOpen + out[i - 1].haClose) / 2;
    out.push({ haOpen, haClose });
  }
  return out;
};

// Highest high / lowest low over last N bars (excluding current bar — like Pine's [1])
export const highestHighPrev = (bars, length) => {
  if (bars.length < length + 1) return null;
  const window = bars.slice(-length - 1, -1);
  return Math.max(...window.map(b => b.high));
};
export const lowestLowPrev = (bars, length) => {
  if (bars.length < length + 1) return null;
  const window = bars.slice(-length - 1, -1);
  return Math.min(...window.map(b => b.low));
};

// Volume SMA
export const volumeSMA = (bars, length) => {
  if (bars.length < length) return null;
  const window = bars.slice(-length);
  return window.reduce((s, b) => s + b.volume, 0) / length;
};

// ADX (Wilder smoothing, matches Pine ADX). Returns the current ADX value only.
// Requires at least length*3 bars for stable output. Use bars.slice(-150) like ATR.
export const adx = (bars, length = 14) => {
  if (bars.length < length * 2 + 1) return 0;
  let smoothTR = 0, smoothPDM = 0, smoothNDM = 0;
  for (let i = 1; i <= length; i++) {
    const tr  = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i-1].close), Math.abs(bars[i].low - bars[i-1].close));
    const pdm = Math.max(bars[i].high - bars[i-1].high, 0);
    const ndm = Math.max(bars[i-1].low - bars[i].low, 0);
    smoothTR  += tr;
    smoothPDM += pdm > ndm ? pdm : 0;
    smoothNDM += ndm > pdm ? ndm : 0;
  }
  let adxVal = 0;
  for (let i = length + 1; i < bars.length; i++) {
    const tr  = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i-1].close), Math.abs(bars[i].low - bars[i-1].close));
    const pdm = Math.max(bars[i].high - bars[i-1].high, 0);
    const ndm = Math.max(bars[i-1].low - bars[i].low, 0);
    smoothTR  = smoothTR  - smoothTR  / length + tr;
    smoothPDM = smoothPDM - smoothPDM / length + (pdm > ndm ? pdm : 0);
    smoothNDM = smoothNDM - smoothNDM / length + (ndm > pdm ? ndm : 0);
    const diP = smoothTR > 0 ? (smoothPDM / smoothTR) * 100 : 0;
    const diN = smoothTR > 0 ? (smoothNDM / smoothTR) * 100 : 0;
    const dx  = (diP + diN) > 0 ? Math.abs(diP - diN) / (diP + diN) * 100 : 0;
    adxVal = i === length + 1 ? dx : (adxVal * (length - 1) + dx) / length;
  }
  return adxVal;
};

// Bollinger Bands — returns { upper, mid, lower, width% } for the closes slice provided.
// width% = (upper - lower) / mid * 100 — used for squeeze detection (< 0.5 = squeeze).
export const bollingerBands = (closes, length = 20, mult = 2.0) => {
  if (closes.length < length) return null;
  const slice = closes.slice(-length);
  const mid = slice.reduce((s, x) => s + x, 0) / length;
  const variance = slice.reduce((s, x) => s + (x - mid) ** 2, 0) / length;
  const stddev = Math.sqrt(variance);
  const upper = mid + mult * stddev;
  const lower = mid - mult * stddev;
  return { upper, lower, mid, widthPct: mid > 0 ? (upper - lower) / mid * 100 : 0 };
};

// MACD histogram series — returns array of hist values aligned to the input closes array.
// Uses standard (12, 26, 9) defaults. NaN for warmup bars.
export const macdHistSeries = (closes, fast = 12, slow = 26, sig = 9) => {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length < slow + sig) return out;
  const fastE = emaSeries(closes, fast);
  const slowE = emaSeries(closes, slow);
  // macd line aligned to closes index
  const macdLine = closes.map((_, i) => {
    if (isNaN(fastE[i]) || isNaN(slowE[i])) return NaN;
    return fastE[i] - slowE[i];
  });
  // signal = EMA(sig) of macdLine — only compute where macdLine is valid
  const firstValid = macdLine.findIndex(v => !isNaN(v));
  if (firstValid < 0 || closes.length - firstValid < sig) return out;
  const macdValid = macdLine.slice(firstValid);
  const sigE = emaSeries(macdValid, sig);
  for (let i = 0; i < sigE.length; i++) {
    if (!isNaN(sigE[i])) out[firstValid + i] = macdValid[i] - sigE[i];
  }
  return out;
};
