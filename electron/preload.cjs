const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isDesktop: true,
  platform: process.platform,
  setNativeTheme: (mode) => ipcRenderer.send('set-native-theme', mode),
  pickDirectoryPath: () => ipcRenderer.invoke('desktop:pickDirectoryPath'),
  pickDirectoriesForUpload: () => ipcRenderer.invoke('desktop:pickDirectoriesForUpload'),
  pickRootFolder: () => ipcRenderer.invoke('desktop:pickRootFolder'),
  rescanRootFolder: (rootFolderPath, scanId) =>
    ipcRenderer.invoke('desktop:rescanRootFolder', rootFolderPath, scanId),
  scanPathsForUpload: (targetPaths, scanId) =>
    ipcRenderer.invoke('desktop:scanPathsForUpload', targetPaths, scanId),
  cancelFolderScan: (scanId) => ipcRenderer.send('desktop:cancelFolderScan', scanId),
  readFileBytes: (fullPath) => ipcRenderer.invoke('desktop:readFileBytes', fullPath),
  saveExtractedFiles: (defaultFolderName, files) =>
    ipcRenderer.invoke('desktop:saveExtractedFiles', defaultFolderName, files),
  httpRequest: (reqOpts) => ipcRenderer.invoke('desktop:httpRequest', reqOpts),
  streamLayerFileList: (opts) =>
    ipcRenderer.invoke('desktop:streamLayerFileList', opts),
  cancelLayerStream: (requestId) =>
    ipcRenderer.send('desktop:cancelLayerStream', requestId),
  onLayerStreamProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('desktop:layerStreamProgress', listener);
    return () => ipcRenderer.removeListener('desktop:layerStreamProgress', listener);
  },
});
