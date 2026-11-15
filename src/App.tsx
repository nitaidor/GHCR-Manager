import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  File as FileIcon,
  FilePlus2,
  Folder,
  FolderSync,
  Github,
  HardDrive,
  Info,
  KeyRound,
  Layers,
  Loader2,
  Lock,
  LogOut,
  Package,
  RefreshCw,
  Search,
  ShieldCheck,
  Smartphone,
  Trash2,
  Upload,
  X,
  AlertCircle,
} from 'lucide-react';
import {
  buildAndPushOciImage,
  deleteGitHubPackage,
  downloadAndExtractPackage,
  fetchGitHubUser,
  formatBytes,
  inspectPackageManifest,
  listPackagesForRepo,
  listUserRepositories,
  pollGitHubDeviceFlowToken,
  startGitHubDeviceFlow,
  type GitHubPackageItem,
  type GitHubRepo,
  type GitHubUser,
  type OciPackageDetails,
  type PushProgressUpdate,
} from './lib/github-oci';
import {
  scanBrowserDirectoryHandle,
  type DesktopRootFolderItem,
  type DesktopRootFolderScanResult,
} from './lib/http';
import { toOciImageName, validateFilesSelectionName } from './lib/naming';
import { createZipFromExtractedFiles, type TarInputFile } from './lib/tar';

type ActiveTab = 'upload-files' | 'sync-folder' | 'packages';

interface SyncItemStatus {
  state: 'idle' | 'uploading' | 'done' | 'error';
  message?: string;
  percent?: number;
}

const STORAGE_TOKEN_KEY = 'ghpm_github_token_v1';
const STORAGE_REPO_KEY = 'ghpm_selected_repo_id_v1';

