'use strict';

/* ── State ─────────────────────────────────────────────────────────────────── */
const state = {
  allEntries: [],
  windowMs: 0,
  sysInfo: null,
};

/* ── Process color palette ─────────────────────────────────────────────────── */
const PAL = [
  '#f85149', '#a371f7', '#58a6ff', '#3ddc84',
  '#f5a623', '#64d2ff', '#ffd60a', '#ff6b35',
  '#5eeaae', '#ffe5b4', '#30d158', '#bf5af2',
];
const NAMED = {
  coreaudiod: '#f85149', WindowServer: '#a371f7', Claude: '#58a6ff',
  Spotify: '#3ddc84', 'Spotify Helper': '#3ddc84', Python: '#ffd60a',
  python3: '#ffd60a', opencode: '#f5a623', MTLCompilerService: '#ff6b35',
  'Zen Browser': '#30d158', zen: '#30d158', node: '#5eeaae',
  Safari: '#64d2ff', kernel_task: '#7d8590',
};
const cc = {};
let ci = 0;
function procColor(name) {
  if (NAMED[name]) return NAMED[name];
  if (!cc[name]) cc[name] = PAL[ci++ % PAL.length];
  return cc[name];
}

/* ── Filter helpers ──────────────────────────────────────────────────────────── */
const IGNORE_ASSERT = [
  'powerd', 'useractive', 'iohideventsystem', 'delaydisplayoff',
  'applehibtransport', 'com.apple.powermanagement',
];

function interestingAssertions(list) {
  return list.filter((a) => {
    const low = a.toLowerCase();
    return !IGNORE_ASSERT.some((s) => low.includes(s));
  });
}

/* ── Canvas helpers ─────────────────────────────────────────────────────────── */
function initCanvas(id) {
  const canvas = document.getElementById(id);
  const wrap = canvas.closest('.chart-wrap') || canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth;
  const h = Math.max(wrap.clientHeight, 80);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return { canvas, ctx, w, h };
}

function round(n) { return Math.round(n); }

/* ── Chart: Battery ──────────────────────────────────────────────────────────── */
function drawBattery(entries) {
  const V = applyWindow(entries);
  if (V.length < 2) return;
  const { ctx, w, h } = initCanvas('batt-canvas');
  const pL = 38, pR = 12, pT = 10, pB = 22;
  ctx.clearRect(0, 0, w, h);

  const ch = h - pT - pB;
  const cw = w - pL - pR;

  ctx.strokeStyle = '#222';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pT + ch * (i / 4);
    ctx.beginPath(); ctx.moveTo(pL, y); ctx.lineTo(w - pR, y); ctx.stroke();
  }
  ctx.fillStyle = '#555';
  ctx.font = '10px -apple-system,system-ui,sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = 100 * (1 - i / 4);
    const y = pT + ch * (i / 4);
    ctx.fillText(round(v) + '%', pL - 6, y + 3.5);
  }

  const t0 = new Date(V[0].ts), t1 = new Date(V[V.length - 1].ts);
  const span = t1 - t0;
  const xOf = (e) => pL + cw * ((new Date(e.ts) - t0) / span);
  const yOf = (v) => pT + ch * (1 - v / 100);

  for (let i = 1; i < V.length; i++) {
    if (V[i].charging) {
      ctx.fillStyle = 'rgba(48, 209, 88, 0.04)';
      ctx.fillRect(xOf(V[i - 1]), pT, xOf(V[i]) - xOf(V[i - 1]), ch);
    }
  }

  const pts = V.map((e) => [xOf(e), yOf(e.battery)]);
  const g = ctx.createLinearGradient(0, pT, 0, pT + ch);
  g.addColorStop(0, 'rgba(48, 209, 88, 0.15)');
  g.addColorStop(1, 'rgba(48, 209, 88, 0.01)');
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pT + ch);
  pts.forEach(([x, y]) => ctx.lineTo(x, y));
  ctx.lineTo(pts[pts.length - 1][0], pT + ch);
  ctx.closePath();
  ctx.fillStyle = g; ctx.fill();

  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.strokeStyle = '#30D158';
  ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();

  for (let i = 1; i < V.length; i++) {
    if (V[i].charging !== V[i - 1].charging) {
      ctx.beginPath();
      ctx.arc(xOf(V[i]), yOf(V[i].battery), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = V[i].charging ? '#30D158' : '#f85149';
      ctx.fill();
    }
  }

  const l = V[V.length - 1];
  ctx.beginPath();
  ctx.arc(xOf(l), yOf(l.battery), 4, 0, Math.PI * 2);
  ctx.fillStyle = '#30D158'; ctx.fill();

  ctx.fillStyle = '#555';
  ctx.textAlign = 'center';
  const labelTimes = V.filter((_, i) => i % Math.ceil(V.length / 6) === 0 || i === V.length - 1);
  labelTimes.forEach((e) => {
    const d = new Date(e.ts);
    ctx.fillText(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), xOf(e), h - 4);
  });

  document.getElementById('charging-indicator').textContent =
    l.charging ? '⚡ charging' : '';
  document.getElementById('batt-empty').classList.add('hidden');
  const fmt = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  document.getElementById('batt-range').textContent =
    `${fmt(new Date(V[0].ts))} – ${fmt(new Date(V[V.length - 1].ts))}`;
}

