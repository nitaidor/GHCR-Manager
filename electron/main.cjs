const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const zlib = require('node:zlib');
const {
  buildOciLayerToFile,
  createAbortError,
  createNodeTarStreamParser,
  resolveExtractDestinationInfo,
  resolveSafeExtractPath,
  sanitizeFolderName,
  writeStreamChunk,
} = require('./streaming-tar.cjs');
const {
  BLOB_UPLOAD_CHUNK_BYTES,
  MIN_ADAPTIVE_CHUNK_BYTES,
  isChunkTooLargeResponse,
  streamAndUploadOciLayer,
} = require('./oci-upload.cjs');

const activeLayerStreams = new Map();
const activeTransfers = new Map();
const activeTempFiles = new Set();
const activeStagingDirs = new Set();

async function renameWithRetry(srcPath, destPath) {
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await fs.rename(srcPath, destPath);
      return;
    } catch (err) {
      lastErr = err;
      if (err && (err.code === 'EPERM' || err.code === 'EBUSY')) {
        await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function formatBytesNode(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let val = bytes / 1024;
  let unitIdx = 0;
  while (val >= 1024 && unitIdx < units.length - 1) {
    val /= 1024;
    unitIdx++;
  }
  return `${val.toFixed(val >= 100 ? 0 : val >= 10 ? 1 : 2)} ${units[unitIdx]}`;
}

/**
 * Performs fetch with manual redirect handling so Authorization headers are stripped
 * when redirecting across different hostnames (e.g. ghcr.io -> Azure Blob Storage CDN).
 */
async function fetchWithSafeRedirects(url, opts = {}) {
  let currentUrl = url;
  let currentMethod = opts.method || 'GET';
  let currentHeaders = { ...(opts.headers || {}) };
  let currentBody = opts.body;

  let upstreamRes = null;
  for (let hops = 0; hops < 5; hops++) {
    upstreamRes = await fetch(currentUrl, {
      method: currentMethod,
      headers: currentHeaders,
      body:
        currentMethod !== 'GET' && currentMethod !== 'HEAD' ? currentBody : undefined,
      redirect: 'manual',
      signal: opts.signal,
    });

    if ([301, 302, 303, 307, 308].includes(upstreamRes.status)) {
      const loc = upstreamRes.headers.get('location');
      if (!loc) break;
      const nextUrl = new URL(loc, currentUrl).toString();
      const nextHost = new URL(nextUrl).hostname;
      const prevHost = new URL(currentUrl).hostname;
      if (nextHost !== prevHost) {
        delete currentHeaders['Authorization'];
        delete currentHeaders['authorization'];
      }
      if (upstreamRes.status === 303) {
        currentMethod = 'GET';
        currentBody = undefined;
      }
      currentUrl = nextUrl;
      continue;
    }
    break;
  }

  return upstreamRes;
}

async function refreshGhcrTokenNode(basicAuthHeader, scopeParam) {
  const tokenUrl = `https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(scopeParam)}`;
  const res = await fetch(tokenUrl, {
    method: 'GET',
    headers: {
      Authorization: basicAuthHeader,
      Accept: 'application/json',
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.token || data.access_token || null;
}

async function pumpResponseStream(responseBody, { onProgress, onFirstDetectGzip, onUncompressedChunk, signal }) {
  const reader = responseBody.getReader();
  const parserMode = { gunzip: null, detectBuf: Buffer.alloc(0), initialized: false };

  let pumpErr = null;
  let consumeErr = null;
  let consumePromise = null;
  let stopEarly = false;

  function ensureDecompressor(magicBuf) {
    const isGzip = magicBuf.length >= 2 && magicBuf[0] === 0x1f && magicBuf[1] === 0x8b;
    if (onFirstDetectGzip) onFirstDetectGzip(isGzip);
    if (!isGzip) return;

    const gunzip = zlib.createGunzip({ chunkSize: 1024 * 1024 });
    gunzip.on('error', (err) => {
      if (!consumeErr) consumeErr = err;
    });
    parserMode.gunzip = gunzip;
    consumePromise = (async () => {
      try {
        for await (const decompressed of gunzip) {
          if (stopEarly) break;
          const shouldStop = await onUncompressedChunk(decompressed);
          if (shouldStop) {
            stopEarly = true;
            await reader.cancel().catch(() => {});
            gunzip.destroy();
            break;
          }
        }
      } catch (err) {
        if (!consumeErr) consumeErr = err;
        stopEarly = true;
        gunzip.destroy();
        await reader.cancel().catch(() => {});
      }
    })();
  }

  const pumpPromise = (async () => {
    try {
      while (true) {
        if (signal?.aborted) {
          const abortErr = new Error('Operation aborted');
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        if (stopEarly) break;

        const { done, value } = await reader.read();
        if (done || stopEarly) break;
        if (!value || value.byteLength === 0) continue;

        onProgress?.(value.byteLength);
        const chunk = Buffer.from(value);

        if (!parserMode.initialized) {
          parserMode.detectBuf =
            parserMode.detectBuf.length > 0
              ? Buffer.concat([parserMode.detectBuf, chunk])
              : chunk;
          if (parserMode.detectBuf.length < 2) continue;

          parserMode.initialized = true;
          ensureDecompressor(parserMode.detectBuf);

          if (parserMode.gunzip) {
            await writeStreamChunk(parserMode.gunzip, parserMode.detectBuf);
          } else {
            const shouldStop = await onUncompressedChunk(parserMode.detectBuf);
            if (shouldStop) {
              stopEarly = true;
              await reader.cancel().catch(() => {});
              break;
            }
          }
          parserMode.detectBuf = Buffer.alloc(0);
          continue;
        }

        if (parserMode.gunzip) {
          await writeStreamChunk(parserMode.gunzip, chunk);
        } else {
          const shouldStop = await onUncompressedChunk(chunk);
          if (shouldStop) {
            stopEarly = true;
            await reader.cancel().catch(() => {});
            break;
          }
        }
      }

      if (!parserMode.initialized && parserMode.detectBuf.length > 0 && !stopEarly) {
        parserMode.initialized = true;
        ensureDecompressor(parserMode.detectBuf);
        if (parserMode.gunzip) {
          await writeStreamChunk(parserMode.gunzip, parserMode.detectBuf);
        } else {
          await onUncompressedChunk(parserMode.detectBuf);
        }
        parserMode.detectBuf = Buffer.alloc(0);
      }

      if (parserMode.gunzip && !parserMode.gunzip.destroyed) {
        parserMode.gunzip.end();
      }
    } catch (err) {
      pumpErr = err;
      if (parserMode.gunzip) parserMode.gunzip.destroy();
      await reader.cancel().catch(() => {});
    }
  })();

  await pumpPromise;
  if (consumePromise) {
    await consumePromise;
  }
  if (pumpErr) throw pumpErr;
  if (consumeErr) throw consumeErr;
}

app.setName('GHCR Manager');
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
}
// In portable runs the app launches from a temporary extracted binary with no Start Menu shortcut,
// so keep the custom AppUserModelId for installed builds only.
if (process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_FILE) {
  app.setAppUserModelId('io.ghcr.manager');
}

// Synchronize native OS right-click context menus with the app's Dark/Light theme state
ipcMain.on('set-native-theme', (_event, mode) => {
  if (mode === 'dark' || mode === 'light' || mode === 'system') {
    nativeTheme.themeSource = mode;
  }
});

function createWindow() {
  const iconFile = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const iconPath = path.join(__dirname, '../assets', iconFile);

  const win = new BrowserWindow({
    title: 'GHCR Manager',
    icon: fsSync.existsSync(iconPath) ? iconPath : undefined,
    width: 1200,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setMenuBarVisibility(false);

  // Native right-click context menu (Undo, Redo, Cut, Copy, Paste, Select All)
  win.webContents.on('context-menu', (_event, params) => {
    const menuTemplate = [];

    if (params.isEditable) {
      menuTemplate.push(
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { role: 'selectAll' }
      );
    } else {
      if (params.selectionText && params.selectionText.trim().length > 0) {
        menuTemplate.push({ role: 'copy' }, { type: 'separator' });
      }
      menuTemplate.push({ role: 'selectAll' });
    }

    if (menuTemplate.length > 0) {
      const menu = Menu.buildFromTemplate(menuTemplate);
      menu.popup({ window: win });
    }
  });

  // Open external links in default system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
  if (!app.isPackaged) {
    win.loadURL(devUrl).catch(() => {
      win.loadFile(path.join(__dirname, '../dist/index.html'));
    });
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

// Track cancelled folder scan IDs so long directory walks can abort immediately
const cancelledFolderScans = new Set();

/**
 * Recursively collect all files inside a directory with paths relative to baseDir.
 * Yields periodically to the event loop and aborts immediately if scanId is cancelled.
 */
async function collectFilesRecursively(dirPath, baseDir, scanState = { count: 0, scanId: null }) {
  if (scanState.scanId && cancelledFolderScans.has(scanState.scanId)) {
    throw new Error('SCAN_ABORTED');
  }

  const results = [];
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (scanState.scanId && cancelledFolderScans.has(scanState.scanId)) {
      throw new Error('SCAN_ABORTED');
    }
    if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue;

    scanState.count += 1;
    if (scanState.count % 40 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
      if (scanState.scanId && cancelledFolderScans.has(scanState.scanId)) {
        throw new Error('SCAN_ABORTED');
      }
    }

    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFilesRecursively(fullPath, baseDir, scanState);
      for (let i = 0; i < nested.length; i++) {
        results.push(nested[i]);
      }
    } else if (entry.isFile()) {
      try {
        const stat = await fs.stat(fullPath);
        const relPath = path.relative(baseDir, fullPath).split(path.sep).join('/');
        results.push({
          fullPath,
          relativePath: relPath,
          name: entry.name,
          size: stat.size,
          mtime: Math.floor(stat.mtimeMs / 1000),
          isDirectory: false,
        });
      } catch {
        // Ignore unreadable transient files
      }
    }
  }

  if (results.length === 0 && dirPath !== baseDir) {
    try {
      const dirStat = await fs.stat(dirPath);
      const relPath = path.relative(baseDir, dirPath).split(path.sep).join('/');
      results.push({
        fullPath: dirPath,
        relativePath: relPath,
        name: path.basename(dirPath),
        size: 0,
        mtime: Math.floor(dirStat.mtimeMs / 1000),
        isDirectory: true,
      });
    } catch {
      // Ignore unreadable transient directory
    }
  }

  return results;
}

/**
 * Scan a chosen Root Folder according to the app rules:
 * - Each direct file in Root Folder -> 1 standalone image (image name = file name)
 * - Each immediate sub-folder in Root Folder -> 1 bundled image containing all files in that sub-folder (image name = sub-folder name)
 */
async function scanRootFolderEntries(rootFolderPath, scanId = null) {
  const scanState = { count: 0, scanId };
  const entries = await fs.readdir(rootFolderPath, { withFileTypes: true });
  const rootFiles = [];
  const subFolders = [];

  for (const entry of entries) {
    if (scanId && cancelledFolderScans.has(scanId)) {
      throw new Error('SCAN_ABORTED');
    }
    if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue;
    const fullPath = path.join(rootFolderPath, entry.name);

    if (entry.isFile()) {
      const stat = await fs.stat(fullPath);
      rootFiles.push({
        kind: 'root-file',
        name: entry.name,
        fullPath,
        size: stat.size,
        mtime: Math.floor(stat.mtimeMs / 1000),
        files: [
          {
            fullPath,
            relativePath: entry.name,
            name: entry.name,
            size: stat.size,
            mtime: Math.floor(stat.mtimeMs / 1000),
          },
        ],
      });
    } else if (entry.isDirectory()) {
      const files = await collectFilesRecursively(fullPath, fullPath, scanState);
      const totalSize = files.reduce((acc, f) => acc + f.size, 0);
      subFolders.push({
        kind: 'root-subfolder',
        name: entry.name,
        fullPath,
        size: totalSize,
        files,
      });
    }
  }

  return {
    rootFolderPath,
    rootFolderName: path.basename(rootFolderPath),
    items: [...rootFiles, ...subFolders],
  };
}

/**
 * Scan one or more file/folder paths for Tab 1 (Upload File(s) or Folder(s))
 */
async function scanPathsForUpload(targetPaths, scanId = null) {
  const scanState = { count: 0, scanId };
  const items = [];

  for (const targetPath of targetPaths) {
    if (scanId && cancelledFolderScans.has(scanId)) {
      throw new Error('SCAN_ABORTED');
    }
    let stat;
    try {
      stat = await fs.stat(targetPath);
    } catch {
      continue;
    }

    const baseName = path.basename(targetPath);
    if (baseName === '.DS_Store' || baseName === 'Thumbs.db') continue;

    if (stat.isFile()) {
      items.push({
        kind: 'file',
        name: baseName,
        fullPath: targetPath,
        size: stat.size,
        mtime: Math.floor(stat.mtimeMs / 1000),
        files: [
          {
            fullPath: targetPath,
            relativePath: baseName,
            name: baseName,
            size: stat.size,
            mtime: Math.floor(stat.mtimeMs / 1000),
          },
        ],
      });
    } else if (stat.isDirectory()) {
      const files = await collectFilesRecursively(targetPath, targetPath, scanState);
      const totalSize = files.reduce((acc, f) => acc + f.size, 0);
      items.push({
        kind: 'folder',
        name: baseName,
        fullPath: targetPath,
        size: totalSize,
        files,
      });
    }
  }

  return items;
}

app.whenReady().then(() => {
  ipcMain.handle('desktop:pickDirectoryPath', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Select Root Folder to Sync with GitHub Packages',
      properties: ['openDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('desktop:pickDirectoriesForUpload', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Select Folder(s) to Upload as OCI Image',
      properties: ['openDirectory', 'multiSelections'],
    });
    if (res.canceled || res.filePaths.length === 0) return [];
    return res.filePaths;
  });

  ipcMain.handle('desktop:pickRootFolder', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Select Root Folder to Sync with GitHub Packages',
      properties: ['openDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return await scanRootFolderEntries(res.filePaths[0]);
  });

  ipcMain.handle('desktop:rescanRootFolder', async (_event, rootFolderPath, scanId) => {
    try {
      return await scanRootFolderEntries(rootFolderPath, scanId || null);
    } finally {
      if (scanId) cancelledFolderScans.delete(scanId);
    }
  });

  ipcMain.handle('desktop:scanPathsForUpload', async (_event, targetPaths, scanId) => {
    try {
      return await scanPathsForUpload(targetPaths, scanId || null);
    } finally {
      if (scanId) cancelledFolderScans.delete(scanId);
    }
  });

  ipcMain.on('desktop:cancelFolderScan', (_event, scanId) => {
    if (scanId) {
      cancelledFolderScans.add(scanId);
    }
  });

  ipcMain.handle('desktop:readFileBytes', async (_event, fullPath) => {
    const buf = await fs.readFile(fullPath);
    return new Uint8Array(buf);
  });

  ipcMain.handle('desktop:prepareExtractDestination', async (_event, { defaultFolderName }) => {
    const res = await dialog.showOpenDialog({
      title: `Select Destination Folder to Extract "${defaultFolderName}"`,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) {
      return { canceled: true };
    }
    const info = resolveExtractDestinationInfo(res.filePaths[0], defaultFolderName);
    return { canceled: false, ...info };
  });

  ipcMain.handle('desktop:saveExtractedFiles', async (_event, defaultFolderName, files) => {
    const res = await dialog.showOpenDialog({
      title: `Select Destination Folder to Extract "${defaultFolderName}"`,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return { saved: false };

    const info = resolveExtractDestinationInfo(res.filePaths[0], defaultFolderName);
    const baseDest = info.exists ? info.suggestedPath : info.targetPath;
    await fs.mkdir(baseDest, { recursive: true });

    for (const file of files) {
      if (file.isDirectory) {
        const cleanDir = String(file.relativePath || '').replace(/^\/+|\/+$/g, '');
        if (cleanDir && cleanDir !== '.') {
          const dirDest = resolveSafeExtractPath(baseDest, cleanDir);
          await fs.mkdir(dirDest, { recursive: true });
        }
        continue;
      }
      const destPath = resolveSafeExtractPath(baseDest, file.relativePath);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, Buffer.from(file.data));
    }

    return { saved: true, outputPath: baseDest };
  });

  ipcMain.on('desktop:cancelTransfer', (_event, requestId) => {
    const ac = activeTransfers.get(requestId);
    if (ac) {
      ac.abort();
      activeTransfers.delete(requestId);
    }
  });

  ipcMain.handle('desktop:httpRequest', async (_event, reqOpts) => {
    const upstreamRes = await fetchWithSafeRedirects(reqOpts.url, {
      method: reqOpts.method || 'GET',
      headers: reqOpts.headers || {},
      body: reqOpts.body ? Buffer.from(reqOpts.body) : undefined,
    });

    const headersObj = {};
    upstreamRes.headers.forEach((val, key) => {
      headersObj[key.toLowerCase()] = val;
    });
    const arrayBuf = await upstreamRes.arrayBuffer();
    return {
      status: upstreamRes.status,
      headers: headersObj,
      body: new Uint8Array(arrayBuf),
    };
  });

  ipcMain.handle('desktop:buildOciLayerFile', async (event, { files, requestId }) => {
    const tempName = `ghcr-manager-layer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tar.gz`;
    const tempPath = path.join(os.tmpdir(), tempName);
    activeTempFiles.add(tempPath);

    const abortController = new AbortController();
    if (requestId) activeTransfers.set(requestId, abortController);

    let lastSentPct = -1;
    try {
      return await buildOciLayerToFile({
        files,
        outFilePath: tempPath,
        signal: abortController.signal,
        onProgress: ({ processedBytes, totalBytes, percent }) => {
          const scaledPct = 10 + Math.round((percent / 100) * 35); // 10% -> 45%
          if (requestId && scaledPct !== lastSentPct) {
            lastSentPct = scaledPct;
            event.sender.send('desktop:transferProgress', {
              requestId,
              stage: 'archiving',
              message: `Archiving & compressing layer (${formatBytesNode(processedBytes)} / ${formatBytesNode(totalBytes)})...`,
              percent: scaledPct,
            });
          }
        },
      });
    } catch (err) {
      activeTempFiles.delete(tempPath);
      await fs.unlink(tempPath).catch(() => {});
      throw err;
    } finally {
      if (requestId) activeTransfers.delete(requestId);
    }
  });

  ipcMain.handle('desktop:deleteTempFile', async (_event, tempPath) => {
    if (!tempPath || !activeTempFiles.has(tempPath)) return;
    activeTempFiles.delete(tempPath);
    await fs.unlink(tempPath).catch(() => {});
  });

  ipcMain.handle(
    'desktop:uploadBlobFromFile',
    async (
      event,
      {
        tempPath,
        uploadInitUrl,
        digest,
        registryToken,
        basicAuthHeader,
        scopeParam,
        compressedSize,
        requestId,
      }
    ) => {
      const abortController = new AbortController();
      if (requestId) activeTransfers.set(requestId, abortController);
      let token = registryToken;
      let fileHandle = null;
      let sessionUrl = '';

      async function readExactChunk(fh, buf, length, position) {
        let totalRead = 0;
        while (totalRead < length) {
          if (abortController.signal.aborted) throw createAbortError('Upload cancelled');
          const { bytesRead } = await fh.read(buf, totalRead, length - totalRead, position + totalRead);
          if (bytesRead === 0) break;
          totalRead += bytesRead;
        }
        return totalRead;
      }

      async function sendRequestWithAuthRetry(url, initBuilder) {
        if (abortController.signal.aborted) throw createAbortError('Upload cancelled');
        let res = await fetchWithSafeRedirects(url, {
          ...initBuilder(token),
          signal: abortController.signal,
        });
        if (res.status === 401 && basicAuthHeader && scopeParam) {
          const nextToken = await refreshGhcrTokenNode(basicAuthHeader, scopeParam);
          if (nextToken) {
            token = nextToken;
            res = await fetchWithSafeRedirects(url, {
              ...initBuilder(token),
              signal: abortController.signal,
            });
          }
        }
        return res;
      }

      try {
        fileHandle = await fs.open(tempPath, 'r');
        const st = await fileHandle.stat();
        const totalSize = typeof compressedSize === 'number' && compressedSize > 0 ? compressedSize : st.size;

        const startRes = await sendRequestWithAuthRetry(uploadInitUrl, (tok) => ({
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tok}`,
            'Content-Length': '0',
          },
        }));

        if (startRes.status !== 202) {
          const bodyText = await startRes.text().catch(() => '');
          throw new Error(
            `Failed to initiate blob upload to ghcr.io (HTTP ${startRes.status}): ${bodyText}`
          );
        }

        const locationHeader = startRes.headers.get('location');
        if (!locationHeader) {
          throw new Error('ghcr.io blob upload response missing Location header.');
        }

        sessionUrl = new URL(locationHeader, uploadInitUrl).toString();

        if (totalSize <= BLOB_UPLOAD_CHUNK_BYTES) {
          const singleBuf = Buffer.allocUnsafe(totalSize);
          const bytesRead = await readExactChunk(fileHandle, singleBuf, totalSize, 0);
          const putUrlObj = new URL(sessionUrl);
          putUrlObj.searchParams.set('digest', digest);

          const putRes = await sendRequestWithAuthRetry(putUrlObj.toString(), (tok) => ({
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${tok}`,
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(bytesRead),
            },
            body: bytesRead === singleBuf.length ? singleBuf : singleBuf.subarray(0, bytesRead),
          }));

          if (putRes.status !== 201 && putRes.status !== 202) {
            const bodyText = await putRes.text().catch(() => '');
            throw new Error(
              `Failed to finish blob upload to ghcr.io (HTTP ${putRes.status}): ${bodyText}`
            );
          }

          if (requestId) {
            event.sender.send('desktop:transferProgress', {
              requestId,
              stage: 'uploading-layer',
              message: `Uploaded compressed image layer (${formatBytesNode(totalSize)})`,
              percent: 90,
            });
          }
          return { registryToken: token };
        }

        const chunkBuf = Buffer.allocUnsafe(BLOB_UPLOAD_CHUNK_BYTES);
        let activePatchLimit = BLOB_UPLOAD_CHUNK_BYTES;
        let offset = 0;
        let lastSentPct = -1;

        while (offset < totalSize) {
          if (abortController.signal.aborted) {
            throw createAbortError('Upload cancelled');
          }
          const toRead = Math.min(activePatchLimit, totalSize - offset);
          const bytesRead = await readExactChunk(fileHandle, chunkBuf, toRead, offset);
          if (bytesRead === 0) {
            throw new Error('Unexpected end of temporary archive file while uploading.');
          }
          const payload = bytesRead === chunkBuf.length ? chunkBuf : chunkBuf.subarray(0, bytesRead);
          const rangeHeader = `${offset}-${offset + bytesRead - 1}`;

          const patchRes = await sendRequestWithAuthRetry(sessionUrl, (tok) => ({
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${tok}`,
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(bytesRead),
              'Content-Range': rangeHeader,
            },
            body: payload,
          }));

          if (patchRes.status !== 202 && patchRes.status !== 201 && patchRes.status !== 204) {
            const bodyText = await patchRes.text().catch(() => '');
            if (
              isChunkTooLargeResponse(patchRes.status, bodyText) &&
              bytesRead > MIN_ADAPTIVE_CHUNK_BYTES
            ) {
              activePatchLimit = Math.max(
                MIN_ADAPTIVE_CHUNK_BYTES,
                Math.floor(bytesRead / 2)
              );
              continue;
            }
            throw new Error(
              `Failed to upload layer chunk at byte ${offset} (HTTP ${patchRes.status}): ${bodyText}`
            );
          }

          const nextLoc = patchRes.headers.get('location');
          if (nextLoc) {
            sessionUrl = new URL(nextLoc, sessionUrl).toString();
          }

          offset += bytesRead;
          const scaledPct = 55 + Math.round((offset / totalSize) * 35); // 55% -> 90%
          if (requestId && scaledPct !== lastSentPct) {
            lastSentPct = scaledPct;
            event.sender.send('desktop:transferProgress', {
              requestId,
              stage: 'uploading-layer',
              message: `Uploading compressed image layer (${formatBytesNode(offset)} / ${formatBytesNode(totalSize)})...`,
              percent: scaledPct,
            });
          }
        }

        const finalUrlObj = new URL(sessionUrl);
        finalUrlObj.searchParams.set('digest', digest);
        const finalPutRes = await sendRequestWithAuthRetry(finalUrlObj.toString(), (tok) => ({
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${tok}`,
            'Content-Length': '0',
          },
        }));

        if (finalPutRes.status !== 201 && finalPutRes.status !== 202) {
          const bodyText = await finalPutRes.text().catch(() => '');
          throw new Error(
            `Failed to commit chunked blob upload to ghcr.io (HTTP ${finalPutRes.status}): ${bodyText}`
          );
        }

        return { registryToken: token };
      } catch (err) {
        if (abortController.signal.aborted && sessionUrl) {
          await fetchWithSafeRedirects(sessionUrl, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          }).catch(() => {});
        }
        throw err;
      } finally {
        if (requestId) activeTransfers.delete(requestId);
        if (fileHandle) {
          await fileHandle.close().catch(() => {});
        }
      }
    }
  );

  ipcMain.handle(
    'desktop:streamAndUploadOciLayer',
    async (
      event,
      {
        files,
        uploadInitUrl,
        registryToken,
        basicAuthHeader,
        scopeParam,
        requestId,
      }
    ) => {
      const abortController = new AbortController();
      if (requestId) activeTransfers.set(requestId, abortController);
      let lastSentPct = -1;
      let lastSentUploadedBytes = -1;

      try {
        const result = await streamAndUploadOciLayer({
          files,
          uploadInitUrl,
          registryToken,
          refreshToken:
            basicAuthHeader && scopeParam
              ? () => refreshGhcrTokenNode(basicAuthHeader, scopeParam)
              : undefined,
          fetchFn: fetchWithSafeRedirects,
          signal: abortController.signal,
          onStatusMessage: (message) => {
            if (requestId) {
              lastSentPct = -1;
              lastSentUploadedBytes = -1;
              event.sender.send('desktop:transferProgress', {
                requestId,
                stage: 'uploading-layer',
                message,
                percent: 10,
              });
            }
          },
          onProgress: ({ processedBytes, totalBytes, uploadedBytes, percent }) => {
            const scaledPct = 10 + Math.round((percent / 100) * 76); // 10% -> 86%
            if (
              requestId &&
              (scaledPct !== lastSentPct || uploadedBytes !== lastSentUploadedBytes)
            ) {
              lastSentPct = scaledPct;
              lastSentUploadedBytes = uploadedBytes;
              const message =
                totalBytes > 0
                  ? `Streaming & uploading layer (${formatBytesNode(processedBytes)} / ${formatBytesNode(totalBytes)}, ${formatBytesNode(uploadedBytes)} sent)...`
                  : `Streaming & uploading layer (${formatBytesNode(uploadedBytes)} sent)...`;
              event.sender.send('desktop:transferProgress', {
                requestId,
                stage: 'uploading-layer',
                message,
                percent: scaledPct,
              });
            }
          },
        });

        if (requestId) {
          event.sender.send('desktop:transferProgress', {
            requestId,
            stage: 'uploading-layer',
            message: `Uploaded compressed image layer (${formatBytesNode(result.compressedSize)})`,
            percent: 88,
          });
        }

        return {
          uncompressedDigest: result.uncompressedDigest,
          compressedDigest: result.compressedDigest,
          compressedSize: result.compressedSize,
          totalFileBytes: result.totalFileBytes,
          fileCount: result.fileCount,
          fileMetaList: result.fileMetaList,
          registryToken: result.registryToken,
        };
      } finally {
        if (requestId) activeTransfers.delete(requestId);
      }
    }
  );

  ipcMain.handle(
    'desktop:downloadAndExtractLayer',
    async (
      event,
      {
        url,
        registryToken,
        parentDir,
        folderName,
        replaceExisting = false,
        defaultFolderName,
        expectedSize,
        requestId,
      }
    ) => {
      let chosenParentDir = parentDir;
      let desiredFolderName = folderName || defaultFolderName || 'package';

      if (!chosenParentDir) {
        const dialogRes = await dialog.showOpenDialog({
          title: `Select Destination Folder to Extract "${desiredFolderName}"`,
          properties: ['openDirectory', 'createDirectory'],
        });
        if (dialogRes.canceled || dialogRes.filePaths.length === 0) {
          return { saved: false, files: [] };
        }
        chosenParentDir = dialogRes.filePaths[0];
      }

      const abortController = new AbortController();
      if (requestId) activeTransfers.set(requestId, abortController);

      const safeFolderName = sanitizeFolderName(desiredFolderName);
      const stagingName = `.ghcr-extract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const stagingDest = path.join(chosenParentDir, stagingName);
      activeStagingDirs.add(stagingDest);

      let activeOutStream = null;
      let activeOutStreamError = null;

      function closeActiveStream() {
        if (activeOutStreamError) {
          const err = activeOutStreamError;
          activeOutStreamError = null;
          activeOutStream = null;
          return Promise.reject(err);
        }
        if (!activeOutStream) return Promise.resolve();
        const streamRef = activeOutStream;
        activeOutStream = null;
        return new Promise((resolve, reject) => {
          streamRef.once('error', reject);
          streamRef.end(() => {
            if (activeOutStreamError) {
              const err = activeOutStreamError;
              activeOutStreamError = null;
              reject(err);
            } else {
              resolve();
            }
          });
        });
      }

      async function destroyActiveStream() {
        if (!activeOutStream) return;
        const streamRef = activeOutStream;
        activeOutStream = null;
        await new Promise((resolve) => {
          if (streamRef.closed) return resolve();
          streamRef.once('close', resolve);
          streamRef.destroy();
        });
      }

      try {
        if (requestId) {
          event.sender.send('desktop:transferProgress', {
            requestId,
            stage: 'downloading',
            message: 'Connecting to ghcr.io...',
            percent: 2,
          });
        }

        const upstreamRes = await fetchWithSafeRedirects(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${registryToken}` },
          signal: abortController.signal,
        });

        if (!upstreamRes || !upstreamRes.ok || !upstreamRes.body) {
          throw new Error(
            `Failed to download layer blob (HTTP ${upstreamRes?.status || 'unknown'})`
          );
        }

        await fs.mkdir(stagingDest, { recursive: true });

        const totalBytes =
          Number(upstreamRes.headers.get('content-length')) || expectedSize || 0;
        let receivedBytes = 0;
        let lastEmittedPct = -1;

        async function ensureDirectoryPathSafe(rootDir, targetDir) {
          const rel = path.relative(rootDir, targetDir);
          if (!rel || rel === '.' || rel.startsWith('..')) return;
          const parts = rel.split(path.sep).filter(Boolean);
          let curr = rootDir;
          for (const part of parts) {
            curr = path.join(curr, part);
            try {
              const st = await fs.lstat(curr);
              if (!st.isDirectory()) {
                const renamed = resolveExtractDestinationInfo(
                  path.dirname(curr),
                  path.basename(curr)
                ).suggestedPath;
                await renameWithRetry(curr, renamed);
              }
            } catch {
              // Segment does not exist yet
            }
          }
          await fs.mkdir(targetDir, { recursive: true });
        }

        const parser = createNodeTarStreamParser({
          onDirectory: async (meta) => {
            if (meta.path && meta.path !== '.') {
              const dirDest = resolveSafeExtractPath(stagingDest, meta.path);
              await ensureDirectoryPathSafe(stagingDest, dirDest);
            }
          },
          onFileStart: async (meta) => {
            await closeActiveStream();
            let destPath = resolveSafeExtractPath(stagingDest, meta.path);
            await ensureDirectoryPathSafe(stagingDest, path.dirname(destPath));
            if (fsSync.existsSync(destPath)) {
              destPath = resolveExtractDestinationInfo(
                path.dirname(destPath),
                path.basename(destPath)
              ).suggestedPath;
            }
            activeOutStreamError = null;
            const ws = fsSync.createWriteStream(destPath, {
              highWaterMark: 1024 * 1024,
            });
            ws.on('error', (err) => {
              activeOutStreamError = err;
            });
            activeOutStream = ws;
          },
          onFileData: async (chunk) => {
            if (abortController.signal.aborted) throw createAbortError('Download cancelled');
            if (activeOutStreamError) throw activeOutStreamError;
            if (activeOutStream) {
              await writeStreamChunk(activeOutStream, chunk);
            }
          },
          onFileEnd: async () => {
            await closeActiveStream();
          },
        });

        await pumpResponseStream(upstreamRes.body, {
          signal: abortController.signal,
          onProgress: (delta) => {
            receivedBytes += delta;
            if (requestId) {
              const pct =
                totalBytes > 0
                  ? Math.min(99, Math.round((receivedBytes / totalBytes) * 100))
                  : 50;
              if (pct !== lastEmittedPct) {
                lastEmittedPct = pct;
                event.sender.send('desktop:transferProgress', {
                  requestId,
                  stage: 'downloading',
                  message:
                    totalBytes > 0
                      ? `Downloading & extracting (${formatBytesNode(receivedBytes)} / ${formatBytesNode(totalBytes)})...`
                      : `Downloading & extracting (${formatBytesNode(receivedBytes)})...`,
                  percent: pct,
                });
              }
            }
          },
          onUncompressedChunk: async (decompressed) => {
            await parser.feed(decompressed);
            return parser.isDone();
          },
        });

        await closeActiveStream();

        const extractedMeta = parser.getFiles();
        if (extractedMeta.length === 0) {
          throw new Error('No files or folders were found inside the image layer.');
        }

        let finalDest = resolveSafeExtractPath(chosenParentDir, safeFolderName);
        if (replaceExisting) {
          await fs.rm(finalDest, { recursive: true, force: true });
        } else if (fsSync.existsSync(finalDest)) {
          finalDest = resolveExtractDestinationInfo(chosenParentDir, safeFolderName).suggestedPath;
        }

        await renameWithRetry(stagingDest, finalDest);
        activeStagingDirs.delete(stagingDest);

        const extractedRegularCount = extractedMeta.filter((m) => !m.isDirectory).length;
        if (requestId) {
          event.sender.send('desktop:transferProgress', {
            requestId,
            stage: 'downloading',
            message:
              extractedRegularCount > 0
                ? `Extracted ${extractedRegularCount} file(s)`
                : 'Extracted empty folder',
            percent: 100,
          });
        }

        return { saved: true, outputPath: finalDest, files: extractedMeta };
      } catch (err) {
        await destroyActiveStream();
        throw err;
      } finally {
        if (requestId) activeTransfers.delete(requestId);
        activeStagingDirs.delete(stagingDest);
        await fs.rm(stagingDest, { recursive: true, force: true }).catch(() => {});
      }
    }
  );

  ipcMain.on('desktop:cancelLayerStream', (_event, requestId) => {
    const ac = activeLayerStreams.get(requestId);
    if (ac) {
      ac.abort();
      activeLayerStreams.delete(requestId);
    }
  });

  ipcMain.handle(
    'desktop:streamLayerFileList',
    async (event, { url, registryToken, expectedSize, requestId }) => {
      const abortController = new AbortController();
      if (requestId) activeLayerStreams.set(requestId, abortController);

      try {
        const upstreamRes = await fetchWithSafeRedirects(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${registryToken}` },
          signal: abortController.signal,
        });

        if (!upstreamRes || !upstreamRes.ok || !upstreamRes.body) {
          throw new Error(
            `Failed to stream layer blob (HTTP ${upstreamRes?.status || 'unknown'})`
          );
        }

        const totalBytes =
          Number(upstreamRes.headers.get('content-length')) || expectedSize || 0;
        const parser = createNodeTarStreamParser();
        let receivedBytes = 0;
        let lastEmittedPct = -1;

        await pumpResponseStream(upstreamRes.body, {
          signal: abortController.signal,
          onProgress: (delta) => {
            receivedBytes += delta;
            if (totalBytes > 0 && requestId) {
              const pct = Math.min(99, Math.round((receivedBytes / totalBytes) * 100));
              if (pct !== lastEmittedPct) {
                lastEmittedPct = pct;
                event.sender.send('desktop:layerStreamProgress', {
                  requestId,
                  percent: pct,
                });
              }
            }
          },
          onUncompressedChunk: async (decompressed) => {
            await parser.feed(decompressed);
            return parser.isDone();
          },
        });

        if (requestId) {
          event.sender.send('desktop:layerStreamProgress', {
            requestId,
            percent: 100,
          });
        }

        return { files: parser.getFiles() };
      } finally {
        if (requestId) activeLayerStreams.delete(requestId);
      }
    }
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  for (const tempPath of activeTempFiles) {
    try {
      fsSync.unlinkSync(tempPath);
    } catch {
      // ignore cleanup error on quit
    }
  }
  activeTempFiles.clear();

  for (const stagingDir of activeStagingDirs) {
    try {
      fsSync.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // ignore staging cleanup error on quit
    }
  }
  activeStagingDirs.clear();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
