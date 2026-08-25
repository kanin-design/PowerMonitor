#!/usr/bin/env node
// PowerMonitor Logger
// Runs once per invocation (called every 60s by launchd).
// Invoked via: ELECTRON_RUN_AS_NODE=1 <electron-binary> logger.js

'use strict';

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DB_PATH    = path.join(os.homedir(), '.local', 'powermon.db');
const MIN_CPU    = 0.5;
const MIN_MEM_KB = 5000;
const MAX_PROCS  = 10;

// macmon binary lives in app.asar.unpacked/bin/macmon; path injected via env by main.js
const MACMON_PATH = process.env.ELECTRON_RESOURCE_PATH
  ? path.join(process.env.ELECTRON_RESOURCE_PATH, 'app.asar.unpacked', 'bin', 'macmon')
  : null;

/* ── SQLite helper ──────────────────────────────────────────────────────────*/
function sqlExec(query) {
  execSync(`sqlite3 "${DB_PATH}" ${shellQuote('PRAGMA busy_timeout=5000; ' + query)}`, { encoding: 'utf8' });
}

function shellQuote(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/* ── Schema ──────────────────────────────────────────────────────────────────*/
function ensureDb() {
  sqlExec(`
    CREATE TABLE IF NOT EXISTS power_log (
      ts                  TEXT PRIMARY KEY,
      ts_unix             INTEGER,
      battery             INTEGER NOT NULL,
      charging            INTEGER NOT NULL,
      amperage            INTEGER NOT NULL,
      voltage             INTEGER NOT NULL,
      time_remaining_mins INTEGER,
      temperature_celsius REAL,
      processdetails      TEXT NOT NULL
    )
  `);
  sqlExec(`CREATE INDEX IF NOT EXISTS idx_power_log_ts_unix ON power_log(ts_unix)`);
}

/* ── Battery ─────────────────────────────────────────────────────────────────*/
function getBattery() {
  try {
    const out = execSync('pmset -g batt', { encoding: 'utf8', timeout: 5000 });
    const onAC = /ac power/i.test(out);
    let battery = null, charging = false;

    for (const line of out.split('\n')) {
      if (!line.includes('InternalBattery')) continue;
      const m = line.match(/(\d+)%/);
      if (m) battery = parseInt(m[1], 10);
      charging = onAC || /\bcharging\b/i.test(line);
      break;
    }
    return { battery, charging };
  } catch { return { battery: null, charging: false }; }
}

/* ── Power (amperage / voltage / time remaining) ─────────────────────────────*/
function getPower() {
  try {
    const out = execSync('ioreg -rn AppleSmartBattery', { encoding: 'utf8', timeout: 5000 });
    let amperage = null, voltage = null, timeRemaining = null;

    for (const line of out.split('\n')) {
      if (line.includes('"InstantAmperage"')) {
        const parts = line.split('=');
        if (parts.length >= 2) {
          try {
            const raw = BigInt(parts[parts.length - 1].trim());
            amperage = Number(raw >= 2n ** 63n ? raw - 2n ** 64n : raw);
          } catch {}
        }
      } else if (line.includes('"Voltage"') && !line.includes('BatteryData')) {
        const parts = line.split('=');
        if (parts.length >= 2) voltage = parseInt(parts[parts.length - 1].trim(), 10);
      } else if (line.includes('"TimeRemaining"')) {
        const parts = line.split('=');
        if (parts.length >= 2) {
          const mins = parseInt(parts[parts.length - 1].trim(), 10);
          if (!isNaN(mins) && mins < 65535) timeRemaining = mins;
        }
      }
    }
    return { amperage, voltage, timeRemaining };
  } catch { return { amperage: null, voltage: null, timeRemaining: null }; }
}

/* ── Temperature (via bundled macmon) ────────────────────────────────────────*/
function getTemperature() {
  if (!MACMON_PATH || !fs.existsSync(MACMON_PATH)) return null;
  try {
    const out  = execSync(`"${MACMON_PATH}" pipe -s 1`, { encoding: 'utf8', timeout: 5000 });
    const data = JSON.parse(out.trim().split('\n')[0]);
    const temp = data?.temp?.cpu_temp_avg;
    if (typeof temp === 'number' && Number.isFinite(temp) && temp >= 20 && temp <= 120) return temp;
  } catch {}
  return null;
}

/* ── Processes ───────────────────────────────────────────────────────────────*/
function getProcesses() {
  try {
    const out  = execSync('ps -Ao pcpu,rss,comm -r', { encoding: 'utf8', timeout: 5000 });
    const procs = [];
    const seen  = {};

    for (const line of out.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const cpu = parseFloat(parts[0]);
      const mem = parseInt(parts[1], 10);
      let name  = parts.slice(2).join(' ');
      if (name.includes('/')) name = name.split('/').pop();
      if (cpu >= MIN_CPU && mem >= MIN_MEM_KB && !seen[name] && procs.length < MAX_PROCS) {
        seen[name] = true;
        procs.push({ name, cpu: Math.round(cpu * 10) / 10, mem });
      }
    }
    return procs;
  } catch { return []; }
}

/* ── Sleep assertions ────────────────────────────────────────────────────────*/
function getAssertions() {
  try {
    const out = execSync('pmset -g assertions', { encoding: 'utf8', timeout: 5000 });
    const results = [];
    for (const line of out.split('\n')) {
      if (/pid\s+\d+\s*\(/.test(line)) {
        const m = line.match(/\(([^)]+)\)/);
        if (m) results.push(m[1]);
      }
    }
    return results.slice(0, 5);
  } catch { return []; }
}

/* ── Numeric validation ──────────────────────────────────────────────────────*/
function safeInt(v, name) {
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw new Error(`Invalid value for ${name}: ${v}`);
  return Math.round(v);
}

/* ── Main ────────────────────────────────────────────────────────────────────*/
function run() {
  ensureDb();

  const { battery, charging }               = getBattery();
  const { amperage, voltage, timeRemaining } = getPower();
  const temperature                          = getTemperature();
  const processes                            = getProcesses();
  const assertions                           = getAssertions();

  if (battery === null || amperage === null || voltage === null) {
    console.error('powermonitor-logger: missing battery data, skipping');
    process.exit(0);
  }

  const safeBattery  = safeInt(battery,  'battery');
  const safeAmperage = safeInt(amperage, 'amperage');
  const safeVoltage  = safeInt(voltage,  'voltage');
  const nowUnix      = safeInt(Math.floor(Date.now() / 1000), 'ts_unix');
  const safeCharging = charging ? 1 : 0;
  const nowIso       = new Date(nowUnix * 1000).toISOString().replace('T', ' ').slice(0, 19);

  const timeCol = (timeRemaining !== null && Number.isFinite(timeRemaining))
    ? Math.round(timeRemaining) : 'NULL';
  const tempCol = (temperature !== null && Number.isFinite(temperature))
    ? temperature : 'NULL';

  const processdetails = JSON.stringify({ processes, assertions });
  const pd = processdetails.replace(/'/g, "''");

  sqlExec(`
    INSERT OR REPLACE INTO power_log
      (ts, ts_unix, battery, charging, amperage, voltage, time_remaining_mins, temperature_celsius, processdetails)
    VALUES
      ('${nowIso}', ${nowUnix}, ${safeBattery}, ${safeCharging}, ${safeAmperage}, ${safeVoltage}, ${timeCol}, ${tempCol}, '${pd}')
  `);

  console.log(`logged: ${nowIso} | ${safeBattery}% | ${safeCharging ? 'charging' : 'battery'} | ${safeAmperage}mA | ${safeVoltage}mV | temp=${temperature ?? 'n/a'}`);
}

run();
