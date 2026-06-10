'use strict';

/* ── HTML escaping ───────────────────────────────────────────────────────────*/
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function h(s) { return String(s).replace(/[&<>"']/g, c => ESC[c]); }

/* ── State ─────────────────────────────────────────────────────────────────── */
const state = {
  entries:      [],     // chart history from DB (~60s updates)
  latest:       null,   // most recent values — set from DB on first load, then overwritten by 1s IORegistry loop
  sysInfo:      null,   // static hardware info, set once at startup
  expandedChart: null,
  windowMs:     0,
  cpuView:      'blocks',
};

/* ── Process color palette ─────────────────────────────────────────────────── */
// Ten curated colors per theme. Dark: vivid/luminous. Light: same hues, darker+saturated.
const PALETTES = {
  dark: [
    '#0A84FF', // Blue
    '#32D74B', // Green
    '#FF9F0A', // Amber
    '#BF5AF2', // Purple
    '#FF453A', // Red
    '#40C8E0', // Cyan
    '#FFD60A', // Yellow
    '#FF6BD6', // Magenta
    '#4CD990', // Mint
    '#FF5E7A', // Rose
  ],
  light: [
    '#0055CC', // Blue
    '#1A7A1A', // Green
    '#C85500', // Burnt Orange
    '#8833CC', // Purple
    '#CC1A00', // Red
    '#006B8C', // Cyan
    '#997700', // Amber
    '#CC22AA', // Magenta
    '#0D8C4A', // Mint
    '#CC2244', // Rose
  ],
};

const procIdx = {};  // name → palette index (0-9) or ≥10 for hash-based
let nextIdx = 0;

function procColor(name) {
  if (procIdx[name] === undefined) procIdx[name] = nextIdx++;
  const idx   = procIdx[name];
  const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  const pal   = PALETTES[theme];
  if (idx < pal.length) return pal[idx];
  // Overflow: deterministic hash → pleasant hue for current theme
  let hash = 5381;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) + hash + name.charCodeAt(i)) & 0xFFFFFF;
  const hue = hash % 360;
  return theme === 'dark' ? `hsl(${hue},72%,62%)` : `hsl(${hue},60%,36%)`;
}

/* ── System process classification ──────────────────────────────────────────*/
const SYSTEM_USERS = new Set([
  'root', '_windowserver', '_spotlight', '_mdnsresponder', '_networkd',
  'daemon', '_coreaudiod', '_usbmuxd', '_locationd', '_hidd', '_appinstalld',
  '_assetcache', '_softwareupdate', '_sntpd', '_logd', '_trustd', '_nsurlsessiond',
]);

const SYSTEM_PROC_INFO = {
  kernel_task:       'macOS kernel',
  WindowServer:      'Display compositor',
  coreaudiod:        'Audio engine',
  launchd:           'System init',
  mds:               'Spotlight indexer',
  mds_stores:        'Spotlight storage',
  mdworker_shared:   'Spotlight worker',
  trustd:            'Certificate trust',
  logd:              'System logging',
  configd:           'Network config',
  distnoted:         'Distributed notifications',
  powerd:            'Power management',
  bluetoothd:        'Bluetooth daemon',
  nsurlsessiond:     'URL session daemon',
  hidd:              'HID event daemon',
  locationd:         'Location services',
  symptomsd:         'Network diagnostics',
  sysmond:           'System monitor',
  UserEventAgent:    'User event agent',
  cfprefsd:          'Preferences daemon',
};

// rank 0 = biggest sys proc, rank (total-1) = smallest
// Dark mode: biggest → mid-grey, smallest → near-white
// Light mode: biggest → mid-grey, smallest → near-black
function sysGrey(rank, total, isDark) {
  const t = total <= 1 ? 0 : rank / (total - 1);
  const l = isDark ? Math.round(42 + t * 52) : Math.round(62 - t * 48);
  return `hsl(220,8%,${l}%)`;  // very slight blue tint keeps it "cool" grey
}

function isSystemProcess(name, user) {
  if (user && SYSTEM_USERS.has(user)) return true;
  // Fallback for older entries without user data: check known system process names
  if (!user && SYSTEM_PROC_INFO[name]) return true;
  return false;
}

function desaturate(hex, amount) {
  const r = parseInt(hex.slice(1,3),16)/255;
  const g = parseInt(hex.slice(3,5),16)/255;
  const b = parseInt(hex.slice(5,7),16)/255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h2 = 0, s = 0;
  const l = (max+min)/2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d/(2-max-min) : d/(max+min);
    switch(max) {
      case r: h2 = ((g-b)/d + (g<b?6:0))/6; break;
      case g: h2 = ((b-r)/d + 2)/6; break;
      case b: h2 = ((r-g)/d + 4)/6; break;
    }
  }
  const ns = Math.max(0, s * (1-amount));
  // HSL back to RGB
  function hue2rgb(p,q,t){if(t<0)t+=1;if(t>1)t-=1;if(t<1/6)return p+(q-p)*6*t;if(t<1/2)return q;if(t<2/3)return p+(q-p)*(2/3-t)*6;return p;}
  let rr,gg,bb;
  if (ns===0) { rr=gg=bb=l; }
  else {
    const q2 = l<0.5 ? l*(1+ns) : l+ns-l*ns;
    const p2 = 2*l-q2;
    rr = hue2rgb(p2,q2,h2+1/3);
    gg = hue2rgb(p2,q2,h2);
    bb = hue2rgb(p2,q2,h2-1/3);
  }
  const toHex = x => Math.round(x*255).toString(16).padStart(2,'0');
  return `#${toHex(rr)}${toHex(gg)}${toHex(bb)}`;
}

/* ── Assertion filter ────────────────────────────────────────────────────────*/
const IGNORE_ASSERT = [
  'powerd', 'useractive', 'iohideventsystem', 'delaydisplayoff',
  'applehibtransport', 'com.apple.powermanagement',
];
function interestingAssertions(list) {
  return [...new Set(list.filter(a => !IGNORE_ASSERT.some(s => a.toLowerCase().includes(s))))];
}

/* ── Theme ───────────────────────────────────────────────────────────────────*/
function applyTheme(isDark) {
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
}

if (window.api && window.api.onThemeChanged) {
  window.api.onThemeChanged(({ isDark }) => { applyTheme(isDark); render(); });
}

