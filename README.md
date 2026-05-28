# PowerMonitor

A macOS app for tracking battery health, power draw, and CPU usage over time — built for Apple Silicon.

![PowerMonitor screenshot](docs/screenshot.png)

> **Alpha software.** Expect rough edges. Feedback welcome.

---

## Features

- **Battery level** — live % with charge/discharge history
- **Power draw** — real-time wattage (positive when charging, negative when discharging)
- **CPU by process** — per-core usage breakdown across your top processes, no 100% cap
- **System info** — chip, cores, GPU cores, RAM, battery health and cycle count
- **Range selector** — view the last 10m, 1h, 6h, 24h, or 30 days
- **Smart x-axis** — relative labels for short ranges ("8m ago"), absolute clock times for 24h, dates for 30d
- **Hover crosshair** — hover any chart to see exact values and timestamps
- **LaunchAgent logger** — collects data every 60 seconds in the background, even when the app is closed
- **Glass UI** — native macOS vibrancy, dark/light mode support
- **Local only** — all data stays on your machine in a SQLite database

---

## Requirements

- macOS 13 Ventura or later
- Apple Silicon (M1 or newer)

---

## Install

1. Download `PowerMonitor-0.0.2-arm64.dmg` from [Releases](../../releases/latest)
2. Open the DMG and drag **PowerMonitor.app** to your Applications folder
3. Launch the app — on first run it installs a background logger automatically

> **Gatekeeper note:** Right-click → Open on first launch if macOS blocks it. The app is not yet notarized.

---

## How it works

PowerMonitor installs a macOS LaunchAgent that runs a lightweight logger every 60 seconds using the bundled Electron binary — no separate runtime required. Data is written to a local SQLite database at `~/.local/powermon.db`. The app reads from that database and renders charts over your chosen time window.

The logger collects:
- Battery percentage, charging state, amperage, voltage, estimated time remaining
- Top CPU and memory consuming processes
- Sleep assertions (anything preventing your Mac from sleeping)

---

## Build from source

```bash
# Prerequisites: Node.js, npm, Homebrew
brew install create-dmg

git clone https://github.com/kanin-design/PowerMonitor.git
cd PowerMonitor
npm install
npm run build
```

The build script packages the app and produces a DMG in the project root.

---

## Data

All data is stored locally at `~/.local/powermon.db` (SQLite). Nothing is sent anywhere.

To inspect your data:

```bash
sqlite3 ~/.local/powermon.db "SELECT ts, battery FROM power_log ORDER BY ts_unix DESC LIMIT 10"
```

To uninstall the background logger:

```bash
launchctl unload ~/Library/LaunchAgents/com.delfinsoft.powermonitor.plist
rm ~/Library/LaunchAgents/com.delfinsoft.powermonitor.plist
```

---

## License

MIT © 2026 Delfinsoft
