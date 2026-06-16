const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('errorAPI', {
  onContent: (cb) => {
    ipcRenderer.on('error-content', (_, data) => cb(data));
  },
  quit: () => ipcRenderer.invoke('fatal-error-quit')
});