export default function App() {
  // Auth state
  const [tokenInput, setTokenInput] = useState<string>(
    () => localStorage.getItem(STORAGE_TOKEN_KEY) || ''
  );
  const [authToken, setAuthToken] = useState<string>('');
  const [user, setUser] = useState<GitHubUser | null>(null);
  const [authLoading, setAuthLoading] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authTab, setAuthTab] = useState<'pat' | 'device'>('pat');

  // Device flow state
  const [oauthClientId, setOauthClientId] = useState<string>('');
  const [deviceFlowInfo, setDeviceFlowInfo] = useState<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    interval: number;
  } | null>(null);
  const [devicePolling, setDevicePolling] = useState<boolean>(false);

  // Repositories state
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [reposLoading, setReposLoading] = useState<boolean>(false);
  const [repoSearch, setRepoSearch] = useState<string>('');
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);

  // Navigation tab
  const [activeTab, setActiveTab] = useState<ActiveTab>('upload-files');

  // --- TAB 1: Pick File(s) state ---
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  const [customImageName, setCustomImageName] = useState<string>('');
  const [imageTag, setImageTag] = useState<string>('latest');
  const [uploadProgress, setUploadProgress] = useState<PushProgressUpdate | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<OciPackageDetails | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // --- TAB 2: Root Folder Sync state (Windows / Linux / macOS) ---
  const [rootScan, setRootScan] = useState<DesktopRootFolderScanResult | null>(null);
  const [selectedSyncIndices, setSelectedSyncIndices] = useState<Set<number>>(new Set());
  const [expandedSubfolders, setExpandedSubfolders] = useState<Set<number>>(new Set());
  const [syncStatuses, setSyncStatuses] = useState<Record<number, SyncItemStatus>>({});
  const [isSyncingFolder, setIsSyncingFolder] = useState<boolean>(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const fallbackFolderInputRef = useRef<HTMLInputElement | null>(null);
  // Keep raw browser File objects mapped when using <input webkitdirectory> fallback
  const fallbackFileMapRef = useRef<Map<string, File>>(new Map());

  // --- TAB 3: Repo Packages state ---
  const [repoPackages, setRepoPackages] = useState<GitHubPackageItem[]>([]);
  const [otherPackages, setOtherPackages] = useState<GitHubPackageItem[]>([]);
  const [showOtherPackages, setShowOtherPackages] = useState<boolean>(false);
  const [packagesLoading, setPackagesLoading] = useState<boolean>(false);
  const [packagesError, setPackagesError] = useState<string | null>(null);
  const [inspectedManifests, setInspectedManifests] = useState<
    Record<string, OciPackageDetails>
  >({});
  const [inspectingPkgName, setInspectingPkgName] = useState<string | null>(null);
  const [downloadingPkgName, setDownloadingPkgName] = useState<string | null>(null);
  const [deletingPkgName, setDeletingPkgName] = useState<string | null>(null);
  const [confirmDeletePkg, setConfirmDeletePkg] = useState<GitHubPackageItem | null>(null);
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [actionBanner, setActionBanner] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Auto sign-in if token is saved in localStorage
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_TOKEN_KEY);
    if (saved) {
      handleSignInWithToken(saved);
    }
  }, []);

  async function handleSignInWithToken(tokenToUse: string) {
    const clean = tokenToUse.trim();
    if (!clean) {
      setAuthError('Please enter a GitHub token.');
      return;
    }
    setAuthLoading(true);
    setAuthError(null);
    try {
      const ghUser = await fetchGitHubUser(clean);
      setUser(ghUser);
      setAuthToken(clean);
      localStorage.setItem(STORAGE_TOKEN_KEY, clean);

      setReposLoading(true);
      const userRepos = await listUserRepositories(clean);
      setRepos(userRepos);

      const savedRepoId = Number(localStorage.getItem(STORAGE_REPO_KEY));
      const matched =
        userRepos.find((r) => r.id === savedRepoId) || userRepos[0] || null;
      setSelectedRepo(matched);
    } catch (err: unknown) {
      setAuthError(err instanceof Error ? err.message : String(err));
      setUser(null);
      setAuthToken('');
    } finally {
      setAuthLoading(false);
      setReposLoading(false);
    }
  }

  function handleSignOut() {
    localStorage.removeItem(STORAGE_TOKEN_KEY);
    setUser(null);
    setAuthToken('');
    setTokenInput('');
    setRepos([]);
    setSelectedRepo(null);
    setRepoPackages([]);
    setOtherPackages([]);
  }

  // OAuth Device Flow handlers
  async function handleStartDeviceFlow() {
    if (!oauthClientId.trim()) {
      setAuthError('Please enter your GitHub OAuth App Client ID.');
      return;
    }
    setAuthLoading(true);
    setAuthError(null);
    try {
      const info = await startGitHubDeviceFlow(oauthClientId);
      setDeviceFlowInfo(info);
      setDevicePolling(true);
    } catch (err: unknown) {
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthLoading(false);
    }
  }

  useEffect(() => {
    if (!devicePolling || !deviceFlowInfo || !oauthClientId) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const res = await pollGitHubDeviceFlowToken(
          oauthClientId,
          deviceFlowInfo.device_code
        );
        if (cancelled) return;
        if (res.status === 'success' && res.accessToken) {
          setDevicePolling(false);
          setDeviceFlowInfo(null);
          setTokenInput(res.accessToken);
          await handleSignInWithToken(res.accessToken);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setDevicePolling(false);
          setAuthError(err instanceof Error ? err.message : String(err));
        }
      }
    }, (deviceFlowInfo.interval || 5) * 1000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [devicePolling, deviceFlowInfo, oauthClientId]);

  // Refresh packages when selectedRepo changes or when switching to Packages tab
  useEffect(() => {
    if (selectedRepo && authToken && user) {
      localStorage.setItem(STORAGE_REPO_KEY, String(selectedRepo.id));
      refreshPackages();
    }
  }, [selectedRepo, authToken, user]);

  async function refreshPackages() {
    if (!selectedRepo || !authToken || !user) return;
    setPackagesLoading(true);
    setPackagesError(null);
    try {
      const { repoPackages: linked, otherOwnerPackages: others } =
        await listPackagesForRepo(authToken, user.login, selectedRepo);
      setRepoPackages(linked);
      setOtherPackages(others);
    } catch (err: unknown) {
      setPackagesError(err instanceof Error ? err.message : String(err));
    } finally {
      setPackagesLoading(false);
    }
  }

  const filteredRepos = useMemo(() => {
    const q = repoSearch.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter(
      (r) =>
        r.full_name.toLowerCase().includes(q) ||
        (r.description && r.description.toLowerCase().includes(q))
    );
  }, [repos, repoSearch]);

  // --- TAB 1: File selection & naming logic ---
  function handleFilesAdded(newFiles: FileList | File[]) {
    const incoming = Array.from(newFiles);
    if (incoming.length === 0) return;

    setUploadError(null);
    setUploadSuccess(null);

    const updated = [...pickedFiles, ...incoming];
    setPickedFiles(updated);

    // Apply the user's exact naming rules:
    // - If 1 file is picked: default to the file's name (user can keep it or edit it)
    // - If multiple files are picked: user MUST enter a name (clear auto-filled single-file default if transitioning from 0/1 to 2+)
    if (updated.length === 1) {
      setCustomImageName(updated[0].name);
    } else if (pickedFiles.length <= 1 && updated.length > 1) {
      // Transitioned to multiple files: require user to enter a name explicitly
      if (
        !customImageName ||
        (pickedFiles.length === 1 && customImageName === pickedFiles[0].name)
      ) {
        setCustomImageName('');
      }
    }
  }

  function handleRemovePickedFile(idx: number) {
    const next = pickedFiles.filter((_, i) => i !== idx);
    setPickedFiles(next);
    if (next.length === 1 && !customImageName.trim()) {
      setCustomImageName(next[0].name);
    } else if (next.length === 0) {
      setCustomImageName('');
    }
  }

  const fileNamingValidation = useMemo(() => {
    return validateFilesSelectionName(
      pickedFiles.length,
      customImageName,
      pickedFiles.length === 1 ? pickedFiles[0].name : undefined
    );
  }, [pickedFiles, customImageName]);

  async function handleUploadSelectedFiles() {
    if (!selectedRepo || !user || !authToken) return;
    if (!fileNamingValidation.valid) {
      setUploadError(fileNamingValidation.error || 'Invalid image name.');
      return;
    }

    setUploadError(null);
    setUploadSuccess(null);

    try {
      const tarInputs: TarInputFile[] = [];
      for (const f of pickedFiles) {
        const buf = new Uint8Array(await f.arrayBuffer());
        tarInputs.push({
          relativePath: f.name,
          data: buf,
          mtime: Math.floor(f.lastModified / 1000),
        });
      }

      const details = await buildAndPushOciImage({
        username: user.login,
        githubToken: authToken,
        repo: selectedRepo,
        rawImageName: fileNamingValidation.effectiveRawName,
        tag: imageTag.trim() || 'latest',
        mode: pickedFiles.length === 1 ? 'single-file' : 'multi-file',
        files: tarInputs,
        onProgress: (p) => setUploadProgress(p),
      });

      setUploadSuccess(details);
      setInspectedManifests((prev) => ({
        ...prev,
        [details.packageName]: details,
      }));
      refreshPackages();
    } catch (err: unknown) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadProgress(null);
    }
  }

  // --- TAB 2: Root Folder Sync handlers (Windows, Linux, macOS) ---
  async function handlePickRootFolder() {
    setSyncError(null);
    try {
      // 1. Native Desktop Electron folder dialog
      if (window.electronAPI?.pickRootFolder) {
        const scan = await window.electronAPI.pickRootFolder();
        if (scan) {
          applyRootScan(scan);
        }
        return;
      }

      // 2. Chromium File System Access API (showDirectoryPicker)
      if (typeof window.showDirectoryPicker === 'function') {
        const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
        const scan = await scanBrowserDirectoryHandle(dirHandle);
        applyRootScan(scan);
        return;
      }

      // 3. Universal fallback via <input webkitdirectory>
      fallbackFolderInputRef.current?.click();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setSyncError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleFallbackWebkitDirectory(e: React.ChangeEvent<HTMLInputElement>) {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;

    fallbackFileMapRef.current.clear();
    const rootFiles: DesktopRootFolderItem[] = [];
    const subFoldersMap = new Map<string, DesktopRootFolderItem>();
    let detectedRootName = 'Selected Folder';

    for (const file of Array.from(fileList)) {
      const rel = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
      const parts = rel.split('/').filter(Boolean);
      if (parts.length === 0) continue;

      detectedRootName = parts[0];
      const insideRootParts = parts.slice(1);
      if (insideRootParts.length === 0) continue;

      const lastPart = insideRootParts[insideRootParts.length - 1];
      if (lastPart === '.DS_Store' || lastPart === 'Thumbs.db') continue;

      if (insideRootParts.length === 1) {
        // Direct file in Root Folder -> 1 standalone image named after the file
        const fileName = insideRootParts[0];
        const mapKey = `root-file:${fileName}`;
        fallbackFileMapRef.current.set(mapKey, file);
        rootFiles.push({
          kind: 'root-file',
          name: fileName,
          size: file.size,
          mtime: Math.floor(file.lastModified / 1000),
          files: [
            {
              fullPath: mapKey,
              relativePath: fileName,
              name: fileName,
              size: file.size,
              mtime: Math.floor(file.lastModified / 1000),
            },
          ],
        });
      } else {
        // Inside an immediate sub-folder of the Root Folder -> bundled into 1 image named after the sub-folder
        const subFolderName = insideRootParts[0];
        const pathInsideSubFolder = insideRootParts.slice(1).join('/');
        const mapKey = `subfolder:${subFolderName}/${pathInsideSubFolder}`;
        fallbackFileMapRef.current.set(mapKey, file);

        let group = subFoldersMap.get(subFolderName);
        if (!group) {
          group = {
            kind: 'root-subfolder',
            name: subFolderName,
            size: 0,
            files: [],
          };
          subFoldersMap.set(subFolderName, group);
        }
        group.size += file.size;
        group.files.push({
          fullPath: mapKey,
          relativePath: pathInsideSubFolder,
          name: lastPart,
          size: file.size,
          mtime: Math.floor(file.lastModified / 1000),
        });
      }
    }

    const items = [...rootFiles, ...Array.from(subFoldersMap.values())];
    applyRootScan({
      rootFolderPath: detectedRootName,
      rootFolderName: detectedRootName,
      items,
    });
    e.target.value = '';
  }

  function applyRootScan(scan: DesktopRootFolderScanResult) {
    setRootScan(scan);
    setSelectedSyncIndices(new Set(scan.items.map((_, idx) => idx)));
    setExpandedSubfolders(new Set());
    setSyncStatuses({});
  }

  async function handleRescanRootFolder() {
    if (!rootScan) return;
    setSyncError(null);
    try {
      if (window.electronAPI?.rescanRootFolder && rootScan.rootFolderPath) {
        const updated = await window.electronAPI.rescanRootFolder(
          rootScan.rootFolderPath
        );
        applyRootScan(updated);
      } else if (rootScan.dirHandle) {
        const updated = await scanBrowserDirectoryHandle(rootScan.dirHandle);
        applyRootScan(updated);
      }
    } catch (err: unknown) {
      setSyncError(err instanceof Error ? err.message : String(err));
    }
  }

  async function readRootSyncItemFiles(
    item: DesktopRootFolderItem
  ): Promise<TarInputFile[]> {
    const result: TarInputFile[] = [];
    for (const entry of item.files) {
      let bytes: Uint8Array;
      if (entry.fileHandle) {
        const fileObj = await entry.fileHandle.getFile();
        bytes = new Uint8Array(await fileObj.arrayBuffer());
      } else if (
        entry.fullPath &&
        fallbackFileMapRef.current.has(entry.fullPath)
      ) {
        const fileObj = fallbackFileMapRef.current.get(entry.fullPath)!;
        bytes = new Uint8Array(await fileObj.arrayBuffer());
      } else if (entry.fullPath && window.electronAPI?.readFileBytes) {
        bytes = await window.electronAPI.readFileBytes(entry.fullPath);
      } else {
        throw new Error(`Unable to read bytes for file: ${entry.relativePath}`);
      }

      result.push({
        relativePath: entry.relativePath,
        data: bytes,
        mtime: entry.mtime,
      });
    }
    return result;
  }

  async function handleSyncRootFolder() {
    if (!rootScan || !selectedRepo || !user || !authToken) return;
    const indicesToSync = Array.from(selectedSyncIndices).sort((a, b) => a - b);
    if (indicesToSync.length === 0) {
      setSyncError('Please select at least one item in the root folder to sync.');
      return;
    }

    setIsSyncingFolder(true);
    setSyncError(null);

    for (const idx of indicesToSync) {
      const item = rootScan.items[idx];
      if (!item) continue;

      setSyncStatuses((prev) => ({
        ...prev,
        [idx]: {
          state: 'uploading',
          message: 'Reading files...',
          percent: 5,
        },
      }));

      try {
        const tarFiles = await readRootSyncItemFiles(item);
        const details = await buildAndPushOciImage({
          username: user.login,
          githubToken: authToken,
          repo: selectedRepo,
          // Rule:
          // - Root file -> image/package name is the file name
          // - Sub-folder -> image/package name is the sub-folder name
          rawImageName: item.name,
          tag: 'latest',
          mode: item.kind,
          files: tarFiles,
          onProgress: (p) => {
            setSyncStatuses((prev) => ({
              ...prev,
              [idx]: {
                state: 'uploading',
                message: p.message,
                percent: p.percent,
              },
            }));
          },
        });

        setInspectedManifests((prev) => ({
          ...prev,
          [details.packageName]: details,
        }));

        setSyncStatuses((prev) => ({
          ...prev,
          [idx]: {
            state: 'done',
            message: `Uploaded as package "${details.packageName}"`,
            percent: 100,
          },
        }));
      } catch (err: unknown) {
        setSyncStatuses((prev) => ({
          ...prev,
          [idx]: {
            state: 'error',
            message: err instanceof Error ? err.message : String(err),
          },
        }));
      }
    }

    setIsSyncingFolder(false);
    refreshPackages();
  }

  // --- TAB 3: Package Inspect, Download, and Delete handlers ---
  async function handleInspectPackage(pkgName: string) {
    if (!selectedRepo || !user || !authToken) return;
    setInspectingPkgName(pkgName);
    setActionBanner(null);
    try {
      const details = await inspectPackageManifest({
        username: user.login,
        githubToken: authToken,
        owner: selectedRepo.owner.login,
        packageName: pkgName,
      });
      setInspectedManifests((prev) => ({
        ...prev,
        [pkgName]: details,
      }));
    } catch (err: unknown) {
      setActionBanner({
        type: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setInspectingPkgName(null);
    }
  }

  function triggerBrowserDownload(bytes: Uint8Array, fileName: string) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const blob = new Blob([copy.buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function handleDownloadPackage(pkgName: string) {
    if (!selectedRepo || !user || !authToken) return;
    setDownloadingPkgName(pkgName);
    setActionBanner(null);
    try {
      const { details, extractedFiles } = await downloadAndExtractPackage({
        username: user.login,
        githubToken: authToken,
        owner: selectedRepo.owner.login,
        packageName: pkgName,
      });

      setInspectedManifests((prev) => ({
        ...prev,
        [pkgName]: details,
      }));

      if (extractedFiles.length === 0) {
        throw new Error('No files were found inside the package layer.');
      }

      // On Desktop (Electron), let user choose a folder to extract directly to disk
      if (window.electronAPI?.saveExtractedFiles) {
        const res = await window.electronAPI.saveExtractedFiles(
          details.originalName || pkgName,
          extractedFiles
        );
        if (res.saved) {
          setActionBanner({
            type: 'success',
            text: `Extracted ${extractedFiles.length} file(s) from "${pkgName}" to ${res.outputPath}`,
          });
        }
        return;
      }

      // On Web / Mobile: if single file, download that exact file directly; if multiple files, download as .zip
      if (extractedFiles.length === 1) {
        const single = extractedFiles[0];
        const fileName = single.relativePath.split('/').pop() || pkgName;
        triggerBrowserDownload(single.data, fileName);
        setActionBanner({
          type: 'success',
          text: `Downloaded "${fileName}" (${formatBytes(single.data.byteLength)})`,
        });
      } else {
        const zipBytes = createZipFromExtractedFiles(extractedFiles);
        const zipName = `${details.originalName || pkgName}.zip`;
        triggerBrowserDownload(zipBytes, zipName);
        setActionBanner({
          type: 'success',
          text: `Downloaded ${extractedFiles.length} files as "${zipName}" (${formatBytes(zipBytes.byteLength)})`,
        });
      }
    } catch (err: unknown) {
      setActionBanner({
        type: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDownloadingPkgName(null);
    }
  }

  async function handleDeletePackageConfirmed(pkg: GitHubPackageItem) {
    if (!selectedRepo || !user || !authToken) return;
    setDeletingPkgName(pkg.name);
    setConfirmDeletePkg(null);
    setActionBanner(null);
    try {
      await deleteGitHubPackage({
        githubToken: authToken,
        currentUserLogin: user.login,
        owner: pkg.owner.login,
        ownerType: pkg.owner.type,
        packageName: pkg.name,
      });
      setActionBanner({
        type: 'success',
        text: `Removed package "${pkg.name}" from GitHub Packages.`,
      });
      await refreshPackages();
    } catch (err: unknown) {
      setActionBanner({
        type: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDeletingPkgName(null);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    setCopiedText(text);
    setTimeout(() => setCopiedText(null), 2000);
  }

  // ==================== RENDER: SIGN-IN SCREEN ====================
  if (!user) {
    const tokenGenUrl =
      'https://github.com/settings/tokens/new?description=GHCR%20Manager&scopes=repo,write:packages,read:packages,delete:packages';

    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-center items-center p-4">
        <div className="w-full max-w-lg bg-slate-900/90 border border-slate-800 rounded-2xl shadow-2xl p-6 sm:p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 rounded-xl bg-indigo-600/20 border border-indigo-500/40 flex items-center justify-center text-indigo-400">
              <Package className="w-7 h-7" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-white">
                GHCR Manager
              </h1>
            </div>
          </div>

          {/* Auth Method Tabs */}
          <div className="grid grid-cols-2 gap-2 p-1 bg-slate-950 rounded-xl border border-slate-800 mb-6">
            <button
              type="button"
              onClick={() => {
                setAuthTab('pat');
                setAuthError(null);
              }}
              className={`py-2 px-3 rounded-lg text-xs font-medium transition flex items-center justify-center gap-2 ${
                authTab === 'pat'
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <KeyRound className="w-3.5 h-3.5" />
              GitHub Token (Instant)
            </button>
            <button
              type="button"
              onClick={() => {
                setAuthTab('device');
                setAuthError(null);
              }}
              className={`py-2 px-3 rounded-lg text-xs font-medium transition flex items-center justify-center gap-2 ${
                authTab === 'device'
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Smartphone className="w-3.5 h-3.5" />
              OAuth Device Flow
            </button>
          </div>

          {authError && (
            <div className="mb-5 p-3.5 rounded-xl bg-rose-950/60 border border-rose-800/70 text-rose-200 text-xs flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <span>{authError}</span>
            </div>
          )}

          {authTab === 'pat' ? (
            <div className="space-y-4">
              <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800 text-xs text-slate-300 space-y-2">
                <div className="font-medium text-slate-200 flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  Required GitHub Scopes:
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {['repo', 'write:packages', 'read:packages', 'delete:packages'].map(
                    (scope) => (
                      <span
                        key={scope}
                        className="px-2 py-0.5 rounded bg-slate-800 text-indigo-300 font-mono text-[11px]"
                      >
                        {scope}
                      </span>
                    )
                  )}
                </div>
                <a
                  href={tokenGenUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-indigo-400 hover:text-indigo-300 font-medium pt-1"
                >
                  Open GitHub with scopes pre-selected
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Personal Access Token (Classic `ghp_...`)
                </label>
                <input
                  type="password"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSignInWithToken(tokenInput);
                  }}
                  placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>

              <button
                type="button"
                disabled={authLoading}
                onClick={() => handleSignInWithToken(tokenInput)}
                className="w-full py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium text-sm transition flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20 cursor-pointer"
              >
                {authLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Signing in to GitHub...
                  </>
                ) : (
                  <>
                    <Github className="w-4 h-4" />
                    Sign In with GitHub
                  </>
                )}
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-xs text-slate-400 leading-relaxed">
                Sign in via browser code using a GitHub OAuth App Client ID (with Device
                Flow enabled in your GitHub OAuth App settings).
              </p>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  GitHub OAuth App Client ID
                </label>
                <input
                  type="text"
                  value={oauthClientId}
                  onChange={(e) => setOauthClientId(e.target.value)}
                  placeholder="Iv1.xxxxxxxxxxxxxxxx or Ov23lixxxxxxxxx"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>

              {!deviceFlowInfo ? (
                <button
                  type="button"
                  disabled={authLoading}
                  onClick={handleStartDeviceFlow}
                  className="w-full py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium text-sm transition flex items-center justify-center gap-2 cursor-pointer"
                >
                  {authLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Github className="w-4 h-4" />
                  )}
                  Generate Device Login Code
                </button>
              ) : (
                <div className="p-4 rounded-xl bg-slate-950 border border-indigo-500/40 text-center space-y-3">
                  <div className="text-xs text-slate-400">
                    Enter this code on GitHub to authorize:
                  </div>
                  <div className="text-2xl font-mono font-bold tracking-widest text-indigo-400 bg-slate-900 py-2 px-4 rounded-lg inline-block border border-slate-800">
                    {deviceFlowInfo.user_code}
                  </div>
                  <div>
                    <a
                      href={deviceFlowInfo.verification_uri}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 px-3.5 py-2 rounded-lg"
                    >
                      Open {deviceFlowInfo.verification_uri}
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                  <div className="flex items-center justify-center gap-2 text-xs text-slate-400 pt-1">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400" />
                    Waiting for authorization in browser...
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ==================== RENDER: AUTHENTICATED MAIN WORKSPACE ====================
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top Navigation Bar */}
      <header className="border-b border-slate-800/80 bg-slate-900/70 backdrop-blur sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-600/20 border border-indigo-500/40 flex items-center justify-center text-indigo-400">
              <Package className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-sm sm:text-base text-white">
                  GHCR Manager
                </span>
                <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-indigo-950 text-indigo-300 border border-indigo-800/60 font-semibold">
                  ghcr.io OCI
                </span>
              </div>
              <p className="text-xs text-slate-400 hidden sm:block">
                Create, sync, view, download & remove repository container packages
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-950 border border-slate-800">
              <img
                src={user.avatar_url}
                alt={user.login}
                className="w-5 h-5 rounded-full"
              />
              <span className="text-xs font-medium text-slate-200">{user.login}</span>
            </div>
            <button
              type="button"
              onClick={handleSignOut}
              title="Sign Out"
              className="p-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-rose-400 border border-slate-800 transition cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Layout: Left Sidebar (Repo Picker) + Right Content */}
      <div className="max-w-7xl w-full mx-auto flex-1 grid grid-cols-1 lg:grid-cols-12 gap-6 p-4 sm:p-6">
        {/* Left Column: Repository Picker */}
        <aside className="lg:col-span-4 xl:col-span-3 flex flex-col bg-slate-900/60 border border-slate-800/90 rounded-2xl overflow-hidden max-h-[420px] lg:max-h-[calc(100vh-120px)]">
          <div className="p-3.5 border-b border-slate-800 space-y-2.5">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                1. Select Repository ({repos.length})
              </h2>
              <button
                type="button"
                onClick={() => handleSignInWithToken(authToken)}
                title="Refresh repositories"
                className="text-slate-400 hover:text-white p-1 rounded cursor-pointer"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${reposLoading ? 'animate-spin' : ''}`}
                />
              </button>
            </div>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={repoSearch}
                onChange={(e) => setRepoSearch(e.target.value)}
                placeholder="Filter repositories..."
                className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-slate-800/50">
            {filteredRepos.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-500">
                No matching repositories found.
              </div>
            ) : (
              filteredRepos.map((repo) => {
                const isSelected = selectedRepo?.id === repo.id;
                return (
                  <button
                    key={repo.id}
                    type="button"
                    onClick={() => setSelectedRepo(repo)}
                    className={`w-full text-left p-3 transition flex items-start justify-between gap-2 cursor-pointer ${
                      isSelected
                        ? 'bg-indigo-600/15 border-l-2 border-l-indigo-500 text-white'
                        : 'hover:bg-slate-800/50 text-slate-300'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-semibold truncate">
                        {repo.full_name}
                      </div>
                      {repo.description && (
                        <div className="text-[11px] text-slate-400 truncate mt-0.5">
                          {repo.description}
                        </div>
                      )}
                    </div>
                    <span
                      className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border ${
                        repo.private
                          ? 'bg-amber-950/60 border-amber-800/60 text-amber-300'
                          : 'bg-slate-800 border-slate-700 text-slate-400'
                      }`}
                    >
                      {repo.private ? 'Private' : 'Public'}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {/* Right Column: Active Repo Workspace */}
        <main className="lg:col-span-8 xl:col-span-9 flex flex-col gap-5">
          {!selectedRepo ? (
            <div className="flex-1 bg-slate-900/60 border border-slate-800 rounded-2xl p-12 flex flex-col items-center justify-center text-center">
              <Box className="w-10 h-10 text-slate-600 mb-3" />
              <h3 className="text-base font-semibold text-slate-300">
                Select a GitHub Repository
              </h3>
              <p className="text-xs text-slate-500 max-w-md mt-1">
                Choose a repository from the sidebar to upload files, sync a desktop root
                folder, or manage existing packages.
              </p>
            </div>
          ) : (
            <>
              {/* Selected Repo Banner + Mode Switcher Tabs */}
              <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-4 sm:p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-indigo-400 font-semibold">
                      Target Repository
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <h2 className="text-lg font-bold text-white">
                        {selectedRepo.full_name}
                      </h2>
                      <a
                        href={`${selectedRepo.html_url}/packages`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-slate-400 hover:text-indigo-400 inline-flex items-center gap-1"
                      >
                        View on GitHub
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                  </div>

                  <div className="text-xs text-slate-400 bg-slate-950 px-3 py-1.5 rounded-xl border border-slate-800 font-mono">
                    ghcr.io/{selectedRepo.owner.login.toLowerCase()}/&lt;image-name&gt;
                  </div>
                </div>

                {/* 3 Workspace Tabs */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setActiveTab('upload-files')}
                    className={`py-2.5 px-4 rounded-xl text-xs font-semibold transition flex items-center justify-center gap-2 cursor-pointer border ${
                      activeTab === 'upload-files'
                        ? 'bg-indigo-600 text-white border-indigo-500 shadow-lg shadow-indigo-600/20'
                        : 'bg-slate-950/80 text-slate-400 border-slate-800 hover:text-slate-200 hover:bg-slate-900'
                    }`}
                  >
                    <Upload className="w-4 h-4" />
                    Upload File(s)
                  </button>

                  <button
                    type="button"
                    onClick={() => setActiveTab('sync-folder')}
                    className={`py-2.5 px-4 rounded-xl text-xs font-semibold transition flex items-center justify-center gap-2 cursor-pointer border ${
                      activeTab === 'sync-folder'
                        ? 'bg-indigo-600 text-white border-indigo-500 shadow-lg shadow-indigo-600/20'
                        : 'bg-slate-950/80 text-slate-400 border-slate-800 hover:text-slate-200 hover:bg-slate-900'
                    }`}
                  >
                    <FolderSync className="w-4 h-4" />
                    Sync Root Folder (Desktop)
                  </button>

                  <button
                    type="button"
                    onClick={() => setActiveTab('packages')}
                    className={`py-2.5 px-4 rounded-xl text-xs font-semibold transition flex items-center justify-center gap-2 cursor-pointer border ${
                      activeTab === 'packages'
                        ? 'bg-indigo-600 text-white border-indigo-500 shadow-lg shadow-indigo-600/20'
                        : 'bg-slate-950/80 text-slate-400 border-slate-800 hover:text-slate-200 hover:bg-slate-900'
                    }`}
                  >
                    <Layers className="w-4 h-4" />
                    Repo Packages ({repoPackages.length})
                  </button>
                </div>
              </div>

              {/* ==================== TAB 1: UPLOAD FILE(S) ==================== */}
              {activeTab === 'upload-files' && (
                <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 sm:p-6 space-y-6">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <h3 className="text-base font-bold text-white flex items-center gap-2">
                        <FilePlus2 className="w-5 h-5 text-indigo-400" />
                        Upload Single or Multiple Files as an Image
                      </h3>
                      <p className="text-xs text-slate-400 mt-1">
                        Works on Windows, Linux, macOS, Android, and iOS. Packages your
                        selected file(s) into an OCI container image and pushes to{' '}
                        <span className="text-slate-200 font-medium">
                          {selectedRepo.full_name}
                        </span>
                        .
                      </p>
                    </div>
                  </div>

                  {/* Naming Rules Callout */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                    <div
                      className={`p-3.5 rounded-xl border ${
                        pickedFiles.length === 1
                          ? 'bg-indigo-950/40 border-indigo-500/50 text-indigo-200'
                          : 'bg-slate-950/60 border-slate-800/80 text-slate-400'
                      }`}
                    >
                      <div className="font-semibold text-slate-200 mb-0.5">
                        • Single File Selected:
                      </div>
                      Keep the file&apos;s name as the image/package name, or enter a
                      custom image name.
                    </div>
                    <div
                      className={`p-3.5 rounded-xl border ${
                        pickedFiles.length > 1
                          ? 'bg-indigo-950/40 border-indigo-500/50 text-indigo-200'
                          : 'bg-slate-950/60 border-slate-800/80 text-slate-400'
                      }`}
                    >
                      <div className="font-semibold text-slate-200 mb-0.5">
                        • Multiple Files Selected:
                      </div>
                      All files are bundled into one image, and you{' '}
                      <span className="underline font-medium">must</span> enter a name for
                      the image.
                    </div>
                  </div>

                  {/* File Dropzone */}
                  <div
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (e.dataTransfer.files?.length) {
                        handleFilesAdded(e.dataTransfer.files);
                      }
                    }}
                    onClick={() => fileInputRef.current?.click()}
                    className="border-2 border-dashed border-slate-700 hover:border-indigo-500 bg-slate-950/50 hover:bg-slate-950 rounded-2xl p-8 text-center transition cursor-pointer"
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        if (e.target.files) {
                          handleFilesAdded(e.target.files);
                          e.target.value = '';
                        }
                      }}
                    />
                    <Upload className="w-8 h-8 text-indigo-400 mx-auto mb-2.5" />
                    <div className="text-sm font-semibold text-slate-200">
                      Click to choose file(s) or drag & drop here
                    </div>
                    <div className="text-xs text-slate-500 mt-1">
                      Select 1 file or multiple files from your device
                    </div>
                  </div>

                  {/* Picked Files List */}
                  {pickedFiles.length > 0 && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-300">
                          Selected Files ({pickedFiles.length}) — Total:{' '}
                          {formatBytes(
                            pickedFiles.reduce((acc, f) => acc + f.size, 0)
                          )}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setPickedFiles([]);
                            setCustomImageName('');
                          }}
                          className="text-xs text-rose-400 hover:text-rose-300 cursor-pointer"
                        >
                          Clear all
                        </button>
                      </div>

                      <div className="max-h-48 overflow-y-auto divide-y divide-slate-800/60 bg-slate-950 rounded-xl border border-slate-800">
                        {pickedFiles.map((file, idx) => (
                          <div
                            key={`${file.name}-${idx}`}
                            className="px-3.5 py-2 flex items-center justify-between gap-2 text-xs"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <FileIcon className="w-4 h-4 text-indigo-400 shrink-0" />
                              <span className="truncate text-slate-200 font-medium">
                                {file.name}
                              </span>
                              <span className="text-slate-500 shrink-0">
                                ({formatBytes(file.size)})
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleRemovePickedFile(idx)}
                              className="text-slate-500 hover:text-rose-400 p-1 cursor-pointer"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Image / Package Name Input */}
                  {pickedFiles.length > 0 && (
                    <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-4">
                      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                        <div className="sm:col-span-3">
                          <label className="block text-xs font-semibold text-slate-200 mb-1">
                            Image & Package Name{' '}
                            {pickedFiles.length > 1 ? (
                              <span className="text-amber-400 font-normal">
                                (Required for multiple files)
                              </span>
                            ) : (
                              <span className="text-slate-400 font-normal">
                                (Defaults to file name — edit if you want another name)
                              </span>
                            )}
                          </label>
                          <input
                            type="text"
                            value={customImageName}
                            onChange={(e) => setCustomImageName(e.target.value)}
                            placeholder={
                              pickedFiles.length === 1
                                ? pickedFiles[0].name
                                : 'Enter a name for this multi-file image (e.g. release-bundle)'
                            }
                            className={`w-full px-3.5 py-2 rounded-xl bg-slate-900 border text-sm text-white focus:outline-none ${
                              !fileNamingValidation.valid
                                ? 'border-amber-500/70 focus:border-amber-400'
                                : 'border-slate-700 focus:border-indigo-500'
                            }`}
                          />
                        </div>

                        <div>
                          <label className="block text-xs font-semibold text-slate-200 mb-1">
                            Tag
                          </label>
                          <input
                            type="text"
                            value={imageTag}
                            onChange={(e) => setImageTag(e.target.value)}
                            placeholder="latest"
                            className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-sm text-white font-mono focus:outline-none focus:border-indigo-500"
                          />
                        </div>
                      </div>

                      {fileNamingValidation.valid ? (
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs bg-slate-900/90 px-3.5 py-2.5 rounded-lg border border-slate-800">
                          <span className="text-slate-400">
                            Resulting Package & Image Name:
                          </span>
                          <code className="text-indigo-300 font-mono font-semibold">
                            ghcr.io/{selectedRepo.owner.login.toLowerCase()}/
                            {fileNamingValidation.ociPackageName}:
                            {imageTag.trim() || 'latest'}
                          </code>
                        </div>
                      ) : (
                        <div className="text-xs text-amber-400 flex items-center gap-1.5">
                          <Info className="w-4 h-4 shrink-0" />
                          {fileNamingValidation.error}
                        </div>
                      )}

                      {uploadError && (
                        <div className="p-3 rounded-lg bg-rose-950/70 border border-rose-800 text-rose-200 text-xs flex items-start gap-2">
                          <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                          <span>{uploadError}</span>
                        </div>
                      )}

                      {uploadProgress && (
                        <div className="space-y-1.5">
                          <div className="flex justify-between text-xs text-indigo-300">
                            <span>{uploadProgress.message}</span>
                            <span>{uploadProgress.percent}%</span>
                          </div>
                          <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-indigo-500 transition-all duration-300"
                              style={{ width: `${uploadProgress.percent}%` }}
                            />
                          </div>
                        </div>
                      )}

                      {uploadSuccess && (
                        <div className="p-3.5 rounded-xl bg-emerald-950/50 border border-emerald-800/70 text-emerald-200 text-xs flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                            <div>
                              <span className="font-semibold">
                                Package &quot;{uploadSuccess.packageName}&quot; uploaded!
                              </span>{' '}
                              ({uploadSuccess.fileCount} file(s), compressed size{' '}
                              {formatBytes(uploadSuccess.compressedSize)})
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setActiveTab('packages')}
                            className="px-2.5 py-1 rounded-lg bg-emerald-800/60 hover:bg-emerald-700/60 text-emerald-100 font-medium shrink-0 cursor-pointer"
                          >
                            View in Packages →
                          </button>
                        </div>
                      )}

                      <button
                        type="button"
                        disabled={!fileNamingValidation.valid || !!uploadProgress}
                        onClick={handleUploadSelectedFiles}
                        className="w-full py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-semibold text-sm transition flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20 cursor-pointer"
                      >
                        {uploadProgress ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Building & Uploading OCI Image...
                          </>
                        ) : (
                          <>
                            <Upload className="w-4 h-4" />
                            Create Image &quot;
                            {fileNamingValidation.ociPackageName || '...'}&quot; & Upload
                            to Repo Packages
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* ==================== TAB 2: SYNC ROOT FOLDER (DESKTOP) ==================== */}
              {activeTab === 'sync-folder' && (
                <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 sm:p-6 space-y-6">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <h3 className="text-base font-bold text-white flex items-center gap-2">
                        <FolderSync className="w-5 h-5 text-indigo-400" />
                        Root Folder Auto-Image Sync (Windows, Linux, macOS)
                      </h3>
                      <p className="text-xs text-slate-400 mt-1">
                        Choose a root folder on your computer and press{' '}
                        <span className="text-slate-200 font-semibold">Sync Folder</span>:
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      {/* Hidden fallback directory input */}
                      <input
                        ref={fallbackFolderInputRef}
                        type="file"
                        // @ts-expect-error webkitdirectory is standard across desktop browsers
                        webkitdirectory="true"
                        directory="true"
                        multiple
                        className="hidden"
                        onChange={handleFallbackWebkitDirectory}
                      />
                      {rootScan && (
                        <button
                          type="button"
                          disabled={isSyncingFolder}
                          onClick={handleRescanRootFolder}
                          className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 cursor-pointer"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          Rescan
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={isSyncingFolder}
                        onClick={handlePickRootFolder}
                        className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white flex items-center gap-2 shadow-lg shadow-indigo-600/20 cursor-pointer"
                      >
                        <Folder className="w-4 h-4" />
                        {rootScan ? 'Change Root Folder' : 'Choose Root Folder'}
                      </button>
                    </div>
                  </div>

                  {/* Explanation of the two Root Folder rules */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                    <div className="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800">
                      <div className="font-semibold text-indigo-300 flex items-center gap-1.5 mb-1">
                        <FileIcon className="w-3.5 h-3.5" />
                        Rule 1: Direct Files in Root Folder
                      </div>
                      <p className="text-slate-400">
                        Each file placed directly inside the root folder creates its{' '}
                        <strong className="text-slate-200">own separate image</strong>.
                        The image/package name is the{' '}
                        <strong className="text-slate-200">name of the file</strong>.
                      </p>
                    </div>

                    <div className="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800">
                      <div className="font-semibold text-emerald-300 flex items-center gap-1.5 mb-1">
                        <Folder className="w-3.5 h-3.5" />
                        Rule 2: Sub-Folders in Root Folder
                      </div>
                      <p className="text-slate-400">
                        Each sub-folder inside the root folder bundles{' '}
                        <strong className="text-slate-200">
                          all files in that sub-folder
                        </strong>{' '}
                        into a single image. The image/package name is the{' '}
                        <strong className="text-slate-200">name of the sub-folder</strong>.
                      </p>
                    </div>
                  </div>

                  {syncError && (
                    <div className="p-3.5 rounded-xl bg-rose-950/70 border border-rose-800 text-rose-200 text-xs flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                      <span>{syncError}</span>
                    </div>
                  )}

                  {!rootScan ? (
                    <div
                      onClick={handlePickRootFolder}
                      className="border-2 border-dashed border-slate-700 hover:border-indigo-500 bg-slate-950/40 hover:bg-slate-950 rounded-2xl p-10 text-center transition cursor-pointer"
                    >
                      <HardDrive className="w-9 h-9 text-indigo-400 mx-auto mb-3" />
                      <div className="text-sm font-semibold text-slate-200">
                        Select a Root Folder to Scan
                      </div>
                      <p className="text-xs text-slate-500 max-w-md mx-auto mt-1">
                        We will automatically detect all top-level files and sub-folders
                        and prepare an OCI package image for each one.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-950 px-4 py-3 rounded-xl border border-slate-800">
                        <div className="flex items-center gap-2 min-w-0">
                          <Folder className="w-4 h-4 text-indigo-400 shrink-0" />
                          <span className="text-xs text-slate-400">Root Folder:</span>
                          <code className="text-xs text-white font-mono truncate">
                            {rootScan.rootFolderPath}
                          </code>
                        </div>
                        <div className="flex items-center gap-3 text-xs">
                          <button
                            type="button"
                            onClick={() =>
                              setSelectedSyncIndices(
                                new Set(rootScan.items.map((_, i) => i))
                              )
                            }
                            className="text-indigo-400 hover:text-indigo-300 cursor-pointer"
                          >
                            Select All ({rootScan.items.length})
                          </button>
                          <span className="text-slate-700">|</span>
                          <button
                            type="button"
                            onClick={() => setSelectedSyncIndices(new Set())}
                            className="text-slate-400 hover:text-slate-200 cursor-pointer"
                          >
                            None
                          </button>
                        </div>
                      </div>

                      {rootScan.items.length === 0 ? (
                        <div className="p-8 text-center text-xs text-slate-500 bg-slate-950 rounded-xl border border-slate-800">
                          The selected root folder is empty. Add files or sub-folders and
                          click Rescan.
                        </div>
                      ) : (
                        <div className="divide-y divide-slate-800/70 bg-slate-950 rounded-xl border border-slate-800 overflow-hidden">
                          {rootScan.items.map((item, idx) => {
                            const ociName = toOciImageName(item.name);
                            const isChecked = selectedSyncIndices.has(idx);
                            const isExpanded = expandedSubfolders.has(idx);
                            const status = syncStatuses[idx];

                            return (
                              <div key={`${item.kind}-${item.name}-${idx}`} className="p-3.5">
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                  <div className="flex items-center gap-3 min-w-0">
                                    <input
                                      type="checkbox"
                                      checked={isChecked}
                                      disabled={isSyncingFolder}
                                      onChange={() => {
                                        const next = new Set(selectedSyncIndices);
                                        if (next.has(idx)) next.delete(idx);
                                        else next.add(idx);
                                        setSelectedSyncIndices(next);
                                      }}
                                      className="w-4 h-4 rounded accent-indigo-600 cursor-pointer"
                                    />

                                    {item.kind === 'root-file' ? (
                                      <FileIcon className="w-4 h-4 text-indigo-400 shrink-0" />
                                    ) : (
                                      <Folder className="w-4 h-4 text-emerald-400 shrink-0" />
                                    )}

                                    <div className="min-w-0">
                                      <div className="flex items-center gap-2 flex-wrap">
                                        <span className="text-xs font-semibold text-white">
                                          {item.name}
                                        </span>
                                        <span
                                          className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                                            item.kind === 'root-file'
                                              ? 'bg-indigo-950 text-indigo-300 border border-indigo-800/60'
                                              : 'bg-emerald-950 text-emerald-300 border border-emerald-800/60'
                                          }`}
                                        >
                                          {item.kind === 'root-file'
                                            ? 'Root File → 1 Image'
                                            : `Sub-folder (${item.files.length} file${
                                                item.files.length === 1 ? '' : 's'
                                              }) → 1 Image`}
                                        </span>
                                        <span className="text-xs text-slate-500">
                                          ({formatBytes(item.size)})
                                        </span>
                                      </div>

                                      <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                                        Package / Image:{' '}
                                        <span className="text-indigo-300 font-semibold">
                                          {ociName}
                                        </span>
                                      </div>
                                    </div>
                                  </div>

                                  <div className="flex items-center gap-2">
                                    {status?.state === 'uploading' && (
                                      <span className="text-xs text-indigo-300 flex items-center gap-1.5">
                                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                        {status.percent ?? 0}%
                                      </span>
                                    )}
                                    {status?.state === 'done' && (
                                      <span className="text-xs text-emerald-400 flex items-center gap-1 font-medium">
                                        <CheckCircle2 className="w-4 h-4" />
                                        Synced
                                      </span>
                                    )}
                                    {status?.state === 'error' && (
                                      <span
                                        title={status.message}
                                        className="text-xs text-rose-400 flex items-center gap-1"
                                      >
                                        <AlertCircle className="w-4 h-4" />
                                        Failed
                                      </span>
                                    )}

                                    {item.kind === 'root-subfolder' && (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          const next = new Set(expandedSubfolders);
                                          if (next.has(idx)) next.delete(idx);
                                          else next.add(idx);
                                          setExpandedSubfolders(next);
                                        }}
                                        className="text-xs text-slate-400 hover:text-white px-2 py-1 rounded bg-slate-900 border border-slate-800 flex items-center gap-1 cursor-pointer"
                                      >
                                        {isExpanded ? (
                                          <ChevronDown className="w-3.5 h-3.5" />
                                        ) : (
                                          <ChevronRight className="w-3.5 h-3.5" />
                                        )}
                                        Files
                                      </button>
                                    )}
                                  </div>
                                </div>

                                {status?.state === 'error' && status.message && (
                                  <div className="mt-2 text-[11px] text-rose-300 bg-rose-950/50 px-3 py-1.5 rounded border border-rose-800/60">
                                    {status.message}
                                  </div>
                                )}

                                {item.kind === 'root-subfolder' && isExpanded && (
                                  <div className="mt-3 pl-7 space-y-1 max-h-40 overflow-y-auto border-l border-slate-800 ml-2">
                                    {item.files.map((f, fIdx) => (
                                      <div
                                        key={`${f.relativePath}-${fIdx}`}
                                        className="text-[11px] text-slate-400 flex items-center justify-between pr-2 font-mono"
                                      >
                                        <span className="truncate">{f.relativePath}</span>
                                        <span className="text-slate-500 shrink-0 ml-2">
                                          {formatBytes(f.size)}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {rootScan.items.length > 0 && (
                        <button
                          type="button"
                          disabled={isSyncingFolder || selectedSyncIndices.size === 0}
                          onClick={handleSyncRootFolder}
                          className="w-full py-3 px-5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-semibold text-sm transition flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20 cursor-pointer"
                        >
                          {isSyncingFolder ? (
                            <>
                              <Loader2 className="w-4 h-4 animate-spin" />
                              Syncing Folder Images to {selectedRepo.full_name}...
                            </>
                          ) : (
                            <>
                              <FolderSync className="w-4 h-4" />
                              Sync Folder — Create & Upload {selectedSyncIndices.size}{' '}
                              Image{selectedSyncIndices.size === 1 ? '' : 's'} to Repo
                              Packages
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ==================== TAB 3: REPO PACKAGES (VIEW, DOWNLOAD, REMOVE) ==================== */}
              {activeTab === 'packages' && (
                <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 sm:p-6 space-y-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-base font-bold text-white flex items-center gap-2">
                        <Layers className="w-5 h-5 text-indigo-400" />
                        Packages in {selectedRepo.full_name}
                      </h3>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Inspect files inside any image, download & extract original files,
                        or remove packages from GitHub.
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      {otherPackages.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setShowOtherPackages(!showOtherPackages)}
                          className="px-3 py-1.5 rounded-xl bg-slate-950 hover:bg-slate-800 text-xs text-slate-300 border border-slate-800 cursor-pointer"
                        >
                          {showOtherPackages
                            ? 'Hide other owner packages'
                            : `Show ${otherPackages.length} other account package(s)`}
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={packagesLoading}
                        onClick={refreshPackages}
                        className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-medium text-white flex items-center gap-1.5 cursor-pointer"
                      >
                        <RefreshCw
                          className={`w-3.5 h-3.5 ${
                            packagesLoading ? 'animate-spin' : ''
                          }`}
                        />
                        Refresh
                      </button>
                    </div>
                  </div>

                  {actionBanner && (
                    <div
                      className={`p-3.5 rounded-xl border text-xs flex items-center justify-between gap-2 ${
                        actionBanner.type === 'success'
                          ? 'bg-emerald-950/60 border-emerald-800 text-emerald-200'
                          : 'bg-rose-950/60 border-rose-800 text-rose-200'
                      }`}
                    >
                      <span>{actionBanner.text}</span>
                      <button
                        type="button"
                        onClick={() => setActionBanner(null)}
                        className="text-slate-400 hover:text-white cursor-pointer"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  )}

                  {packagesError && (
                    <div className="p-3.5 rounded-xl bg-rose-950/60 border border-rose-800 text-rose-200 text-xs">
                      {packagesError}
                    </div>
                  )}

                  {/* Delete Confirmation Modal */}
                  {confirmDeletePkg && (
                    <div className="p-4 rounded-xl bg-rose-950/50 border border-rose-700/80 flex flex-wrap items-center justify-between gap-3">
                      <div className="text-xs text-rose-100">
                        Are you sure you want to permanently remove package{' '}
                        <strong className="font-mono">{confirmDeletePkg.name}</strong> from
                        GitHub Packages?
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setConfirmDeletePkg(null)}
                          className="px-3 py-1.5 rounded-lg bg-slate-800 text-xs text-slate-200 cursor-pointer"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeletePackageConfirmed(confirmDeletePkg)}
                          className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-xs font-semibold text-white cursor-pointer"
                        >
                          Confirm Remove
                        </button>
                      </div>
                    </div>
                  )}

                  {packagesLoading ? (
                    <div className="p-12 flex flex-col items-center justify-center text-slate-400 gap-2">
                      <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
                      <span className="text-xs">Loading packages from GitHub...</span>
                    </div>
                  ) : repoPackages.length === 0 && !showOtherPackages ? (
                    <div className="p-10 rounded-xl bg-slate-950/70 border border-slate-800 text-center space-y-2">
                      <Package className="w-8 h-8 text-slate-600 mx-auto" />
                      <div className="text-sm font-semibold text-slate-300">
                        No packages linked to {selectedRepo.full_name} yet
                      </div>
                      <p className="text-xs text-slate-500 max-w-md mx-auto">
                        Use the &quot;Upload File(s)&quot; or &quot;Sync Root Folder&quot;
                        tabs to create and push your first container package image.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {[
                        ...repoPackages,
                        ...(showOtherPackages ? otherPackages : []),
                      ].map((pkg) => {
                        const details = inspectedManifests[pkg.name];
                        const pullCmd = `docker pull ghcr.io/${pkg.owner.login.toLowerCase()}/${pkg.name}:latest`;

                        return (
                          <div
                            key={pkg.id}
                            className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3"
                          >
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div className="space-y-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <Package className="w-4 h-4 text-indigo-400" />
                                  <span className="text-sm font-bold text-white font-mono">
                                    {pkg.name}
                                  </span>
                                  <span
                                    className={`text-[10px] px-2 py-0.5 rounded-full border ${
                                      pkg.visibility === 'private'
                                        ? 'bg-amber-950/60 border-amber-800/60 text-amber-300'
                                        : 'bg-emerald-950/60 border-emerald-800/60 text-emerald-300'
                                    }`}
                                  >
                                    {pkg.visibility === 'private' && (
                                      <Lock className="w-2.5 h-2.5 inline mr-1" />
                                    )}
                                    {pkg.visibility}
                                  </span>
                                  {pkg.repository && (
                                    <span className="text-[11px] text-slate-400">
                                      Linked to{' '}
                                      <strong className="text-slate-300">
                                        {pkg.repository.full_name}
                                      </strong>
                                    </span>
                                  )}
                                </div>

                                <div className="flex items-center gap-2 text-[11px] text-slate-500 font-mono">
                                  <span>{pullCmd}</span>
                                  <button
                                    type="button"
                                    onClick={() => copyToClipboard(pullCmd)}
                                    className="text-slate-400 hover:text-indigo-400 cursor-pointer"
                                    title="Copy docker pull command"
                                  >
                                    {copiedText === pullCmd ? (
                                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                                    ) : (
                                      <Copy className="w-3.5 h-3.5" />
                                    )}
                                  </button>
                                </div>
                              </div>

                              {/* Package Actions: Inspect, Download, Remove */}
                              <div className="flex items-center gap-2 flex-wrap">
                                <button
                                  type="button"
                                  disabled={inspectingPkgName === pkg.name}
                                  onClick={() => handleInspectPackage(pkg.name)}
                                  className="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 cursor-pointer"
                                >
                                  {inspectingPkgName === pkg.name ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    <Info className="w-3.5 h-3.5 text-indigo-400" />
                                  )}
                                  Inspect Files
                                </button>

                                <button
                                  type="button"
                                  disabled={downloadingPkgName === pkg.name}
                                  onClick={() => handleDownloadPackage(pkg.name)}
                                  className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white flex items-center gap-1.5 cursor-pointer"
                                >
                                  {downloadingPkgName === pkg.name ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    <Download className="w-3.5 h-3.5" />
                                  )}
                                  Download & Extract
                                </button>

                                <button
                                  type="button"
                                  disabled={deletingPkgName === pkg.name}
                                  onClick={() => setConfirmDeletePkg(pkg)}
                                  className="p-1.5 rounded-lg bg-slate-900 hover:bg-rose-950 border border-slate-800 hover:border-rose-800 text-slate-400 hover:text-rose-400 transition cursor-pointer"
                                  title="Remove package from GitHub"
                                >
                                  {deletingPkgName === pkg.name ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <Trash2 className="w-4 h-4" />
                                  )}
                                </button>
                              </div>
                            </div>

                            {/* Inspected OCI Manifest Details */}
                            {details && (
                              <div className="mt-3 pt-3 border-t border-slate-800/80 space-y-2 text-xs">
                                <div className="flex flex-wrap gap-4 text-slate-400">
                                  <span>
                                    Original Name:{' '}
                                    <strong className="text-slate-200">
                                      {details.originalName}
                                    </strong>
                                  </span>
                                  <span>
                                    Mode:{' '}
                                    <strong className="text-indigo-300">
                                      {details.mode}
                                    </strong>
                                  </span>
                                  <span>
                                    Files:{' '}
                                    <strong className="text-slate-200">
                                      {details.fileCount}
                                    </strong>
                                  </span>
                                  <span>
                                    Layer Size:{' '}
                                    <strong className="text-slate-200">
                                      {formatBytes(details.compressedSize)}
                                    </strong>{' '}
                                    (Uncompressed:{' '}
                                    {formatBytes(details.totalUncompressedBytes)})
                                  </span>
                                </div>

                                {details.files.length > 0 && (
                                  <div className="bg-slate-900/90 rounded-lg p-2.5 border border-slate-800 max-h-40 overflow-y-auto space-y-1">
                                    <div className="text-[11px] font-semibold text-slate-400 mb-1">
                                      Files inside image layer:
                                    </div>
                                    {details.files.map((f, i) => (
                                      <div
                                        key={`${f.path}-${i}`}
                                        className="flex items-center justify-between text-[11px] font-mono text-slate-300"
                                      >
                                        <span className="truncate">{f.path}</span>
                                        <span className="text-slate-500 shrink-0 ml-2">
                                          {formatBytes(f.size)}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
