# PowerMonitor

A native macOS menu bar app for tracking battery health, power draw, and CPU usage over time — built for Apple Silicon.

![PowerMonitor screenshot](docs/screenshot.png)

---

## Features

- **Battery level** — live % with charge/discharge history
- **Power draw** — real-time wattage (charging positive, discharging negative)
- **CPU by process** — per-core usage breakdown, top 10 processes
- **Temperature** — CPU temperature via [macmon](https://github.com/vladkens/macmon)
- **System info** — chip, cores, GPU cores, RAM, battery health and cycle count
- **LaunchAgent logger** — runs every 60 seconds in the background, even when the app is closed
- **Glass UI** — native macOS vibrancy with dark/light mode support
- **Local only** — all data stays on your machine in a SQLite database at `~/.local/powermon.db`

---

## Requirements

- macOS 13 Ventura or later
- Apple Silicon (M1 or newer)

---

## Install

1. Download `PowerMonitor-0.0.2-arm64.dmg` from [Releases](../../releases/latest)
2. Open the DMG and drag **PowerMonitor.app** to your Applications folder
3. Launch the app — on first run it installs a background logger automatically

> **Gatekeeper note:** Right-click → Open on first launch if macOS blocks it, as the app is not yet notarized.

---

## How it works

PowerMonitor installs a macOS LaunchAgent that runs a lightweight Node.js logger every 60 seconds using the bundled Electron binary — no separate runtime required. Data is written to a local SQLite database. The app reads from that database and renders charts over your chosen time range (10m, 1h, 6h, 24h, or 30d).

The logger collects:
- Battery percentage, charging state, amperage, voltage, time remaining
- CPU temperature (via bundled macmon)
- Top CPU and memory consuming processes
- Sleep assertions (anything preventing your Mac from sleeping)

---

## Build from source

```bash
# Prerequisites: Node.js, npm, Homebrew
brew install macmon create-dmg

git clone https://github.com/kanin-design/PowerMonitor.git
cd PowerMonitor
npm install
npm run build
```

The build script packages the app, bundles macmon, and produces a DMG in the project root.

---

## Data

All data is stored locally at `~/.local/powermon.db` (SQLite). Nothing is sent anywhere.

To inspect your data directly:

```bash
sqlite3 ~/.local/powermon.db "SELECT ts, battery, temperature_celsius FROM power_log ORDER BY ts_unix DESC LIMIT 10"
```

To uninstall the background logger:

```bash
launchctl unload ~/Library/LaunchAgents/com.delfinsoft.powermonitor.plist
rm ~/Library/LaunchAgents/com.delfinsoft.powermonitor.plist
```

---

## License

MIT © 2026 Delfinsoft
