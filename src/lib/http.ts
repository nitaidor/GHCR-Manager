export type DesktopCloseGuardMode = 'none' | 'upload' | 'sync' | 'index';

export interface HttpResponseData {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface DesktopRootFolderFileEntry {
  fullPath?: string;
  relativePath: string;
  name: string;
  size: number;
  mtime?: number;
  isDirectory?: boolean;
  fileHandle?: FileSystemFileHandle;
  rawFile?: File;
}

export interface DesktopRootFolderItem {
  kind: 'root-file' | 'root-subfolder';
  /** Raw file name (for root-file) or sub-folder name (for root-subfolder) */
  name: string;
  fullPath?: string;
  size: number;
  mtime?: number;
  files: DesktopRootFolderFileEntry[];
}

export interface UploadSelectionItem {
  kind: 'file' | 'folder';
  name: string;
  fullPath?: string;
  size: number;
  mtime?: number;
  rawFile?: File;
  files: DesktopRootFolderFileEntry[];
}

export interface DesktopRootFolderScanResult {
  rootFolderPath: string;
  rootFolderName: string;
  items: DesktopRootFolderItem[];
  dirHandle?: FileSystemDirectoryHandle;
}

declare global {
  interface Window {
    electronAPI?: {
      isDesktop: boolean;
      platform: string;
      getPathForFile?: (file: File) => string | undefined;
      setNativeTheme?: (mode: 'dark' | 'light' | 'system') => void;
      setCloseGuardMode?: (mode: DesktopCloseGuardMode) => void;
      onCloseBlocked?: (
        cb: (payload: { mode: Exclude<DesktopCloseGuardMode, 'none'> }) => void
      ) => () => void;
      pickDirectoryPath?: () => Promise<string | null>;
      pickDirectoriesForUpload?: () => Promise<string[]>;
      pickRootFolder: () => Promise<DesktopRootFolderScanResult | null>;
      rescanRootFolder: (
        rootFolderPath: string,
        scanId?: string
      ) => Promise<DesktopRootFolderScanResult>;
      scanPathsForUpload?: (
        targetPaths: string[],
        scanId?: string
      ) => Promise<UploadSelectionItem[]>;
      cancelFolderScan?: (scanId: string) => void;
      readFileBytes: (fullPath: string) => Promise<Uint8Array>;
      saveExtractedFiles: (
        defaultFolderName: string,
        files: Array<{ relativePath: string; data: Uint8Array; isDirectory?: boolean }>
      ) => Promise<{ saved: boolean; outputPath?: string }>;
      buildOciLayerFile?: (opts: {
        files: Array<{
          fullPath: string;
          relativePath: string;
          size?: number;
          mtime?: number;
          isDirectory?: boolean;
        }>;
        requestId?: string;
      }) => Promise<{
        tempPath: string;
        uncompressedDigest: string;
        compressedDigest: string;
        compressedSize: number;
        totalFileBytes: number;
        fileCount: number;
        fileMetaList: Array<{ path: string; size: number; isDirectory?: boolean }>;
      }>;
      uploadBlobFromFile?: (opts: {
        tempPath: string;
        uploadInitUrl: string;
        digest: string;
        registryToken: string;
        basicAuthHeader?: string;
        scopeParam?: string;
        compressedSize: number;
        requestId?: string;
      }) => Promise<{ registryToken?: string }>;
      streamAndUploadOciLayer?: (opts: {
        files: Array<{
          fullPath: string;
          relativePath: string;
          size?: number;
          mtime?: number;
          isDirectory?: boolean;
        }>;
        uploadInitUrl: string;
        registryToken: string;
        basicAuthHeader?: string;
        scopeParam?: string;
        requestId?: string;
      }) => Promise<{
        uncompressedDigest: string;
        compressedDigest: string;
        compressedSize: number;
        totalFileBytes: number;
        fileCount: number;
        fileMetaList: Array<{ path: string; size: number; isDirectory?: boolean }>;
        registryToken?: string;
      }>;
      deleteTempFile?: (tempPath: string) => Promise<void>;
      prepareExtractDestination?: (opts: {
        defaultFolderName: string;
      }) => Promise<{
        canceled: boolean;
        parentDir?: string;
        folderName?: string;
        targetPath?: string;
        exists?: boolean;
        suggestedName?: string;
        suggestedPath?: string;
      }>;
      downloadAndExtractLayer?: (opts: {
        url: string;
        registryToken: string;
        parentDir?: string;
        folderName?: string;
        replaceExisting?: boolean;
        defaultFolderName?: string;
        expectedSize?: number;
        requestId?: string;
      }) => Promise<{
        saved: boolean;
        outputPath?: string;
        files: Array<{ path: string; size: number; isDirectory?: boolean }>;
      }>;
      cancelTransfer?: (requestId: string) => void;
      onTransferProgress?: (
        cb: (payload: {
          requestId: string;
          stage: string;
          message: string;
          percent: number;
        }) => void
      ) => () => void;
      httpRequest: (opts: {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        body?: Uint8Array;
      }) => Promise<HttpResponseData>;
      streamLayerFileList?: (opts: {
        url: string;
        registryToken: string;
        expectedSize?: number;
        requestId: string;
      }) => Promise<{
        files: Array<{ path: string; size: number; isDirectory?: boolean }>;
      }>;
      cancelLayerStream?: (requestId: string) => void;
      onLayerStreamProgress?: (
        cb: (payload: { requestId: string; percent: number }) => void
      ) => () => void;
    };
    showDirectoryPicker?: (options?: {
      mode?: 'read' | 'readwrite';
    }) => Promise<FileSystemDirectoryHandle>;
  }
}

const decoder = new TextDecoder();

export function decodeJson<T>(bytes: Uint8Array): T {
  const text = decoder.decode(bytes);
  return JSON.parse(text) as T;
}

export function decodeText(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; message?: string };
  return (
    e.name === 'AbortError' ||
    (typeof e.message === 'string' && /\bAbortError\b/i.test(e.message))
  );
}