if (window.api && window.api.onSettings) {
  window.api.onSettings(({ isDark, timeRange, cpuView }) => {
    applyTheme(isDark);
    const btn = document.querySelector(`.range-btn[data-min="${timeRange}"]`);
    if (btn) {
      document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.windowMs = timeRange * 60000;
    }
    if (cpuView === 'smooth' || cpuView === 'blocks') {
      state.cpuView = cpuView;
      if (state.entries.length) drawCpu(state.entries);
    }
  });
}

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

// Returns { major:[{frac,label}], minor:[{frac}] }
// Short ranges → relative labels counted back from "now" (t1)
// Long ranges  → absolute LOCAL-TIME calendar anchors (00:00, 06:00 … Jun 12 …)
function xTicks(t0, t1) {
  const span = t1 - t0;

  // Relative: step backwards from t1
  function relTicks(stepMs) {
    const r = [];
    for (let t = t1; t >= t0; t -= stepMs) r.unshift((t - t0) / span);
    return r;
  }

  // Absolute: snap to LOCAL-time boundaries (hours or days), then step forward.
  // This avoids the UTC-offset bug where Math.ceil(t/step)*step gives 07:00
  // instead of 06:00 in non-UTC timezones.
  function absTicks(stepHours) {
    const stepMs = stepHours * 3600e3;
    // Local midnight of the day containing t0
    const d0 = new Date(t0);
    const midnight = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate()).getTime();
    // First boundary at or after t0
    const stepsFromMidnight = Math.ceil((t0 - midnight) / stepMs);
    const first = midnight + stepsFromMidnight * stepMs;
    const r = [];
    for (let t = first; t <= t1; t += stepMs) r.push((t - t0) / span);
    return r;
  }

  // Absolute day ticks: start from midnight of the first data day, step forward.
  // Starting from midnight (not the next boundary) ensures the first visible label
  // anchors to the start of the data rather than jumping forward a full week.
  function dayTicks(stepDays) {
    const stepMs = stepDays * 86400e3;
    const d0 = new Date(t0);
    const midnight = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate()).getTime();
    const r = [];
    for (let t = midnight; t <= t1; t += stepMs) {
      const frac = (t - t0) / span;
      if (frac >= 0) r.push(frac);   // only include ticks at or after data start
    }
    return r;
  }

  // Choose major step to target ~5 labels across the visible span
  const daysInSpan = span / 86400e3;
  const dayMajorStep = daysInSpan <= 5  ? 1
                     : daysInSpan <= 12 ? 2
                     : daysInSpan <= 20 ? 4
                     : daysInSpan <= 35 ? 5
                     : 7;

  let majorFracs, minorFracs, fmt;
  if      (span <= 12  * 60e3)  { majorFracs=relTicks(2*60e3);          minorFracs=relTicks(60e3);    fmt='rel-min'; }
  else if (span <= 75  * 60e3)  { majorFracs=relTicks(15*60e3);         minorFracs=relTicks(5*60e3);  fmt='rel-min'; }
  else if (span <= 7   * 3600e3){ majorFracs=relTicks(3600e3);          minorFracs=relTicks(30*60e3); fmt='rel-hr';  }
  else if (span <= 25  * 3600e3){ majorFracs=absTicks(6);               minorFracs=absTicks(1);       fmt='abs-hr';  }
  else                          { majorFracs=dayTicks(dayMajorStep);    minorFracs=dayTicks(1);       fmt='abs-day'; }

  const majorSet = new Set(majorFracs.map(f => f.toFixed(8)));
  const minor    = minorFracs.filter(f => !majorSet.has(f.toFixed(8)));

  const major = majorFracs.map(frac => {
    const t = t0 + frac * span;
    const d = new Date(t);
    let label;
    if (fmt === 'rel-min') {
      const m = Math.round((t1 - t) / 60e3);
      label = m === 0 ? 'now' : `${m}m`;
    } else if (fmt === 'rel-hr') {
      const hr = Math.round((t1 - t) / 3600e3);
      label = hr === 0 ? 'now' : `${hr}h`;
    } else if (fmt === 'abs-hr') {
      // Local 24-hour clock — always 00:00, 06:00, 12:00, 18:00
      label = `${String(d.getHours()).padStart(2,'0')}:00`;
    } else {
      label = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
    return { frac, label };
  });

  return { major, minor };
}

// Draw x-axis: dotted vertical lines + labels at major ticks, small marks at minor ticks
function drawXAxis(ctx, ticks, pL, pT, cw, ch, h) {
  const { major, minor } = ticks;
  ctx.save();

  // Minor tick marks at bottom of chart area
  ctx.strokeStyle = getVar('--text-quaternary');
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  for (const frac of minor) {
    const x = pL + cw * frac;
    ctx.beginPath(); ctx.moveTo(x, pT + ch); ctx.lineTo(x, pT + ch + 4); ctx.stroke();
  }

  // Major: dotted vertical line through chart body
  ctx.setLineDash([2, 3]);
  ctx.globalAlpha = 0.25;
  for (const { frac } of major) {
    const x = pL + cw * frac;
    ctx.beginPath(); ctx.moveTo(x, pT); ctx.lineTo(x, pT + ch); ctx.stroke();
  }
  ctx.setLineDash([]); ctx.globalAlpha = 1;

  // Labels — skip if they'd overlap the previous one
  axisStyle(ctx); ctx.textAlign = 'center';
  let lastX = -99;
  for (const { frac, label } of major) {
    const x = pL + cw * frac;
    if (x - lastX < 28) continue;
    ctx.fillText(label, x, h - 6);
    lastX = x;
  }
  ctx.restore();
}

// Crosshair: thin vertical line at mouse position (0..1 fraction of chart width)
function drawCrosshair(ctx, frac, pL, pT, cw, ch) {
  if (frac === null) return;
  const x = pL + cw * frac;
  ctx.save();
  ctx.strokeStyle = getVar('--text-secondary');
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(x, pT); ctx.lineTo(x, pT + ch); ctx.stroke();
  ctx.restore();
}

