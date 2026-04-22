const { app, BrowserWindow, nativeTheme, Menu, ipcMain } = require("electron");
const Database = require("better-sqlite3");
const { join } = require("path");
const { homedir } = require("os");
const { execSync } = require("child_process");
const fs = require("fs");

const DB_PATH = join(homedir(), ".local", "powermon.db");

let mainWindow;
let db;

/* ── Settings ────────────────────────────────────────────────────────────── */
const SETTINGS_DEFAULTS = { theme: 'system', timeRange: 0, windowBounds: { width: 920, height: 680 } };
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
function queryEntries(limit = 3000) {
  if (!db) return [];
  try {
    const rows = db.prepare(`
      SELECT ts, battery, charging, amperage, voltage,
             time_remaining_mins, processdetails
      FROM power_log
      ORDER BY ts DESC
      LIMIT ?
    `).all(limit);

    return rows.map(row => {
      let pd = {};
      try { pd = JSON.parse(row.processdetails || "{}"); } catch {}
      const cpus = {}, mem = {};
      (pd.processes || []).forEach(p => {
        if (p.name) { cpus[p.name] = p.cpu || 0; mem[p.name] = p.mem || p.rss || 0; }
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

      return {
        ts:       row.ts,
        battery:  row.battery,
        charging: !!row.charging,
        amperage,
        voltage:  row.voltage,
        cpus,
        mem,
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
function buildMenu() {
  const setTheme = (mode) => {
    settings.theme = mode;
    saveSettings();
    nativeTheme.themeSource = mode;
  };
  const t = settings.theme;
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
          label: 'Theme',
          submenu: [
            { label: 'System', type: 'radio', checked: t === 'system', click: () => setTheme('system') },
            { label: 'Light',  type: 'radio', checked: t === 'light',  click: () => setTheme('light')  },
            { label: 'Dark',   type: 'radio', checked: t === 'dark',   click: () => setTheme('dark')   },
          ],
        },
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
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0A0A0A' : '#F5F5F7',
    icon: join(__dirname, "icons", "mac", "icon.icns"),
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  if (typeof b.x === 'number' && typeof b.y === 'number') { opts.x = b.x; opts.y = b.y; }
  mainWindow = new BrowserWindow(opts);
  mainWindow.loadFile(join(__dirname, "src", "index.html"));

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
    const raw = execSync('system_profiler SPHardwareDataType 2>/dev/null').toString();
    const f = key => { const m = raw.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm')); return m ? m[1].trim() : null; };
    const modelId  = f('Model Identifier');
    const chip     = (f('Chip') || '').replace(/^Apple\s+/, '') || CHIP_NAMES[modelId] || '';
    const model    = (modelId && FRIENDLY_NAMES[modelId]) ? FRIENDLY_NAMES[modelId] : (f('Model Name') || 'Mac');
    const coresRaw = f('Total Number of Cores');
    const cores    = coresRaw ? ((coresRaw.match(/^(\d+)/) || [])[1] || '?') : '?';
    const memory   = f('Memory') || '?';
    return { model, chip, cores, memory };
  } catch {
    return { model: 'Mac', chip: '', cores: '?', memory: '?' };
  }
}

/* ── Free memory ─────────────────────────────────────────────────────────── */
function getMemFree() {
  try {
    const vmstat = execSync('vm_stat 2>/dev/null').toString();
    const free     = parseInt(vmstat.match(/Pages free:\s+(\d+)/)?.[1]     || 0);
    const inactive = parseInt(vmstat.match(/Pages inactive:\s+(\d+)/)?.[1] || 0);
    const mb = Math.round((free + inactive) * 4096 / 1048576);
    return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB';
  } catch { return null; }
}

/* ── Send to renderer ────────────────────────────────────────────────────── */
let lastEntryTs = null;
let sysInfo = null;

function queryAndSend() {
  if (!db) return;
  const entries = queryEntries(3000);
  if (!entries.length) return;
  const latest = entries[entries.length - 1];
  if (latest.ts === lastEntryTs) return;
  lastEntryTs = latest.ts;
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      const info = sysInfo ? { ...sysInfo, memFree: getMemFree() } : null;
      mainWindow.webContents.send("log-update", { entries, sysInfo: info });
    } catch {}
  }
}

/* ── App lifecycle ───────────────────────────────────────────────────────── */
app.setName("PowerMonitor");

app.whenReady().then(() => {
  loadSettings();
  nativeTheme.themeSource = settings.theme;

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
    settings.timeRange = min;
    saveSettings();
  });

  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.send('settings', {
      isDark:    nativeTheme.shouldUseDarkColors,
      timeRange: settings.timeRange,
    });
    queryAndSend();
  });

  setInterval(queryAndSend, 5000);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("quit", () => {
  if (db) db.close();
});
