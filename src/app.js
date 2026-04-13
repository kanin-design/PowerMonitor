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

/* ── Assertion filter ────────────────────────────────────────────────────────*/
const IGNORE_ASSERT = [
  'powerd', 'useractive', 'iohideventsystem', 'delaydisplayoff',
  'applehibtransport', 'com.apple.powermanagement',
];
function interestingAssertions(list) {
  return list.filter(a => !IGNORE_ASSERT.some(s => a.toLowerCase().includes(s)));
}

/* ── Canvas helpers ──────────────────────────────────────────────────────────*/
function initCanvas(id) {
  const canvas = document.getElementById(id);
  const wrap = canvas.closest('.chart-wrap') || canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth;
  const h = Math.max(wrap.clientHeight, 60);
  canvas.style.width  = w + 'px';
  canvas.style.height = h + 'px';
  canvas.width  = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return { canvas, ctx, w, h };
}

function round(n) { return Math.round(n); }

/* ── Shared axis style ───────────────────────────────────────────────────────*/
function drawGrid(ctx, w, h, pL, pR, pT, pB, rows = 4) {
  const ch = h - pT - pB;
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= rows; i++) {
    const y = pT + ch * (i / rows);
    ctx.beginPath(); ctx.moveTo(pL, y); ctx.lineTo(w - pR, y); ctx.stroke();
  }
}

function axisFont(ctx) {
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.font = '10px -apple-system,system-ui,sans-serif';
}

/* ── Chart: Battery ──────────────────────────────────────────────────────────*/
function drawBattery(entries) {
  const V = applyWindow(entries);
  if (V.length < 2) return;
  const { ctx, w, h } = initCanvas('batt-canvas');
  const pL = 36, pR = 12, pT = 10, pB = 20;
  ctx.clearRect(0, 0, w, h);

  const ch = h - pT - pB;
  const cw = w - pL - pR;

  drawGrid(ctx, w, h, pL, pR, pT, pB, 4);

  axisFont(ctx);
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = 100 * (1 - i / 4);
    ctx.fillText(round(v) + '%', pL - 6, pT + ch * (i / 4) + 3.5);
  }

  const t0 = +new Date(V[0].ts), t1 = +new Date(V[V.length - 1].ts);
  const span = t1 - t0 || 1;
  const xOf = e => pL + cw * ((+new Date(e.ts) - t0) / span);
  const yOf = v => pT + ch * (1 - v / 100);

  // Charging tint
  for (let i = 1; i < V.length; i++) {
    if (V[i].charging) {
      ctx.fillStyle = 'rgba(48, 209, 88, 0.04)';
      ctx.fillRect(xOf(V[i - 1]), pT, xOf(V[i]) - xOf(V[i - 1]), ch);
    }
  }

  const pts = V.map(e => [xOf(e), yOf(e.battery)]);

  // Area fill
  const g = ctx.createLinearGradient(0, pT, 0, pT + ch);
  g.addColorStop(0, 'rgba(48, 209, 88, 0.1)');
  g.addColorStop(1, 'rgba(48, 209, 88, 0)');
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pT + ch);
  pts.forEach(([x, y]) => ctx.lineTo(x, y));
  ctx.lineTo(pts[pts.length - 1][0], pT + ch);
  ctx.closePath();
  ctx.fillStyle = g; ctx.fill();

  // Line
  ctx.beginPath();
  pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  ctx.strokeStyle = '#30D158';
  ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();

  // Transition dots
  for (let i = 1; i < V.length; i++) {
    if (V[i].charging !== V[i - 1].charging) {
      ctx.beginPath();
      ctx.arc(xOf(V[i]), yOf(V[i].battery), 3, 0, Math.PI * 2);
      ctx.fillStyle = V[i].charging ? '#30D158' : '#f85149';
      ctx.fill();
    }
  }

  // End dot
  const l = V[V.length - 1];
  ctx.beginPath();
  ctx.arc(xOf(l), yOf(l.battery), 3.5, 0, Math.PI * 2);
  ctx.fillStyle = '#30D158'; ctx.fill();

  // X labels
  axisFont(ctx);
  ctx.textAlign = 'center';
  V.filter((_, i) => i % Math.ceil(V.length / 6) === 0 || i === V.length - 1)
    .forEach(e => ctx.fillText(
      new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      xOf(e), h - 3
    ));

  // Inline stats
  const vals = V.map(e => e.battery);
  document.getElementById('batt-high').textContent = Math.max(...vals) + '%';
  document.getElementById('batt-low').textContent  = Math.min(...vals) + '%';

  document.getElementById('charging-indicator').textContent = l.charging ? '⚡ charging' : '';
  document.getElementById('batt-empty').classList.add('hidden');

  const fmt = d => new Date(d.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  document.getElementById('batt-range').textContent = `${fmt(V[0])} – ${fmt(V[V.length - 1])}`;
}

