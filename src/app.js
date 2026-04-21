'use strict';

/* ── State ─────────────────────────────────────────────────────────────────── */
const state = {
  allEntries: [],
  windowMs: 0,
  sysInfo: null,
  expandedChart: null,
};

/* ── Process color palette ─────────────────────────────────────────────────── */
const PROCESS_COLORS = [
  '#0A84FF', '#BF5AF2', '#32D74B', '#FF9F0A',
  '#5AC8FA', '#FFD60A', '#FF375F', '#A2845E',
  '#30D158', '#64D2FF',
];
const NAMED = {
  coreaudiod: '#FF375F', WindowServer: '#BF5AF2', Claude: '#0A84FF',
  Spotify: '#32D74B', 'Spotify Helper': '#32D74B', Python: '#FFD60A',
  python3: '#FFD60A', opencode: '#FF9F0A', MTLCompilerService: '#5AC8FA',
  'Zen Browser': '#30D158', zen: '#30D158', node: '#64D2FF',
  Safari: '#5AC8FA', kernel_task: '#A2845E',
};
const cc = {};
let ci = 0;
function procColor(name) {
  if (NAMED[name]) return NAMED[name];
  if (!cc[name]) cc[name] = PROCESS_COLORS[ci++ % PROCESS_COLORS.length];
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

/* ── Theme ───────────────────────────────────────────────────────────────────*/
(function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved) {
    document.documentElement.setAttribute('data-theme', saved);
  } else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();

document.getElementById('theme-toggle').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  render();
});

function getVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* ── Canvas helpers ──────────────────────────────────────────────────────────*/
function initCanvas(id) {
  const canvas = document.getElementById(id);
  const body = canvas.closest('.chart-body') || canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const w = body.clientWidth;
  const h = Math.max(body.clientHeight, 80);
  canvas.width  = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return { canvas, ctx, w, h };
}

function round(n) { return Math.round(n); }

const PAD = { top: 16, right: 20, bottom: 32, left: 48 };

