const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isDesktop: true,
  platform: process.platform,
  getPathForFile: (file) => {
    try {
      return webUtils && typeof webUtils.getPathForFile === 'function'
        ? webUtils.getPathForFile(file)
        : undefined;
    } catch {
      return undefined;
    }
  },
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
  buildOciLayerFile: (opts) => ipcRenderer.invoke('desktop:buildOciLayerFile', opts),
  uploadBlobFromFile: (opts) => ipcRenderer.invoke('desktop:uploadBlobFromFile', opts),
  deleteTempFile: (tempPath) => ipcRenderer.invoke('desktop:deleteTempFile', tempPath),
  downloadAndExtractLayer: (opts) =>
    ipcRenderer.invoke('desktop:downloadAndExtractLayer', opts),
  onTransferProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('desktop:transferProgress', listener);
    return () => ipcRenderer.removeListener('desktop:transferProgress', listener);
  },
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
