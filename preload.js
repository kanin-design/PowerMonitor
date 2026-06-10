const { contextBridge, ipcRenderer } = require("electron");

// Replace any previous listener before adding, so callbacks never stack up.
function onChannel(channel, cb) {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, (_e, d) => cb(d));
}

contextBridge.exposeInMainWorld("api", {
  onLogUpdate:    (cb) => onChannel("log-update",    cb),
  onLiveUpdate:   (cb) => onChannel("live-update",   cb),
  onThemeChanged: (cb) => onChannel("theme-changed", cb),
  onSettings:     (cb) => onChannel("settings",      cb),
  onAccentColor:  (cb) => onChannel("accent-color",  cb),
  setTimeRange:   (min)  => ipcRenderer.send("set-time-range", min),
  setCpuView:     (mode) => ipcRenderer.send("set-cpu-view",   mode),
  showProcessMenu: (name) => ipcRenderer.send("proc-context",  name),
});