function drawGrid(ctx, w, h, pad, rows = 4) {
  const ch = h - pad.top - pad.bottom;
  ctx.strokeStyle = getVar('--text-quaternary');
  ctx.globalAlpha = 0.4;
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= rows; i++) {
    const y = pad.top + ch * (i / rows);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function axisStyle(ctx) {
  ctx.fillStyle = getVar('--text-tertiary');
  ctx.font = `11px ${getVar('--font-system')}`;
}

/* ── Smooth path (quadratic bezier through midpoints) ───────────────────────*/
// Caller must ctx.moveTo(pts[0]) before calling. Does NOT call moveTo internally.
function smoothPath(ctx, pts) {
  if (pts.length < 2) return;
  if (pts.length === 2) { ctx.lineTo(pts[1][0], pts[1][1]); return; }
  for (let i = 0; i < pts.length - 2; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  ctx.quadraticCurveTo(
    pts[pts.length - 2][0], pts[pts.length - 2][1],
    pts[pts.length - 1][0], pts[pts.length - 1][1]
  );
}

/* ── Data smoothing (weighted 3-point average, N passes) ────────────────────*/
function smoothData(pts, passes = 2) {
  let r = pts;
  for (let p = 0; p < passes; p++) {
    r = r.map((pt, i) => {
      if (i === 0 || i === r.length - 1) return pt;
      return [pt[0], (r[i-1][1] + pt[1] * 2 + r[i+1][1]) / 4];
    });
  }
  return r;
}

/* ── LTTB downsampling — cap at maxPts while preserving visual shape ─────────*/
function lttb(pts, maxPts = 200) {
  const n = pts.length;
  if (n <= maxPts) return pts;

  const out = [pts[0]];
  const bucketSize = (n - 2) / (maxPts - 2);

  let prevIdx = 0;
  for (let b = 0; b < maxPts - 2; b++) {
    // Next bucket range
    const nextStart = Math.floor((b + 1) * bucketSize) + 1;
    const nextEnd   = Math.min(Math.floor((b + 2) * bucketSize) + 1, n - 1);

    // Average point in next bucket (used as the "far point")
    let avgX = 0, avgY = 0, avgCount = 0;
    for (let i = nextStart; i < nextEnd; i++) {
      avgX += pts[i][0]; avgY += pts[i][1]; avgCount++;
    }
    avgX /= avgCount; avgY /= avgCount;

    // Current bucket range
    const currStart = Math.floor(b * bucketSize) + 1;
    const currEnd   = Math.floor((b + 1) * bucketSize) + 1;

    // Pick point in current bucket that forms largest triangle with prevIdx and avg
    let maxArea = -1, maxIdx = currStart;
    for (let i = currStart; i < currEnd; i++) {
      const area = Math.abs(
        (pts[prevIdx][0] - avgX) * (pts[i][1] - pts[prevIdx][1]) -
        (pts[prevIdx][0] - pts[i][0]) * (avgY - pts[prevIdx][1])
      );
      if (area > maxArea) { maxArea = area; maxIdx = i; }
    }
    out.push(pts[maxIdx]);
    prevIdx = maxIdx;
  }
  out.push(pts[n - 1]);
  return out;
}

/* ── Chart: Battery ──────────────────────────────────────────────────────────*/
function drawBattery(entries) {
  const V = lttb(applyWindow(entries), 200);
  if (V.length < 2) return;
  const { ctx, w, h } = initCanvas('batt-canvas');
  const { top: pT, right: pR, bottom: pB, left: pL } = PAD;
  ctx.clearRect(0, 0, w, h);

  const ch = h - pT - pB, cw = w - pL - pR;
  drawGrid(ctx, w, h, PAD, 4);

  axisStyle(ctx);
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    ctx.fillText(round(100 * (1 - i/4)) + '%', pL - 8, pT + ch*(i/4) + 3.5);
  }

  const t0 = +new Date(V[0].ts), span = +new Date(V[V.length-1].ts) - t0 || 1;
  const xOf = e => pL + cw * ((+new Date(e.ts) - t0) / span);
  const yOf = v => pT + ch * (1 - v / 100);

  // Charging background
  for (let i = 1; i < V.length; i++) {
    if (V[i].charging) {
      ctx.fillStyle = 'rgba(50,215,75,0.04)';
      ctx.fillRect(xOf(V[i-1]), pT, xOf(V[i]) - xOf(V[i-1]), ch);
    }
  }

  const pts  = V.map(e => [xOf(e), yOf(e.battery)]);
  const spts = smoothData(pts, 3);

  // Area
  const g = ctx.createLinearGradient(0, pT, 0, pT + ch);
  g.addColorStop(0, 'rgba(50,215,75,0.25)');
  g.addColorStop(1, 'rgba(50,215,75,0)');
  ctx.beginPath();
  ctx.moveTo(spts[0][0], pT + ch);
  ctx.lineTo(spts[0][0], spts[0][1]);
  smoothPath(ctx, spts);
  ctx.lineTo(spts[spts.length-1][0], pT + ch);
  ctx.closePath();
  ctx.fillStyle = g; ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(spts[0][0], spts[0][1]);
  smoothPath(ctx, spts);
  ctx.strokeStyle = '#32D74B';
  ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();

  // End dot
  const l = V[V.length-1];
  ctx.beginPath();
  ctx.arc(xOf(l), yOf(l.battery), 4, 0, Math.PI*2);
  ctx.fillStyle = '#32D74B'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1.5; ctx.stroke();

  // X labels
  axisStyle(ctx); ctx.textAlign = 'center';
  V.filter((_, i) => i % Math.ceil(V.length/6) === 0 || i === V.length-1)
    .forEach(e => ctx.fillText(
      new Date(e.ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }),
      xOf(e), h - 6
    ));

  document.getElementById('batt-empty').classList.add('hidden');
  const vals = V.map(e => e.battery);
  const fmt = e => new Date(e.ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  document.getElementById('batt-range').textContent =
    `${fmt(V[0])} – ${fmt(V[V.length-1])}  ·  H: ${Math.max(...vals)}%  L: ${Math.min(...vals)}%`;
}

/* ── Chart: Power Draw ───────────────────────────────────────────────────────*/
function drawWatts(entries) {
  const V = lttb(applyWindow(entries), 200);
  if (V.length < 2) return;

  const withW = V.filter(e => e.amperage != null && e.voltage != null);
  if (!withW.length) { document.getElementById('watts-empty').classList.remove('hidden'); return; }
  document.getElementById('watts-empty').classList.add('hidden');

  const WE = withW.map(e => ({ ...e, watts: (e.amperage * e.voltage) / 1e6 }));
  const { ctx, w, h } = initCanvas('watts-canvas');
  const { top: pT, right: pR, bottom: pB, left: pL } = PAD;
  ctx.clearRect(0, 0, w, h);

  const allW = WE.map(e => e.watts);
  const yTop = Math.max(...allW, 0) + 2;
  const yBot = Math.min(...allW, 0) - 2;
  const yRange = yTop - yBot || 1;
  const ch = h - pT - pB, cw = w - pL - pR;

  drawGrid(ctx, w, h, PAD, 4);

  const t0 = +new Date(WE[0].ts), span = +new Date(WE[WE.length-1].ts) - t0 || 1;
  const xOf = e => pL + cw * ((+new Date(e.ts) - t0) / span);
  const yOf = v => pT + ch * (1 - (v - yBot) / yRange);
  const yZero = yOf(0);

  // Zero line
  ctx.strokeStyle = getVar('--text-quaternary');
  ctx.globalAlpha = 0.6; ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(pL, yZero); ctx.lineTo(w - pR, yZero); ctx.stroke();
  ctx.setLineDash([]); ctx.globalAlpha = 1;

  axisStyle(ctx); ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = yTop*(1-i/4) + yBot*(i/4);
    ctx.fillText(round(v) + 'W', pL - 8, pT + ch*(i/4) + 3.5);
  }

  // X labels
  axisStyle(ctx); ctx.textAlign = 'center';
  const step = Math.ceil(WE.length / 6);
  const labeled = new Set();
  for (let i = 0; i < WE.length; i += step) {
    ctx.fillText(new Date(WE[i].ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}), xOf(WE[i]), h-6);
    labeled.add(i);
  }
  const li = WE.length-1;
  if (!labeled.has(li))
    ctx.fillText(new Date(WE[li].ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}), xOf(WE[li]), h-6);

  // Pre-smooth Y positions (keep original .watts for color decisions)
  const wRaw  = WE.map((e, i) => [xOf(e), yOf(e.watts)]);
  const wSmooth = smoothData(wRaw, 3);
  const syOf  = i => wSmooth[i][1];

  // Area fills per segment
  for (let i = 1; i < WE.length; i++) {
    const p = WE[i-1], c = WE[i];
    ctx.beginPath();
    ctx.moveTo(xOf(p), syOf(i-1)); ctx.lineTo(xOf(c), syOf(i));
    ctx.lineTo(xOf(c), yZero); ctx.lineTo(xOf(p), yZero);
    ctx.closePath();
    ctx.fillStyle = (p.watts + c.watts)/2 >= 0
      ? 'rgba(50,215,75,0.15)' : 'rgba(255,159,10,0.15)';
    ctx.fill();
  }

  // Line — color per segment with bezier smoothing over smoothed Y
  for (let i = 1; i < WE.length; i++) {
    const i0 = Math.max(i-2, 0), i3 = Math.min(i+1, WE.length-1);
    const p0 = WE[i0], p1 = WE[i-1], p2 = WE[i], p3 = WE[i3];
    const tension = 0.4;
    const cp1x = xOf(p1) + (xOf(p2) - xOf(p0)) * tension;
    const cp1y = syOf(i-1) + (syOf(i) - syOf(i0)) * tension;
    const cp2x = xOf(p2) - (xOf(p3) - xOf(p1)) * tension;
    const cp2y = syOf(i)   - (syOf(i3) - syOf(i-1)) * tension;
    ctx.beginPath();
    ctx.moveTo(xOf(p1), syOf(i-1));
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, xOf(p2), syOf(i));
    ctx.strokeStyle = (p1.watts + p2.watts)/2 >= 0 ? '#32D74B' : '#FF9F0A';
    ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
  }

  const avg = allW.reduce((a,b) => a+b, 0) / allW.length;
  const peak = Math.max(...allW.map(Math.abs));
  const fmt = e => new Date(e.ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  document.getElementById('watts-range').textContent =
    `${fmt(WE[0])} – ${fmt(WE[WE.length-1])}  ·  Avg: ${Math.abs(avg).toFixed(1)}W  Peak: ${peak.toFixed(1)}W`;
}

