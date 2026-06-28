const { app, BrowserWindow, nativeTheme, Menu, ipcMain, powerMonitor, systemPreferences, clipboard } = require("electron");
const Database = require("better-sqlite3");
const { join } = require("path");
const { homedir } = require("os");
const { execSync } = require("child_process");
const fs = require("fs");

const DB_PATH = join(homedir(), ".local", "powermon.db");

/* ── Liquid Glass (macOS 26+) ────────────────────────────────────────────── */
// Real NSGlassEffectView via electron-liquid-glass. When available we skip
// Electron's vibrancy entirely — it would render on top and look frosted.
let liquidGlass = null;
try {
  const lg = require('electron-liquid-glass');
  if (lg.isGlassSupported()) liquidGlass = lg;
} catch {}

// Test presets, switchable via View ▸ Glass Style. Tint changes require a
// fresh addView (the addon only applies tint at creation) — addView removes
// the previous glass view internally, so re-adding is safe.
const GLASS_PRESETS = {
  'Default (Scrim)':     { variant: 0, scrim: 1 },
  'Pure Glass':          { variant: 0 },
  'Clear':               { variant: 1 },
  'Clear + Dark Tint':   { variant: 1, tint: '#00000040' },
  'Regular + Dark Tint': { variant: 0, tint: '#00000040' },
  'Control Center':      { variant: 8, scrim: 1 },
  'Subdued':             { variant: 0, subdued: 1 },
};
const DEFAULT_GLASS_PRESET = 'Default (Scrim)';

function applyGlassPreset(name) {
  if (!liquidGlass || !mainWindow || mainWindow.isDestroyed()) return;
  const p = GLASS_PRESETS[name] || GLASS_PRESETS[DEFAULT_GLASS_PRESET];
  try {
    const opts = { cornerRadius: 12 };
    if (p.tint) opts.tintColor = p.tint;
    const id = liquidGlass.addView(mainWindow.getNativeWindowHandle(), opts);
    if (id === -1) return;
    liquidGlass.setVariant(id, p.variant ?? 0);
    liquidGlass.unstable_setScrim(id, p.scrim ? 1 : 0);
    liquidGlass.unstable_setSubdued(id, p.subdued ? 1 : 0);
  } catch (e) { console.error('glass preset failed:', e.message); }
}

/* ── Logger / LaunchAgent constants ─────────────────────────────────────── */
const PLIST_LABEL  = 'com.delfinsoft.powermonitor';
const PLIST_PATH   = join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
const LOGGER_DEST  = join(homedir(), '.local', 'bin', 'powermonitor-logger.js');
const LOG_OUT      = join(homedir(), '.local', 'logs', 'powermonitor.log');
const LOG_ERR      = join(homedir(), '.local', 'logs', 'powermonitor.err');

let mainWindow;
let db;

/* ── Settings ────────────────────────────────────────────────────────────── */
const SETTINGS_DEFAULTS = { theme: 'system', timeRange: 43200, cpuView: 'blocks', windowBounds: { width: 920, height: 680 } };
let settings = { ...SETTINGS_DEFAULTS };

function settingsPath() { return join(app.getPath('userData'), 'settings.json'); }

