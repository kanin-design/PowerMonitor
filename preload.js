const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  onLogUpdate:    (cb) => ipcRenderer.on("log-update",    (_e, d) => cb(d)),
  onThemeChanged: (cb) => ipcRenderer.on("theme-changed", (_e, d) => cb(d)),
  onSettings:     (cb) => ipcRenderer.on("settings",      (_e, d) => cb(d)),
  setTimeRange:   (min) => ipcRenderer.send("set-time-range", min),
  getMemFree:     ()    => ipcRenderer.invoke("get-mem-free"),
});
