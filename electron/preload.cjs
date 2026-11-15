const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isDesktop: true,
  platform: process.platform,
  pickRootFolder: () => ipcRenderer.invoke('desktop:pickRootFolder'),
  rescanRootFolder: (rootFolderPath) =>
    ipcRenderer.invoke('desktop:rescanRootFolder', rootFolderPath),
  readFileBytes: (fullPath) => ipcRenderer.invoke('desktop:readFileBytes', fullPath),
  saveExtractedFiles: (defaultFolderName, files) =>
    ipcRenderer.invoke('desktop:saveExtractedFiles', defaultFolderName, files),
  httpRequest: (reqOpts) => ipcRenderer.invoke('desktop:httpRequest', reqOpts),
});