function loadSettings() {
  try {
    const p = settingsPath();
    if (fs.existsSync(p)) settings = { ...SETTINGS_DEFAULTS, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch {}
}

function saveSettings() {
  try {
    const p = settingsPath();
    fs.mkdirSync(join(p, '..'), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(settings, null, 2));
  } catch (e) { console.error('Settings save failed:', e.message); }
}

/* ── Model / chip name tables ────────────────────────────────────────────── */
const CHIP_NAMES = {
  'Mac17,3': 'M4 Chip',   'Mac17,4': 'M4 Chip',
  'Mac16,1': 'M4 Pro',    'Mac16,2': 'M4 Pro',    'Mac16,3': 'M4 Chip',
  'Mac16,6': 'M4 Max',    'Mac16,7': 'M4 Max',
  'Mac16,8': 'M4 Chip',   'Mac16,10': 'M4 Pro',
  'Mac16,12': 'M3 Chip',  'Mac16,13': 'M3 Chip',
  'Mac15,3': 'M3 Chip',   'Mac15,4': 'M3 Chip',   'Mac15,5': 'M3 Chip',
  'Mac15,6': 'M3 Pro',    'Mac15,7': 'M3 Max',
  'Mac15,9': 'M3 Pro',    'Mac15,10': 'M3 Max',   'Mac15,11': 'M3 Max',
  'Mac15,12': 'M3 Chip',  'Mac15,13': 'M3 Chip',
  'Mac14,2': 'M2 Chip',   'Mac14,15': 'M2 Chip',
  'Mac14,3': 'M2 Chip',   'Mac14,12': 'M2 Pro',
  'Mac14,5': 'M2 Pro',    'Mac14,6': 'M2 Pro',    'Mac14,7': 'M2 Chip',
  'Mac14,9': 'M2 Pro',    'Mac14,10': 'M2 Pro',
  'Mac14,13': 'M2 Max',   'Mac14,14': 'M2 Ultra',
  'Mac13,1': 'M1 Max',    'Mac13,2': 'M1 Ultra',
  'MacBookAir10,1': 'M1 Chip', 'MacBookPro17,1': 'M1 Chip',
  'MacBookPro18,1': 'M1 Pro',  'MacBookPro18,2': 'M1 Max',
  'MacBookPro18,3': 'M1 Pro',  'MacBookPro18,4': 'M1 Max',
  'Macmini9,1': 'M1 Chip', 'iMac21,1': 'M1 Chip', 'iMac21,2': 'M1 Chip',
};

const FRIENDLY_NAMES = {
  'Mac17,3': 'MacBook Air 13"', 'Mac17,4': 'MacBook Air 15"',
  'Mac16,12': 'MacBook Air 13"', 'Mac16,13': 'MacBook Air 15"',
  'Mac14,2':  'MacBook Air 13"', 'Mac14,15': 'MacBook Air 15"',
  'MacBookAir10,1': 'MacBook Air 13"',
  'MacBookAir9,1':  'MacBook Air 13"', 'MacBookAir8,2': 'MacBook Air 13"', 'MacBookAir8,1': 'MacBook Air 13"',
  'Mac16,1':  'MacBook Pro 14"', 'Mac16,2':  'MacBook Pro 16"',
  'Mac16,3':  'MacBook Pro 14"', 'Mac16,6':  'MacBook Pro 16"', 'Mac16,7': 'MacBook Pro 14"',
  'Mac15,3':  'MacBook Pro 14"', 'Mac15,6':  'MacBook Pro 14"', 'Mac15,7': 'MacBook Pro 14"',
  'Mac15,9':  'MacBook Pro 16"', 'Mac15,10': 'MacBook Pro 16"', 'Mac15,11': 'MacBook Pro 14"',
  'Mac14,5':  'MacBook Pro 14"', 'Mac14,6':  'MacBook Pro 16"',
  'Mac14,7':  'MacBook Pro 13"', 'Mac14,9':  'MacBook Pro 14"', 'Mac14,10': 'MacBook Pro 16"',
  'MacBookPro18,1': 'MacBook Pro 16"', 'MacBookPro18,2': 'MacBook Pro 16"',
  'MacBookPro18,3': 'MacBook Pro 14"', 'MacBookPro18,4': 'MacBook Pro 14"',
  'MacBookPro17,1': 'MacBook Pro 13"',
  'Mac16,8':  'Mac mini', 'Mac16,10': 'Mac mini',
  'Mac14,3':  'Mac mini', 'Mac14,12': 'Mac mini', 'Macmini9,1': 'Mac mini',
  'Mac15,4': 'iMac 24"',  'Mac15,5': 'iMac 24"',
  'iMac21,1': 'iMac 24"', 'iMac21,2': 'iMac 24"',
  'Mac14,13': 'Mac Studio', 'Mac14,14': 'Mac Studio',
  'Mac13,1':  'Mac Studio', 'Mac13,2':  'Mac Studio',
};

/* ── Database (read-only) ────────────────────────────────────────────────── */
function connectDb() {
  try {
    db = new Database(DB_PATH, { readonly: true });
  } catch (e) {
    console.error("Failed to open DB:", e.message);
    return false;
  }
  return true;
}

/* ── Query entries ───────────────────────────────────────────────────────── */
function queryEntries(minutesBack = 43200) {
  if (!db) return [];
  try {
    // Query by timestamp (indexed) rather than a raw row LIMIT so "30d" actually
    // returns 30 days of data instead of an arbitrary row count.
    const cutoff = Math.floor(Date.now() / 1000) - minutesBack * 60;
    const rows = db.prepare(`
      SELECT ts, ts_unix, battery, charging, amperage, voltage,
             time_remaining_mins, processdetails
      FROM power_log
      WHERE ts_unix >= ?
      ORDER BY ts_unix DESC
      LIMIT 50000
    `).all(cutoff);

    const pad = n => String(n).padStart(2, '0');

    return rows.map(row => {
      let pd = {};
      try { pd = JSON.parse(row.processdetails || "{}"); } catch {}
      const cpus = {}, mem = {}, procUsers = {};
      (pd.processes || []).forEach(p => {
        if (p.name) {
          cpus[p.name] = p.cpu || 0;
          mem[p.name]  = p.mem || p.rss || 0;
          if (p.user) procUsers[p.name] = p.user;
        }
      });

      // Amperage stored as unsigned 64-bit — convert to signed
      let amperage = row.amperage;
      if (amperage !== null && amperage > 9223372036854775807) {
        amperage = amperage - 18446744073709551616;
      }

      // time_remaining_mins (integer) → "H:MM" string for renderer
      const mins = row.time_remaining_mins;
      const timeLeft = mins != null
        ? `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`
        : null;

      // Derive ts from ts_unix as a LOCAL-time string. Stored ts strings are
      // unreliable (legacy loggers wrote local time, current logger writes
      // UTC); the renderer parses ts with new Date() which assumes local.
      const d = new Date(row.ts_unix * 1000);
      const tsLocal = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
                      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

      return {
        ts:        tsLocal,
        ts_unix:   row.ts_unix,
        battery:   row.battery,
        charging:  !!row.charging,
        amperage,
        voltage:   row.voltage,
        cpus,
        mem,
        procUsers,
        timeLeft,
        assertions: pd.assertions || [],
      };
    }).reverse();
  } catch (e) {
    console.error("Query failed:", e.message);
    return [];
  }
}

/* ── App menu ────────────────────────────────────────────────────────────── */
function sendSettings() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send('settings', {
      isDark:    nativeTheme.shouldUseDarkColors,
      timeRange: settings.timeRange,
      cpuView:   settings.cpuView || 'blocks',
      glass:     !!liquidGlass,
    });
  } catch {}
}