/* ── Chart: Power Draw ──────────────────────────────────────────────────────── */
function drawWatts(entries) {
  const V = applyWindow(entries);
  if (V.length < 2) return;

  const withWatts = V.filter((e) => e.amperage != null && e.voltage != null);
  if (!withWatts.length) {
    document.getElementById('watts-empty').classList.remove('hidden');
    return;
  }
  document.getElementById('watts-empty').classList.add('hidden');

  const wattsEntries = withWatts.map(e => ({ ...e, watts: (e.amperage * e.voltage) / 1e6 }));

  const { ctx, w, h } = initCanvas('watts-canvas');
  const pL = 38, pR = 12, pT = 10, pB = 22;
  ctx.clearRect(0, 0, w, h);

  const allWatts = wattsEntries.map(e => e.watts);
  const yTop = Math.max(...allWatts, 0) + 2;
  const yBot = Math.min(...allWatts, 0) - 2;
  const yRange = yTop - yBot || 1;

  const ch = h - pT - pB;
  const cw = w - pL - pR;

  const t0 = new Date(wattsEntries[0].ts);
  const t1 = new Date(wattsEntries[wattsEntries.length - 1].ts);
  const span = t1 - t0 || 1;
  const xOf = (e) => pL + cw * ((new Date(e.ts) - t0) / span);
  const yOf = (v) => pT + ch * (1 - (v - yBot) / yRange);
  const yZero = yOf(0);

  ctx.strokeStyle = '#222';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pT + ch * (i / 4);
    ctx.beginPath(); ctx.moveTo(pL, y); ctx.lineTo(w - pR, y); ctx.stroke();
  }

  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(pL, yZero); ctx.lineTo(w - pR, yZero); ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#555';
  ctx.font = '10px -apple-system,system-ui,sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = yTop * (1 - i / 4) + yBot * (i / 4);
    const y = pT + ch * (i / 4);
    ctx.fillText(round(v) + 'W', pL - 6, y + 3.5);
  }

  ctx.textAlign = 'center';
  const step = Math.ceil(wattsEntries.length / 6);
  const labeled = new Set();
  for (let i = 0; i < wattsEntries.length; i += step) {
    ctx.fillText(
      new Date(wattsEntries[i].ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      xOf(wattsEntries[i]), h - 4
    );
    labeled.add(i);
  }
  const lastIdx = wattsEntries.length - 1;
  if (!labeled.has(lastIdx)) {
    ctx.fillText(
      new Date(wattsEntries[lastIdx].ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      xOf(wattsEntries[lastIdx]), h - 4
    );
  }

  for (let i = 1; i < wattsEntries.length; i++) {
    const prev = wattsEntries[i - 1], curr = wattsEntries[i];
    const avgWatts = (prev.watts + curr.watts) / 2;
    ctx.beginPath();
    ctx.moveTo(xOf(prev), yOf(prev.watts));
    ctx.lineTo(xOf(curr), yOf(curr.watts));
    ctx.lineTo(xOf(curr), yZero);
    ctx.lineTo(xOf(prev), yZero);
    ctx.closePath();
    ctx.fillStyle = avgWatts >= 0 ? 'rgba(48, 209, 88, 0.1)' : 'rgba(255, 159, 10, 0.1)';
    ctx.fill();
  }

  ctx.beginPath();
  wattsEntries.forEach((e, i) => {
    i === 0 ? ctx.moveTo(xOf(e), yOf(e.watts)) : ctx.lineTo(xOf(e), yOf(e.watts));
  });
  ctx.strokeStyle = '#58a6ff';
  ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();

  const fmt = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  document.getElementById('watts-range').textContent =
    `${fmt(new Date(wattsEntries[0].ts))} – ${fmt(new Date(wattsEntries[wattsEntries.length - 1].ts))}`;
}

/* ── Chart: CPU by process ─────────────────────────────────────────────────── */
function drawCpu(entries) {
  const V = applyWindow(entries);
  if (V.length < 2) return;
  const { ctx, w, h } = initCanvas('cpu-canvas');
  const pL = 38, pR = 12, pT = 10, pB = 22;
  ctx.clearRect(0, 0, w, h);

  const tot = {};
  let mx = 10;
  V.forEach((e) => {
    Object.entries(e.cpus).forEach(([k, v]) => {
      tot[k] = (tot[k] || 0) + v;
      mx = Math.max(mx, v);
    });
  });
  const procs = Object.keys(tot).sort((a, b) => tot[b] - tot[a]).slice(0, 9);
  if (!procs.length) return;
  const yMax = Math.ceil(mx / 10) * 10 || 10;
  const ch = h - pT - pB;
  const cw = w - pL - pR;

  ctx.strokeStyle = '#222';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pT + ch * (i / 4);
    ctx.beginPath(); ctx.moveTo(pL, y); ctx.lineTo(w - pR, y); ctx.stroke();
  }
  ctx.fillStyle = '#555';
  ctx.font = '10px -apple-system,system-ui,sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = yMax * (1 - i / 4);
    const y = pT + ch * (i / 4);
    ctx.fillText(round(v) + '%', pL - 6, y + 3.5);
  }

  const t0 = new Date(V[0].ts), t1 = new Date(V[V.length - 1].ts);
  const span = t1 - t0;
  const xOf = (e) => pL + cw * ((new Date(e.ts) - t0) / span);
  const yOf = (v) => pT + ch * (1 - v / yMax);

  for (const proc of [...procs].reverse()) {
    const c = procColor(proc);
    const rgb = hexRgb(c);
    const pts = V.map((e) => [xOf(e), yOf(e.cpus[proc] || 0)]);

    ctx.beginPath();
    ctx.moveTo(pts[0][0], pT + ch);
    pts.forEach(([x, y]) => ctx.lineTo(x, y));
    ctx.lineTo(pts[pts.length - 1][0], pT + ch);
    ctx.closePath();
    ctx.fillStyle = `rgba(${rgb},0.08)`; ctx.fill();

    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();
  }

  const l = V[V.length - 1];
  procs.forEach((proc) => {
    const v = l.cpus[proc];
    if (!v) return;
    ctx.beginPath();
    ctx.arc(xOf(l), yOf(v), 3, 0, Math.PI * 2);
    ctx.fillStyle = procColor(proc); ctx.fill();
  });

  document.getElementById('cpu-legend').innerHTML = procs.map(
    (p) => `<div class="legend-item"><div class="legend-swatch" style="background:${procColor(p)}"></div>${p}</div>`
  ).join('');

  const fmt = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  document.getElementById('cpu-range').textContent =
    `${fmt(new Date(V[0].ts))} – ${fmt(new Date(V[V.length - 1].ts))}`;
  document.getElementById('cpu-empty').classList.add('hidden');
}

function hexRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ].join(',');
}

/* ── Window filter ──────────────────────────────────────────────────────────── */
function applyWindow(entries) {
  if (!state.windowMs || !entries.length) return entries;
  const cutoff = new Date(entries[entries.length - 1].ts).getTime() - state.windowMs;
  return entries.filter((e) => new Date(e.ts).getTime() >= cutoff);
}

/* ── Sidebar render ─────────────────────────────────────────────────────────── */
function renderSidebar() {
  const entries = state.allEntries;
  if (!entries.length) return;
  const l = entries[entries.length - 1];

  // Battery percentage + bar
  const battColor = l.battery > 50 ? 'var(--green)' : l.battery > 20 ? 'var(--orange)' : 'var(--red)';
  const batt = document.getElementById('sb-batt');
  batt.textContent = l.battery + '%';
  batt.style.color = battColor;

  const fill = document.getElementById('sb-batt-fill');
  fill.style.width = l.battery + '%';
  fill.style.backgroundColor = battColor.replace('var(--green)', '#30D158')
    .replace('var(--orange)', '#FF9F0A').replace('var(--red)', '#FF453A');

  // Status
  const isCharging = l.amperage != null && l.amperage > 0;
  const stateEl = document.getElementById('sb-state');
  stateEl.textContent = isCharging ? '⚡ charging' : 'on battery';
  stateEl.style.color = isCharging ? 'var(--green)' : 'var(--muted)';

  // Time remaining chip
  const tl = document.getElementById('sb-timeleft');
  if (l.timeLeft) {
    const [hh, mm] = l.timeLeft.split(':').map(Number);
    tl.textContent = hh > 0 ? `${hh}h ${mm}m` : `${mm}m`;
    tl.style.color = isCharging ? 'var(--green)'
      : hh < 1 ? 'var(--red)' : hh < 3 ? 'var(--orange)' : 'var(--text)';
  } else {
    tl.textContent = isCharging ? '—' : '—';
    tl.style.color = 'var(--muted)';
  }

  // Watts chip
  const wv = document.getElementById('sb-watts');
  if (l.amperage != null && l.voltage != null) {
    const watts = (l.amperage * l.voltage) / 1e6;
    wv.textContent = Math.abs(watts).toFixed(1) + 'W';
    wv.style.color = watts >= 0 ? 'var(--green)' : 'var(--orange)';
  } else {
    wv.textContent = '—';
    wv.style.color = 'var(--muted)';
  }

  renderProcessList(l.cpus);
  renderAssertions(l.assertions);

  // Subtitle
  const fmt = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dt = new Date(entries[entries.length - 1].ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
  document.getElementById('main-sub').textContent =
    `· ${dt} · ${fmt(new Date(entries[0].ts))} – ${fmt(new Date(entries[entries.length - 1].ts))}`;
}

function renderProcessList(cpus) {
  const sorted = Object.entries(cpus).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maxCpu = sorted.length ? sorted[0][1] : 1;

  if (!sorted.length) {
    document.getElementById('proc-list').innerHTML =
      '<div style="font-size:var(--text-xs);color:var(--muted);padding:8px 0">idle</div>';
    return;
  }

  document.getElementById('proc-list').innerHTML = sorted.map(([name, cpu]) => {
    const c = procColor(name);
    const barW = maxCpu > 0 ? round((cpu / maxCpu) * 100) : 0;
    return `<div class="proc-item">
      <div class="proc-name" style="color:${c}">${name}</div>
      <div class="proc-pct">${cpu.toFixed(1)}%</div>
      <div class="proc-bar-wrap"><div class="proc-bar" style="width:${barW}%;background:${c}"></div></div>
    </div>`;
  }).join('');
}

function renderAssertions(assertions) {
  const filtered = interestingAssertions(assertions);
  const wrapper = document.getElementById('sb-asserts');
  const list = document.getElementById('assert-list');

  if (!filtered.length) {
    wrapper.style.display = 'none';
    list.innerHTML = '';
    return;
  }

  wrapper.style.display = 'block';
  list.innerHTML = filtered.map((a) => {
    const m = a.match(/^(.*?)\s*→\s*(.*)/);
    return m
      ? `<div class="assert-pill">${m[1].trim()} → ${m[2].trim()}</div>`
      : `<div class="assert-pill">${a}</div>`;
  }).join('');
}

/* ── Render pipeline ─────────────────────────────────────────────────────────── */
function render() {
  const E = state.allEntries;
  renderSidebar();
  drawBattery(E);
  drawWatts(E);
  drawCpu(E);
  document.getElementById('last-update').textContent =
    'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/* ── Data listener ──────────────────────────────────────────────────────────── */
if (window.api && window.api.onLogUpdate) {
  window.api.onLogUpdate((data) => {
    state.allEntries = data.entries || data;
    if (data.sysInfo) {
      state.sysInfo = data.sysInfo;
      const titleEl = document.getElementById('main-title');
      titleEl.textContent = data.sysInfo.model;
      titleEl.title = `${data.sysInfo.cores} cores, ${data.sysInfo.memory} RAM`;
    }
    render();
  });
}

/* ── Range selector ─────────────────────────────────────────────────────────── */
document.getElementById('range-bar').addEventListener('click', (e) => {
  const btn = e.target.closest('.range-btn');
  if (!btn) return;
  document.querySelectorAll('.range-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  state.windowMs = parseInt(btn.dataset.min) * 60000;
  render();
});

/* ── Tooltip ──────────────────────────────────────────────────────────────── */
function nearestEntry(mouseX, canvasWidth, V) {
  const pL = 38, pR = 12;
  const cw = canvasWidth - pL - pR;
  if (!V.length || cw <= 0) return null;
  const t0 = +new Date(V[0].ts);
  const span = +new Date(V[V.length - 1].ts) - t0;
  if (!span) return V[V.length - 1];
  const ratio = Math.max(0, Math.min(1, (mouseX - pL) / cw));
  const target = t0 + ratio * span;
  return V.reduce((best, e) =>
    Math.abs(+new Date(e.ts) - target) < Math.abs(+new Date(best.ts) - target) ? e : best
  );
}

function showTooltip(mx, my, entry) {
  if (!entry) return;
  const tt = document.getElementById('tooltip');
  const body = document.getElementById('tt-body');
  const watts = entry.amperage != null && entry.voltage != null
    ? (entry.amperage * entry.voltage) / 1e6 : null;

  let html = `<div class="tt-time">${new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>`;
  html += `<div class="tt-row"><span class="tt-name">Battery</span><span class="tt-val">${entry.battery}%${entry.charging ? ' ⚡' : ''}</span></div>`;

  if (watts !== null) {
    const cls = watts >= 0 ? 'tt-charging' : 'tt-discharging';
    html += `<div class="tt-row"><span class="tt-name">Power</span><span class="tt-val ${cls}">${watts >= 0 ? '+' : ''}${watts.toFixed(2)}W</span></div>`;
  }
  if (entry.amperage != null) {
    const cls = entry.amperage > 0 ? 'tt-charging' : 'tt-discharging';
    html += `<div class="tt-row"><span class="tt-name">Amperage</span><span class="tt-val ${cls}">${entry.amperage > 0 ? '+' : ''}${entry.amperage}mA</span></div>`;
  }
  if (entry.voltage != null) {
    html += `<div class="tt-row"><span class="tt-name">Voltage</span><span class="tt-val">${(entry.voltage / 1000).toFixed(2)}V</span></div>`;
  }
  if (entry.cpus && Object.keys(entry.cpus).length) {
    html += `<div class="tt-div"></div><div class="tt-label" style="margin-bottom:6px">Processes</div>`;
    Object.entries(entry.cpus).sort((a, b) => b[1] - a[1]).filter(([, v]) => v > 0.5).forEach(([name, cpu]) => {
      html += `<div class="tt-row"><span class="tt-name"><span class="tt-dot" style="background:${procColor(name)}"></span>${name}</span><span class="tt-val">${cpu.toFixed(1)}%</span></div>`;
    });
  }

  body.innerHTML = html;
  const W = tt.offsetWidth || 200, H = tt.offsetHeight || 180;
  tt.style.left = (mx + 16 + W > window.innerWidth ? mx - W - 16 : mx + 16) + 'px';
  tt.style.top = (my - 10 + H > window.innerHeight ? window.innerHeight - H - 10 : my - 10) + 'px';
  tt.style.display = 'block';
}

function hideTooltip() { document.getElementById('tooltip').style.display = 'none'; }

function setupHover() {
  ['batt-canvas', 'watts-canvas', 'cpu-canvas'].forEach(id => {
    const canvas = document.getElementById(id);
    canvas.style.cursor = 'crosshair';
    canvas.addEventListener('mousemove', e => {
      const rect = canvas.getBoundingClientRect();
      const V = applyWindow(state.allEntries);
      if (V.length < 2) return;
      showTooltip(e.clientX, e.clientY, nearestEntry(e.clientX - rect.left, rect.width, V));
    });
    canvas.addEventListener('mouseleave', hideTooltip);
  });
}

/* ── Resize handler ─────────────────────────────────────────────────────────── */
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 80);
});

setupHover();
