const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');
const path = require('node:path');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const zlib = require('node:zlib');

const activeLayerStreams = new Map();

function createNodeTarMetaParser() {
  const files = [];
  let pendingBuf = Buffer.alloc(4096);
  let pendingLen = 0;
  let skipRemaining = 0;
  let metaNeededBlocks = 0;
  let metaExactSize = 0;
  let metaType = null;
  let pendingPaxPath = null;
  let done = false;

  function appendToPending(slice) {
    const needed = pendingLen + slice.length;
    if (needed > pendingBuf.length) {
      const next = Buffer.alloc(Math.max(pendingBuf.length * 2, needed));
      pendingBuf.copy(next, 0, 0, pendingLen);
      pendingBuf = next;
    }
    Buffer.from(slice).copy(pendingBuf, pendingLen);
    pendingLen += slice.length;
  }

  function readNullStr(buf, offset, maxLen) {
    let end = offset;
    const limit = offset + maxLen;
    while (end < limit && buf[end] !== 0) end++;
    return buf.subarray(offset, end).toString('utf8');
  }

  function readOctal(buf, offset, maxLen) {
    const s = readNullStr(buf, offset, maxLen).trim();
    return s ? parseInt(s, 8) || 0 : 0;
  }

  function feed(chunk) {
    if (done || !chunk || chunk.length === 0) return;
    let pos = 0;

    while (pos < chunk.length && !done) {
      if (skipRemaining > 0) {
        const avail = chunk.length - pos;
        const toSkip = Math.min(avail, skipRemaining);
        pos += toSkip;
        skipRemaining -= toSkip;
        continue;
      }

      if (metaNeededBlocks > 0) {
        const need = metaNeededBlocks - pendingLen;
        const take = Math.min(need, chunk.length - pos);
        appendToPending(chunk.subarray(pos, pos + take));
        pos += take;

        if (pendingLen === metaNeededBlocks) {
          const payload = pendingBuf.subarray(0, metaExactSize);
          if (metaType === 'x' || metaType === 'g') {
            const paxText = payload.toString('utf8');
            for (const line of paxText.split('\n')) {
              const spaceIdx = line.indexOf(' ');
              if (spaceIdx > 0) {
                const kv = line.slice(spaceIdx + 1);
                if (kv.startsWith('path=')) {
                  pendingPaxPath = kv.slice(5);
                }
              }
            }
          } else if (metaType === 'L') {
            pendingPaxPath = readNullStr(payload, 0, payload.length);
          }
          pendingLen = 0;
          metaNeededBlocks = 0;
          metaExactSize = 0;
          metaType = null;
        }
        continue;
      }

      const need = 512 - pendingLen;
      const take = Math.min(need, chunk.length - pos);
      appendToPending(chunk.subarray(pos, pos + take));
      pos += take;

      if (pendingLen === 512) {
        const header = pendingBuf.subarray(0, 512);
        pendingLen = 0;

        let allZero = true;
        for (let i = 0; i < 512; i++) {
          if (header[i] !== 0) {
            allZero = false;
            break;
          }
        }
        if (allZero) {
          done = true;
          break;
        }

        const name = readNullStr(header, 0, 100);
        const prefix = readNullStr(header, 345, 155);
        const size = readOctal(header, 124, 12);
        const typeflag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
        const blocks = Math.ceil(size / 512) * 512;

        if (typeflag === 'x' || typeflag === 'g' || typeflag === 'L') {
          if (blocks > 0) {
            metaType = typeflag;
            metaExactSize = size;
            metaNeededBlocks = blocks;
          }
        } else if (typeflag === '0' || typeflag === '\0') {
          const fullPath = (
            pendingPaxPath || (prefix ? `${prefix}/${name}` : name)
          ).replace(/^\/+/, '');
          pendingPaxPath = null;
          if (fullPath) {
            files.push({ path: fullPath, size });
          }
          skipRemaining = blocks;
        } else {
          pendingPaxPath = null;
          skipRemaining = blocks;
        }
      }
    }
  }

  return {
    feed,
    getFiles: () => files,
    isDone: () => done,
  };
}

app.setName('GHCR Manager');
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
}
if (process.platform === 'win32') {
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

/**
 * Recursively collect all files inside a directory with paths relative to baseDir
 */
async function collectFilesRecursively(dirPath, baseDir) {
  const results = [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFilesRecursively(fullPath, baseDir);
      results.push(...nested);
    } else if (entry.isFile()) {
      const stat = await fs.stat(fullPath);
      const relPath = path.relative(baseDir, fullPath).split(path.sep).join('/');
      results.push({
        fullPath,
        relativePath: relPath,
        name: entry.name,
        size: stat.size,
        mtime: Math.floor(stat.mtimeMs / 1000),
      });
    }
  }
  return results;
}

/**
 * Scan a chosen Root Folder according to the app rules:
 * - Each direct file in Root Folder -> 1 standalone image (image name = file name)
 * - Each immediate sub-folder in Root Folder -> 1 bundled image containing all files in that sub-folder (image name = sub-folder name)
 */