const MENU_RANGES = [
  { label: '10 Minutes', min: 10 },
  { label: '1 Hour',     min: 60 },
  { label: '6 Hours',    min: 360 },
  { label: '24 Hours',   min: 1440 },
  { label: '30 Days',    min: 43200 },
];

function buildMenu() {
  const setTheme = (mode) => {
    settings.theme = mode;
    saveSettings();
    nativeTheme.themeSource = mode;
  };
  const setCpuView = (mode) => {
    settings.cpuView = mode;
    saveSettings();
    buildMenu();
    sendSettings();
  };
  const setRange = (min) => {
    settings.timeRange = min;
    saveSettings();
    lastEntryTs = null;   // force re-fetch with new time window
    clearTimeout(dbTimer);
    queryAndSend();
    sendSettings();
  };
  const t = settings.theme;
  const cv = settings.cpuView || 'blocks';
  const tr = settings.timeRange || 43200;
  const template = [
    {
      label: 'PowerMonitor',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Time Range',
          submenu: MENU_RANGES.map((r, i) => ({
            label: r.label,
            type: 'radio',
            accelerator: `Cmd+${i + 1}`,
            checked: tr === r.min,
            click: () => setRange(r.min),
          })),
        },
        { type: 'separator' },
        {
          label: 'Theme',
          submenu: [
            { label: 'System', type: 'radio', checked: t === 'system', click: () => setTheme('system') },
            { label: 'Light',  type: 'radio', checked: t === 'light',  click: () => setTheme('light')  },
            { label: 'Dark',   type: 'radio', checked: t === 'dark',   click: () => setTheme('dark')   },
          ],
        },
        { type: 'separator' },
        {
          label: 'CPU Chart Style',
          submenu: [
            { label: 'Stacked Blocks', type: 'radio', checked: cv === 'blocks', click: () => setCpuView('blocks') },
            { label: 'Smooth',         type: 'radio', checked: cv === 'smooth', click: () => setCpuView('smooth') },
          ],
        },
        // Liquid Glass test presets — only shown when the real material is active
        ...(liquidGlass ? [
          { type: 'separator' },
          {
            label: 'Glass Style',
            submenu: Object.keys(GLASS_PRESETS).map(name => ({
              label: name,
              type: 'radio',
              checked: (settings.glassPreset || DEFAULT_GLASS_PRESET) === name,
              click: () => {
                settings.glassPreset = name;
                saveSettings();
                applyGlassPreset(name);
              },
            })),
          },
        ] : []),
      ],
    },
    { label: 'Window', role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ── Window ──────────────────────────────────────────────────────────────── */
function createWindow() {
  const b = settings.windowBounds || {};
  const opts = {
    width:    b.width  || 920,
    height:   b.height || 680,
    minWidth: 800,
    minHeight: 560,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    transparent: true,
    backgroundColor: '#00000000',
    icon: join(__dirname, "icons", "mac", "icon.icns"),
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
  if (typeof b.x === 'number' && typeof b.y === 'number') { opts.x = b.x; opts.y = b.y; }
  // Fallback material for macOS < 26 (or if the glass addon failed to load)
  if (!liquidGlass) { opts.vibrancy = 'under-window'; opts.visualEffectState = 'active'; }
  mainWindow = new BrowserWindow(opts);
  mainWindow.loadFile(join(__dirname, "src", "index.html"));

  if (liquidGlass) {
    mainWindow.webContents.once('did-finish-load', () => {
      applyGlassPreset(settings.glassPreset || DEFAULT_GLASS_PRESET);
    });
  }

  let boundsTimer;
  const saveBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        settings.windowBounds = mainWindow.getBounds();
        saveSettings();
      }
    }, 500);
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move',   saveBounds);
  mainWindow.on('closed', () => { mainWindow = null; });
}