/* ── Chart: CPU ──────────────────────────────────────────────────────────────*/
let hoveredProcess = null;

function drawCpu(entries) {
  const V = lttb(applyWindow(entries), 200);
  if (V.length < 2) return;
  const { ctx, w, h } = initCanvas('cpu-canvas');
  const { top: pT, right: pR, bottom: pB, left: pL } = PAD;
  ctx.clearRect(0, 0, w, h);

  const tot = {};
  let mx = 10;
  V.forEach(e => Object.entries(e.cpus).forEach(([k, v]) => {
    tot[k] = (tot[k] || 0) + v;
    mx = Math.max(mx, v);
  }));
  const procs = Object.keys(tot).sort((a,b) => tot[b]-tot[a]).slice(0, 9);
  if (!procs.length) return;

  const yMax = Math.min(100, Math.ceil(mx / 10) * 10) || 10;
  const ch = h - pT - pB, cw = w - pL - pR;
  drawGrid(ctx, w, h, PAD, 4);

  axisStyle(ctx); ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++)
    ctx.fillText(round(yMax*(1-i/4)) + '%', pL - 8, pT + ch*(i/4) + 3.5);

  const t0 = +new Date(V[0].ts), span = +new Date(V[V.length-1].ts) - t0 || 1;
  const xOf = e => pL + cw * ((+new Date(e.ts) - t0) / span);
  const yOf = v => pT + ch * (1 - v / yMax);

  // X labels
  axisStyle(ctx); ctx.textAlign = 'center';
  V.filter((_, i) => i % Math.ceil(V.length/6) === 0 || i === V.length-1)
    .forEach(e => ctx.fillText(
      new Date(e.ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),
      xOf(e), h-6
    ));

  for (const proc of [...procs].reverse()) {
    const c = procColor(proc);
    const rgb = hexRgb(c);
    const isHovered = hoveredProcess === proc;
    const isOtherHovered = hoveredProcess && hoveredProcess !== proc;
    const alpha = isHovered ? 1 : isOtherHovered ? 0.05 : 0.18;

    const pts  = V.map(e => [xOf(e), yOf(e.cpus[proc] || 0)]);
    const spts = smoothData(pts, 3);

    // Area
    ctx.globalAlpha = alpha * 0.5;
    ctx.beginPath();
    ctx.moveTo(spts[0][0], pT + ch);
    ctx.lineTo(spts[0][0], spts[0][1]);
    smoothPath(ctx, spts);
    ctx.lineTo(spts[spts.length-1][0], pT + ch);
    ctx.closePath();
    ctx.fillStyle = `rgba(${rgb},0.15)`; ctx.fill();

    // Line
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(spts[0][0], spts[0][1]);
    smoothPath(ctx, spts);
    ctx.strokeStyle = c;
    ctx.lineWidth = isHovered ? 2.5 : 1.5;
    ctx.lineJoin = 'round'; ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // End dots for top processes
  const l = V[V.length-1];
  procs.forEach(proc => {
    const v = l.cpus[proc];
    if (!v) return;
    const isOtherHovered = hoveredProcess && hoveredProcess !== proc;
    if (isOtherHovered) return;
    ctx.beginPath();
    ctx.arc(xOf(l), yOf(v), 3, 0, Math.PI*2);
    ctx.fillStyle = procColor(proc); ctx.fill();
  });

  // Legend with hover interaction
  const legendEl = document.getElementById('cpu-legend');
  legendEl.innerHTML = procs.map(p =>
    `<div class="legend-item" data-proc="${p}">
      <div class="legend-swatch" style="background:${procColor(p)}"></div>${p}
    </div>`
  ).join('');

  legendEl.onmouseenter = e => {
    const item = e.target.closest('.legend-item');
    if (item) { hoveredProcess = item.dataset.proc; drawCpu(state.allEntries); }
  };
  legendEl.onmouseleave = () => { hoveredProcess = null; drawCpu(state.allEntries); };
  legendEl.onmouseover = e => {
    const item = e.target.closest('.legend-item');
    if (item && item.dataset.proc !== hoveredProcess) {
      hoveredProcess = item.dataset.proc; drawCpu(state.allEntries);
    }
  };

  const fmt = e => new Date(e.ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  document.getElementById('cpu-range').textContent = `${fmt(V[0])} – ${fmt(V[V.length-1])}`;
  document.getElementById('cpu-empty').classList.add('hidden');
}

function hexRgb(hex) {
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)].join(',');
}

