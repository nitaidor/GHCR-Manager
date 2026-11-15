const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 940,
    minHeight: 680,
    backgroundColor: '#020617',
    title: 'GHCR Manager',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setMenuBarVisibility(false);

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
  // IPC: Pick a Root Folder on Desktop (Windows, Linux, macOS)
  ipcMain.handle('desktop:pickRootFolder', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Select Root Folder to Sync with GitHub Packages',
      properties: ['openDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return await scanRootFolderEntries(res.filePaths[0]);
  });

  // IPC: Re-scan an already selected Root Folder
  ipcMain.handle('desktop:rescanRootFolder', async (_event, rootFolderPath) => {
    return await scanRootFolderEntries(rootFolderPath);
  });

  // IPC: Read a local file's binary bytes
  ipcMain.handle('desktop:readFileBytes', async (_event, fullPath) => {
    const buf = await fs.readFile(fullPath);
    return new Uint8Array(buf);
  });

  // IPC: Save extracted files to a chosen destination directory on Desktop
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

  // IPC: Native HTTP bridge for ghcr.io & GitHub API (zero CORS issues, handles 307 blob redirects cleanly)
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

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
