const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  onLogUpdate: (callback) => {
    ipcRenderer.on("log-update", (_event, data) => callback(data));
  },
});