/**
 * Unified cross-platform HTTP client for GitHub REST API and ghcr.io OCI v2 Registry.
 * - On Desktop (Electron): routes through Node.js main process IPC
 * - On Mobile (Capacitor Android/iOS): uses CapacitorHttp-patched native fetch
 * - On Web Dev Server: routes through Vite's /__oci_proxy middleware
 */
export async function crossPlatformHttpRequest(opts: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  signal?: AbortSignal;
}): Promise<HttpResponseData> {
  if (opts.signal?.aborted) {
    throw new DOMException('Operation aborted', 'AbortError');
  }

  const bodyBytes =
    typeof opts.body === 'string'
      ? new TextEncoder().encode(opts.body)
      : opts.body;

  if (window.electronAPI?.httpRequest) {
    const reqPromise = window.electronAPI.httpRequest({
      url: opts.url,
      method: opts.method || 'GET',
      headers: opts.headers,
      body: bodyBytes,
    });
    if (!opts.signal) {
      return await reqPromise;
    }
    return await new Promise<HttpResponseData>((resolve, reject) => {
      const onAbort = () => {
        reject(new DOMException('Operation aborted', 'AbortError'));
      };
      opts.signal!.addEventListener('abort', onAbort, { once: true });
      reqPromise.then(
        (res) => {
          opts.signal!.removeEventListener('abort', onAbort);
          resolve(res);
        },
        (err) => {
          opts.signal!.removeEventListener('abort', onAbort);
          reject(err);
        }
      );
    });
  }

  // Try Vite /__oci_proxy first when running in browser dev/preview mode
  const isLocalWeb =
    typeof window !== 'undefined' &&
    (window.location.protocol === 'http:' || window.location.protocol === 'https:');

  if (isLocalWeb) {
    try {
      const bodyCopy = bodyBytes ? new Uint8Array(bodyBytes.byteLength) : undefined;
      if (bodyCopy && bodyBytes) bodyCopy.set(bodyBytes);

      const proxyRes = await fetch('/__oci_proxy', {
        method: opts.method || 'GET',
        cache: 'no-store',
        headers: {
          'x-target-url': opts.url,
          'x-forward-headers': JSON.stringify(opts.headers || {}),
        },
        body:
          opts.method && opts.method !== 'GET' && opts.method !== 'HEAD' && bodyCopy
            ? bodyCopy.buffer
            : undefined,
        signal: opts.signal,
      });

      const upstreamHeadersRaw = proxyRes.headers.get('x-upstream-headers');
      if (upstreamHeadersRaw) {
        const headers = JSON.parse(upstreamHeadersRaw) as Record<string, string>;
        const buf = new Uint8Array(await proxyRes.arrayBuffer());
        return {
          status: proxyRes.status,
          headers,
          body: buf,
        };
      }
    } catch (err) {
      if (opts.signal?.aborted || isAbortError(err)) {
        throw err;
      }
      // Fallback to direct fetch (e.g. Capacitor native HTTP on Android/iOS)
    }
  }

  if (opts.signal?.aborted) {
    throw new DOMException('Operation aborted', 'AbortError');
  }

  const directCopy = bodyBytes ? new Uint8Array(bodyBytes.byteLength) : undefined;
  if (directCopy && bodyBytes) directCopy.set(bodyBytes);

  const res = await fetch(opts.url, {
    method: opts.method || 'GET',
    cache: 'no-store',
    headers: opts.headers,
    body:
      opts.method && opts.method !== 'GET' && opts.method !== 'HEAD' && directCopy
        ? directCopy.buffer
        : undefined,
    signal: opts.signal,
  });

  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });

  return {
    status: res.status,
    headers,
    body: new Uint8Array(await res.arrayBuffer()),
  };
}