// "3h ago", "2d ago", etc.
function timeAgo(ts) {
  const m = Math.floor((Date.now() - +new Date(ts)) / 60e3);
  if (m <  2)  return 'just now';
  if (m < 60)  return `${m}m ago`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

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
// Set to true to draw smooth bezier curves; false = raw straight line segments.
const SMOOTH_LINES = false;

// Caller must ctx.moveTo(pts[0]) before calling. Does NOT call moveTo internally.
function smoothPath(ctx, pts) {
  if (pts.length < 2) return;
  if (!SMOOTH_LINES) {
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    return;
  }
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
  const windowed = applyWindow(entries);
  if (windowed.length < 2) { document.getElementById('batt-empty').classList.remove('hidden'); return; }
  document.getElementById('batt-empty').classList.add('hidden');

  const { ctx, w, h } = initCanvas('batt-canvas');
  const { top: pT, right: pR, bottom: pB, left: pL } = PAD;
  ctx.clearRect(0, 0, w, h);

  const ch = h - pT - pB, cw = w - pL - pR;

  const t0   = +new Date(windowed[0].ts);
  const t1   = +new Date(windowed[windowed.length - 1].ts);
  const span = t1 - t0 || 1;

  // Group consecutive samples so bars are ~5px wide.
  // All bars are exactly equal width (cw / numBars) — no last-bar remainder.
  const TARGET_PX    = 5;
  const maxBars      = Math.max(1, Math.floor(cw / TARGET_PX));
  const samplesPerBar = Math.max(1, Math.ceil(windowed.length / maxBars));
  const numBars      = Math.ceil(windowed.length / samplesPerBar);
  const barW         = cw / numBars;
  const GAP          = Math.min(1, barW * 0.12);

  const bars = [];
  for (let i = 0; i < windowed.length; i += samplesPerBar) {
    const slice    = windowed.slice(i, i + samplesPerBar);
    const avgBatt  = slice.reduce((a, b) => a + b.battery, 0) / slice.length;
    const charging = slice.filter(e => e.charging).length > slice.length / 2;
    bars.push({ battery: Math.round(avgBatt), charging, ts: slice[Math.floor(slice.length / 2)].ts });
  }

  drawGrid(ctx, w, h, PAD, 4);

  axisStyle(ctx);
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    ctx.fillText(round(100 * (1 - i/4)) + '%', pL - 8, pT + ch*(i/4) + 3.5);
  }

  const yOf    = v => pT + ch * (1 - v / 100);
  const bottom = pT + ch;

  for (let i = 0; i < bars.length; i++) {
    const x  = pL + i * barW + GAP / 2;
    const bw = barW - GAP;
    const y  = yOf(bars[i].battery);
    const r  = Math.min(3, bw / 2);
    ctx.beginPath();
    ctx.roundRect(x, y, bw, bottom - y, [r, r, 0, 0]);
    ctx.fillStyle = bars[i].charging ? 'rgba(50,215,75,0.85)' : 'rgba(50,215,75,0.45)';
    ctx.fill();
  }

  // End dot centred on last bar
  const last = bars[bars.length - 1];
  const dotX = pL + (bars.length - 0.5) * barW;
  ctx.beginPath();
  ctx.arc(dotX, yOf(last.battery), 4, 0, Math.PI * 2);
  ctx.fillStyle = '#32D74B'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1.5; ctx.stroke();

  drawXAxis(ctx, xTicks(t0, t1), pL, pT, cw, ch, h);
  drawCrosshair(ctx, hoverX.batt, pL, pT, cw, ch);

  const vals = bars.map(b => b.battery);
  document.getElementById('batt-range').textContent =
    `H: ${Math.max(...vals)}%  L: ${Math.min(...vals)}%`;
}

/* ── Chart: Power Draw ───────────────────────────────────────────────────────*/
function drawWatts(entries) {
  const V = lttb(applyWindow(entries), 200);
  if (V.length < 2) { document.getElementById('watts-empty').classList.remove('hidden'); return; }

  const withW = V.filter(e => e.amperage != null && e.voltage != null);
  if (!withW.length) { document.getElementById('watts-empty').classList.remove('hidden'); return; }
  document.getElementById('watts-empty').classList.add('hidden');

  const WE = withW.map(e => ({ ...e, watts: (e.amperage * e.voltage) / 1e6 }));
  const { ctx, w, h } = initCanvas('watts-canvas');
  const { top: pT, right: pR, bottom: pB, left: pL } = PAD;
  ctx.clearRect(0, 0, w, h);

  const allW = WE.map(e => e.watts);
  // Round the axis to clean steps with zero on a gridline (no more 26/16/6/-3/-13)
  const niceStep = x => {
    if (x <= 0) return 1;
    const base = Math.pow(10, Math.floor(Math.log10(x)));
    const f = x / base;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * base;
  };
  const step = niceStep((Math.max(...allW, 0) - Math.min(...allW, 0)) / 4 || 1);
  const yBot = Math.floor(Math.min(...allW, 0) / step) * step;
  const yTop = yBot + 4 * step;
  const yRange = yTop - yBot || 1;
  const ch = h - pT - pB, cw = w - pL - pR;

  drawGrid(ctx, w, h, PAD, 4);

  const t0 = +new Date(WE[0].ts), t1w = +new Date(WE[WE.length-1].ts);
  const span = t1w - t0 || 1;
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
    const v = yTop - step * i;
    ctx.fillText((+v.toFixed(1)) + 'W', pL - 8, pT + ch*(i/4) + 3.5);
  }

  drawXAxis(ctx, xTicks(t0, t1w), pL, pT, cw, ch, h);
  drawCrosshair(ctx, hoverX.watts, pL, pT, cw, ch);

  const pts = WE.map(e => [xOf(e), yOf(e.watts)]);

  const drawFill = (color, clipY, clipH) => {
    ctx.save();
    ctx.beginPath(); ctx.rect(pL, clipY, cw, clipH); ctx.clip();
    ctx.beginPath();
    ctx.moveTo(pts[0][0], yZero);
    ctx.lineTo(pts[0][0], pts[0][1]);
    smoothPath(ctx, pts);
    ctx.lineTo(pts[pts.length-1][0], yZero);
    ctx.closePath();
    ctx.fillStyle = color; ctx.fill();
    ctx.restore();
  };
  drawFill('rgba(50,215,75,0.15)',  pT,    yZero - pT);
  drawFill('rgba(255,159,10,0.15)', yZero, pT + ch - yZero);

  const drawLine = (color, clipY, clipH) => {
    ctx.save();
    ctx.beginPath(); ctx.rect(pL, clipY, cw, clipH); ctx.clip();
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    smoothPath(ctx, pts);
    ctx.strokeStyle = color; ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
    ctx.restore();
  };
  drawLine('#32D74B', pT,    yZero - pT);
  drawLine('#FF9F0A', yZero, pT + ch - yZero);

  // Summary reflects power DRAW only — discharge samples, ignoring charging/plugged-in.
  const draw = allW.filter(x => x < 0).map(x => -x);
  document.getElementById('watts-range').textContent = draw.length
    ? `Avg: ${(draw.reduce((a,b)=>a+b,0) / draw.length).toFixed(1)}W  Peak: ${Math.max(...draw).toFixed(1)}W`
    : 'On charger';
}

