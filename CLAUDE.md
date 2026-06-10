# PowerMonitor — CLAUDE.md

macOS power/battery monitor. Electron, vanilla JS (no framework, no bundler),
hand-drawn canvas charts. Data lives in SQLite, written by a separate logger
process — the app itself only reads.

## Architecture

```
logger.js            LaunchAgent (com.delfinsoft.powermonitor), samples every 60s
  └─→ ~/.local/powermon.db          (better-sqlite3)
main.js              Electron main: DB queries, menus, IPC, 1s live loop
  ├─ queryAndSend()  → 'log-update'   chart history (~60s cadence, smart polling)
  ├─ getLiveData()   → 'live-update'  1s IORegistry/vm_stat loop (pauses on blur)
  └─ settings.json   userData: theme, timeRange, cpuView, windowBounds
preload.js           contextBridge: window.api.* (sandbox on, no nodeIntegration)
src/
  index.html         CSP: script-src 'self', style-src allows inline (chart colors)
  app.js             all renderer logic + canvas chart drawing
  app.css            design tokens (:root vars) + all styling
  theme-init.js      pre-paint theme attribute to avoid flash
```

## Run / verify

- `npm start` — human path.
- Agent path (headless verification): launch via Playwright and capture the
  **real window** with `screencapture`. `page.screenshot()` flattens the
  transparent vibrancy sidebar over white and looks catastrophically broken —
  it is an artifact, never trust it for the sidebar.

```js
import { _electron as electron } from 'playwright-core';  // devDependency
const app = await electron.launch({ executablePath: 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', args: ['.'] });
const page = await app.firstWindow();   // wait ~7s for data
const winId = (await app.evaluate(({ BrowserWindow }) =>
  BrowserWindow.getAllWindows()[0].getMediaSourceId())).split(':')[1];
// execSync(`screencapture -o -x -l ${winId} /tmp/shot.png`)
```

- UI changes are not done until verified in the running app (screenshot or
  DOM/pixel assertion). Playwright `setViewportSize`/`setBounds` get persisted
  to `settings.json` windowBounds — restore 920×680 before handing back.

## Domain gotchas (hard-won, do not re-learn)

- **vm_stat page size is 16384 on Apple Silicon, 4096 on Intel.** Always parse
  it from the `vm_stat` header. Hardcoding 4096 silently 4×-understates memory.
- **Memory used = Activity Monitor formula**: wired + anonymous − purgeable +
  compressor. "total − free − inactive" reads ~90% on a healthy Mac because
  macOS keeps RAM full of reclaimable cache by design. The memory bar's color
  tracks `kern.memorystatus_vm_pressure_level` (1/2/4), never capacity %.
- **Battery % is an integer** from IORegistry — over short windows there is no
  trend in the data, which is why the battery chart has two modes.
- **Vibrancy**: `nativeTheme.themeSource` drives the material's appearance;
  the sidebar stays legible even over a white wallpaper. Don't add scrims or
  text shadows "for safety" — verified unnecessary.

## UI conventions

- Color language: green = charging/good, orange = discharging/on-battery,
  red = critical. Used consistently across sidebar, tooltips, and charts.
- Text tokens follow Apple's label ramp (dark: white @ .85/.68/.55/.25).
  `--text-tertiary` is the dimmest tier allowed for readable text;
  `--text-quaternary` is decoration only.
- `--color-accent` is the live macOS accent (pushed from main via
  'accent-color' IPC); use it for focus rings and selection, with
  `--color-blue` as the CSS fallback.
- Battery chart: bars when visible span ≤ 75 min (discrete sample inspectors,
  0–100% axis, hovered bar lights up + others dim), adaptive-floor area line
  beyond (floor snaps to clean steps, min 20% span, top anchored at 100%).
- Bars = length encoding → axis must start at 0. Lines = position encoding →
  zoomed floor is fine. Don't mix these up.
- `hoveredProcess` links sidebar rows, chart legend, and CPU bands. The
  sidebar shows the latest sample's top 8; the chart ranks the window's top
  10 — they differ. When the hovered name is absent from the chart, dim all
  bands; never reset the hover to null (that reads as "highlight everything").
- The 1s live loop must not rebuild DOM whose data hasn't changed —
  `renderProcessList` keys its output and skips identical re-renders.
  Rebuilding under a stationary cursor drops `:hover` (visible 1 Hz blink).
- Sleep assertions: filter noise via `IGNORE_ASSERT` (WindowServer, powerd…) —
  only show assertions a user can act on.

## Product framing

A "system monitor with history" — retrospective inspection of power/CPU/memory
that native tools don't offer. Discrete samples are a feature: hover targets
with full per-sample tooltips (battery, power, top processes at that moment).
The owner runs an always-on machine; charge-state detail matters more than
sleep forensics.
