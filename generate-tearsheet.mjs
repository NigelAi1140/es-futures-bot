/**
 * Daily tearsheet generator — reads logs/trades.jsonl → tearsheet.html
 * Groups by account (balance_after tracks per-account) and date.
 */
import { readFileSync, writeFileSync } from "fs";

const raw = readFileSync("./logs/trades.jsonl","utf8").trim().split("\n")
  .filter(l=>l.trim()).map(l=>JSON.parse(l));

// Filter out voided trades
const trades = raw.filter(t => !t.voided);

// Build daily P&L curve — sum gross_pnl per date across all trades
// (Multiple accounts record separately so divide by ~N accounts per day to avoid double-count)
// Better approach: use balance_after from the funded account only (peak_balance > 50000 → funded)
// Actually let's just show raw cumulative pnl across all recorded trades and note it's multi-account

const byDate = {};
for (const t of trades) {
  if (!byDate[t.date]) byDate[t.date] = { pnl: 0, n: 0, wins: 0, losses: 0 };
  byDate[t.date].pnl += t.gross_pnl;
  byDate[t.date].n++;
  if (t.gross_pnl > 0) byDate[t.date].wins++;
  else if (t.gross_pnl < 0) byDate[t.date].losses++;
}

const dates = Object.keys(byDate).sort();
let cumPnl = 0;
const equityCurve = dates.map(d => {
  cumPnl += byDate[d].pnl;
  return { date: d, pnl: byDate[d].pnl, cumPnl, n: byDate[d].n, wins: byDate[d].wins };
});

// Overall stats
const totalPnl = trades.reduce((s,t) => s + t.gross_pnl, 0);
const wins = trades.filter(t => t.gross_pnl > 0);
const losses = trades.filter(t => t.gross_pnl < 0);
const wr = trades.length ? (wins.length / trades.length * 100).toFixed(1) : 0;
const avgWin = wins.length ? wins.reduce((s,t) => s + t.gross_pnl, 0) / wins.length : 0;
const avgLoss = losses.length ? losses.reduce((s,t) => s + t.gross_pnl, 0) / losses.length : 0;
const profitFactor = losses.length && Math.abs(avgLoss * losses.length) > 0
  ? (wins.reduce((s,t) => s+t.gross_pnl, 0) / Math.abs(losses.reduce((s,t) => s+t.gross_pnl, 0))).toFixed(2)
  : "∞";

// Daily returns for Sharpe (using gross_pnl per day, denominator = funded acct ~50K)
const dailyPnls = dates.map(d => byDate[d].pnl);
const meanDaily = dailyPnls.reduce((s,x) => s+x, 0) / dailyPnls.length;
const stdDaily = Math.sqrt(dailyPnls.reduce((s,x) => s+(x-meanDaily)**2, 0) / dailyPnls.length);
const sharpe = stdDaily > 0 ? ((meanDaily / stdDaily) * Math.sqrt(252)).toFixed(2) : "N/A";

// Max drawdown on cumulative curve
let peak = -Infinity, maxDD = 0;
for (const pt of equityCurve) {
  if (pt.cumPnl > peak) peak = pt.cumPnl;
  const dd = peak - pt.cumPnl;
  if (dd > maxDD) maxDD = dd;
}

// Signal breakdown — only trades that have named signals
const signalTrades = trades.filter(t => t.signal && t.signal !== "RECOVERED");
const bySig = {};
for (const t of signalTrades) {
  if (!bySig[t.signal]) bySig[t.signal] = {pnl:0,n:0,wins:0};
  bySig[t.signal].pnl += t.gross_pnl;
  bySig[t.signal].n++;
  if (t.gross_pnl > 0) bySig[t.signal].wins++;
}

