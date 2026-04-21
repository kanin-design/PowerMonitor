const { app, BrowserWindow } = require("electron");
const Database = require("better-sqlite3");
const { join } = require("path");
const { homedir } = require("os");
const { execSync } = require("child_process");
const fs = require("fs");

const DB_PATH = join(homedir(), ".local", "power.db");

let mainWindow;
let db;

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

/* ── Database ────────────────────────────────────────────────────────────── */
function connectDb() {
  try {
    const dir = join(homedir(), ".local");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
  } catch (e) {
    console.error("Failed to open DB:", e.message);
    return false;
  }
  return true;
}

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS power_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ts            TEXT NOT NULL,
      battery       INTEGER,
      charging      INTEGER,
      amperage      INTEGER,
      voltage       INTEGER,
      time_remaining TEXT,
      processdetails TEXT
    )
  `);
}

/* ── Power logger ────────────────────────────────────────────────────────── */
function logPowerState() {
  if (!db) return;
  try {
    // Battery % + charging state + time remaining via pmset (same as Python logger)
    const pmset = execSync('pmset -g batt 2>/dev/null').toString();
    let battery = null, charging = false, timeRemaining = null;
    for (const line of pmset.split('\n')) {
      if (!line.includes('InternalBattery')) continue;
      const bm = line.match(/(\d+)%/);
      if (bm) battery = parseInt(bm[1]);
      charging = line.includes('AC Power');
      const tm = line.match(/(\d+):(\d+)\s+remaining/);
      if (tm) timeRemaining = `${tm[1]}:${tm[2]}`;
    }

    // InstantAmperage + Voltage via ioreg (same as Python logger)
    // InstantAmperage is an unsigned 64-bit int — wrap to signed like Python does:
    // if val > 2**63: val -= 2**64
    const ioreg = execSync('ioreg -rn AppleSmartBattery 2>/dev/null').toString();
    let amperage = null, voltage = null;
    for (const line of ioreg.split('\n')) {
      if (line.includes('"InstantAmperage"') && amperage === null) {
        const m = line.split('=');
        if (m.length >= 2) {
          let val = BigInt(m[m.length - 1].trim());
          if (val > BigInt('9223372036854775807')) val -= BigInt('18446744073709551616');
          amperage = Number(val);
        }
      } else if (line.includes('"Voltage"') && !line.includes('BatteryData') && voltage === null) {
        const m = line.split('=');
        if (m.length >= 2) voltage = parseInt(m[m.length - 1].trim());
      }
    }

    if (battery === null || amperage === null || voltage === null) return;

    // Top processes by CPU via ps (same as Python logger)
    const psOut = execSync('ps -Ao pcpu,rss,comm -r 2>/dev/null').toString();
    const seen = {}, processes = [];
    for (const line of psOut.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const cpu = parseFloat(parts[0]);
      const mem = parseInt(parts[1]);
      let name = parts.slice(2).join(' ');
      if (name.includes('/')) name = name.split('/').pop();
      if (cpu >= 0.5 && mem >= 5000 && !seen[name] && processes.length < 10) {
        seen[name] = true;
        processes.push({ name, cpu: Math.round(cpu * 10) / 10 });
      }
    }

    // Power assertions
    const assertOut = execSync('pmset -g assertions 2>/dev/null').toString();
    const assertions = [];
    for (const line of assertOut.split('\n')) {
      if (line.includes('→')) assertions.push(line.trim());
    }

    db.prepare(`
      INSERT OR IGNORE INTO power_log (ts, battery, charging, amperage, voltage, time_remaining, processdetails)
      VALUES (datetime('now','localtime'), ?, ?, ?, ?, ?, ?)
    `).run(battery, charging ? 1 : 0, amperage, voltage, timeRemaining,
        JSON.stringify({ processes, assertions: assertions.slice(0, 5) }));

  } catch (e) {
    console.error("Logger error:", e.message);
  }
}

/* ── Query entries ───────────────────────────────────────────────────────── */
function queryEntries(limit = 3000) {
  if (!db) return [];
  try {
    const rows = db.prepare(`
      SELECT ts, battery, charging, amperage, voltage, time_remaining, processdetails
      FROM power_log
      ORDER BY ts DESC
      LIMIT ?
    `).all(limit);

    return rows.map(row => {
      let pd = {};
      try { pd = JSON.parse(row.processdetails || "{}"); } catch {}
      const cpus = {};
      (pd.processes || []).forEach(p => { if (p.name) cpus[p.name] = p.cpu || 0; });
      return {
        ts:        row.ts,
        battery:   row.battery,
        charging:  !!row.charging,
        amperage:  row.amperage,
        voltage:   row.voltage,
        cpus,
        timeLeft:  row.time_remaining,
        assertions: pd.assertions || [],
      };
    }).reverse();
  } catch (e) {
    console.error("Query failed:", e.message);
    return [];
  }
}

/* ── Window ──────────────────────────────────────────────────────────────── */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 680,
    minWidth: 800,
    minHeight: 560,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#1C1C1E',
    icon: join(__dirname, "icons", "mac", "icon.icns"),
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(join(__dirname, "src", "index.html"));
  mainWindow.on("closed", () => { mainWindow = null; });
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
    try { mainWindow.webContents.send("log-update", { entries, sysInfo }); } catch {}
  }
}

/* ── App lifecycle ───────────────────────────────────────────────────────── */
app.setName("PowerMonitor");

app.whenReady().then(() => {
  if (!connectDb()) {
    console.error("Could not connect to database");
    return;
  }

  ensureSchema();
  sysInfo = getSystemInfo();
  createWindow();

  mainWindow.webContents.once('did-finish-load', () => {
    logPowerState();   // log immediately so first-run has data right away
    queryAndSend();
  });

  logPowerState();                      // log immediately on start
  setInterval(logPowerState, 60000);  // log every 60s
  setInterval(queryAndSend,  5000);   // push to renderer every 5s
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("quit", () => {
  if (db) db.close();
});