/* ── System info ─────────────────────────────────────────────────────────── */
function getSystemInfo() {
  try {
    const raw = execSync('system_profiler SPHardwareDataType 2>/dev/null', { timeout: 5000 }).toString();
    const f = key => { const m = raw.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm')); return m ? m[1].trim() : null; };

    const modelId  = f('Model Identifier');
    const chip     = (f('Chip') || '').replace(/^Apple\s+/, '') || CHIP_NAMES[modelId] || '';
    const model    = (modelId && FRIENDLY_NAMES[modelId]) ? FRIENDLY_NAMES[modelId] : (f('Model Name') || 'Mac');
    const memory   = f('Memory') || '?';

    // Core breakdown — M5 says "Super and Efficiency", older chips say "performance and efficiency"
    const coresRaw = f('Total Number of Cores');
    const cores    = coresRaw ? ((coresRaw.match(/^(\d+)/) || [])[1] || '?') : '?';
    const pCores   = coresRaw ? ((coresRaw.match(/(\d+)\s+(?:Super|performance)/i) || [])[1] || null) : null;
    const eCores   = coresRaw ? ((coresRaw.match(/(\d+)\s+(?:Efficiency)/i)        || [])[1] || null) : null;
    const pLabel   = coresRaw && /Super/i.test(coresRaw) ? 'Super' : 'Performance';

    // GPU cores via ioreg (fast, no subprocess overhead)
    let gpuCores = null;
    try {
      const io = execSync('ioreg -r -c AGXAccelerator -d 1 2>/dev/null', { timeout: 3000 }).toString();
      const m  = io.match(/"gpu-core-count"\s*=\s*(\d+)/);
      if (m) gpuCores = m[1];
    } catch {}

    // Battery health via system_profiler
    let battHealth = {};
    try {
      const pwr = execSync('system_profiler SPPowerDataType 2>/dev/null', { timeout: 5000 }).toString();
      const fp  = key => { const m = pwr.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm')); return m ? m[1].trim() : null; };
      battHealth = {
        cycleCount:  fp('Cycle Count'),
        condition:   fp('Condition'),
        maxCapacity: (fp('Maximum Capacity') || '').replace(/\s+%$/, '%'),  // "100 %" → "100%"
        fullCharge:  fp('Full Charge Capacity \\(mAh\\)'),
        designCap:   fp('Battery Design Capacity \\(mAh\\)'),
      };
    } catch {}

    // macOS version
    let macOS = null;
    try { macOS = execSync('sw_vers -productVersion 2>/dev/null', { timeout: 2000 }).toString().trim(); } catch {}

    return { model, chip, cores, pCores, eCores, pLabel, gpuCores, memory, battHealth, macOS };
  } catch {
    return { model: 'Mac', chip: '', cores: '?', memory: '?' };
  }
}

/* ── Live data (1s) — IORegistry + vm_stat, never touches the DB ─────────── */
let memCache = { val: null, at: 0 };

function getLiveData() {
  try {
    const io = execSync('ioreg -r -c AppleSmartBattery -w0 2>/dev/null', { timeout: 2000 }).toString();

    const num  = key => { const m = io.match(new RegExp(`"${key}"\\s*=\\s*(-?\\d+)`)); return m ? parseInt(m[1]) : null; };
    const str  = key => { const m = io.match(new RegExp(`"${key}"\\s*=\\s*"([^"]*)"`)); return m ? m[1] : null; };

    const battery  = num('CurrentCapacity');
    const connected = /"ExternalConnected"\s*=\s*Yes/.test(io);
    const charging  = connected && /"IsCharging"\s*=\s*Yes/.test(io);

    // Amperage (printed as unsigned 64-bit in ioreg). Convert to signed in
    // BigInt — doubles can't represent 2^64-range values and quantize the
    // result to multiples of 2048 (e.g. -578 mA reads as 0).
    // Prefer InstantAmperage: the plain Amperage key is filtered and lags
    // several seconds behind plug/unplug, briefly showing the old sign.
    let amperage = null;
    const am = io.match(/"InstantAmperage"\s*=\s*(-?\d+)/) || io.match(/"Amperage"\s*=\s*(-?\d+)/);
    if (am) {
      let v = BigInt(am[1]);
      if (v > 9223372036854775807n) v -= 18446744073709551616n;
      amperage = Number(v);
    }

    const voltage     = num('Voltage');           // mV
    // 65535 (0xFFFF) is the "calculating, not ready" sentinel — ignore it
    const timeRemRaw  = num('TimeRemaining');
    const timeRemMins = (timeRemRaw != null && timeRemRaw < 65535) ? timeRemRaw : null;

    // Adapter details — negotiated USB-PD contract. ioreg can print several
    // AdapterDetails dicts (an empty {"FamilyCode"=0} when unplugged); scan
    // them all and use the one that actually carries a wattage.
    let adapter = null;
    for (const adMatch of io.matchAll(/"AdapterDetails"\s*=\s*\{([^}]*)\}/g)) {
      const ad = adMatch[1];
      if (!ad.includes('"Watts"')) continue;
      const adNum = k => { const m = ad.match(new RegExp(`"${k}"=(\\d+)`)); return m ? parseInt(m[1]) : null; };
      const watts   = adNum('Watts');
      const voltage_mv = adNum('AdapterVoltage');
      const desc    = (ad.match(/"Description"="([^"]*)"/) || [])[1] || null;
      if (watts) { adapter = { watts, voltage: voltage_mv ? Math.round(voltage_mv / 1000) : null, desc }; break; }
    }

    // Memory used (Activity Monitor formula) + kernel pressure level. Cached 5s —
    // memory drifts slowly and this halves the subprocess cost of the 1s loop.
    let mem = memCache.val;
    if (Date.now() - memCache.at > 5000) {
      try {
        const vm = execSync('vm_stat 2>/dev/null', { timeout: 1000 }).toString();
        // Page size is 16384 on Apple Silicon, 4096 on Intel — never hardcode it
        const pageSize = parseInt(vm.match(/page size of (\d+)/)?.[1] || 4096);
        const pg = name => parseInt(vm.match(new RegExp(name + ':\\s+(\\d+)'))?.[1] || 0);
        // Activity Monitor's "Memory Used" = App Memory (anonymous − purgeable)
        // + wired + compressed. "Free + inactive" is NOT it: macOS keeps RAM
        // deliberately full of reclaimable cache, so that reads ~90% on a healthy Mac.
        const usedMB = Math.round(
          (pg('Pages wired down') + pg('Anonymous pages') - pg('Pages purgeable')
           + pg('Pages occupied by compressor')) * pageSize / 1048576);
        // Kernel pressure level — the signal Activity Monitor charts:
        // 1 normal, 2 warning, 4 critical
        let pressure = 1;
        try {
          pressure = parseInt(execSync('sysctl -n kern.memorystatus_vm_pressure_level',
            { timeout: 1000 }).toString().trim(), 10) || 1;
        } catch {}
        mem = { usedMB, pressure };
        memCache = { val: mem, at: Date.now() };
      } catch {}
    }

    const timeLeft = timeRemMins != null
      ? `${Math.floor(timeRemMins / 60)}:${String(timeRemMins % 60).padStart(2, '0')}`
      : null;

    // Power direction — one settled state for the whole UI (header + watts) so
    // they can never disagree. Derived ONLY from the discrete IORegistry flags,
    // never from the amperage sign: that sign convention is not portable — on
    // this M5, InstantAmperage reads POSITIVE while discharging on battery
    // (verified: unplugged, pmset "discharging", InstantAmperage = +1162), so
    // "negative = draining" silently mislabels charging as draining. The flags
    // are unambiguous. Amperage is used only for the magnitude shown.
    //   not connected            → on battery (discharging)
    //   connected + IsCharging    → charging
    //   connected, not charging   → plugged (powered by adapter, battery held)
    const powerState = !connected ? 'on_battery'
                     : charging    ? 'charging'
                     : 'plugged';

    return { battery, charging, connected, amperage, voltage, timeLeft, adapter, mem, powerState };
  } catch { return null; }
}

function sendLiveData() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const live = getLiveData();
  if (!live) return;
  try { mainWindow.webContents.send('live-update', live); } catch {}
}