/**
 * Runs async tasks across an array with a fixed worker concurrency cap.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Browser File System Access API fallback for Desktop Root Folder Sync when running in Chrome/Edge
 * outside of the Electron shell.
 */
async function collectBrowserDirFilesRecursively(
  dirHandle: FileSystemDirectoryHandle,
  prefix = '',
  signal?: AbortSignal,
  counter = { count: 0 }
): Promise<DesktopRootFolderFileEntry[]> {
  if (signal?.aborted) throw new Error('SCAN_ABORTED');
  const results: DesktopRootFolderFileEntry[] = [];
  // @ts-expect-error FileSystemDirectoryHandle.entries() is supported in Chromium browsers
  for await (const [name, handle] of dirHandle.entries()) {
    if (signal?.aborted) throw new Error('SCAN_ABORTED');
    if (name === '.DS_Store' || name === 'Thumbs.db') continue;

    counter.count += 1;
    if (counter.count % 25 === 0) {
      await new Promise((r) => setTimeout(r, 0));
      if (signal?.aborted) throw new Error('SCAN_ABORTED');
    }

    const relPath = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'file') {
      const fileHandle = handle as FileSystemFileHandle;
      const file = await fileHandle.getFile();
      results.push({
        relativePath: relPath,
        name,
        size: file.size,
        mtime: Math.floor(file.lastModified / 1000),
        fileHandle,
      });
    } else if (handle.kind === 'directory') {
      const subDir = handle as FileSystemDirectoryHandle;
      const nested = await collectBrowserDirFilesRecursively(
        subDir,
        relPath,
        signal,
        counter
      );
      if (nested.length === 0) {
        results.push({
          relativePath: relPath,
          name,
          size: 0,
          mtime: Math.floor(Date.now() / 1000),
          isDirectory: true,
        });
      } else {
        for (let i = 0; i < nested.length; i++) {
          results.push(nested[i]);
        }
      }
    }
  }
  return results;
}

export async function scanBrowserDirectoryHandle(
  dirHandle: FileSystemDirectoryHandle,
  signal?: AbortSignal
): Promise<DesktopRootFolderScanResult> {
  const rootFiles: DesktopRootFolderItem[] = [];
  const subFolders: DesktopRootFolderItem[] = [];
  const counter = { count: 0 };

  // @ts-expect-error FileSystemDirectoryHandle.entries() is supported in Chromium browsers
  for await (const [name, handle] of dirHandle.entries()) {
    if (signal?.aborted) throw new Error('SCAN_ABORTED');
    if (name === '.DS_Store' || name === 'Thumbs.db') continue;
    if (handle.kind === 'file') {
      const fileHandle = handle as FileSystemFileHandle;
      const file = await fileHandle.getFile();
      rootFiles.push({
        kind: 'root-file',
        name,
        size: file.size,
        mtime: Math.floor(file.lastModified / 1000),
        files: [
          {
            relativePath: name,
            name,
            size: file.size,
            mtime: Math.floor(file.lastModified / 1000),
            fileHandle,
          },
        ],
      });
    } else if (handle.kind === 'directory') {
      const subDir = handle as FileSystemDirectoryHandle;
      const files = await collectBrowserDirFilesRecursively(
        subDir,
        '',
        signal,
        counter
      );
      const totalSize = files.reduce((acc, f) => acc + f.size, 0);
      subFolders.push({
        kind: 'root-subfolder',
        name,
        size: totalSize,
        files,
      });
    }
  }

  return {
    rootFolderPath: dirHandle.name,
    rootFolderName: dirHandle.name,
    items: [...rootFiles, ...subFolders],
    dirHandle,
  };
}

export async function scanBrowserDirectoryForUpload(
  dirHandle: FileSystemDirectoryHandle,
  signal?: AbortSignal
): Promise<UploadSelectionItem> {
  const files = await collectBrowserDirFilesRecursively(dirHandle, '', signal);
  const totalSize = files.reduce((acc, f) => acc + f.size, 0);
  return {
    kind: 'folder',
    name: dirHandle.name,
    size: totalSize,
    files,
  };
}
