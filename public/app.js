'use strict';

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 0) =>
  n === undefined || n === null || Number.isNaN(n)
    ? '–'
    : Number(n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });

const el = {
  status: $('statusPill'),
  workload: $('workload'),
  total: $('total'),
  concurrency: $('concurrency'),
  concVal: $('concVal'),
  runBtn: $('runBtn'),
  resetBtn: $('resetBtn'),
  tp: $('tp'),
  p50: $('p50'), p95: $('p95'), p99: $('p99'), pmax: $('pmax'),
  progressBar: $('progressBar'),
  progressText: $('progressText'),
  runsBody: $('runsBody'),
  anonKey: $('anonKey'),
  chart: $('chart'),
};

let running = false;
const series = []; // {t: seconds, v: ops/sec}

// ---------------------------------------------------------------------------
// tiny canvas line chart (no dependencies)
// ---------------------------------------------------------------------------
function drawChart() {
  const c = el.chart;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = 260;
  if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const padL = 54, padR = 12, padT = 12, padB = 24;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const maxV = Math.max(100, ...series.map((p) => p.v)) * 1.15;
  const maxT = Math.max(1, series.length ? series[series.length - 1].t : 1);

  ctx.strokeStyle = '#232c3d';
  ctx.fillStyle = '#8b98ad';
  ctx.font = '11px ui-monospace, monospace';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (plotH * i) / 4;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    const val = maxV * (1 - i / 4);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(fmt(val >= 1000 ? val / 1000 : val, val >= 1000 ? 1 : 0) + (val >= 1000 ? 'k' : ''), padL - 8, y);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText('0s', padL, h - padB + 6);
  ctx.fillText(fmt(maxT, 1) + 's', w - padR, h - padB + 6);

  if (series.length < 2) return;
  const x = (t) => padL + (t / maxT) * plotW;
  const y = (v) => padT + (1 - v / maxV) * plotH;

  // area fill
  const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
  grad.addColorStop(0, 'rgba(61,220,151,0.28)');
  grad.addColorStop(1, 'rgba(61,220,151,0.02)');
  ctx.beginPath();
  ctx.moveTo(x(series[0].t), y(series[0].v));
  for (const p of series) ctx.lineTo(x(p.t), y(p.v));
  ctx.lineTo(x(series[series.length - 1].t), padT + plotH);
  ctx.lineTo(x(series[0].t), padT + plotH);
  ctx.closePath(); ctx.fillStyle = grad; ctx.fill();

  // line
  ctx.beginPath();
  ctx.moveTo(x(series[0].t), y(series[0].v));
  for (const p of series) ctx.lineTo(x(p.t), y(p.v));
  ctx.strokeStyle = '#3ddc97'; ctx.lineWidth = 2; ctx.stroke();
}
window.addEventListener('resize', drawChart);

// ---------------------------------------------------------------------------
// status polling
// ---------------------------------------------------------------------------
async function pollStatus() {
  try {
    const s = await fetch('/api/status').then((r) => r.json());
    if (el.workload.options.length === 0 && s.workloads) {
      for (const [k, label] of Object.entries(s.workloads)) {
        const o = document.createElement('option');
        o.value = k; o.textContent = label; el.workload.appendChild(o);
      }
    }
    if (s.anonKey) { el.anonKey.textContent = s.anonKey; el.anonKey.title = s.anonKey; }
    if (s.tbReady) {
      setStatus('ok', 'ready');
      el.runBtn.disabled = running;
      el.resetBtn.disabled = running;
      return;
    }
    setStatus('wait', 'booting tinbase…');
  } catch (_) {
    setStatus('err', 'unreachable');
  }
  setTimeout(pollStatus, 1500);
}
function setStatus(kind, text) {
  el.status.className = 'pill pill-' + kind;
  el.status.textContent = text;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
function run() {
  if (running) return;
  running = true;
  series.length = 0;
  el.runBtn.disabled = true; el.resetBtn.disabled = true;
  ['tp', 'p50', 'p95', 'p99', 'pmax'].forEach((k) => (el[k].textContent = '–'));
  el.progressBar.style.width = '0%';

  const workload = el.workload.value;
  const total = el.total.value;
  const concurrency = el.concurrency.value;
  const es = new EventSource(`/api/run?workload=${workload}&total=${total}&concurrency=${concurrency}`);

  es.addEventListener('start', (e) => {
    setStatus('run', 'running');
    el.progressText.textContent = `0 / ${fmt(JSON.parse(e.data).total)}`;
  });
  es.addEventListener('prepare', (e) => {
    const d = JSON.parse(e.data);
    el.progressText.textContent = d.total ? `${d.message} ${fmt(d.done)}/${fmt(d.total)}` : d.message;
    if (d.total) el.progressBar.style.width = ((d.done / d.total) * 100).toFixed(1) + '%';
  });
  es.addEventListener('progress', (e) => {
    const d = JSON.parse(e.data);
    el.tp.textContent = fmt(d.instThroughput);
    el.progressBar.style.width = ((d.done / d.total) * 100).toFixed(1) + '%';
    el.progressText.textContent = `${fmt(d.done)} / ${fmt(d.total)}`;
    series.push({ t: d.elapsedMs / 1000, v: d.instThroughput });
    drawChart();
  });
  es.addEventListener('done', (e) => {
    const d = JSON.parse(e.data);
    el.tp.textContent = fmt(d.throughput);
    el.p50.textContent = fmt(d.latency.p50, 2);
    el.p95.textContent = fmt(d.latency.p95, 2);
    el.p99.textContent = fmt(d.latency.p99, 2);
    el.pmax.textContent = fmt(d.latency.max, 2);
    el.progressBar.style.width = '100%';
    el.progressText.textContent = `done in ${fmt(d.durationMs / 1000, 2)}s${d.errors ? ` · ${d.errors} errors` : ''}`;
    addRun(d);
    finish(es);
  });
  es.addEventListener('error', (e) => {
    try { el.progressText.textContent = 'error: ' + JSON.parse(e.data).message; } catch (_) {}
    finish(es);
  });
  es.onerror = () => finish(es); // stream closed
}

function finish(es) {
  es.close();
  running = false;
  el.runBtn.disabled = false; el.resetBtn.disabled = false;
  setStatus('ok', 'ready');
}

function addRun(d) {
  const empty = el.runsBody.querySelector('.empty');
  if (empty) empty.remove();
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${d.workloadLabel.split(' (')[0]}</td>
    <td>${fmt(d.count)}</td><td>${d.concurrency}</td>
    <td class="hl">${fmt(d.throughput)}</td>
    <td>${fmt(d.latency.p50, 2)}</td><td>${fmt(d.latency.p99, 2)}</td>`;
  el.runsBody.prepend(tr);
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------
el.concurrency.addEventListener('input', () => (el.concVal.textContent = el.concurrency.value));
el.runBtn.addEventListener('click', run);
el.resetBtn.addEventListener('click', async () => {
  el.resetBtn.disabled = true;
  await fetch('/api/reset', { method: 'POST' }).catch(() => {});
  el.progressText.textContent = 'table reset';
  el.resetBtn.disabled = false;
});
document.querySelectorAll('.copy').forEach((n) =>
  n.addEventListener('click', () => {
    navigator.clipboard?.writeText(n.title || n.textContent).catch(() => {});
    const prev = n.textContent; n.textContent = 'copied!';
    setTimeout(() => (n.textContent = prev), 900);
  })
);

drawChart();
pollStatus();