/* ── Chart: CPU ──────────────────────────────────────────────────────────────*/
let hoveredProcess  = null;
let cpuBlocksLayout = [];  // [{x, bw, segments:[{proc,y,h,value,isSystem}]}]
let lastLegendKey   = '';

// Per-chart hover crosshair position (0..1 fraction of chart width, or null)
const hoverX = { batt: null, watts: null, cpu: null };

function drawCpu(entries) {
  if (state.cpuView === 'blocks') { drawCpuBlocks(entries); return; }
  drawCpuSmooth(entries);
}

function drawCpuSmooth(entries) {
  const windowed = applyWindow(entries);
  if (windowed.length < 2) { document.getElementById('cpu-empty').classList.remove('hidden'); return; }

  // Rank processes by total CPU across ALL windowed entries (not lttb-reduced),
  // so a process that spiked briefly is still captured and shown.
  const tot = {};
  let mx = 10;
  windowed.forEach(e => Object.entries(e.cpus).forEach(([k, v]) => {
    tot[k] = (tot[k] || 0) + v;
    mx = Math.max(mx, v);
  }));
  const procs = Object.keys(tot).sort((a,b) => tot[b]-tot[a]).slice(0, 10);

  // Clear stale hover if that process isn't in the current window
  if (hoveredProcess && !procs.includes(hoveredProcess)) hoveredProcess = null;

  // Downsample for smooth rendering
  const V = lttb(windowed, 200);
  if (V.length < 2) return;
  const { ctx, w, h } = initCanvas('cpu-canvas');
  const { top: pT, right: pR, bottom: pB, left: pL } = PAD;
  ctx.clearRect(0, 0, w, h);
  if (!procs.length) {
    document.getElementById('cpu-empty').classList.remove('hidden');
    return;
  }
  document.getElementById('cpu-empty').classList.add('hidden');

  const yMax = Math.ceil(mx / 10) * 10 || 10;
  const ch = h - pT - pB, cw = w - pL - pR;
  drawGrid(ctx, w, h, PAD, 4);

  axisStyle(ctx); ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++)
    ctx.fillText(round(yMax*(1-i/4)) + '%', pL - 8, pT + ch*(i/4) + 3.5);

  const t0 = +new Date(V[0].ts), t1 = +new Date(V[V.length-1].ts);
  const span = t1 - t0 || 1;
  const xOf = e => pL + cw * ((+new Date(e.ts) - t0) / span);
  const yOf = v => pT + ch * (1 - v / yMax);

  drawXAxis(ctx, xTicks(t0, t1), pL, pT, cw, ch, h);
  drawCrosshair(ctx, hoverX.cpu, pL, pT, cw, ch);

  for (const proc of [...procs].reverse()) {
    const c = procColor(proc);
    const rgb = hexRgb(c);
    const isHovered = hoveredProcess === proc;
    const isOtherHovered = hoveredProcess && hoveredProcess !== proc;
    const alpha = isHovered ? 1 : isOtherHovered ? 0.05 : 0.18;

    const pts = V.map(e => [xOf(e), yOf(e.cpus[proc] || 0)]);

    // Area
    ctx.globalAlpha = alpha * 0.5;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pT + ch);
    ctx.lineTo(pts[0][0], pts[0][1]);
    smoothPath(ctx, pts);
    ctx.lineTo(pts[pts.length-1][0], pT + ch);
    ctx.closePath();
    ctx.fillStyle = `rgba(${rgb},0.15)`; ctx.fill();

    // Line
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    smoothPath(ctx, pts);
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
    `<div class="legend-item" data-proc="${h(p)}" style="color:${h(procColor(p))}">${h(p)}</div>`
  ).join('');

  legendEl.onmouseenter = e => {
    const item = e.target.closest('.legend-item');
    if (item) { hoveredProcess = item.dataset.proc; drawCpu(state.entries); }
  };
  legendEl.onmouseleave = () => { hoveredProcess = null; drawCpu(state.entries); };
  legendEl.onmouseover = e => {
    const item = e.target.closest('.legend-item');
    if (item && item.dataset.proc !== hoveredProcess) {
      hoveredProcess = item.dataset.proc; drawCpu(state.entries);
    }
  };

  document.getElementById('cpu-range').textContent = '';
}

const rgbCache = {};
function hexRgb(color) {
  if (rgbCache[color]) return rgbCache[color];
  let result;
  if (color.startsWith('#')) {
    result = [parseInt(color.slice(1,3),16), parseInt(color.slice(3,5),16), parseInt(color.slice(5,7),16)].join(',');
  } else {
    const tmp = document.createElement('canvas'); tmp.width = tmp.height = 1;
    const c   = tmp.getContext('2d'); c.fillStyle = color; c.fillRect(0,0,1,1);
    const d   = c.getImageData(0,0,1,1).data;
    result = `${d[0]},${d[1]},${d[2]}`;
  }
  return (rgbCache[color] = result);
}

/* ── CPU blocks helpers ──────────────────────────────────────────────────────*/
function buildBuckets(windowed, procs, N) {
  const t0   = +new Date(windowed[0].ts);
  const t1   = +new Date(windowed[windowed.length-1].ts);
  const span = (t1 - t0) || 1;
  const sums   = Array.from({length: N}, () => ({}));
  const counts = new Array(N).fill(0);

  for (const e of windowed) {
    const b = Math.min(N-1, Math.floor(((+new Date(e.ts) - t0) / span) * N));
    counts[b]++;
    for (const proc of procs) sums[b][proc] = (sums[b][proc] || 0) + (e.cpus[proc] || 0);
  }

  const buckets = [];
  let lastFilled = null;
  for (let b = 0; b < N; b++) {
    if (counts[b] > 0) {
      const avg = {};
      for (const proc of procs) avg[proc] = (sums[b][proc] || 0) / counts[b];
      lastFilled = avg;
      buckets.push({ ...avg });
    } else {
      buckets.push(lastFilled ? { ...lastFilled } : Object.fromEntries(procs.map(p => [p, 0])));
    }
  }
  return buckets;
}

