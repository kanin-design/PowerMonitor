const { contextBridge, ipcRenderer } = require("electron");

// Replace any previous listener before adding, so callbacks never stack up.
function onChannel(channel, cb) {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, (_e, d) => cb(d));
}

contextBridge.exposeInMainWorld("api", {
  onLogUpdate:    (cb) => onChannel("log-update",    cb),
  onThemeChanged: (cb) => onChannel("theme-changed", cb),
  onSettings:     (cb) => onChannel("settings",      cb),
  setTimeRange:   (min) => ipcRenderer.send("set-time-range", min),
  getMemFree:     ()    => ipcRenderer.invoke("get-mem-free"),
});