/* ── Window filter ───────────────────────────────────────────────────────────*/
function applyWindow(entries) {
  if (!state.windowMs || !entries.length) return entries;
  const cutoff = +new Date(entries[entries.length-1].ts) - state.windowMs;
  return entries.filter(e => +new Date(e.ts) >= cutoff);
}

/* ── Sidebar ─────────────────────────────────────────────────────────────────*/
function renderSidebar() {
  const entries = state.allEntries;
  if (!entries.length) return;
  const l = entries[entries.length-1];

  // Battery %
  document.getElementById('sb-batt-num').textContent = l.battery + '%';

  // Status pill
  const isCharging = l.amperage != null && l.amperage > 0;
  const stateEl = document.getElementById('sb-state');
  stateEl.textContent = isCharging ? '⚡ Charging' : 'On Battery';
  stateEl.className = 'battery-status ' + (isCharging ? 'charging' : 'discharging');

  // Time left
  const tl = document.getElementById('sb-timeleft');
  if (l.timeLeft) {
    const [hh, mm] = l.timeLeft.split(':').map(Number);
    tl.textContent = hh > 0 ? `${hh}h ${mm}m` : `${mm}m`;
    tl.style.color = isCharging ? 'var(--color-green)'
      : hh < 1 ? 'var(--color-red)' : hh < 3 ? 'var(--color-orange)' : 'var(--text-primary)';
  } else {
    tl.textContent = '—';
    tl.style.color = 'var(--text-tertiary)';
  }

  // Watts
  const wv = document.getElementById('sb-watts');
  if (l.amperage != null && l.voltage != null) {
    const watts = (l.amperage * l.voltage) / 1e6;
    wv.textContent = (watts >= 0 ? '+' : '') + watts.toFixed(1) + 'W';
    wv.style.color = watts >= 0 ? 'var(--color-green)' : 'var(--color-orange)';
  } else {
    wv.textContent = '—';
    wv.style.color = 'var(--text-tertiary)';
  }

  renderProcessList(l.cpus);
  renderAssertions(l.assertions);

  // Header subtitle
  const fmt = d => new Date(d).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  const d0 = new Date(entries[0].ts), d1 = new Date(entries[entries.length-1].ts);
  const sameDay = d0.toDateString() === d1.toDateString();
  const dateStr = sameDay
    ? d0.toLocaleDateString([],{month:'short',day:'numeric'})
    : `${d0.toLocaleDateString([],{month:'short',day:'numeric'})} – ${d1.toLocaleDateString([],{month:'short',day:'numeric'})}`;
  document.getElementById('main-sub').textContent = `${dateStr}  ${fmt(entries[0].ts)} – ${fmt(entries[entries.length-1].ts)}`;
}

