const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  startDownload: (opts) => ipcRenderer.invoke('start-download', opts),
  stopDownload: () => ipcRenderer.invoke('stop-download'),
  openFolder: (path) => ipcRenderer.invoke('open-folder', path),
  downloadGifs: (opts) => ipcRenderer.invoke('download-gifs', opts),
  onProgress: (callback) => {
    ipcRenderer.on('download-progress', (_event, data) => callback(data));
  }
});