/* ── Chart data — DB query, smart-scheduled to fire when new data expected ── */
let lastEntryTs  = null;
let sysInfo      = null;
let dbTimer      = null;

function scheduleNextDbQuery(lastTsUnix) {
  clearTimeout(dbTimer);
  // Logger writes every 60s; ts_unix is UTC epoch seconds, so no string
  // parsing and no timezone traps. Fire 1s after the next entry is due.
  let delay;
  if (!lastTsUnix) {
    delay = 5000;                       // empty DB — check again soon
  } else {
    delay = (lastTsUnix + 61) * 1000 - Date.now();
    if (delay < 0)      delay = delay > -120000 ? 5000 : 60000;  // overdue: brief retries, then 1/min
    else if (delay > 65000) delay = 65000;                        // clock skew guard
  }
  dbTimer = setTimeout(queryAndSend, delay);
}

function queryAndSend() {
  if (!db) return;
  const entries = queryEntries(settings.timeRange || 43200);
  if (!entries.length) { scheduleNextDbQuery(null); return; }
  const latest = entries[entries.length - 1];
  scheduleNextDbQuery(latest.ts_unix); // schedule next check before early-exit
  if (latest.ts === lastEntryTs) return;
  lastEntryTs = latest.ts;
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      const info = sysInfo ? { ...sysInfo } : null;
      mainWindow.webContents.send('log-update', { entries, sysInfo: info });
    } catch {}
  }
}