async function scanRootFolderEntries(rootFolderPath) {
  const entries = await fs.readdir(rootFolderPath, { withFileTypes: true });
  const rootFiles = [];
  const subFolders = [];

  for (const entry of entries) {
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
      const files = await collectFilesRecursively(fullPath, fullPath);
      if (files.length > 0) {
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
  }

  return {
    rootFolderPath,
    rootFolderName: path.basename(rootFolderPath),
    items: [...rootFiles, ...subFolders],
  };
}

app.whenReady().then(() => {
  ipcMain.handle('desktop:pickRootFolder', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Select Root Folder to Sync with GitHub Packages',
      properties: ['openDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return await scanRootFolderEntries(res.filePaths[0]);
  });

  ipcMain.handle('desktop:rescanRootFolder', async (_event, rootFolderPath) => {
    return await scanRootFolderEntries(rootFolderPath);
  });

  ipcMain.handle('desktop:readFileBytes', async (_event, fullPath) => {
    const buf = await fs.readFile(fullPath);
    return new Uint8Array(buf);
  });

  ipcMain.handle('desktop:saveExtractedFiles', async (_event, defaultFolderName, files) => {
    const res = await dialog.showOpenDialog({
      title: `Select Destination Folder to Extract "${defaultFolderName}"`,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return { saved: false };

    const baseDest =
      files.length === 1
        ? res.filePaths[0]
        : path.join(res.filePaths[0], defaultFolderName);

    for (const file of files) {
      const safeRel = path
        .normalize(file.relativePath)
        .replace(/^(\.\.(\/|\\|$))+/, '');
      const destPath = path.join(baseDest, safeRel);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, Buffer.from(file.data));
    }

    return { saved: true, outputPath: baseDest };
  });

  ipcMain.handle('desktop:httpRequest', async (_event, reqOpts) => {
    let currentUrl = reqOpts.url;
    let currentMethod = reqOpts.method || 'GET';
    let currentHeaders = { ...(reqOpts.headers || {}) };
    let currentBody = reqOpts.body ? Buffer.from(reqOpts.body) : undefined;

    let upstreamRes = null;
    for (let hops = 0; hops < 5; hops++) {
      upstreamRes = await fetch(currentUrl, {
        method: currentMethod,
        headers: currentHeaders,
        body:
          currentMethod !== 'GET' && currentMethod !== 'HEAD' ? currentBody : undefined,
        redirect: 'manual',
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
        let currentUrl = url;
        const headers = { Authorization: `Bearer ${registryToken}` };
        let upstreamRes = null;

        for (let hops = 0; hops < 5; hops++) {
          upstreamRes = await fetch(currentUrl, {
            method: 'GET',
            headers,
            redirect: 'manual',
            signal: abortController.signal,
          });

          if ([301, 302, 303, 307, 308].includes(upstreamRes.status)) {
            const loc = upstreamRes.headers.get('location');
            if (!loc) break;
            const nextUrl = new URL(loc, currentUrl).toString();
            const nextHost = new URL(nextUrl).hostname;
            const prevHost = new URL(currentUrl).hostname;
            if (nextHost !== prevHost) {
              delete headers['Authorization'];
            }
            currentUrl = nextUrl;
            continue;
          }
          break;
        }

        if (!upstreamRes || !upstreamRes.ok || !upstreamRes.body) {
          throw new Error(
            `Failed to stream layer blob (HTTP ${upstreamRes?.status || 'unknown'})`
          );
        }

        const totalBytes =
          Number(upstreamRes.headers.get('content-length')) || expectedSize || 0;
        const parser = createNodeTarMetaParser();
        const reader = upstreamRes.body.getReader();

        let gunzip = null;
        let gunzipDone = null;
        let isFirstChunk = true;
        let receivedBytes = 0;
        let lastEmittedPct = -1;

        while (true) {
          if (abortController.signal.aborted) {
            const abortErr = new Error('Layer scan aborted');
            abortErr.name = 'AbortError';
            throw abortErr;
          }

          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;

          receivedBytes += value.byteLength;
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

          const buf = Buffer.from(value);
          if (isFirstChunk) {
            isFirstChunk = false;
            const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
            if (isGzip) {
              gunzip = zlib.createGunzip();
              gunzipDone = new Promise((resolve, reject) => {
                gunzip.on('data', (decompressed) => {
                  try {
                    parser.feed(decompressed);
                  } catch (err) {
                    reject(err);
                  }
                });
                gunzip.on('end', resolve);
                gunzip.on('error', reject);
              });
            }
          }

          if (gunzip) {
            const canContinue = gunzip.write(buf);
            if (!canContinue) {
              await new Promise((resolve) => gunzip.once('drain', resolve));
            }
          } else {
            parser.feed(buf);
          }

          if (parser.isDone()) {
            await reader.cancel().catch(() => {});
            break;
          }
        }

        if (gunzip) {
          gunzip.end();
          await gunzipDone;
        }

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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