function drawCpuBlocks(entries) {
  const windowed = applyWindow(entries);
  if (windowed.length < 2) { document.getElementById('cpu-empty').classList.remove('hidden'); return; }

  const tot = {};
  windowed.forEach(e => Object.entries(e.cpus).forEach(([k, v]) => { tot[k] = (tot[k] || 0) + v; }));
  const allProcs = Object.keys(tot).sort((a, b) => tot[b] - tot[a]).slice(0, 10);
  if (!allProcs.length) { document.getElementById('cpu-empty').classList.remove('hidden'); return; }
  document.getElementById('cpu-empty').classList.add('hidden');

  if (hoveredProcess && !allProcs.includes(hoveredProcess)) hoveredProcess = null;

  // Classify — preserve size-sort order within each group
  const lastWithUsers = [...windowed].reverse().find(e => e.procUsers && Object.keys(e.procUsers).length);
  const procUsers = lastWithUsers ? lastWithUsers.procUsers : {};
  const sysProcs  = allProcs.filter(p =>  isSystemProcess(p, procUsers[p]));
  const userProcs = allProcs.filter(p => !isSystemProcess(p, procUsers[p]));
  // Draw order: system first from bottom, then user on top — both groups largest-at-bottom
  const drawOrder = [...sysProcs, ...userProcs];

  const { ctx, w, h } = initCanvas('cpu-canvas');
  const { top: pT, right: pR, bottom: pB, left: pL } = PAD;
  ctx.clearRect(0, 0, w, h);

  const ch = h - pT - pB, cw = w - pL - pR;
  const N       = Math.max(40, Math.min(120, Math.floor(cw / 8)));
  const buckets = buildBuckets(windowed, allProcs, N);

  let peakStack = 0;
  for (const bkt of buckets) {
    const total = allProcs.reduce((s, p) => s + (bkt[p] || 0), 0);
    if (total > peakStack) peakStack = total;
  }
  const yMax    = Math.ceil(Math.max(peakStack, 10) / 10) * 10;
  const bucketW = cw / N;

  drawGrid(ctx, w, h, PAD, 4);

  axisStyle(ctx); ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++)
    ctx.fillText(Math.round(yMax * (1 - i/4)) + '%', pL - 8, pT + ch*(i/4) + 3.5);

  const t0 = +new Date(windowed[0].ts);
  const t1 = +new Date(windowed[windowed.length-1].ts);
  drawXAxis(ctx, xTicks(t0, t1), pL, pT, cw, ch, h);
  drawCrosshair(ctx, hoverX.cpu, pL, pT, cw, ch);

  cpuBlocksLayout = [];
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';

  for (let b = 0; b < N; b++) {
    const x        = pL + b * bucketW;
    const bw       = Math.max(1, bucketW - 1);
    const bkt      = buckets[b];
    const segments = [];
    let yBase      = pT + ch;

    for (const proc of drawOrder) {
      const val  = bkt[proc] || 0;
      const segH = Math.min((val / yMax) * ch, yBase - pT);
      if (segH <= 0) continue;

      const sysRank = sysProcs.indexOf(proc);
      const isSys   = sysRank !== -1;
      const color   = isSys ? sysGrey(sysRank, sysProcs.length, isDark) : procColor(proc);
      const alpha   = hoveredProcess === null ? 0.75 : hoveredProcess === proc ? 1.0 : 0.2;
      ctx.globalAlpha = alpha;
      ctx.fillStyle   = color;
      ctx.fillRect(x, yBase - segH, bw, segH);

      segments.push({ proc, y: yBase - segH, h: segH, value: val, isSystem: isSys, color });
      yBase -= segH;
    }

    cpuBlocksLayout.push({ x, bw, segments });
  }
  ctx.globalAlpha = 1;

  // Legend: user procs first (colored), then system procs (grey, muted)
  // Only rebuild DOM when the process list or theme actually changes — prevents
  // layout thrash on every RAF frame which would interfere with the expand transition.
  const legendEl = document.getElementById('cpu-legend');
  const legendKey = userProcs.join(',') + '|' + sysProcs.join(',') + '|' + (isDark ? 'd' : 'l');
  if (legendKey !== lastLegendKey) {
    lastLegendKey = legendKey;
    legendEl.innerHTML = [
      ...userProcs.map(p =>
        `<div class="legend-item" data-proc="${h(p)}" style="color:${h(procColor(p))}">${h(p)}</div>`),
      ...sysProcs.map((p, i) =>
        `<div class="legend-item legend-item-sys" data-proc="${h(p)}" style="color:${h(sysGrey(i, sysProcs.length, isDark))}">${h(p)}</div>`),
    ].join('');

    legendEl.onmouseover = e => {
      const item = e.target.closest('.legend-item');
      if (item && item.dataset.proc !== hoveredProcess) {
        hoveredProcess = item.dataset.proc;
        drawCpuBlocks(state.entries);
      }
    };
    legendEl.onmouseleave = () => {
      hoveredProcess = null;
      drawCpuBlocks(state.entries);
    };
  }

  document.getElementById('cpu-range').textContent = '';
}

function handleCpuBlocksHover(e) {
  const canvas = document.getElementById('cpu-canvas');
  const rect   = canvas.getBoundingClientRect();
  const mx     = e.clientX - rect.left;
  const my     = e.clientY - rect.top;

  let found = null;
  outer: for (const bucket of cpuBlocksLayout) {
    if (mx < bucket.x || mx > bucket.x + bucket.bw) continue;
    for (const seg of bucket.segments) {
      if (my >= seg.y && my <= seg.y + seg.h) { found = seg.proc; break outer; }
    }
  }

  if (found !== hoveredProcess) {
    hoveredProcess = found;
    drawCpuBlocks(state.entries);
  }

  if (found) {
    showCpuBlockTooltip(e.clientX, e.clientY, found, mx);
  } else {
    hideTooltip();
  }
}