/* ── Chart: Power Draw ───────────────────────────────────────────────────────*/
function drawWatts(entries) {
  const V = applyWindow(entries);
  if (V.length < 2) return;

  const withW = V.filter(e => e.amperage != null && e.voltage != null);
  if (!withW.length) { document.getElementById('watts-empty').classList.remove('hidden'); return; }
  document.getElementById('watts-empty').classList.add('hidden');

  const WE = withW.map(e => ({ ...e, watts: (e.amperage * e.voltage) / 1e6 }));

  const { ctx, w, h } = initCanvas('watts-canvas');
  const pL = 36, pR = 12, pT = 10, pB = 20;
  ctx.clearRect(0, 0, w, h);

  const allW = WE.map(e => e.watts);
  const yTop = Math.max(...allW, 0) + 2;
  const yBot = Math.min(...allW, 0) - 2;
  const yRange = yTop - yBot || 1;
  const ch = h - pT - pB, cw = w - pL - pR;

  const t0 = +new Date(WE[0].ts), t1 = +new Date(WE[WE.length - 1].ts);
  const span = t1 - t0 || 1;
  const xOf = e  => pL + cw * ((+new Date(e.ts) - t0) / span);
  const yOf = v  => pT + ch * (1 - (v - yBot) / yRange);
  const yZero    = yOf(0);

  drawGrid(ctx, w, h, pL, pR, pT, pB, 4);

  // Zero line
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  ctx.beginPath(); ctx.moveTo(pL, yZero); ctx.lineTo(w - pR, yZero); ctx.stroke();
  ctx.setLineDash([]);

  axisFont(ctx);
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = yTop * (1 - i / 4) + yBot * (i / 4);
    ctx.fillText(round(v) + 'W', pL - 6, pT + ch * (i / 4) + 3.5);
  }

  ctx.textAlign = 'center';
  const step = Math.ceil(WE.length / 6);
  const labeled = new Set();
  for (let i = 0; i < WE.length; i += step) {
    ctx.fillText(new Date(WE[i].ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), xOf(WE[i]), h - 3);
    labeled.add(i);
  }
  const li = WE.length - 1;
  if (!labeled.has(li))
    ctx.fillText(new Date(WE[li].ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), xOf(WE[li]), h - 3);

  // Area fills
  for (let i = 1; i < WE.length; i++) {
    const p = WE[i - 1], c = WE[i];
    ctx.beginPath();
    ctx.moveTo(xOf(p), yOf(p.watts)); ctx.lineTo(xOf(c), yOf(c.watts));
    ctx.lineTo(xOf(c), yZero); ctx.lineTo(xOf(p), yZero);
    ctx.closePath();
    ctx.fillStyle = (p.watts + c.watts) / 2 >= 0
      ? 'rgba(48, 209, 88, 0.08)'
      : 'rgba(255, 159, 10, 0.08)';
    ctx.fill();
  }

  // Line
  ctx.beginPath();
  WE.forEach((e, i) => i ? ctx.lineTo(xOf(e), yOf(e.watts)) : ctx.moveTo(xOf(e), yOf(e.watts)));
  ctx.strokeStyle = '#4da3ff';
  ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();

  // Inline stats
  const absW = allW.map(Math.abs);
  const avg  = allW.reduce((a, b) => a + b, 0) / allW.length;
  document.getElementById('watts-avg').textContent  = Math.abs(avg).toFixed(1) + 'W';
  document.getElementById('watts-peak').textContent = Math.max(...absW).toFixed(1) + 'W';

  const fmt = e => new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  document.getElementById('watts-range').textContent = `${fmt(WE[0])} – ${fmt(WE[WE.length - 1])}`;
}

