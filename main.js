const { app, BrowserWindow, nativeTheme, Menu, ipcMain } = require("electron");
const Database = require("better-sqlite3");
const { join } = require("path");
const { homedir } = require("os");
const { execSync } = require("child_process");
const fs = require("fs");

const DB_PATH = join(homedir(), ".local", "powermon.db");

/* ── Logger / LaunchAgent constants ─────────────────────────────────────── */
const PLIST_LABEL  = 'com.delfinsoft.powermonitor';
const PLIST_PATH   = join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
const LOGGER_DEST  = join(homedir(), '.local', 'bin', 'powermonitor-logger.js');
const LOG_OUT      = join(homedir(), '.local', 'logs', 'powermonitor.log');
const LOG_ERR      = join(homedir(), '.local', 'logs', 'powermonitor.err');

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
    vibrancy: 'under-window',
    visualEffectState: 'active',
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

/* ── Free memory ─────────────────────────────────────────────────────────── */
function getMemFree() {
  try {
    const vmstat = execSync('vm_stat 2>/dev/null', { timeout: 2000 }).toString();
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

async function setupLogger() {
  if (!app.isPackaged) {
    console.log('powermonitor: dev mode — skipping logger auto-setup');
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
    const safe = typeof min === 'number' && Number.isFinite(min) && min >= 0 ? Math.round(min) : 0;
    settings.timeRange = safe;
    saveSettings();
  });

  ipcMain.handle('get-mem-free', () => getMemFree());

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