function showCpuBlockTooltip(clientX, clientY, proc, canvasX) {
  const bucket = cpuBlocksLayout.find(b => canvasX >= b.x && canvasX <= b.x + b.bw);
  const seg    = bucket ? bucket.segments.find(s => s.proc === proc) : null;
  const val      = seg ? seg.value : 0;
  const isSystem = seg ? seg.isSystem : false;
  const color    = seg ? seg.color : procColor(proc);

  // Determine user owner from last entries
  const lastWithUsers = [...state.entries].reverse().find(e => e.procUsers && e.procUsers[proc]);
  const owner  = lastWithUsers ? lastWithUsers.procUsers[proc] : null;
  const desc   = SYSTEM_PROC_INFO[proc];

  const badge  = isSystem
    ? `<span style="color:var(--text-tertiary);font-size:10px">System${desc ? ' · ' + h(desc) : ''}</span>`
    : `<span style="color:var(--text-tertiary);font-size:10px">User process</span>`;

  // Estimate timestamp for hovered bucket from current data range
  const windowed = applyWindow(state.entries);
  let bucketTs = null;
  if (windowed.length >= 2 && hoverX.cpu !== null) {
    const t0b = +new Date(windowed[0].ts), t1b = +new Date(windowed[windowed.length-1].ts);
    bucketTs = new Date(t0b + hoverX.cpu * (t1b - t0b));
  }

  const tt = document.getElementById('tooltip');
  document.getElementById('tt-time').textContent = bucketTs
    ? new Date(bucketTs).toLocaleString([], {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }) + '  ·  ' + timeAgo(bucketTs)
    : proc;
  document.getElementById('tt-body').innerHTML =
    `<div class="tooltip-row">
       <span class="tooltip-label">
         <span class="tooltip-dot" style="background:${h(color)}"></span>${h(proc)}
       </span>
       <span class="tooltip-value">${val.toFixed(1)}%</span>
     </div>
     <div style="margin-top:4px">${badge}</div>
     ${owner ? `<div style="color:var(--text-tertiary);font-size:10px;margin-top:2px">Owner: ${h(owner)}</div>` : ''}`;

  const W = tt.offsetWidth || 200, H = tt.offsetHeight || 100;
  tt.style.left    = (clientX + 16 + W > window.innerWidth  ? clientX - W - 16 : clientX + 16) + 'px';
  tt.style.top     = (clientY - 10 + H > window.innerHeight ? window.innerHeight - H - 10 : clientY - 10) + 'px';
  tt.style.display = 'block';
}

/* ── Window filter ───────────────────────────────────────────────────────────*/
function applyWindow(entries) {
  if (!state.windowMs || !entries.length) return entries;
  const cutoff = +new Date(entries[entries.length-1].ts) - state.windowMs;
  return entries.filter(e => +new Date(e.ts) >= cutoff);
}

/* ── Sidebar ─────────────────────────────────────────────────────────────────*/
function renderSidebar() {
  const live = state.latest;
  if (!live) return;

  // Battery %
  if (live.battery != null)
    document.getElementById('sb-batt-num').textContent = live.battery + '%';

  // connected = charger physically present (ExternalConnected) — updates immediately on plug/unplug
  // charging  = current actively flowing in (IsCharging) — may lag or be false at ~100% optimization
  const connected  = live.connected;
  const isCharging = live.charging;

  // State label and dot: driven by connected, not IsCharging
  const stateEl = document.getElementById('sb-state');
  // Three states: "Charging" only when current actually flows in — a plugged
  // Mac that is holding or draining its battery says "Plugged In" instead,
  // so the header can never contradict the watts label below it.
  stateEl.querySelector('.state-text').textContent =
    connected ? (isCharging ? 'Charging' : 'Plugged In') : 'On Battery';
  stateEl.className = 'battery-state ' + (connected ? 'charging' : 'discharging');

  // Time left
  const tl = document.getElementById('sb-timeleft');
  const tlLabel = document.getElementById('sb-timeleft-label');
  if (live.timeLeft) {
    const [hh, mm] = live.timeLeft.split(':').map(Number);
    tl.textContent = hh > 0 ? `${hh}h ${mm}m` : `${mm}m`;
    tlLabel.textContent = connected ? 'until full' : 'remaining';
    tl.style.color = connected ? 'var(--color-green)'
      : hh < 1 ? 'var(--color-red)' : hh < 3 ? 'var(--color-orange)' : 'var(--text-primary)';
  } else {
    tl.textContent = '—';
    tlLabel.textContent = connected ? 'until full' : 'remaining';
    tl.style.color = 'var(--text-tertiary)';
  }

  // Watts + adapter info
  const wv = document.getElementById('sb-watts');
  const wvLabel = document.getElementById('sb-watts-label');
  if (live.amperage != null && live.voltage != null) {
    const watts = (live.amperage * live.voltage) / 1e6;
    wv.textContent = Math.abs(watts).toFixed(1) + 'W';
    // InstantAmperage is noisy around zero (±0.5W even unplugged), so color
    // and verb use a deadband. Plugged in: green unless the battery is
    // meaningfully feeding the system; unplugged: never "charging".
    if (connected && live.adapter) {
      const a = live.adapter;
      const draining = watts < -0.5;
      const verb = isCharging ? 'charging' : draining ? 'draining' : 'plugged';
      wv.style.color = draining ? 'var(--color-orange)' : 'var(--color-green)';
      wvLabel.textContent = `${verb} · ${a.watts}W${a.voltage ? ` @ ${a.voltage}V` : ''}`;
    } else {
      const gaining = connected && watts >= 0;
      wv.style.color = gaining ? 'var(--color-green)' : 'var(--color-orange)';
      wvLabel.textContent = gaining ? 'charging' : 'discharging';
    }
    wvLabel.style.color = '';
  } else {
    wv.textContent = '—';
    wv.style.color = 'var(--text-tertiary)';
    wvLabel.textContent = '—';
    wvLabel.style.color = '';
  }

  // Process list and assertions come from last DB entry (don't change every second)
  const entries = state.entries;
  if (entries.length) {
    const l = entries[entries.length - 1];
    renderProcessList(l.cpus, l.mem || {}, l.procUsers || {});
    renderAssertions(l.assertions);
  }

  renderMemBar(live.memFree);
}