/* ── Chart: CPU ──────────────────────────────────────────────────────────────*/
function drawCpu(entries) {
  const V = applyWindow(entries);
  if (V.length < 2) return;
  const { ctx, w, h } = initCanvas('cpu-canvas');
  const pL = 36, pR = 12, pT = 10, pB = 20;
  ctx.clearRect(0, 0, w, h);

  const tot = {};
  let mx = 10;
  V.forEach(e => Object.entries(e.cpus).forEach(([k, v]) => {
    tot[k] = (tot[k] || 0) + v;
    mx = Math.max(mx, v);
  }));
  const procs = Object.keys(tot).sort((a, b) => tot[b] - tot[a]).slice(0, 9);
  if (!procs.length) return;

  const yMax = Math.ceil(mx / 10) * 10 || 10;
  const ch = h - pT - pB, cw = w - pL - pR;

  drawGrid(ctx, w, h, pL, pR, pT, pB, 4);

  axisFont(ctx);
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++)
    ctx.fillText(round(yMax * (1 - i / 4)) + '%', pL - 6, pT + ch * (i / 4) + 3.5);

  const t0 = +new Date(V[0].ts), t1 = +new Date(V[V.length - 1].ts);
  const span = t1 - t0 || 1;
  const xOf = e => pL + cw * ((+new Date(e.ts) - t0) / span);
  const yOf = v => pT + ch * (1 - v / yMax);

  for (const proc of [...procs].reverse()) {
    const c = procColor(proc);
    const rgb = hexRgb(c);
    const pts = V.map(e => [xOf(e), yOf(e.cpus[proc] || 0)]);

    ctx.beginPath();
    ctx.moveTo(pts[0][0], pT + ch);
    pts.forEach(([x, y]) => ctx.lineTo(x, y));
    ctx.lineTo(pts[pts.length - 1][0], pT + ch);
    ctx.closePath();
    ctx.fillStyle = `rgba(${rgb},0.07)`; ctx.fill();

    ctx.beginPath();
    pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();
  }

  // End dots
  const l = V[V.length - 1];
  procs.forEach(proc => {
    const v = l.cpus[proc];
    if (!v) return;
    ctx.beginPath();
    ctx.arc(xOf(l), yOf(v), 3, 0, Math.PI * 2);
    ctx.fillStyle = procColor(proc); ctx.fill();
  });

  // X labels
  axisFont(ctx);
  ctx.textAlign = 'center';
  V.filter((_, i) => i % Math.ceil(V.length / 6) === 0 || i === V.length - 1)
    .forEach(e => ctx.fillText(
      new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      xOf(e), h - 3
    ));

  document.getElementById('cpu-legend').innerHTML = procs.map(p =>
    `<div class="legend-item"><div class="legend-swatch" style="background:${procColor(p)}"></div>${p}</div>`
  ).join('');

  const fmt = e => new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  document.getElementById('cpu-range').textContent = `${fmt(V[0])} – ${fmt(V[V.length - 1])}`;
  document.getElementById('cpu-empty').classList.add('hidden');
}

function hexRgb(hex) {
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)].join(',');
}

/* ── Window filter ───────────────────────────────────────────────────────────*/
function applyWindow(entries) {
  if (!state.windowMs || !entries.length) return entries;
  const cutoff = +new Date(entries[entries.length - 1].ts) - state.windowMs;
  return entries.filter(e => +new Date(e.ts) >= cutoff);
}