/* ── Logger setup ────────────────────────────────────────────────────────── */
function isLoggerCurrent() {
  if (!fs.existsSync(PLIST_PATH)) return false;
  try {
    const content = fs.readFileSync(PLIST_PATH, 'utf8');
    return content.includes(process.execPath) && content.includes(LOGGER_DEST);
  } catch { return false; }
}

function writePlist() {
  const resourcesPath = process.resourcesPath;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${process.execPath}</string>
        <string>${LOGGER_DEST}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>ELECTRON_RUN_AS_NODE</key>
        <string>1</string>
        <key>ELECTRON_RESOURCE_PATH</key>
        <string>${resourcesPath}</string>
    </dict>
    <key>StartInterval</key>
    <integer>60</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${LOG_OUT}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_ERR}</string>
</dict>
</plist>`;
  fs.writeFileSync(PLIST_PATH, xml, 'utf8');
}

let setupWin = null;

function showSetupWindow() {
  setupWin = new BrowserWindow({
    width: 340, height: 120,
    resizable: false, minimizable: false, maximizable: false,
    titleBarStyle: 'hiddenInset',
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  setupWin.loadURL(`data:text/html,<html><body style="font-family:-apple-system;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:%231e1e1e;color:%23e8e8e8"><div style="text-align:center"><p style="font-size:15px;margin:0;font-weight:300">Setting up PowerMonitor</p><p style="font-size:12px;color:%23888;margin:8px 0 0">This only happens once</p></div></body></html>`);
}

function closeSetupWindow() {
  if (setupWin && !setupWin.isDestroyed()) { setupWin.close(); setupWin = null; }
}

function runLoggerOnce(loggerPath) {
  try {
    execSync(`"${process.execPath}" "${loggerPath}"`, {
      timeout: 15000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
  } catch (e) { console.error('powermonitor: logger run failed:', e.message); }
}

async function setupLogger() {
  if (!app.isPackaged) {
    const devLoggerPath = join(__dirname, 'logger.js');
    runLoggerOnce(devLoggerPath);
    setInterval(() => runLoggerOnce(devLoggerPath), 60000);
    return;
  }
  if (isLoggerCurrent()) return;

  showSetupWindow();

  try {
    // Ensure directories exist
    fs.mkdirSync(join(homedir(), '.local', 'bin'),  { recursive: true });
    fs.mkdirSync(join(homedir(), '.local', 'logs'), { recursive: true });

    // Copy logger.js from bundle to user home
    const loggerSrc = fs.readFileSync(join(__dirname, 'logger.js'), 'utf8');
    fs.writeFileSync(LOGGER_DEST, loggerSrc, 'utf8');
    fs.chmodSync(LOGGER_DEST, 0o755);

    // Validate the write succeeded before proceeding
    if (!fs.existsSync(LOGGER_DEST))
      throw new Error(`Failed to write logger to ${LOGGER_DEST}`);

    // Unload existing plist if present (upgrade path)
    if (fs.existsSync(PLIST_PATH)) {
      try { execSync(`launchctl unload "${PLIST_PATH}"`, { timeout: 5000 }); } catch {}
    }

    // Write new plist and load it
    writePlist();
    execSync(`launchctl load "${PLIST_PATH}"`, { timeout: 5000 });

    // Run once immediately so DB/table exist before connectDb()
    execSync(`"${process.execPath}" "${LOGGER_DEST}"`, {
      timeout: 15000,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ELECTRON_RESOURCE_PATH: process.resourcesPath,
      },
    });

    console.log('powermonitor: logger setup complete');
  } catch (e) {
    console.error('powermonitor: logger setup failed:', e.message);
  } finally {
    closeSetupWindow();
  }
}

/* ── App lifecycle ───────────────────────────────────────────────────────── */
app.setName("PowerMonitor");

app.whenReady().then(async () => {
  loadSettings();
  nativeTheme.themeSource = settings.theme;

  await setupLogger();

  if (!connectDb()) {
    console.error("Could not connect to database");
    return;
  }

  sysInfo = getSystemInfo();
  buildMenu();
  createWindow();

  nativeTheme.on('updated', () => {
    buildMenu();
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('theme-changed', { isDark: nativeTheme.shouldUseDarkColors }); } catch {}
    }
  });

  ipcMain.on('set-time-range', (_, min) => {
    const safe = typeof min === 'number' && Number.isFinite(min) && min >= 0 ? Math.round(min) : 43200;
    settings.timeRange = safe;
    saveSettings();
    lastEntryTs = null;   // force re-fetch with new time window
    clearTimeout(dbTimer);
    queryAndSend();
    buildMenu();          // sync the Time Range radio checkmarks
  });

  // Right-click on a sidebar process row → native context menu
  ipcMain.on('proc-context', (_, name) => {
    if (typeof name !== 'string' || !name || name.length > 256) return;
    Menu.buildFromTemplate([
      { label: name, enabled: false },
      { type: 'separator' },
      { label: 'Copy Name', click: () => clipboard.writeText(name) },
    ]).popup({ window: mainWindow });
  });

  // User's macOS accent color → renderer CSS variable, live on change
  const sendAccent = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try { mainWindow.webContents.send('accent-color', systemPreferences.getAccentColor()); } catch {}
  };
  systemPreferences.on('accent-color-changed', sendAccent);

  mainWindow.webContents.once('did-finish-load', () => {
    sendSettings();
    sendAccent();
    // Reset so queryAndSend always delivers on first real page load,
    // even if focus fired early and set lastEntryTs before the page was ready.
    lastEntryTs = null;
    queryAndSend();
    sendLiveData();
  });

  // 1s live loop — pauses when window is hidden/blurred, resumes on focus/show
  let liveInterval = null;

  function startLive() {
    if (liveInterval) return;
    sendLiveData();
    liveInterval = setInterval(sendLiveData, 1000);
  }
  function stopLive() {
    clearInterval(liveInterval);
    liveInterval = null;
  }

  mainWindow.on('focus', () => {
    startLive();
    // Also re-query DB immediately on focus in case we missed a cycle while hidden
    queryAndSend();
  });
  // Keep ticking while visible-but-unfocused — it's a monitor, the user
  // watches it while working elsewhere. The blur-pause froze the sidebar on
  // stale charge states. Pause only when the window truly leaves the screen.
  mainWindow.on('hide',     stopLive);
  mainWindow.on('minimize', stopLive);
  mainWindow.on('show',     startLive);
  mainWindow.on('restore',  () => { startLive(); queryAndSend(); });

  // Instant plug/unplug + wake updates — these fire even while the window is
  // blurred and the 1s loop is paused, so the sidebar never shows a stale
  // charging state.
  // Second sample 3s later catches the settled charge/discharge current.
  const liveBurst = () => { sendLiveData(); setTimeout(sendLiveData, 3000); };
  powerMonitor.on('on-ac',      liveBurst);
  powerMonitor.on('on-battery', liveBurst);
  powerMonitor.on('resume', () => { liveBurst(); queryAndSend(); });

  // Start live loop immediately (window starts focused)
  startLive();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("quit", () => {
  if (db) db.close();
});
