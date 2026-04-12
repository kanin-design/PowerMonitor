const { app, BrowserWindow } = require("electron");
const Database = require("better-sqlite3");
const { join } = require("path");
const { homedir } = require("os");
const { execSync } = require("child_process");

const DB_PATH = join(homedir(), ".local", "power.db");

let mainWindow;
let db;

function connectDb() {
  try {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
  } catch (e) {
    console.error("Failed to open DB:", e.message);
    return false;
  }
  return true;
}

function queryEntries(limit = 500) {
  if (!db) return [];

  try {
    const stmt = db.prepare(`
      SELECT ts, battery, charging, amperage, voltage, time_remaining, processdetails
      FROM power_log
      ORDER BY ts DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit);

    return rows.map(row => {
      let processdetails = {};
      try {
        processdetails = JSON.parse(row.processdetails || "{}");
      } catch (e) {
        processdetails = {};
      }

      const cpus = {};
      if (processdetails.processes) {
        processdetails.processes.forEach(p => {
          if (p.name) cpus[p.name] = p.cpu || 0;
        });
      }

      const assertions = processdetails.assertions || [];

      return {
        ts: row.ts,
        battery: row.battery,
        charging: !!row.charging,
        amperage: row.amperage,
        voltage: row.voltage,
        cpus,
        timeLeft: row.time_remaining,
        assertions,
      };
    }).reverse();
  } catch (e) {
    console.error("Query failed:", e.message);
    return [];
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 600,
    height: 700,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#000000',
    icon: join(__dirname, "icons", "mac", "icon.icns"),
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(join(__dirname, "src", "index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

let lastEntryTs = null;
let sysInfo = null;

const FRIENDLY_NAMES = {
  // MacBook Air
  'Mac17,3': 'MacBook Air 13"', 'Mac17,4': 'MacBook Air 15"',
  'Mac16,12': 'MacBook Air 13"', 'Mac16,13': 'MacBook Air 15"',
  'Mac14,2': 'MacBook Air 13"', 'Mac14,15': 'MacBook Air 15"',
  'MacBookAir10,1': 'MacBook Air 13"',
  'MacBookAir9,1': 'MacBook Air 13"', 'MacBookAir8,2': 'MacBook Air 13"', 'MacBookAir8,1': 'MacBook Air 13"',
  // MacBook Pro
  'Mac16,1': 'MacBook Pro 14"', 'Mac16,2': 'MacBook Pro 16"',
  'Mac16,3': 'MacBook Pro 14"', 'Mac16,6': 'MacBook Pro 16"', 'Mac16,7': 'MacBook Pro 14"',
  'Mac15,3': 'MacBook Pro 14"', 'Mac15,6': 'MacBook Pro 14"', 'Mac15,7': 'MacBook Pro 14"',
  'Mac15,9': 'MacBook Pro 16"', 'Mac15,10': 'MacBook Pro 16"', 'Mac15,11': 'MacBook Pro 14"',
  'Mac14,5': 'MacBook Pro 14"', 'Mac14,6': 'MacBook Pro 16"',
  'Mac14,7': 'MacBook Pro 13"', 'Mac14,9': 'MacBook Pro 14"', 'Mac14,10': 'MacBook Pro 16"',
  'MacBookPro18,1': 'MacBook Pro 16"', 'MacBookPro18,2': 'MacBook Pro 16"',
  'MacBookPro18,3': 'MacBook Pro 14"', 'MacBookPro18,4': 'MacBook Pro 14"',
  'MacBookPro17,1': 'MacBook Pro 13"',
  // Mac mini
  'Mac16,8': 'Mac mini', 'Mac16,10': 'Mac mini',
  'Mac14,3': 'Mac mini', 'Mac14,12': 'Mac mini', 'Macmini9,1': 'Mac mini',
  // iMac
  'Mac15,4': 'iMac 24"', 'Mac15,5': 'iMac 24"',
  'iMac21,1': 'iMac 24"', 'iMac21,2': 'iMac 24"',
  // Mac Studio / Mac Pro
  'Mac14,13': 'Mac Studio', 'Mac14,14': 'Mac Studio',
  'Mac13,1': 'Mac Studio', 'Mac13,2': 'Mac Studio',
};

function getSystemInfo() {
  try {
    const model = execSync('sysctl -n hw.model').toString().trim();
    const cpu = execSync('sysctl -n hw.physicalcpu').toString().trim();
    const mem = execSync('sysctl -n hw.memsize').toString().trim();
    const memGB = Math.round(parseInt(mem) / 1073741824);

    return {
      model: FRIENDLY_NAMES[model] || model,
      cores: cpu,
      memory: memGB + ' GB'
    };
  } catch (e) {
    return { model: 'Mac', cores: '?', memory: '?' };
  }
}

function queryAndSend() {
  if (!db) return;

  const entries = queryEntries(500);
  if (!entries.length) return;

  const latest = entries[entries.length - 1];
  if (latest.ts === lastEntryTs) return;

  lastEntryTs = latest.ts;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("log-update", { entries: entries, sysInfo: sysInfo });
  }
}

app.setName("PowerMonitor");

app.whenReady().then(() => {
  if (!connectDb()) {
    console.error("Could not connect to database");
    return;
  }

  sysInfo = getSystemInfo();
  createWindow();

  mainWindow.webContents.once('did-finish-load', () => {
    queryAndSend();
  });

  setInterval(queryAndSend, 3000);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("quit", () => {
  if (db) {
    db.close();
  }
});
