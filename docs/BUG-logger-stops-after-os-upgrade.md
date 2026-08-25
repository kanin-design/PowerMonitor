# Bug: logger stops logging after a macOS upgrade

## Summary

The PowerMonitor **logger** (the 60s launchd agent that writes to
`~/.local/powermon.db`) silently stops filling the database after a macOS
upgrade. The **app runs fine**; only the historical data stops accumulating.

## Root cause (verified)

After a macOS upgrade, the user's launchd domain is rebuilt and LaunchAgents are
**not automatically re-bootstrapped**. The agent's plist still exists on disk and
is still correct, but it is **not loaded** into launchd, so `StartInterval` never
fires and nothing writes to the DB.

Why the app doesn't re-register it:

- `main.js` → `setupLogger()` runs `isLoggerCurrent()` first.
- `isLoggerCurrent()` returns `true` when the plist exists AND contains the
  current `process.execPath` AND `LOGGER_DEST`.
- After the upgrade, the plist is unchanged and still matches → `isLoggerCurrent()`
  returns `true` → `setupLogger()` **short-circuits and never calls
  `launchctl load`/`bootstrap` again**.

So the upgrade silently breaks the assumption that "plist exists ⇒ agent loaded."

### The full chain that leads to the symptom

```
macOS upgrade  →  launchd domain rebuilt  →  agent not re-bootstrapped
              →  plist still on disk + still matches current execPath
              →  app's isLoggerCurrent() returns true
              →  setupLogger() returns early, never runs launchctl load
              →  nothing writes to ~/.local/powermon.db every 60s
```

## Evidence collected (read-only, on this machine)

- DB `~/.local/powermon.db`: `185625` rows, last row `2026-08-23 17:56:54`,
  then silence. Now ~27h later. DB itself is healthy.
- Plist `~/Library/LaunchAgents/com.delfinsoft.powermonitor.plist` exists,
  points to `/Applications/PowerMonitor.app/Contents/MacOS/PowerMonitor` +
  `~/.local/bin/powermonitor-logger.js`, `StartInterval=60`, `RunAtLoad=true`.
- `launchctl list com.delfinsoft.powermonitor` → **"Could not find service"**
  (exit 113). The agent is NOT in the graph.
- `launchctl print-disabled gui/501 | grep -i delfinsoft` → empty (NOT disabled).
- No launchd error in `log show` for `powermonitor` (it simply isn't loaded).
- The only delfinsoft launchd entries are the running **app's** own registration
  (`application.com.delfinsoft.powermonitor.12647526.12647529`) and an Electron
  runtime `MachPortRendezvousServer.62179` — **neither is the 60s logger**.
- Running the logger manually succeeds (fresh row written, exit 0):
  `ELECTRON_RUN_AS_NODE=1 "/Applications/.../PowerMonitor" ~/.local/bin/powermonitor-logger.js`
- Logger script on disk == project source (`diff` is identical) — no drift.
- OS: `ProductVersion 27.0` / `26A5416b`.

## The logger's write path (context, not the bug)

`logger.js` uses the **`sqlite3` CLI** via `execSync`, despite `package.json`
declaring `better-sqlite3` and CLAUDE.md saying "better-sqlite3". The CLI subprocess
has **no `busy_timeout`**, so a rare lock collision with the app's read-only
`better-sqlite3` handle produces:

```
Error: stepping, database is locked (5)
```

These errors are **secondary / legacy** (they appear in `~/.local/logs/powermonitor.err`
and predate the current outage). They did **not** cause the stop. They caused
occasional missed runs and made launchd mark the job as failed during those runs,
which *contributes* to launchd dropping the job — but the primary regression is the
launchd-agent-not-loaded issue above.

## The fix

Reload the agent so launchd runs it again. Run from a **separate shell** (the
Hermes terminal tool deliberately blocks `launchctl bootstrap` as a
KeepAlive-persistent unsafe action from inside the agent):

```bash
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.delfinsoft.powermonitor.plist
```

Verify:

```bash
launchctl list | grep delfinsoft          # should list com.delfinsoft.powermonitor
sqlite3 ~/.local/powermon.db "SELECT ts, battery FROM power_log ORDER BY ts_unix DESC LIMIT 3;"
```

Fallback if `bootstrap` complains:

```bash
launchctl load ~/Library/LaunchAgents/com.delfinsoft.powermonitor.plist
```

## Secondary symptom: "Awaiting data…" in the app (verified)

The app shows "Awaiting data…" on every chart even though the DB is full and
current. **The data is fine** — this is a runtime/IPC symptom, not a data issue.
Read-only findings:

- `~/.local/powermon.db` has **39,324 rows in the last 30d**, newest
  `2026-08-25 04:17:29`. Full and current.
- The exact `queryEntries()` query returns all of them (39,324), every
  `ts_unix` → `local ts` renderer-parseable (no NaN).
- The packaged app's **own** bundled `better-sqlite3` (Electron **module 130**)
  reads the DB fine — it is NOT the system-Node module-141 mismatch.
  Running it via the packaged app's Electron 130 confirmed a clean read.
  (The dev build's `node_modules` better-sqlite3 is compiled for 130 too.)
- Preload `onLogUpdate` → `log-update` IPC is correctly wired; renderer gates
  "Awaiting data…" on `entries.length < 2`.

Conclusion: the empty placeholder means **no `log-update` reaches the renderer**
in the live session — `connectDb()`/`queryAndSend()` isn't delivering, i.e. a
runtime/state failure (or a relaunch that drops the in-memory `db` handle before
the first send). **Not** caused by empty DB content.

Corroborating anomaly: the unified log showed the app relaunching repeatedly
within seconds (Electron PIDs 99220 → 99256 → 99293 → 99397) — a crash-relaunch
pattern that can lose the `db` handle before `log-update` fires.

Likely connection: the same **WAL write contention** (`database is locked`) that
poisons the logger's writes can also make the app's `connectDb()`/read flaky in
the live window. Reloading the launchd logger (the fix above) is the cleanest
first lever; if "Awaiting data" persists after that, investigate `connectDb()`
+ WAL setup in `main.js`.

## Status as of this report

- [x] Diagnosis confirmed
- [x] `launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.delfinsoft.powermonitor.plist` run — logger loaded
- [x] "Awaiting data…" traced to an IPC/runtime symptom, NOT empty DB
- [x] Fresh rows confirmed in `~/.local/powermon.db` (3 rows written within minutes of bootstrap)
- [x] `logger.js` `sqlExec` hardened with `PRAGMA busy_timeout=5000` (deployed to `~/.local/bin/`)
- [x] `isLoggerCurrent()` in `main.js` now also checks `launchctl list` — prevents silent drop after future OS upgrades
- [x] `setupLogger()` switched from deprecated `launchctl load/unload` to `bootstrap/bootout`
- [ ] Confirm "Awaiting data…" clears after app restart

## Prevention / next-time notes

- `isLoggerCurrent()` should not treat "plist exists and matches" as "agent is
  loaded". Consider checking launchd state (`launchctl list <label>`) or
  re-running `bootstrap` idempotently on app launch.
- After any OS upgrade, verify `launchctl list | grep com.delfinsoft.powermonitor`
  is present; if not, re-bootstrap.
- The logger is invoked via the Electron binary in `ELECTRON_RUN_AS_NODE` mode,
  so `process.execPath` is the app binary — the plist ProgramArguments[0] must be
  the app binary, not `node`.