function renderProcessList(cpus) {
  const sorted = Object.entries(cpus).sort((a,b) => b[1]-a[1]).slice(0, 8);
  const maxCpu = sorted.length ? sorted[0][1] : 1;

  if (!sorted.length) {
    document.getElementById('proc-list').innerHTML =
      '<div style="font-size:12px;color:var(--text-tertiary);padding:8px 0">Idle</div>';
    return;
  }

  document.getElementById('proc-list').innerHTML = sorted.map(([name, cpu]) => {
    const c = procColor(name);
    const barW = maxCpu > 0 ? round((cpu / maxCpu) * 100) : 0;
    return `<div class="process-item">
      <span class="process-dot" style="background:${c}"></span>
      <span class="process-name">${name}</span>
      <div class="process-bar-container">
        <div class="process-bar-fill" style="width:${barW}%;background:${c}"></div>
      </div>
      <span class="process-cpu">${cpu.toFixed(1)}%</span>
    </div>`;
  }).join('');
}

function renderAssertions(assertions) {
  const filtered = interestingAssertions(assertions);
  const wrapper = document.getElementById('sb-asserts');
  const list = document.getElementById('assert-list');

  if (!filtered.length) { wrapper.style.display = 'none'; list.innerHTML = ''; return; }

  wrapper.style.display = 'block';
  list.innerHTML = filtered.map(a => {
    const m = a.match(/^(.*?)\s*→\s*(.*)/);
    return `<span class="assertion-pill">${m ? m[1].trim() + ' → ' + m[2].trim() : a}</span>`;
  }).join('');
}