// Parse a memory string ("16 GB", "1.2 GB", "512 MB") to GB float
function parseMemGB(str) {
  if (!str) return null;
  const m = String(str).match(/([\d.]+)\s*(TB|GB|MB|KB)?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const u = (m[2] || 'GB').toUpperCase();
  return u === 'TB' ? n * 1024 : u === 'MB' ? n / 1024 : u === 'KB' ? n / 1048576 : n;
}

function renderMemBar(memFreeStr) {
  const el = document.getElementById('sb-mem-free');
  if (!el) return;
  const si = state.sysInfo;
  const totalGB = si && parseMemGB(si.memory);
  const freeGB  = parseMemGB(memFreeStr);
  if (!totalGB || freeGB == null) {
    el.innerHTML = memFreeStr
      ? `<span class="mem-bar-sub">${h(memFreeStr)} free</span>` : '';
    return;
  }
  const usedGB  = Math.max(0, totalGB - freeGB);
  const pct = Math.round(Math.max(0, Math.min(1, usedGB / totalGB)) * 100);
  el.innerHTML =
    `<div class="mem-card">
       <div class="mem-card-top">
         <span class="mem-card-label">Memory</span>
         <span class="mem-card-value">${pct}<span class="mem-card-unit">%</span></span>
       </div>
       <div class="mem-bar-track">
         <div class="mem-bar-fill" style="width:${pct}%"></div>
       </div>
       <div class="mem-card-foot">
         <span>${usedGB.toFixed(1)} GB used</span>
         <span>${freeGB.toFixed(1)} GB free</span>
       </div>
     </div>`;
}

function formatMem(kb) {
  if (kb >= 1048576) return (kb / 1048576).toFixed(1) + 'GB';
  if (kb >= 1024) return Math.round(kb / 1024) + 'MB';
  return kb + 'KB';
}

function renderProcessList(cpus, mem = {}, procUsers = {}) {
  const sorted = Object.entries(cpus).sort((a,b) => b[1]-a[1]).slice(0, 8);

  if (!sorted.length) {
    document.getElementById('proc-list').innerHTML =
      '<div style="font-size:12px;color:var(--text-tertiary);padding:8px 0">Idle</div>';
    return;
  }

  // Match the CPU chart's colour scheme: system processes get grey shades by rank,
  // user processes get palette colours — so a sidebar dot maps to its chart band.
  const isDark   = document.documentElement.getAttribute('data-theme') !== 'light';
  const sysNames = sorted.map(([n]) => n).filter(n => isSystemProcess(n, procUsers[n]));
  const colorFor = name => {
    const r = sysNames.indexOf(name);
    return r !== -1 ? sysGrey(r, sysNames.length, isDark) : procColor(name);
  };

  document.getElementById('proc-list').innerHTML = sorted.map(([name, cpu]) => {
    const c = colorFor(name);
    const rss = mem[name];

    const memStr = rss ? formatMem(rss) : '';
    return `<div class="process-item">
      <span class="process-dot" style="background:${h(c)}"></span>
      <span class="process-name">${h(name)}</span>
      <span class="process-stat">
        <span class="process-cpu">${h(cpu.toFixed(1))}%</span>
        <span class="process-mem">${h(memStr)}</span>
      </span>
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
    return `<span class="assertion-pill">${m ? h(m[1].trim()) + ' → ' + h(m[2].trim()) : h(a)}</span>`;
  }).join('');
}

/* ── Render ──────────────────────────────────────────────────────────────────*/
function render() {
  if (document.hidden) return;
  const E = state.entries;
  drawBattery(E);
  drawWatts(E);
  drawCpu(E);
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

/* ── Data listeners ──────────────────────────────────────────────────────────*/
// Chart data — fires ~every 60s when logger writes a new DB entry
if (window.api && window.api.onLogUpdate) {
  window.api.onLogUpdate((data) => {
    state.entries = data.entries || data;
    if (data.sysInfo) {
      state.sysInfo = data.sysInfo;
      const si = data.sysInfo;
      document.getElementById('main-title').textContent =
        si.chip ? `${si.model} · ${si.chip}` : si.model || 'MacBook';
    }
    // Seed state.latest from last DB entry so sidebar shows immediately
    // before the first live-update arrives (~1s after load)
    if (!state.latest && state.entries.length) {
      const l = state.entries[state.entries.length - 1];
      state.latest = {
        battery:  l.battery,  charging: l.charging,
        amperage: l.amperage, voltage:  l.voltage,
        timeLeft: l.timeLeft, adapter:  null, memFree: null,
      };
      renderSidebar();
    }
    render();
  });
}

// Live sidebar — fires every 1s from IORegistry, no DB involved
if (window.api && window.api.onLiveUpdate) {
  window.api.onLiveUpdate((live) => {
    state.latest = live;
    renderSidebar();
  });
}

/* ── Range selector ──────────────────────────────────────────────────────────*/
document.getElementById('range-bar').addEventListener('click', e => {
  const btn = e.target.closest('.range-btn');
  if (!btn) return;
  document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const min = parseInt(btn.dataset.min);
  state.windowMs = min * 60000;
  if (window.api && window.api.setTimeRange) window.api.setTimeRange(min);
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
    new Date(entry.ts).toLocaleString([], {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }) + '  ·  ' + timeAgo(entry.ts);

  let html = `<div class="tooltip-row">
    <span class="tooltip-label">Battery</span>
    <span class="tooltip-value">${h(entry.battery)}%${entry.charging ? ' ⚡' : ''}</span>
  </div>`;

  if (watts !== null) {
    const cls = watts >= 0 ? 'tt-charging' : 'tt-discharging';
    html += `<div class="tooltip-row">
      <span class="tooltip-label">Power</span>
      <span class="tooltip-value ${cls}">${watts >= 0 ? '+' : ''}${h(watts.toFixed(2))}W</span>
    </div>`;
  }
  if (entry.amperage != null) {
    const cls = entry.amperage > 0 ? 'tt-charging' : 'tt-discharging';
    html += `<div class="tooltip-row">
      <span class="tooltip-label">Amperage</span>
      <span class="tooltip-value ${cls}">${entry.amperage > 0 ? '+' : ''}${h(entry.amperage)}mA</span>
    </div>`;
  }
  if (entry.voltage != null) {
    html += `<div class="tooltip-row">
      <span class="tooltip-label">Voltage</span>
      <span class="tooltip-value">${h((entry.voltage/1000).toFixed(2))}V</span>
    </div>`;
  }
  if (entry.cpus && Object.keys(entry.cpus).length) {
    const top = Object.entries(entry.cpus).sort((a,b) => b[1]-a[1]).filter(([,v]) => v > 0.5).slice(0, 5);
    if (top.length) {
      html += `<div style="height:1px;background:var(--border-subtle);margin:6px 0"></div>`;
      top.forEach(([name, cpu]) =>
        html += `<div class="tooltip-row">
          <span class="tooltip-label">
            <span class="tooltip-dot" style="background:${h(procColor(name))}"></span>${h(name)}
          </span>
          <span class="tooltip-value">${h(cpu.toFixed(1))}%</span>
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

// Convert clientX to 0..1 fraction within the chart's data area
function toHoverFrac(clientX, rect) {
  const frac = (clientX - rect.left - PAD.left) / (rect.width - PAD.left - PAD.right);
  return Math.max(0, Math.min(1, frac));
}

function setupHover() {
  // Generic handler for battery and watts (smooth line charts)
  [
    { id: 'batt-canvas',  key: 'batt',  draw: drawBattery },
    { id: 'watts-canvas', key: 'watts', draw: drawWatts   },
  ].forEach(({ id, key, draw }) => {
    const canvas = document.getElementById(id);
    canvas.addEventListener('mousemove', e => {
      const V = applyWindow(state.entries);
      if (V.length < 2) return;
      const rect = canvas.getBoundingClientRect();
      hoverX[key] = toHoverFrac(e.clientX, rect);
      draw(state.entries);
      showTooltip(e.clientX, e.clientY, nearestEntry(e.clientX - rect.left, rect.width, V));
    });
    canvas.addEventListener('mouseleave', () => {
      hoverX[key] = null;
      draw(state.entries);
      hideTooltip();
    });
  });

  // CPU canvas — blocks or smooth mode
  const cpuCanvas = document.getElementById('cpu-canvas');
  cpuCanvas.addEventListener('mousemove', e => {
    const rect = cpuCanvas.getBoundingClientRect();
    hoverX.cpu = toHoverFrac(e.clientX, rect);
    if (state.cpuView === 'blocks') {
      handleCpuBlocksHover(e);           // handles its own redraw + tooltip
    } else {
      const V = applyWindow(state.entries);
      if (V.length < 2) return;
      drawCpuSmooth(state.entries);
      showTooltip(e.clientX, e.clientY, nearestEntry(e.clientX - rect.left, rect.width, V));
    }
  });
  cpuCanvas.addEventListener('mouseleave', () => {
    hoverX.cpu = null;
    if (state.cpuView === 'blocks') {
      hoveredProcess = null;
      drawCpuBlocks(state.entries);
    } else {
      drawCpuSmooth(state.entries);
    }
    hideTooltip();
  });
}

/* ── Resize ──────────────────────────────────────────────────────────────────*/
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 100); });

setupHover();

/* ── Model-name hover panel ──────────────────────────────────────────────────*/
function buildSiPanel(si, memFree) {
  if (!si) return '<div class="si-loading">Loading…</div>';

  const row = (label, value, cls = '') =>
    `<div class="si-row">
       <span class="si-label">${h(label)}</span>
       <span class="si-value${cls ? ' ' + h(cls) : ''}">${h(value)}</span>
     </div>`;

  const div = (cls) => `<div class="${cls}"></div>`;

  // CPU cores
  let cpuVal = si.cores ? si.cores + ' cores' : '?';
  if (si.pCores && si.eCores) {
    const pl = si.pLabel || 'Performance';
    cpuVal = `${si.pCores} ${pl} · ${si.eCores} Efficiency`;
  }

  // Battery health colour
  const pct = si.battHealth && si.battHealth.maxCapacity
    ? parseInt(si.battHealth.maxCapacity) : null;
  const healthCls = pct === null ? '' : pct >= 85 ? 'si-green' : pct >= 70 ? 'si-orange' : 'si-red';

  // RAM line: total always shown, free appended when available
  // Note: ramVal is inserted via a dedicated path below (not through row()) to allow the inner span
  const ramVal = memFree
    ? `${h(si.memory)} <span class="si-dim">· ${h(memFree)} free</span>`
    : h(si.memory || '?');

  // RAM row is built separately so we can embed a safe inner <span> for the "free" label
  const ramRow = `<div class="si-row">
    <span class="si-label">RAM</span>
    <span class="si-value">${ramVal}</span>
  </div>`;

  let html = `
    <div class="si-head">
      <div class="si-model-name">${h(si.model || 'Mac')}</div>
      <div class="si-chip-name">Apple ${h(si.chip || '')}</div>
    </div>
    ${div('si-sep')}
    <div class="si-section">
      ${row('CPU', cpuVal)}
      ${si.gpuCores ? row('GPU', si.gpuCores + ' cores') : ''}
      ${ramRow}
    </div>`;

  if (si.battHealth && (si.battHealth.maxCapacity || si.battHealth.cycleCount)) {
    const b = si.battHealth;
    html += `
    ${div('si-sep')}
    <div class="si-section si-section-label">Battery</div>
    <div class="si-section">
      ${b.maxCapacity ? row('Health', b.maxCapacity, healthCls) : ''}
      ${b.cycleCount  ? row('Cycles', b.cycleCount)             : ''}
      ${b.fullCharge && b.designCap
          ? row('Capacity', `${parseInt(b.fullCharge).toLocaleString()} / ${parseInt(b.designCap).toLocaleString()} mAh`)
          : ''}
      ${b.condition   ? row('Condition', b.condition)           : ''}
    </div>`;
  }

  if (si.macOS) {
    html += `
    ${div('si-sep')}
    <div class="si-section">
      ${row('macOS', si.macOS)}
    </div>`;
  }

  return html;
}

function positionSiPanel(trigger, panel) {
  const rect = trigger.getBoundingClientRect();
  panel.style.left = Math.min(rect.left, window.innerWidth - panel.offsetWidth - 8) + 'px';
  panel.style.top  = (rect.bottom + 8) + 'px';
}

(function setupModelTooltip() {
  const trigger = document.getElementById('main-title');
  const panel   = document.getElementById('model-tooltip');
  if (!trigger || !panel) return;

  trigger.addEventListener('mouseenter', () => {
    // Use live memFree from the 1s IORegistry loop
    const memFree = state.latest && state.latest.memFree;
    panel.innerHTML = buildSiPanel(state.sysInfo, memFree);
    panel.style.display = 'block';
    positionSiPanel(trigger, panel);
  });

  trigger.addEventListener('mouseleave', () => { panel.style.display = 'none'; });
})();


/* ── Chart expand/collapse (overlay mode) ────────────────────────────────────*/
(function setupChartExpand() {
  const cards = Array.from(document.querySelectorAll('.chart-card'));
  const container = document.querySelector('.charts');
  let mdX = 0, mdY = 0;
  let saved = null; // { card, top, left, w, h } — original viewport rect before expand

  // ResizeObserver redraws only the chart whose card changed size — no RAF loop needed
  const cardDrawMap = {
    batt:  () => drawBattery(state.entries),
    watts: () => drawWatts(state.entries),
    cpu:   () => drawCpu(state.entries),
  };
  const ro = new ResizeObserver(entries => {
    for (const entry of entries) {
      const fn = cardDrawMap[entry.target.dataset.chartId];
      if (fn) fn();
    }
  });
  cards.forEach(c => ro.observe(c));

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

    // Now set destination — CSS transition fires from here
    card.style.top    = destT + 'px';
    card.style.left   = destL + 'px';
    card.style.width  = destW + 'px';
    card.style.height = destH + 'px';
  }

  function doCollapse() {
    if (!saved) return;
    const { card, top, left, w, h } = saved;
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
      if (!state.expandedChart) restoreAll();
      render();
    });

    card.addEventListener('mousedown', e => { mdX = e.clientX; mdY = e.clientY; });
    card.addEventListener('click', e => {
      if (e.target.closest('.legend-item')) return;
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