/* ── Sidebar ─────────────────────────────────────────────────────────────────*/
function renderSidebar() {
  const entries = state.allEntries;
  if (!entries.length) return;
  const l = entries[entries.length - 1];

  // Battery hero
  const hex = l.battery > 50 ? '#30D158' : l.battery > 20 ? '#FF9F0A' : '#FF453A';
  document.getElementById('sb-batt-num').textContent = l.battery;
  document.getElementById('sb-batt-num').style.color = hex;
  document.querySelector('.sb-pct-sym').style.color   = hex;
  document.getElementById('sb-batt-fill').style.width           = l.battery + '%';
  document.getElementById('sb-batt-fill').style.backgroundColor = hex;

  // Status
  const isCharging = l.amperage != null && l.amperage > 0;
  const stateEl = document.getElementById('sb-state');
  stateEl.textContent = isCharging ? '⚡ Charging' : 'On Battery';
  stateEl.style.color = isCharging ? 'var(--green)' : 'var(--muted)';

  // Remaining
  const tl = document.getElementById('sb-timeleft');
  if (l.timeLeft) {
    const [hh, mm] = l.timeLeft.split(':').map(Number);
    tl.textContent  = hh > 0 ? `${hh}h ${mm}m` : `${mm}m`;
    tl.style.color  = isCharging ? 'var(--green)'
      : hh < 1 ? 'var(--red)' : hh < 3 ? 'var(--orange)' : 'var(--text)';
  } else {
    tl.textContent = '—';
    tl.style.color = 'var(--muted)';
  }

  // Watts
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
  const fmt = d => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dt  = new Date(entries[entries.length - 1].ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
  document.getElementById('main-sub').textContent =
    `· ${dt} · ${fmt(entries[0].ts)} – ${fmt(entries[entries.length - 1].ts)}`;
}

function renderProcessList(cpus) {
  const sorted = Object.entries(cpus).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maxCpu = sorted.length ? sorted[0][1] : 1;

  if (!sorted.length) {
    document.getElementById('proc-list').innerHTML =
      '<div style="font-size:10px;color:var(--muted);padding:8px 0">Idle</div>';
    return;
  }

  document.getElementById('proc-list').innerHTML = sorted.map(([name, cpu]) => {
    const c    = procColor(name);
    const barW = maxCpu > 0 ? round((cpu / maxCpu) * 100) : 0;
    return `<div class="proc-item">
      <div class="proc-row">
        <span class="proc-name" style="color:${c}">${name}</span>
        <span class="proc-pct">${cpu.toFixed(1)}%</span>
      </div>
      <div class="proc-bar-wrap"><div class="proc-bar" style="width:${barW}%;background:${c}"></div></div>
    </div>`;
  }).join('');
}

function renderAssertions(assertions) {
  const filtered = interestingAssertions(assertions);
  const wrapper  = document.getElementById('sb-asserts');
  const list     = document.getElementById('assert-list');

  if (!filtered.length) { wrapper.style.display = 'none'; list.innerHTML = ''; return; }

  wrapper.style.display = 'block';
  list.innerHTML = filtered.map(a => {
    const m = a.match(/^(.*?)\s*→\s*(.*)/);
    return m
      ? `<div class="assert-pill">${m[1].trim()} → ${m[2].trim()}</div>`
      : `<div class="assert-pill">${a}</div>`;
  }).join('');
}

/* ── Render ──────────────────────────────────────────────────────────────────*/
function render() {
  const E = state.allEntries;
  renderSidebar();
  drawBattery(E);
  drawWatts(E);
  drawCpu(E);
  document.getElementById('last-update').textContent =
    'Last logged ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/* ── Data listener ───────────────────────────────────────────────────────────*/
if (window.api && window.api.onLogUpdate) {
  window.api.onLogUpdate((data) => {
    state.allEntries = data.entries || data;
    if (data.sysInfo) {
      state.sysInfo = data.sysInfo;
      const titleEl = document.getElementById('main-title');
      titleEl.textContent = data.sysInfo.model;
      titleEl.title = `${data.sysInfo.cores} cores · ${data.sysInfo.memory}`;
      const chipEl = document.getElementById('main-chip');
      if (chipEl) chipEl.textContent = data.sysInfo.chip;
    }
    render();
  });
}

/* ── Range selector ──────────────────────────────────────────────────────────*/
document.getElementById('range-bar').addEventListener('click', e => {
  const btn = e.target.closest('.range-btn');
  if (!btn) return;
  document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.windowMs = parseInt(btn.dataset.min) * 60000;
  render();
});

/* ── Tooltip ─────────────────────────────────────────────────────────────────*/
function nearestEntry(mouseX, canvasWidth, V) {
  const pL = 36, pR = 12, cw = canvasWidth - pL - pR;
  if (!V.length || cw <= 0) return null;
  const t0 = +new Date(V[0].ts), span = +new Date(V[V.length - 1].ts) - t0;
  if (!span) return V[V.length - 1];
  const target = t0 + Math.max(0, Math.min(1, (mouseX - pL) / cw)) * span;
  return V.reduce((best, e) => Math.abs(+new Date(e.ts) - target) < Math.abs(+new Date(best.ts) - target) ? e : best);
}

function showTooltip(mx, my, entry) {
  if (!entry) return;
  const tt = document.getElementById('tooltip');
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
  if (entry.voltage != null)
    html += `<div class="tt-row"><span class="tt-name">Voltage</span><span class="tt-val">${(entry.voltage / 1000).toFixed(2)}V</span></div>`;

  if (entry.cpus && Object.keys(entry.cpus).length) {
    html += `<div class="tt-div"></div><div class="tt-label" style="margin-bottom:6px">Processes</div>`;
    Object.entries(entry.cpus).sort((a, b) => b[1] - a[1]).filter(([, v]) => v > 0.5).forEach(([name, cpu]) =>
      html += `<div class="tt-row"><span class="tt-name"><span class="tt-dot" style="background:${procColor(name)}"></span>${name}</span><span class="tt-val">${cpu.toFixed(1)}%</span></div>`
    );
  }

  document.getElementById('tt-body').innerHTML = html;
  const W = tt.offsetWidth || 200, H = tt.offsetHeight || 180;
  tt.style.left    = (mx + 16 + W > window.innerWidth  ? mx - W - 16 : mx + 16) + 'px';
  tt.style.top     = (my - 10 + H > window.innerHeight ? window.innerHeight - H - 10 : my - 10) + 'px';
  tt.style.display = 'block';
}

function hideTooltip() { document.getElementById('tooltip').style.display = 'none'; }

function setupHover() {
  ['batt-canvas', 'watts-canvas', 'cpu-canvas'].forEach(id => {
    const canvas = document.getElementById(id);
    canvas.style.cursor = 'crosshair';
    canvas.addEventListener('mousemove', e => {
      const V = applyWindow(state.allEntries);
      if (V.length < 2) return;
      const rect = canvas.getBoundingClientRect();
      showTooltip(e.clientX, e.clientY, nearestEntry(e.clientX - rect.left, rect.width, V));
    });
    canvas.addEventListener('mouseleave', hideTooltip);
  });
}

/* ── Resize ──────────────────────────────────────────────────────────────────*/
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 80); });

setupHover();