/* ── Render ──────────────────────────────────────────────────────────────────*/
function render() {
  const E = state.allEntries;
  renderSidebar();
  drawBattery(E);
  drawWatts(E);
  drawCpu(E);

  const now = new Date();
  document.getElementById('last-update').textContent =
    'Updated ' + now.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  document.getElementById('updated-sep').style.display = '';
}

/* ── Data listener ───────────────────────────────────────────────────────────*/
if (window.api && window.api.onLogUpdate) {
  window.api.onLogUpdate((data) => {
    state.allEntries = data.entries || data;
    if (data.sysInfo) {
      state.sysInfo = data.sysInfo;
      const el = document.getElementById('main-title');
      el.textContent = data.sysInfo.chip
        ? `${data.sysInfo.model} (${data.sysInfo.chip})`
        : data.sysInfo.model;
      // Populate sysinfo panel (sidebar)
      const si = data.sysInfo;
      document.getElementById('si-model').textContent = si.model  || '—';
      document.getElementById('si-chip').textContent  = si.chip   || '—';
      document.getElementById('si-cores').textContent = si.cores ? si.cores + ' cores' : '—';
      document.getElementById('si-mem').textContent   = si.memory || '—';
      // Populate model-name hover tooltip
      document.getElementById('mt-body').innerHTML = [
        ['Model',  si.model  || '—'],
        ['Chip',   si.chip   || '—'],
        ['Cores',  si.cores  ? si.cores + ' cores' : '—'],
        ['Memory', si.memory || '—'],
      ].map(([k, v]) =>
        `<div class="tt-row"><span class="tt-label">${k}</span><span class="tooltip-value">${v}</span></div>`
      ).join('');
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
  const cw = canvasWidth - PAD.left - PAD.right;
  if (!V.length || cw <= 0) return null;
  const t0 = +new Date(V[0].ts), span = +new Date(V[V.length-1].ts) - t0;
  if (!span) return V[V.length-1];
  const target = t0 + Math.max(0, Math.min(1, (mouseX - PAD.left) / cw)) * span;
  return V.reduce((best, e) =>
    Math.abs(+new Date(e.ts) - target) < Math.abs(+new Date(best.ts) - target) ? e : best);
}

function showTooltip(mx, my, entry) {
  if (!entry) return;
  const tt = document.getElementById('tooltip');
  const watts = entry.amperage != null && entry.voltage != null
    ? (entry.amperage * entry.voltage) / 1e6 : null;

  document.getElementById('tt-time').textContent =
    new Date(entry.ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});

  let html = `<div class="tooltip-row">
    <span class="tooltip-label">Battery</span>
    <span class="tooltip-value">${entry.battery}%${entry.charging ? ' ⚡' : ''}</span>
  </div>`;

  if (watts !== null) {
    const cls = watts >= 0 ? 'tt-charging' : 'tt-discharging';
    html += `<div class="tooltip-row">
      <span class="tooltip-label">Power</span>
      <span class="tooltip-value ${cls}">${watts >= 0 ? '+' : ''}${watts.toFixed(2)}W</span>
    </div>`;
  }
  if (entry.amperage != null) {
    const cls = entry.amperage > 0 ? 'tt-charging' : 'tt-discharging';
    html += `<div class="tooltip-row">
      <span class="tooltip-label">Amperage</span>
      <span class="tooltip-value ${cls}">${entry.amperage > 0 ? '+' : ''}${entry.amperage}mA</span>
    </div>`;
  }
  if (entry.voltage != null) {
    html += `<div class="tooltip-row">
      <span class="tooltip-label">Voltage</span>
      <span class="tooltip-value">${(entry.voltage/1000).toFixed(2)}V</span>
    </div>`;
  }
  if (entry.cpus && Object.keys(entry.cpus).length) {
    const top = Object.entries(entry.cpus).sort((a,b) => b[1]-a[1]).filter(([,v]) => v > 0.5).slice(0, 5);
    if (top.length) {
      html += `<div style="height:1px;background:var(--border-subtle);margin:6px 0"></div>`;
      top.forEach(([name, cpu]) =>
        html += `<div class="tooltip-row">
          <span class="tooltip-label">
            <span class="tooltip-dot" style="background:${procColor(name)}"></span>${name}
          </span>
          <span class="tooltip-value">${cpu.toFixed(1)}%</span>
        </div>`
      );
    }
  }

  document.getElementById('tt-body').innerHTML = html;
  const W = tt.offsetWidth || 200, H = tt.offsetHeight || 180;
  tt.style.left = (mx + 16 + W > window.innerWidth  ? mx - W - 16 : mx + 16) + 'px';
  tt.style.top  = (my - 10 + H > window.innerHeight ? window.innerHeight - H - 10 : my - 10) + 'px';
  tt.style.display = 'block';
}

function hideTooltip() { document.getElementById('tooltip').style.display = 'none'; }

function setupHover() {
  ['batt-canvas', 'watts-canvas', 'cpu-canvas'].forEach(id => {
    const canvas = document.getElementById(id);
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
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 100); });

setupHover();

/* ── Model-name hover tooltip ────────────────────────────────────────────────*/
(function setupModelTooltip() {
  const trigger = document.getElementById('main-title');
  const panel   = document.getElementById('model-tooltip');
  if (!trigger || !panel) return;
  trigger.addEventListener('mouseenter', () => {
    panel.style.display = 'block';
    const rect = trigger.getBoundingClientRect();
    const pw   = panel.offsetWidth;
    let left   = rect.left;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    panel.style.left = left + 'px';
    panel.style.top  = (rect.bottom + 8) + 'px';
  });
  trigger.addEventListener('mouseleave', () => { panel.style.display = 'none'; });
})();

/* ── Sysinfo panel (CPU legend → hover) ─────────────────────────────────────*/
(function setupSysInfoPanel() {
  const section = document.querySelector('.processes-section');
  const panel   = document.getElementById('sysinfo-panel');
  if (!section || !panel) return;
  section.addEventListener('mouseenter', () => { panel.style.display = 'flex'; });
  section.addEventListener('mouseleave', () => { panel.style.display = 'none'; });
})();

/* ── Chart expand/collapse (overlay mode) ────────────────────────────────────*/
(function setupChartExpand() {
  const cards = Array.from(document.querySelectorAll('.chart-card'));
  const container = document.querySelector('.charts');
  let mdX = 0, mdY = 0;
  let rafId = null;
  let saved = null; // { card, top, left, w, h } — original viewport rect before expand

  function startRenderLoop() {
    if (rafId) return;
    (function loop() { render(); rafId = requestAnimationFrame(loop); })();
  }
  function stopRenderLoop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  function doExpand(targetId) {
    const card = cards.find(c => c.dataset.chartId === targetId);
    if (!card) return;

    const cardRect      = card.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const cs   = getComputedStyle(container);
    const padT = parseFloat(cs.paddingTop),    padB = parseFloat(cs.paddingBottom);
    const padL = parseFloat(cs.paddingLeft),   padR = parseFloat(cs.paddingRight);

    // Hide other cards — they can reflow freely underneath the overlay
    cards.forEach(c => {
      if (c !== card) {
        c.style.opacity       = '0';
        c.style.pointerEvents = 'none';
      }
    });

    // Store starting rect for collapse animation
    saved = { card,
      top:  cardRect.top,  left: cardRect.left,
      w:    cardRect.width, h:   cardRect.height };

    // Destination fills the visible container area (viewport-relative, fixed)
    const destT = containerRect.top    + padT;
    const destL = containerRect.left   + padL;
    const destW = containerRect.width  - padL - padR;
    const destH = containerRect.height - padT - padB;

    // Snap to start position (no transition yet)
    card.style.position = 'fixed';
    card.style.top      = cardRect.top    + 'px';
    card.style.left     = cardRect.left   + 'px';
    card.style.width    = cardRect.width  + 'px';
    card.style.height   = cardRect.height + 'px';
    card.style.zIndex   = '200';
    card.style.margin   = '0';
    card.classList.add('expanded');

    // Force reflow so the browser records the "from" values
    void card.offsetHeight;

    startRenderLoop();

    // Now set destination — CSS transition fires from here
    card.style.top    = destT + 'px';
    card.style.left   = destL + 'px';
    card.style.width  = destW + 'px';
    card.style.height = destH + 'px';
  }

  function doCollapse() {
    if (!saved) return;
    const { card, top, left, w, h } = saved;
    startRenderLoop();
    // Animate back to stored original position
    card.style.top    = top  + 'px';
    card.style.left   = left + 'px';
    card.style.width  = w    + 'px';
    card.style.height = h    + 'px';
  }

  function restoreAll() {
    if (!saved) return;
    const { card } = saved;
    // Remove all inline overrides — card returns to normal flex flow
    card.style.position = card.style.top = card.style.left =
      card.style.width = card.style.height = card.style.zIndex =
      card.style.margin = '';
    card.classList.remove('expanded');
    cards.forEach(c => {
      c.style.flex = c.style.minHeight = c.style.height =
        c.style.opacity = c.style.pointerEvents = '';
    });
    saved = null;
  }

  cards.forEach(card => {
    // Clean up after animation finishes (use 'height' as sentinel)
    card.addEventListener('transitionend', e => {
      if (e.propertyName !== 'height' || e.target !== card) return;
      stopRenderLoop();
      if (!state.expandedChart) restoreAll();
      render();
    });

    card.addEventListener('mousedown', e => { mdX = e.clientX; mdY = e.clientY; });
    card.addEventListener('click', e => {
      if (Math.abs(e.clientX - mdX) > 5 || Math.abs(e.clientY - mdY) > 5) return;
      const chartId = card.dataset.chartId;
      if (!chartId) return;
      if (state.expandedChart === chartId) {
        state.expandedChart = null;
        doCollapse();
      } else {
        state.expandedChart = chartId;
        doExpand(chartId);
      }
    });
  });
})();