const sigRows = Object.entries(bySig)
  .sort((a,b) => b[1].pnl - a[1].pnl)
  .map(([id,d]) => `<tr>
    <td>${id}</td>
    <td>${d.n}</td>
    <td>${d.n ? (d.wins/d.n*100).toFixed(0)+"%" : "—"}</td>
    <td class="${d.pnl>=0?"pos":"neg"}">${d.pnl>=0?"$":"-$"}${Math.abs(d.pnl).toLocaleString()}</td>
    <td class="${d.pnl/d.n>=0?"pos":"neg"}">${d.pnl/d.n>=0?"$":"-$"}${Math.abs(d.pnl/d.n).toFixed(0)}</td>
  </tr>`).join("\n");

const dateLabels = equityCurve.map(p => `"${p.date}"`).join(",");
const cumData = equityCurve.map(p => p.cumPnl.toFixed(0)).join(",");
const dailyData = equityCurve.map(p => p.pnl.toFixed(0)).join(",");
const dailyColors = equityCurve.map(p => p.pnl >= 0 ? "'rgba(30,175,122,0.75)'" : "'rgba(227,73,72,0.75)'").join(",");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Trading Tearsheet — ES Futures Bot</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f0f0f; color: #e8e8e8; padding: 24px; }
  h1 { font-size: 22px; font-weight: 500; margin-bottom: 4px; }
  .sub { font-size: 13px; color: #888; margin-bottom: 24px; }
  .kpi-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px,1fr)); gap: 12px; margin-bottom: 28px; }
  .kpi { background: #1a1a1a; border: 0.5px solid #2e2e2e; border-radius: 10px; padding: 14px 16px; }
  .kpi-label { font-size: 11px; color: #666; margin-bottom: 6px; text-transform: uppercase; letter-spacing: .04em; }
  .kpi-value { font-size: 24px; font-weight: 500; font-variant-numeric: tabular-nums; }
  .pos { color: #1baf7a; }
  .neg { color: #e34948; }
  .neutral { color: #e8e8e8; }
  .section { font-size: 12px; font-weight: 500; color: #666; text-transform: uppercase; letter-spacing: .06em; margin: 28px 0 12px; }
  .chart-wrap { background: #1a1a1a; border: 0.5px solid #2e2e2e; border-radius: 10px; padding: 16px; margin-bottom: 16px; position: relative; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
  th { text-align: left; padding: 6px 10px; font-size: 11px; color: #666; font-weight: 500; border-bottom: 0.5px solid #2e2e2e; }
  td { padding: 7px 10px; border-bottom: 0.5px solid #1e1e1e; }
  tr:last-child td { border-bottom: none; }
  canvas { width: 100% !important; }
  .note { font-size: 11px; color: #555; margin-top: 8px; }
</style>
</head>
<body>
<h1>ES Futures Bot — Performance Tearsheet</h1>
<p class="sub">Generated ${new Date().toLocaleString("en-US",{timeZone:"America/Denver"})} MST &nbsp;·&nbsp; ${trades.length} trades across ${dates.length} trading days</p>

<div class="kpi-row">
  <div class="kpi">
    <div class="kpi-label">Total P&L</div>
    <div class="kpi-value ${totalPnl>=0?"pos":"neg"}">${totalPnl>=0?"$":"-$"}${Math.abs(totalPnl).toLocaleString()}</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Win Rate</div>
    <div class="kpi-value neutral">${wr}%</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Profit Factor</div>
    <div class="kpi-value ${parseFloat(profitFactor)>=1?"pos":"neg"}">${profitFactor}</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Sharpe (ann.)</div>
    <div class="kpi-value ${parseFloat(sharpe)>=0?"pos":"neg"}">${sharpe}</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Avg Win</div>
    <div class="kpi-value pos">$${avgWin.toFixed(0)}</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Avg Loss</div>
    <div class="kpi-value neg">-$${Math.abs(avgLoss).toFixed(0)}</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Max Drawdown</div>
    <div class="kpi-value neg">-$${Math.round(maxDD).toLocaleString()}</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Total Trades</div>
    <div class="kpi-value neutral">${trades.length}</div>
  </div>
</div>

<div class="section">Cumulative P&L</div>
<div class="chart-wrap" style="height:220px">
  <canvas id="equity"></canvas>
</div>

<div class="section">Daily P&L</div>
<div class="chart-wrap" style="height:180px">
  <canvas id="daily"></canvas>
</div>

${sigRows ? `<div class="section">Strategy Breakdown (named signals only)</div>
<div class="chart-wrap">
<table>
  <thead><tr><th>Signal</th><th>Trades</th><th>WR</th><th>Total P&L</th><th>Avg/trade</th></tr></thead>
  <tbody>${sigRows}</tbody>
</table>
</div>` : ""}

<div class="section">Recent Daily Summary</div>
<div class="chart-wrap">
<table>
  <thead><tr><th>Date</th><th>Trades</th><th>Wins</th><th>P&L</th><th>Cumulative</th></tr></thead>
  <tbody>
  ${equityCurve.slice(-20).reverse().map(p => `<tr>
    <td>${p.date}</td>
    <td>${p.n}</td>
    <td>${p.wins}/${p.n}</td>
    <td class="${p.pnl>=0?"pos":"neg"}">${p.pnl>=0?"$":"-$"}${Math.abs(p.pnl).toLocaleString()}</td>
    <td class="${p.cumPnl>=0?"pos":"neg"}">${p.cumPnl>=0?"$":"-$"}${Math.abs(Math.round(p.cumPnl)).toLocaleString()}</td>
  </tr>`).join("")}
  </tbody>
</table>
<p class="note">Note: All accounts combined. "RECOVERED" signal trades have no strategy name — signal capture was added 2026-07-30.</p>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
<script>
const labels = [${dateLabels}];
const cumData = [${cumData}];
const dailyData = [${dailyData}];
const dailyColors = [${dailyColors}];

Chart.defaults.color = '#666';
Chart.defaults.borderColor = '#2a2a2a';
Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

new Chart(document.getElementById('equity'), {
  type: 'line',
  data: {
    labels,
    datasets: [{
      data: cumData,
      borderColor: cumData[cumData.length-1] >= 0 ? '#1baf7a' : '#e34948',
      borderWidth: 2,
      pointRadius: 0,
      fill: true,
      backgroundColor: ctx => {
        const g = ctx.chart.ctx.createLinearGradient(0,0,0,200);
        g.addColorStop(0, cumData[cumData.length-1] >= 0 ? 'rgba(27,175,122,0.18)' : 'rgba(227,73,72,0.18)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        return g;
      },
      tension: 0.3,
    }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: {
      callbacks: { label: ctx => (ctx.raw >= 0 ? '$' : '-$') + Math.abs(ctx.raw).toLocaleString() }
    }},
    scales: {
      x: { ticks: { maxTicksLimit: 8, font: { size: 11 } }, grid: { color: '#1e1e1e' } },
      y: { ticks: { callback: v => (v>=0?'$':'-$')+Math.abs(v).toLocaleString(), font: { size: 11 } }, grid: { color: '#1e1e1e' } }
    }
  }
});

new Chart(document.getElementById('daily'), {
  type: 'bar',
  data: {
    labels,
    datasets: [{
      data: dailyData,
      backgroundColor: dailyColors,
      borderWidth: 0,
      borderRadius: 2,
    }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: {
      callbacks: { label: ctx => (ctx.raw >= 0 ? '+$' : '-$') + Math.abs(ctx.raw).toLocaleString() }
    }},
    scales: {
      x: { ticks: { maxTicksLimit: 8, font: { size: 11 } }, grid: { display: false } },
      y: { ticks: { callback: v => (v>=0?'$':'-$')+Math.abs(v).toLocaleString(), font: { size: 11 } }, grid: { color: '#1e1e1e' } }
    }
  }
});
</script>
</body>
</html>`;

writeFileSync("./tearsheet.html", html);
console.log("✅ tearsheet.html written");
console.log(`   ${trades.length} trades | ${dates.length} days | Total: $${totalPnl.toLocaleString()} | WR: ${wr}% | Sharpe: ${sharpe}`);
