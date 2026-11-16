import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
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
  Package,
  Pencil,
  RefreshCw,
  Search,
  ShieldCheck,
  Smartphone,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import Header, { type AppSettings } from './components/Header';
import TabNav, { type ActiveTab } from './components/TabNav';
import SettingsModal from './components/SettingsModal';
import HelpModal from './components/HelpModal';
import AboutModal from './components/AboutModal';
import SubfolderFileTree from './components/SubfolderFileTree';
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
  scanBrowserDirectoryForUpload,
  type DesktopRootFolderFileEntry,
  type DesktopRootFolderItem,
  type DesktopRootFolderScanResult,
  type UploadSelectionItem,
} from './lib/http';
import { toOciImageName, validateFilesSelectionName } from './lib/naming';
import { createZipFromExtractedFiles, type TarInputFile } from './lib/tar';

interface SyncItemStatus {
  state: 'idle' | 'uploading' | 'done' | 'error';
  message?: string;
  percent?: number;
}

export interface SavedPatCredential {
  token: string;
  username: string;
  maskedSuffix: string;
  customName: string;
}

export interface SavedOAuthCredential {
  clientId: string;
  accessToken?: string;
  username: string;
  maskedSuffix: string;
  customName: string;
}

const STORAGE_ACTIVE_TOKEN_KEY = 'ghpm_active_session_token_v1';
const STORAGE_REPO_KEY = 'ghpm_selected_repo_id_v1';
const STORAGE_SAVED_PATS_KEY = 'ghpm_saved_pats_v1';
const STORAGE_SAVED_OAUTHS_KEY = 'ghpm_saved_oauths_v1';
const STORAGE_THEME_SETTINGS_KEY = 'ghpm_theme_settings_v1';

/**
 * Formats a PAT or Client ID into a compact masked suffix like "ghp_••••x9a2" or "Ov23••••4f1a"
 */
function formatMaskedSecret(secret: string): string {
  const clean = secret.trim();
  if (clean.length <= 8) return clean;
  const prefix = clean.slice(0, 4);
  const suffix = clean.slice(-4);
  return `${prefix}••••${suffix}`;
}

export default function App() {
  // --- Theme & Appearance State (Matches ShellAssist) ---
  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_THEME_SETTINGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed.isDarkMode === 'boolean') return parsed.isDarkMode;
      }
    } catch {
      // ignore
    }
    return true;
  });

  const [settings, setSettings] = useState<AppSettings>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_THEME_SETTINGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          darkTheme: parsed.darkTheme || 'default',
          lightTheme: parsed.lightTheme || 'default',
        };
      }
    } catch {
      // ignore
    }
    return {
      darkTheme: 'default',
      lightTheme: 'default',
    };
  });

  // Header Menu & Modals State
  const [showMenu, setShowMenu] = useState<boolean>(false);
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false);
  const [showHelpModal, setShowHelpModal] = useState<boolean>(false);
  const [showAboutModal, setShowAboutModal] = useState<boolean>(false);

  // Sync theme classes onto <html> root element & save to localStorage
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove(
      'theme-terminal-green',
      'theme-terminal-red',
      'theme-light',
      'theme-monochrome'
    );
    if (!isDarkMode) {
      root.classList.add('theme-light');
      if (settings.lightTheme === 'monochrome') {
        root.classList.add('theme-monochrome');
      }
    } else {
      if (settings.darkTheme === 'green') {
        root.classList.add('theme-terminal-green');
      }
      if (settings.darkTheme === 'red') {
        root.classList.add('theme-terminal-red');
      }
    }

    localStorage.setItem(
      STORAGE_THEME_SETTINGS_KEY,
      JSON.stringify({ isDarkMode, ...settings })
    );

    // Synchronize native OS right-click context menus with app theme state (dark in 3 dark themes, light in 2 light themes)
    if (
      typeof window !== 'undefined' &&
      window.electronAPI &&
      typeof window.electronAPI.setNativeTheme === 'function'
    ) {
      window.electronAPI.setNativeTheme(isDarkMode ? 'dark' : 'light');
    }
  }, [isDarkMode, settings]);

  const isDesktopEnv =
    typeof window !== 'undefined' && Boolean(window.electronAPI?.isDesktop);

  // Lock background page scroll whenever any modal is open
  const isAnyModalOpen = showSettingsModal || showHelpModal || showAboutModal;
  useEffect(() => {
    if (isAnyModalOpen) {
      document.documentElement.classList.add('modal-open');
    } else {
      document.documentElement.classList.remove('modal-open');
    }
    return () => {
      document.documentElement.classList.remove('modal-open');
    };
  }, [isAnyModalOpen]);

  // --- Saved Credentials State (Displayed on Sign-In screen below each option's textbox) ---
  const [savedPats, setSavedPats] = useState<SavedPatCredential[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_SAVED_PATS_KEY);
      if (raw) return JSON.parse(raw);
    } catch {
      // ignore
    }
    return [];
  });

  const [savedOAuths, setSavedOAuths] = useState<SavedOAuthCredential[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_SAVED_OAUTHS_KEY);
      if (raw) return JSON.parse(raw);
    } catch {
      // ignore
    }
    return [];
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_SAVED_PATS_KEY, JSON.stringify(savedPats));
  }, [savedPats]);

  useEffect(() => {
    localStorage.setItem(STORAGE_SAVED_OAUTHS_KEY, JSON.stringify(savedOAuths));
  }, [savedOAuths]);

  // Inline Rename state for Saved PATs & Saved OAuth Client IDs
  const [editingPatIndex, setEditingPatIndex] = useState<number | null>(null);
  const [editingPatNameInput, setEditingPatNameInput] = useState<string>('');
  const [editingOAuthIndex, setEditingOAuthIndex] = useState<number | null>(null);
  const [editingOAuthNameInput, setEditingOAuthNameInput] = useState<string>('');

  // --- Auth State ---
  const [tokenInput, setTokenInput] = useState<string>('');
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
  const [showRepoDropdown, setShowRepoDropdown] = useState<boolean>(false);
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);
  const repoDropdownRef = useRef<HTMLDivElement | null>(null);

  // Close repo dropdown on outside click
  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (
        repoDropdownRef.current &&
        !repoDropdownRef.current.contains(e.target as Node)
      ) {
        setShowRepoDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, []);

  // Navigation tab
  const [activeTab, setActiveTab] = useState<ActiveTab>('upload-files');

  // --- TAB 1: Pick File(s) or Folder(s) state ---
  const [pickedItems, setPickedItems] = useState<UploadSelectionItem[]>([]);
  const [expandedUploadFolders, setExpandedUploadFolders] = useState<Set<number>>(
    new Set()
  );
  const [loadingUploadFolders, setLoadingUploadFolders] = useState<Set<number>>(
    new Set()
  );
  const [isScanningUploadDrop, setIsScanningUploadDrop] = useState<boolean>(false);
  const uploadScanSeqRef = useRef<number>(0);
  const uploadScanIdRef = useRef<string | null>(null);
  const uploadScanAbortRef = useRef<AbortController | null>(null);
  const [customImageName, setCustomImageName] = useState<string>('');
  const [imageTag, setImageTag] = useState<string>('latest');
  const [uploadProgress, setUploadProgress] = useState<PushProgressUpdate | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<OciPackageDetails | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadFolderInputRef = useRef<HTMLInputElement | null>(null);
  const fileDragCounter = useRef<number>(0);
  const [isDraggingFiles, setIsDraggingFiles] = useState<boolean>(false);

  // --- TAB 2: Root Folder Sync state (Windows / Linux / macOS) ---
  const [rootScan, setRootScan] = useState<DesktopRootFolderScanResult | null>(null);
  const [selectedSyncIndices, setSelectedSyncIndices] = useState<Set<number>>(new Set());
  const [expandedSubfolders, setExpandedSubfolders] = useState<Set<number>>(new Set());
  const [loadingSubfolders, setLoadingSubfolders] = useState<Set<number>>(new Set());
  const [syncStatuses, setSyncStatuses] = useState<Record<number, SyncItemStatus>>({});
  const [isSyncingFolder, setIsSyncingFolder] = useState<boolean>(false);
  const [isScanningFolder, setIsScanningFolder] = useState<boolean>(false);
  const [isHoveringScanAbort, setIsHoveringScanAbort] = useState<boolean>(false);
  const scanSequenceRef = useRef<number>(0);
  const activeScanIdRef = useRef<string | null>(null);
  const scanAbortControllerRef = useRef<AbortController | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [isDraggingRootFolder, setIsDraggingRootFolder] = useState<boolean>(false);
  const rootFolderDragCounter = useRef<number>(0);
  const fallbackFolderInputRef = useRef<HTMLInputElement | null>(null);
  const fallbackFileMapRef = useRef<Map<string, File>>(new Map());

  // --- TAB 3: Repo Packages state ---
  const [repoPackages, setRepoPackages] = useState<GitHubPackageItem[]>([]);
  const [otherPackages, setOtherPackages] = useState<GitHubPackageItem[]>([]);
  const [showOtherPackages, setShowOtherPackages] = useState<boolean>(false);
  const [packageSearch, setPackageSearch] = useState<string>('');
  const [expandedPackages, setExpandedPackages] = useState<Set<string>>(new Set());
  const [packagesLoading, setPackagesLoading] = useState<boolean>(false);
  const [packagesError, setPackagesError] = useState<string | null>(null);
  const [inspectedManifests, setInspectedManifests] = useState<
    Record<string, OciPackageDetails>
  >({});
  const [indexingPkgNames, setIndexingPkgNames] = useState<Set<string>>(new Set());
  const [inspectingPkgName, setInspectingPkgName] = useState<string | null>(null);
  const [inspectProgress, setInspectProgress] = useState<number>(0);
  const inspectAbortRef = useRef<AbortController | null>(null);
  const [downloadingPkgName, setDownloadingPkgName] = useState<string | null>(null);
  const [deletingPkgName, setDeletingPkgName] = useState<string | null>(null);
  const [confirmDeletePkg, setConfirmDeletePkg] = useState<GitHubPackageItem | null>(null);
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [actionBanner, setActionBanner] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Auto sign-in if an active session token exists
  useEffect(() => {
    const activeSaved = localStorage.getItem(STORAGE_ACTIVE_TOKEN_KEY);
    if (activeSaved) {
      handleSignInWithToken(activeSaved, { source: 'restore' });
    }
  }, []);

  async function handleSignInWithToken(
    tokenToUse: string,
    opts?: { source?: 'pat' | 'oauth' | 'restore'; oauthClientId?: string }
  ) {
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
      localStorage.setItem(STORAGE_ACTIVE_TOKEN_KEY, clean);

      // Save credential into the respective Saved Credentials list (<username>/ghp_••••xxxx)
      if (opts?.source === 'oauth' && opts.oauthClientId) {
        const cleanCid = opts.oauthClientId.trim();
        setSavedOAuths((prev) => {
          const existingIdx = prev.findIndex((item) => item.clientId === cleanCid);
          if (existingIdx >= 0) {
            const copy = [...prev];
            copy[existingIdx] = {
              ...copy[existingIdx],
              username: ghUser.login,
              accessToken: clean,
            };
            return copy;
          }
          return [
            {
              clientId: cleanCid,
              accessToken: clean,
              username: ghUser.login,
              maskedSuffix: formatMaskedSecret(cleanCid),
              customName: '',
            },
            ...prev,
          ];
        });
      } else if (opts?.source !== 'restore') {
        setSavedPats((prev) => {
          const existingIdx = prev.findIndex((item) => item.token === clean);
          if (existingIdx >= 0) {
            const copy = [...prev];
            copy[existingIdx] = {
              ...copy[existingIdx],
              username: ghUser.login,
            };
            return copy;
          }
          return [
            {
              token: clean,
              username: ghUser.login,
              maskedSuffix: formatMaskedSecret(clean),
              customName: '',
            },
            ...prev,
          ];
        });
      }

      setTokenInput('');
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
      localStorage.removeItem(STORAGE_ACTIVE_TOKEN_KEY);
    } finally {
      setAuthLoading(false);
      setReposLoading(false);
    }
  }

  function handleSignOut() {
    handleCancelInspect();
    localStorage.removeItem(STORAGE_ACTIVE_TOKEN_KEY);
    setUser(null);
    setAuthToken('');
    setTokenInput('');
    setDeviceFlowInfo(null);
    setDevicePolling(false);
    setRepos([]);
    setSelectedRepo(null);
    setRepoPackages([]);
    setOtherPackages([]);
    setInspectedManifests({});
    setIndexingPkgNames(new Set());
  }

  // Saved PAT handlers
  function handleRenamePat(token: string, newCustomName: string) {
    setSavedPats((prev) =>
      prev.map((item) =>
        item.token === token ? { ...item, customName: newCustomName.trim() } : item
      )
    );
    setEditingPatIndex(null);
  }

  function handleDeletePat(tokenToDelete: string) {
    setSavedPats((prev) => prev.filter((item) => item.token !== tokenToDelete));
  }

  // Saved OAuth Client ID handlers
  function handleRenameOAuth(clientId: string, newCustomName: string) {
    setSavedOAuths((prev) =>
      prev.map((item) =>
        item.clientId === clientId
          ? { ...item, customName: newCustomName.trim() }
          : item
      )
    );
    setEditingOAuthIndex(null);
  }

  function handleDeleteOAuth(clientIdToDelete: string) {
    setSavedOAuths((prev) =>
      prev.filter((item) => item.clientId !== clientIdToDelete)
    );
  }

  async function handleSelectSavedOAuth(entry: SavedOAuthCredential) {
    setOauthClientId(entry.clientId);
    if (entry.accessToken) {
      try {
        await handleSignInWithToken(entry.accessToken, {
          source: 'oauth',
          oauthClientId: entry.clientId,
        });
        return;
      } catch {
        // Stored token expired or revoked; fall through to start Device Flow
      }
    }
    await handleStartDeviceFlowWithClientId(entry.clientId);
  }

  // OAuth Device Flow handlers
  async function handleStartDeviceFlowWithClientId(cid: string) {
    const clean = cid.trim();
    if (!clean) {
      setAuthError('Please enter your GitHub OAuth App Client ID.');
      return;
    }
    setAuthLoading(true);
    setAuthError(null);
    try {
      const info = await startGitHubDeviceFlow(clean);
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
          await handleSignInWithToken(res.accessToken, {
            source: 'oauth',
            oauthClientId,
          });
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

  // Refresh packages when selectedRepo changes or when switching to Repo Packages tab
  useEffect(() => {
    if (selectedRepo && authToken && user) {
      handleCancelInspect();
      setExpandedPackages(new Set());
      localStorage.setItem(STORAGE_REPO_KEY, String(selectedRepo.id));
      refreshPackages();
    }
  }, [selectedRepo, authToken, user]);

  useEffect(() => {
    if (activeTab === 'packages' && selectedRepo && authToken && user) {
      setExpandedPackages(new Set());
      refreshPackages();
    }
  }, [activeTab]);

  async function refreshPackages() {
    if (!selectedRepo || !authToken || !user) return;
    setPackagesLoading(true);
    setPackagesError(null);
    try {
      const { repoPackages: linked, otherOwnerPackages: others } =
        await listPackagesForRepo(authToken, user.login, selectedRepo);
      setRepoPackages(linked);
      setOtherPackages(others);

      // Automatically inspect manifests for all packages on refresh so:
      // 1. Any newly pushed versions (changed layerDigest) are always detected.
      // 2. All GHCR Manager packages and external packages <= 50 MB are auto-indexed.
      // 3. External packages > 50 MB skip auto-download and wait for user click.
      const allToIndex = [...linked, ...others];
      setIndexingPkgNames(new Set(allToIndex.map((p) => p.name)));

      for (const pkg of allToIndex) {
        inspectPackageManifest({
          username: user.login,
          githubToken: authToken,
          owner: pkg.owner.login,
          packageName: pkg.name,
          forceLoadLargeExternal: false,
        })
          .then((details) => {
            setInspectedManifests((prev) => ({
              ...prev,
              [pkg.name]: details,
            }));
          })
          .catch(() => {
            // ignore individual manifest background fetch errors
          })
          .finally(() => {
            setIndexingPkgNames((prev) => {
              const next = new Set(prev);
              next.delete(pkg.name);
              return next;
            });
          });
      }
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

  // --- TAB 1: File & Folder selection & naming logic ---
  function handleAbortUploadScan() {
    uploadScanSeqRef.current += 1;
    if (uploadScanIdRef.current && window.electronAPI?.cancelFolderScan) {
      window.electronAPI.cancelFolderScan(uploadScanIdRef.current);
      uploadScanIdRef.current = null;
    }
    if (uploadScanAbortRef.current) {
      uploadScanAbortRef.current.abort();
      uploadScanAbortRef.current = null;
    }
    setIsScanningUploadDrop(false);
  }

  function handleUploadItemsAdded(incoming: UploadSelectionItem[]) {
    if (incoming.length === 0) return;

    setUploadError(null);
    setUploadSuccess(null);

    setPickedItems((prev) => {
      const updated = [...prev, ...incoming];
      if (updated.length === 1) {
        setCustomImageName(updated[0].name);
      } else if (prev.length <= 1 && updated.length > 1) {
        if (
          !customImageName ||
          (prev.length === 1 && customImageName === prev[0].name)
        ) {
          setCustomImageName('');
        }
      }
      return updated;
    });
  }

  function handleFilesAdded(newFiles: FileList | File[]) {
    const incomingFiles = Array.from(newFiles);
    if (incomingFiles.length === 0) return;

    const items: UploadSelectionItem[] = incomingFiles.map((f) => ({
      kind: 'file',
      name: f.name,
      size: f.size,
      mtime: Math.floor(f.lastModified / 1000),
      rawFile: f,
      files: [
        {
          relativePath: f.name,
          name: f.name,
          size: f.size,
          mtime: Math.floor(f.lastModified / 1000),
          rawFile: f,
        },
      ],
    }));

    handleUploadItemsAdded(items);
  }

  async function handlePickUploadFolders() {
    if (isScanningUploadDrop) return;
    setUploadError(null);
    const seq = ++uploadScanSeqRef.current;

    try {
      if (
        window.electronAPI?.pickDirectoriesForUpload &&
        window.electronAPI?.scanPathsForUpload
      ) {
        const dirPaths = await window.electronAPI.pickDirectoriesForUpload();
        if (!dirPaths || dirPaths.length === 0 || uploadScanSeqRef.current !== seq) {
          return;
        }
        const scanId = `upload-scan-${Date.now()}-${seq}`;
        uploadScanIdRef.current = scanId;
        setIsScanningUploadDrop(true);
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
        const scannedItems = await window.electronAPI.scanPathsForUpload(
          dirPaths,
          scanId
        );
        if (uploadScanSeqRef.current !== seq) return;
        handleUploadItemsAdded(scannedItems);
        return;
      }

      if (typeof window.showDirectoryPicker === 'function') {
        const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
        if (uploadScanSeqRef.current !== seq) return;
        const abortCtrl = new AbortController();
        uploadScanAbortRef.current = abortCtrl;
        setIsScanningUploadDrop(true);
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
        const item = await scanBrowserDirectoryForUpload(
          dirHandle,
          abortCtrl.signal
        );
        if (uploadScanSeqRef.current !== seq) return;
        handleUploadItemsAdded([item]);
        return;
      }

      uploadFolderInputRef.current?.click();
    } catch (err: unknown) {
      if (err instanceof Error && (err.name === 'AbortError' || err.message === 'SCAN_ABORTED')) {
        return;
      }
      if (uploadScanSeqRef.current === seq) {
        setUploadError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (uploadScanSeqRef.current === seq) {
        uploadScanIdRef.current = null;
        uploadScanAbortRef.current = null;
        setIsScanningUploadDrop(false);
      }
    }
  }

  async function handleUploadFallbackWebkitDirectory(
    e: React.ChangeEvent<HTMLInputElement>
  ) {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const rawFiles = Array.from(fileList);
    e.target.value = '';

    const seq = ++uploadScanSeqRef.current;
    const abortCtrl = new AbortController();
    uploadScanAbortRef.current = abortCtrl;
    setIsScanningUploadDrop(true);

    try {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      let folderName = 'Selected Folder';
      let totalSize = 0;
      const entries: DesktopRootFolderFileEntry[] = [];

      for (let i = 0; i < rawFiles.length; i++) {
        if (abortCtrl.signal.aborted || uploadScanSeqRef.current !== seq) return;
        if (i > 0 && i % 40 === 0) {
          await new Promise((r) => setTimeout(r, 0));
          if (abortCtrl.signal.aborted || uploadScanSeqRef.current !== seq) return;
        }
        const file = rawFiles[i];
        const rel = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
        const parts = rel.split('/').filter(Boolean);
        if (parts.length === 0) continue;
        folderName = parts[0];
        const insideParts = parts.slice(1);
        const relInside = insideParts.length > 0 ? insideParts.join('/') : file.name;
        const lastPart = insideParts[insideParts.length - 1] || file.name;
        if (lastPart === '.DS_Store' || lastPart === 'Thumbs.db') continue;

        totalSize += file.size;
        entries.push({
          relativePath: relInside,
          name: lastPart,
          size: file.size,
          mtime: Math.floor(file.lastModified / 1000),
          rawFile: file,
        });
      }

      if (uploadScanSeqRef.current === seq && entries.length > 0) {
        handleUploadItemsAdded([
          {
            kind: 'folder',
            name: folderName,
            size: totalSize,
            files: entries,
          },
        ]);
      }
    } finally {
      if (uploadScanSeqRef.current === seq) {
        uploadScanAbortRef.current = null;
        setIsScanningUploadDrop(false);
      }
    }
  }

  function handleToggleUploadFolderExpand(idx: number) {
    if (expandedUploadFolders.has(idx)) {
      const next = new Set(expandedUploadFolders);
      next.delete(idx);
      setExpandedUploadFolders(next);
      return;
    }
    setLoadingUploadFolders((prev) => new Set(prev).add(idx));
    requestAnimationFrame(() => {
      setTimeout(() => {
        setExpandedUploadFolders((prev) => new Set(prev).add(idx));
        setLoadingUploadFolders((prev) => {
          const next = new Set(prev);
          next.delete(idx);
          return next;
        });
      }, 25);
    });
  }

  function handleRemovePickedItem(idx: number) {
    const next = pickedItems.filter((_, i) => i !== idx);
    setPickedItems(next);
    setExpandedUploadFolders(new Set());
    if (next.length === 1 && !customImageName.trim()) {
      setCustomImageName(next[0].name);
    } else if (next.length === 0) {
      setCustomImageName('');
    }
  }

  const fileNamingValidation = useMemo(() => {
    return validateFilesSelectionName(
      pickedItems.length,
      customImageName,
      pickedItems.length === 1 ? pickedItems[0].name : undefined
    );
  }, [pickedItems, customImageName]);

  async function readUploadEntryBytes(
    entry: DesktopRootFolderFileEntry
  ): Promise<Uint8Array> {
    if (entry.rawFile) {
      return new Uint8Array(await entry.rawFile.arrayBuffer());
    }
    if (entry.fileHandle) {
      const fileObj = await entry.fileHandle.getFile();
      return new Uint8Array(await fileObj.arrayBuffer());
    }
    if (entry.fullPath && window.electronAPI?.readFileBytes) {
      return await window.electronAPI.readFileBytes(entry.fullPath);
    }
    throw new Error(`Unable to read bytes for file: ${entry.relativePath}`);
  }

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
      const isSingleFolderOnly =
        pickedItems.length === 1 && pickedItems[0].kind === 'folder';

      for (const item of pickedItems) {
        if (item.kind === 'file') {
          const entry = item.files[0];
          const bytes = item.rawFile
            ? new Uint8Array(await item.rawFile.arrayBuffer())
            : await readUploadEntryBytes(entry);
          tarInputs.push({
            relativePath: item.name,
            data: bytes,
            mtime: item.mtime,
          });
        } else {
          for (const entry of item.files) {
            const bytes = await readUploadEntryBytes(entry);
            const archivePath = isSingleFolderOnly
              ? entry.relativePath
              : `${item.name}/${entry.relativePath}`;
            tarInputs.push({
              relativePath: archivePath,
              data: bytes,
              mtime: entry.mtime,
            });
          }
        }
      }

      const details = await buildAndPushOciImage({
        username: user.login,
        githubToken: authToken,
        repo: selectedRepo,
        rawImageName: fileNamingValidation.effectiveRawName,
        tag: imageTag.trim() || 'latest',
        mode:
          pickedItems.length === 1 && pickedItems[0].kind === 'file'
            ? 'single-file'
            : 'multi-file',
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
  function handleAbortScan() {
    scanSequenceRef.current += 1;
    if (activeScanIdRef.current && window.electronAPI?.cancelFolderScan) {
      window.electronAPI.cancelFolderScan(activeScanIdRef.current);
      activeScanIdRef.current = null;
    }
    if (scanAbortControllerRef.current) {
      scanAbortControllerRef.current.abort();
      scanAbortControllerRef.current = null;
    }
    setIsScanningFolder(false);
    setIsHoveringScanAbort(false);
  }

  function handleRemoveRootFolder() {
    handleAbortScan();
    setRootScan(null);
    setSelectedSyncIndices(new Set());
    setExpandedSubfolders(new Set());
    setLoadingSubfolders(new Set());
    setSyncStatuses({});
    setSyncError(null);
    fallbackFileMapRef.current.clear();
  }

  function handleToggleSubfolderExpand(idx: number) {
    if (expandedSubfolders.has(idx)) {
      const next = new Set(expandedSubfolders);
      next.delete(idx);
      setExpandedSubfolders(next);
      return;
    }
    setLoadingSubfolders((prev) => new Set(prev).add(idx));
    requestAnimationFrame(() => {
      setTimeout(() => {
        setExpandedSubfolders((prev) => new Set(prev).add(idx));
        setLoadingSubfolders((prev) => {
          const next = new Set(prev);
          next.delete(idx);
          return next;
        });
      }, 25);
    });
  }

  async function handlePickRootFolder() {
    if (isScanningFolder || isSyncingFolder) return;
    setSyncError(null);
    const seq = ++scanSequenceRef.current;

    try {
      if (
        window.electronAPI?.pickDirectoryPath &&
        window.electronAPI?.rescanRootFolder
      ) {
        const chosenPath = await window.electronAPI.pickDirectoryPath();
        if (!chosenPath || scanSequenceRef.current !== seq) return;

        const scanId = `root-scan-${Date.now()}-${seq}`;
        activeScanIdRef.current = scanId;
        setIsScanningFolder(true);
        setIsHoveringScanAbort(false);
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

        const scan = await window.electronAPI.rescanRootFolder(chosenPath, scanId);
        if (scanSequenceRef.current !== seq) return;
        if (scan) {
          applyRootScan(scan);
        }
        return;
      }

      if (window.electronAPI?.pickRootFolder) {
        setIsScanningFolder(true);
        const scan = await window.electronAPI.pickRootFolder();
        if (scanSequenceRef.current !== seq) return;
        if (scan) {
          applyRootScan(scan);
        }
        return;
      }

      if (typeof window.showDirectoryPicker === 'function') {
        const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
        if (scanSequenceRef.current !== seq) return;
        const abortCtrl = new AbortController();
        scanAbortControllerRef.current = abortCtrl;
        setIsScanningFolder(true);
        setIsHoveringScanAbort(false);
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

        const scan = await scanBrowserDirectoryHandle(
          dirHandle,
          abortCtrl.signal
        );
        if (scanSequenceRef.current !== seq) return;
        applyRootScan(scan);
        return;
      }

      fallbackFolderInputRef.current?.click();
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        (err.name === 'AbortError' || err.message === 'SCAN_ABORTED')
      ) {
        return;
      }
      if (scanSequenceRef.current === seq) {
        setSyncError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (scanSequenceRef.current === seq) {
        activeScanIdRef.current = null;
        scanAbortControllerRef.current = null;
        setIsScanningFolder(false);
        setIsHoveringScanAbort(false);
      }
    }
  }

  async function handleFallbackWebkitDirectory(
    e: React.ChangeEvent<HTMLInputElement>
  ) {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const rawFiles = Array.from(fileList);
    e.target.value = '';

    const seq = ++scanSequenceRef.current;
    const abortCtrl = new AbortController();
    scanAbortControllerRef.current = abortCtrl;
    setIsScanningFolder(true);
    setIsHoveringScanAbort(false);

    try {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      fallbackFileMapRef.current.clear();
      const rootFiles: DesktopRootFolderItem[] = [];
      const subFoldersMap = new Map<string, DesktopRootFolderItem>();
      let detectedRootName = 'Selected Folder';

      for (let i = 0; i < rawFiles.length; i++) {
        if (abortCtrl.signal.aborted || scanSequenceRef.current !== seq) return;
        if (i > 0 && i % 40 === 0) {
          await new Promise((r) => setTimeout(r, 0));
          if (abortCtrl.signal.aborted || scanSequenceRef.current !== seq) return;
        }
        const file = rawFiles[i];
        const rel = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
        const parts = rel.split('/').filter(Boolean);
        if (parts.length === 0) continue;

        detectedRootName = parts[0];
        const insideRootParts = parts.slice(1);
        if (insideRootParts.length === 0) continue;

        const lastPart = insideRootParts[insideRootParts.length - 1];
        if (lastPart === '.DS_Store' || lastPart === 'Thumbs.db') continue;

        if (insideRootParts.length === 1) {
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

      if (scanSequenceRef.current === seq) {
        const items = [...rootFiles, ...Array.from(subFoldersMap.values())];
        applyRootScan({
          rootFolderPath: detectedRootName,
          rootFolderName: detectedRootName,
          items,
        });
      }
    } finally {
      if (scanSequenceRef.current === seq) {
        scanAbortControllerRef.current = null;
        setIsScanningFolder(false);
        setIsHoveringScanAbort(false);
      }
    }
  }

  function applyRootScan(scan: DesktopRootFolderScanResult) {
    setRootScan(scan);
    setSelectedSyncIndices(new Set(scan.items.map((_, idx) => idx)));
    setExpandedSubfolders(new Set());
    setLoadingSubfolders(new Set());
    setSyncStatuses({});
  }

  async function handleRescanRootFolder() {
    if (isSyncingFolder) return;
    if (isScanningFolder) {
      handleAbortScan();
      return;
    }
    if (!rootScan) return;

    setSyncError(null);
    const seq = ++scanSequenceRef.current;
    const scanId = `root-scan-${Date.now()}-${seq}`;
    activeScanIdRef.current = scanId;
    const abortCtrl = new AbortController();
    scanAbortControllerRef.current = abortCtrl;
    setIsScanningFolder(true);
    setIsHoveringScanAbort(false);

    try {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      if (window.electronAPI?.rescanRootFolder && rootScan.rootFolderPath) {
        const updated = await window.electronAPI.rescanRootFolder(
          rootScan.rootFolderPath,
          scanId
        );
        if (scanSequenceRef.current !== seq) return;
        applyRootScan(updated);
      } else if (rootScan.dirHandle) {
        const updated = await scanBrowserDirectoryHandle(
          rootScan.dirHandle,
          abortCtrl.signal
        );
        if (scanSequenceRef.current !== seq) return;
        applyRootScan(updated);
      }
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        (err.name === 'AbortError' || err.message === 'SCAN_ABORTED')
      ) {
        return;
      }
      if (scanSequenceRef.current === seq) {
        setSyncError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (scanSequenceRef.current === seq) {
        activeScanIdRef.current = null;
        scanAbortControllerRef.current = null;
        setIsScanningFolder(false);
        setIsHoveringScanAbort(false);
      }
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
  function handleTogglePackageFiles(pkgName: string) {
    const next = new Set(expandedPackages);
    if (next.has(pkgName)) {
      next.delete(pkgName);
    } else {
      next.add(pkgName);
    }
    setExpandedPackages(next);
  }

  function handleCancelInspect() {
    if (inspectAbortRef.current) {
      inspectAbortRef.current.abort();
      inspectAbortRef.current = null;
    }
    setInspectingPkgName(null);
    setInspectProgress(0);
  }

  async function handleLoadLargeExternalPackage(pkgName: string, ownerLogin?: string) {
    if (!selectedRepo || !user || !authToken) return;
    if (inspectAbortRef.current) {
      inspectAbortRef.current.abort();
    }
    const ac = new AbortController();
    inspectAbortRef.current = ac;
    setInspectingPkgName(pkgName);
    setInspectProgress(0);
    setActionBanner(null);

    try {
      const details = await inspectPackageManifest({
        username: user.login,
        githubToken: authToken,
        owner: ownerLogin || selectedRepo.owner.login,
        packageName: pkgName,
        forceLoadLargeExternal: true,
        onProgress: (pct) => setInspectProgress(pct),
        signal: ac.signal,
      });
      setInspectedManifests((prev) => ({
        ...prev,
        [pkgName]: details,
      }));
      setExpandedPackages((prev) => new Set(prev).add(pkgName));
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      setActionBanner({
        type: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (inspectAbortRef.current === ac) {
        inspectAbortRef.current = null;
      }
      setInspectingPkgName(null);
      setInspectProgress(0);
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

  const tokenGenUrl =
    'https://github.com/settings/tokens/new?description=GHCR%20Manager&scopes=repo,write:packages,read:packages,delete:packages';

  return (
    <div className="min-h-screen font-sans flex flex-col items-center py-10 px-4 transition-colors duration-200">
      <Header
        isDarkMode={isDarkMode}
        settings={settings}
        user={user}
        authLoading={authLoading}
        showMenu={showMenu}
        setShowMenu={setShowMenu}
        onOpenSettings={() => setShowSettingsModal(true)}
        onOpenHelp={() => setShowHelpModal(true)}
        onOpenAbout={() => setShowAboutModal(true)}
        onSignOut={handleSignOut}
      />

      {!user ? (
        /* ==================== SIGN-IN VIEW ==================== */
        <main className="w-full max-w-xl relative z-10 mt-2">
          <div className="bg-[#161b22] border border-[#30363d] rounded-xl shadow-2xl p-6 sm:p-8 space-y-6">
            {/* Auth Method Tabs */}
            <div className="grid grid-cols-2 gap-2 p-1 bg-[#0d1117] rounded-lg border border-[#30363d]">
              <button
                type="button"
                onClick={() => {
                  setAuthTab('pat');
                  setAuthError(null);
                }}
                className={`py-2 px-3 rounded-md text-xs font-semibold transition flex items-center justify-center gap-2 cursor-pointer ${
                  authTab === 'pat'
                    ? 'bg-blue-600 text-white shadow'
                    : 'text-gray-400 hover:text-gray-200'
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
                className={`py-2 px-3 rounded-md text-xs font-semibold transition flex items-center justify-center gap-2 cursor-pointer ${
                  authTab === 'device'
                    ? 'bg-blue-600 text-white shadow'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                <Smartphone className="w-3.5 h-3.5" />
                OAuth Device Flow
              </button>
            </div>

            {authError && (
              <div className="p-3.5 rounded-md theme-error-banner text-xs flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{authError}</span>
              </div>
            )}

            {authTab === 'pat' ? (
              <div className="space-y-5">
                <div className="p-3.5 rounded-md bg-[#0d1117] border border-[#30363d] text-xs text-gray-300 space-y-2">
                  <div className="font-semibold text-white flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 header-logo" />
                    Required GitHub Scopes:
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {['repo', 'write:packages', 'read:packages', 'delete:packages'].map(
                      (scope) => (
                        <span
                          key={scope}
                          className="px-2 py-0.5 rounded bg-[#161b22] border border-[#30363d] text-gray-200 font-mono text-[11px]"
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
                    className="inline-flex items-center gap-1.5 text-gray-300 hover:text-white font-semibold pt-1 underline"
                  >
                    Open GitHub with scopes pre-selected
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-300 mb-1.5">
                    Personal Access Token (Classic `ghp_...`)
                  </label>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="password"
                      value={tokenInput}
                      onChange={(e) => setTokenInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handleSignInWithToken(tokenInput, { source: 'pat' });
                        }
                      }}
                      placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                      className="flex-1 px-3.5 py-2.5 rounded-md bg-[#0d1117] border border-[#30363d] text-sm text-white focus:outline-none font-mono"
                    />
                    <button
                      type="button"
                      disabled={authLoading || !tokenInput.trim()}
                      onClick={() =>
                        handleSignInWithToken(tokenInput, { source: 'pat' })
                      }
                      className="py-2.5 px-5 rounded-md bg-blue-600 font-semibold text-xs transition flex items-center justify-center gap-2 cursor-pointer shrink-0"
                    >
                      {authLoading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Github className="w-4 h-4" />
                      )}
                      Sign In
                    </button>
                  </div>
                </div>

                {/* Saved Personal Access Tokens List (Outside, directly below PAT textbox) */}
                <div className="pt-2 border-t border-[#30363d]">
                  <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider block mb-2">
                    Saved Personal Access Tokens:
                  </span>
                  {savedPats.length === 0 ? (
                    <p className="text-xs text-gray-500 italic p-3 border border-dashed border-[#30363d] rounded-md text-center">
                      No saved tokens yet. Sign in above and your token will be saved here as &lt;username&gt;/ghp_••••xxxx.
                    </p>
                  ) : (
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {savedPats.map((entry, idx) => {
                        const isEditing = editingPatIndex === idx;
                        const displayTag = entry.customName
                          ? `${entry.username}/${entry.customName}`
                          : `${entry.username}/${entry.maskedSuffix}`;

                        return (
                          <div
                            key={`${entry.username}-${entry.maskedSuffix}-${idx}`}
                            onClick={() =>
                              !isEditing &&
                              handleSignInWithToken(entry.token, { source: 'pat' })
                            }
                            className="flex items-center justify-between p-2.5 rounded-md border border-[#30363d] bg-[#0d1117] hover:border-gray-500 cursor-pointer text-xs transition-all"
                          >
                            {isEditing ? (
                              <div
                                className="flex items-center gap-1.5 flex-1 min-w-0 mr-2"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <span className="text-xs font-mono text-gray-400 shrink-0">
                                  {entry.username}/
                                </span>
                                <input
                                  type="text"
                                  value={editingPatNameInput}
                                  onChange={(e) =>
                                    setEditingPatNameInput(e.target.value)
                                  }
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      handleRenamePat(entry.token, editingPatNameInput);
                                    }
                                    if (e.key === 'Escape') {
                                      setEditingPatIndex(null);
                                    }
                                  }}
                                  placeholder={entry.maskedSuffix}
                                  autoFocus
                                  className="flex-1 bg-[#161b22] border border-[#30363d] rounded px-2 py-1 text-xs text-gray-200 focus:outline-none"
                                />
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleRenamePat(entry.token, editingPatNameInput)
                                  }
                                  className="p-1 btn-saved-action transition-colors cursor-pointer"
                                  title="Save name"
                                >
                                  <Check className="w-3.5 h-3.5 rename-check-icon" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingPatIndex(null)}
                                  className="p-1 btn-saved-action transition-colors cursor-pointer"
                                  title="Cancel"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center gap-2 truncate flex-1 min-w-0">
                                <span className="w-2 h-2 rounded-full shrink-0 saved-item-dot"></span>
                                <span className="font-semibold font-mono text-xs saved-item-name truncate">
                                  {displayTag}
                                </span>
                                {entry.customName && (
                                  <span className="text-[11px] font-mono text-gray-500 truncate">
                                    ({entry.maskedSuffix})
                                  </span>
                                )}
                              </div>
                            )}

                            <div className="flex items-center gap-1 shrink-0 ml-2">
                              {!isEditing && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setEditingPatIndex(idx);
                                    setEditingPatNameInput(entry.customName || '');
                                  }}
                                  className="p-1 btn-saved-action text-gray-500 transition-colors cursor-pointer"
                                  title="Rename token"
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeletePat(entry.token);
                                }}
                                className="p-1 hover:text-red-400 text-gray-500 transition-colors cursor-pointer"
                                title="Delete saved token"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-5">
                <p className="text-xs text-gray-400 leading-relaxed">
                  Sign in via browser code using a GitHub OAuth App Client ID (with
                  Device Flow enabled in your GitHub OAuth App settings).
                </p>

                <div>
                  <label className="block text-xs font-semibold text-gray-300 mb-1.5">
                    GitHub OAuth App Client ID
                  </label>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="text"
                      value={oauthClientId}
                      onChange={(e) => setOauthClientId(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handleStartDeviceFlowWithClientId(oauthClientId);
                        }
                      }}
                      placeholder="Iv1.xxxxxxxxxxxxxxxx or Ov23lixxxxxxxxx"
                      className="flex-1 px-3.5 py-2.5 rounded-md bg-[#0d1117] border border-[#30363d] text-sm text-white focus:outline-none font-mono"
                    />
                    {!deviceFlowInfo && (
                      <button
                        type="button"
                        disabled={authLoading || !oauthClientId.trim()}
                        onClick={() =>
                          handleStartDeviceFlowWithClientId(oauthClientId)
                        }
                        className="py-2.5 px-4 rounded-md bg-blue-600 font-semibold text-xs transition flex items-center justify-center gap-2 cursor-pointer shrink-0"
                      >
                        {authLoading ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Github className="w-4 h-4" />
                        )}
                        Get Login Code
                      </button>
                    )}
                  </div>
                </div>

                {deviceFlowInfo && (
                  <div className="p-4 rounded-md bg-[#0d1117] border border-[#30363d] text-center space-y-3">
                    <div className="text-xs text-gray-400">
                      Enter this code on GitHub to authorize:
                    </div>
                    <div className="text-2xl font-mono font-bold tracking-widest text-white bg-[#161b22] py-2 px-4 rounded-md inline-block border border-[#30363d]">
                      {deviceFlowInfo.user_code}
                    </div>
                    <div>
                      <a
                        href={deviceFlowInfo.verification_uri}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-blue-600 px-3.5 py-2 rounded-md"
                      >
                        Open {deviceFlowInfo.verification_uri}
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                    <div className="flex items-center justify-center gap-2 text-xs text-gray-400 pt-1">
                      <Loader2 className="w-3.5 h-3.5 animate-spin theme-spinner" />
                      Waiting for authorization in browser...
                    </div>
                  </div>
                )}

                {/* Saved OAuth App Client IDs List (Outside, directly below Client ID textbox) */}
                <div className="pt-2 border-t border-[#30363d]">
                  <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider block mb-2">
                    Saved OAuth Client IDs:
                  </span>
                  {savedOAuths.length === 0 ? (
                    <p className="text-xs text-gray-500 italic p-3 border border-dashed border-[#30363d] rounded-md text-center">
                      No saved OAuth Client IDs yet. Authorize above and your Client ID will be saved here as &lt;username&gt;/Ov23••••xxxx.
                    </p>
                  ) : (
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {savedOAuths.map((entry, idx) => {
                        const isEditing = editingOAuthIndex === idx;
                        const displayTag = entry.customName
                          ? `${entry.username}/${entry.customName}`
                          : `${entry.username}/${entry.maskedSuffix}`;

                        return (
                          <div
                            key={`${entry.username}-${entry.clientId}-${idx}`}
                            onClick={() =>
                              !isEditing && handleSelectSavedOAuth(entry)
                            }
                            className="flex items-center justify-between p-2.5 rounded-md border border-[#30363d] bg-[#0d1117] hover:border-gray-500 cursor-pointer text-xs transition-all"
                          >
                            {isEditing ? (
                              <div
                                className="flex items-center gap-1.5 flex-1 min-w-0 mr-2"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <span className="text-xs font-mono text-gray-400 shrink-0">
                                  {entry.username}/
                                </span>
                                <input
                                  type="text"
                                  value={editingOAuthNameInput}
                                  onChange={(e) =>
                                    setEditingOAuthNameInput(e.target.value)
                                  }
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      handleRenameOAuth(
                                        entry.clientId,
                                        editingOAuthNameInput
                                      );
                                    }
                                    if (e.key === 'Escape') {
                                      setEditingOAuthIndex(null);
                                    }
                                  }}
                                  placeholder={entry.maskedSuffix}
                                  autoFocus
                                  className="flex-1 bg-[#161b22] border border-[#30363d] rounded px-2 py-1 text-xs text-gray-200 focus:outline-none"
                                />
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleRenameOAuth(
                                      entry.clientId,
                                      editingOAuthNameInput
                                    )
                                  }
                                  className="p-1 btn-saved-action transition-colors cursor-pointer"
                                  title="Save name"
                                >
                                  <Check className="w-3.5 h-3.5 rename-check-icon" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingOAuthIndex(null)}
                                  className="p-1 btn-saved-action transition-colors cursor-pointer"
                                  title="Cancel"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center gap-2 truncate flex-1 min-w-0">
                                <span className="w-2 h-2 rounded-full shrink-0 saved-item-dot"></span>
                                <span className="font-semibold font-mono text-xs saved-item-name truncate">
                                  {displayTag}
                                </span>
                                {entry.customName && (
                                  <span className="text-[11px] font-mono text-gray-500 truncate">
                                    ({entry.maskedSuffix})
                                  </span>
                                )}
                              </div>
                            )}

                            <div className="flex items-center gap-1 shrink-0 ml-2">
                              {!isEditing && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setEditingOAuthIndex(idx);
                                    setEditingOAuthNameInput(entry.customName || '');
                                  }}
                                  className="p-1 btn-saved-action text-gray-500 transition-colors cursor-pointer"
                                  title="Rename Client ID"
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeleteOAuth(entry.clientId);
                                }}
                                className="p-1 hover:text-red-400 text-gray-500 transition-colors cursor-pointer"
                                title="Delete saved Client ID"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </main>
      ) : (
        /* ==================== AUTHENTICATED WORKSPACE ==================== */
        <>
          <TabNav
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            packageCount={repoPackages.length}
            isDesktop={isDesktopEnv}
          />

          <main className="w-full max-w-4xl relative z-10 space-y-6">
            {/* Compact Repository Selector Card */}
            <div
              className="bg-[#161b22] border border-[#30363d] rounded-xl p-4 sm:p-5 shadow-md"
              ref={repoDropdownRef}
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="relative flex-1 sm:w-80">
                    <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-400 mb-1">
                      Target GitHub Repository ({repos.length})
                    </label>
                    <button
                      type="button"
                      onClick={() => setShowRepoDropdown(!showRepoDropdown)}
                      className="w-full px-3.5 py-2 rounded-md bg-[#0d1117] border border-[#30363d] text-left text-xs font-semibold text-white flex items-center justify-between gap-2 cursor-pointer"
                    >
                      <span className="truncate">
                        {selectedRepo
                          ? selectedRepo.full_name
                          : 'Select a repository...'}
                      </span>
                      <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" />
                    </button>

                    {showRepoDropdown && (
                      <div className="absolute left-0 top-full mt-1.5 w-full sm:w-96 bg-[#161b22] border border-[#30363d] rounded-md shadow-2xl z-40 overflow-hidden">
                        <div className="p-2 border-b border-[#30363d] bg-[#0d1117]">
                          <div className="relative">
                            <Search className="w-3.5 h-3.5 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                            <input
                              type="text"
                              value={repoSearch}
                              onChange={(e) => setRepoSearch(e.target.value)}
                              placeholder="Filter repositories..."
                              autoFocus
                              className="w-full pl-8 pr-3 py-1.5 rounded bg-[#161b22] border border-[#30363d] text-xs text-white focus:outline-none"
                            />
                          </div>
                        </div>
                        <div className="max-h-64 overflow-y-auto divide-y divide-[#30363d]">
                          {filteredRepos.length === 0 ? (
                            <div className="p-4 text-center text-xs text-gray-500">
                              No matching repositories.
                            </div>
                          ) : (
                            filteredRepos.map((repo) => {
                              const isSelected = selectedRepo?.id === repo.id;
                              return (
                                <button
                                  key={repo.id}
                                  type="button"
                                  onClick={() => {
                                    setSelectedRepo(repo);
                                    setShowRepoDropdown(false);
                                  }}
                                  className={`w-full text-left px-3.5 py-2.5 text-xs flex items-center justify-between gap-2 cursor-pointer transition ${
                                    isSelected
                                      ? 'active-variant font-bold'
                                      : 'hover:bg-[#21262d] text-gray-300'
                                  }`}
                                >
                                  <div className="min-w-0">
                                    <div className="truncate">{repo.full_name}</div>
                                    {repo.description && (
                                      <div className="text-[11px] text-gray-500 truncate">
                                        {repo.description}
                                      </div>
                                    )}
                                  </div>
                                  <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-[#30363d] bg-[#0d1117] text-gray-400">
                                    {repo.private ? 'Private' : 'Public'}
                                  </span>
                                </button>
                              );
                            })
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {selectedRepo && (
                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      href={`${selectedRepo.html_url}/packages`}
                      target="_blank"
                      rel="noreferrer"
                      className="btn-modal-action px-3 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5"
                    >
                      View Repo Packages on GitHub
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                    <button
                      type="button"
                      onClick={() =>
                        handleSignInWithToken(authToken, { source: 'restore' })
                      }
                      title="Refresh repositories"
                      className="btn-modal-action p-2 rounded-md cursor-pointer"
                    >
                      <RefreshCw
                        className={`w-3.5 h-3.5 ${
                          reposLoading ? 'animate-spin' : ''
                        }`}
                      />
                    </button>
                  </div>
                )}
              </div>
            </div>

            {selectedRepo && (
              <>
                {/* ==================== TAB 1: UPLOAD FILE(S) ==================== */}
                {activeTab === 'upload-files' && (
                  <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-6 shadow-md space-y-6">
                    <div>
                      <h3 className="text-base font-bold text-white flex items-center gap-2">
                        <FilePlus2 className="w-5 h-5 icon-upload" />
                        Upload Single or Multiple Files as an Image
                      </h3>
                      <p className="text-xs text-gray-400 mt-1">
                        Select files or folders to package into an OCI container image and push to{' '}
                        <span className="text-white font-semibold">
                          {selectedRepo.full_name}
                        </span>
                        .
                      </p>
                    </div>

                    {/* File & Folder Dropzone */}
                    <div
                      onDragEnter={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (isScanningUploadDrop) return;
                        fileDragCounter.current += 1;
                        if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
                          setIsDraggingFiles(true);
                        }
                      }}
                      onDragLeave={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        fileDragCounter.current -= 1;
                        if (fileDragCounter.current <= 0) {
                          fileDragCounter.current = 0;
                          setIsDraggingFiles(false);
                        }
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        e.dataTransfer.dropEffect = 'copy';
                      }}
                      onDrop={async (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        fileDragCounter.current = 0;
                        setIsDraggingFiles(false);
                        if (isScanningUploadDrop) return;

                        const droppedFileObjs = Array.from(e.dataTransfer.files || []);
                        const nativePaths = droppedFileObjs
                          .map((f) => (f as unknown as { path?: string }).path)
                          .filter((p): p is string => Boolean(p));

                        const seq = ++uploadScanSeqRef.current;

                        if (
                          nativePaths.length > 0 &&
                          window.electronAPI?.scanPathsForUpload
                        ) {
                          const scanId = `upload-drop-${Date.now()}-${seq}`;
                          uploadScanIdRef.current = scanId;
                          setIsScanningUploadDrop(true);
                          try {
                            await new Promise((r) =>
                              requestAnimationFrame(() => setTimeout(r, 0))
                            );
                            const scanned = await window.electronAPI.scanPathsForUpload(
                              nativePaths,
                              scanId
                            );
                            if (uploadScanSeqRef.current === seq && scanned.length > 0) {
                              handleUploadItemsAdded(scanned);
                            }
                          } catch (err: unknown) {
                            if (
                              !(
                                err instanceof Error &&
                                err.message === 'SCAN_ABORTED'
                              ) &&
                              uploadScanSeqRef.current === seq
                            ) {
                              setUploadError(
                                err instanceof Error ? err.message : String(err)
                              );
                            }
                          } finally {
                            if (uploadScanSeqRef.current === seq) {
                              uploadScanIdRef.current = null;
                              setIsScanningUploadDrop(false);
                            }
                          }
                          return;
                        }

                        const items = e.dataTransfer.items;
                        if (
                          items &&
                          items.length > 0 &&
                          typeof items[0].webkitGetAsEntry === 'function'
                        ) {
                          const topEntries: any[] = [];
                          for (let i = 0; i < items.length; i++) {
                            const ent = items[i].webkitGetAsEntry();
                            if (ent) topEntries.push(ent);
                          }

                          if (topEntries.length > 0) {
                            const abortCtrl = new AbortController();
                            uploadScanAbortRef.current = abortCtrl;
                            setIsScanningUploadDrop(true);

                            try {
                              await new Promise((r) =>
                                requestAnimationFrame(() => setTimeout(r, 0))
                              );
                              let stepCounter = 0;
                              const collectDirEntries = async (
                                dirEntry: any,
                                prefix = ''
                              ): Promise<DesktopRootFolderFileEntry[]> => {
                                if (
                                  abortCtrl.signal.aborted ||
                                  uploadScanSeqRef.current !== seq
                                ) {
                                  throw new Error('SCAN_ABORTED');
                                }
                                const out: DesktopRootFolderFileEntry[] = [];
                                const reader = dirEntry.createReader();
                                const readBatch = (): Promise<any[]> =>
                                  new Promise((resolve) => {
                                    reader.readEntries(
                                      (ents: any[]) => resolve(ents || []),
                                      () => resolve([])
                                    );
                                  });

                                let batch: any[] = [];
                                do {
                                  batch = await readBatch();
                                  for (const child of batch) {
                                    if (
                                      abortCtrl.signal.aborted ||
                                      uploadScanSeqRef.current !== seq
                                    ) {
                                      throw new Error('SCAN_ABORTED');
                                    }
                                    if (
                                      child.name === '.DS_Store' ||
                                      child.name === 'Thumbs.db'
                                    ) {
                                      continue;
                                    }
                                    stepCounter += 1;
                                    if (stepCounter % 25 === 0) {
                                      await new Promise((r) => setTimeout(r, 0));
                                    }
                                    const relPath = prefix
                                      ? `${prefix}/${child.name}`
                                      : child.name;
                                    if (child.isFile) {
                                      await new Promise<void>((resolve) => {
                                        child.file(
                                          (f: File) => {
                                            out.push({
                                              relativePath: relPath,
                                              name: child.name,
                                              size: f.size,
                                              mtime: Math.floor(
                                                f.lastModified / 1000
                                              ),
                                              rawFile: f,
                                            });
                                            resolve();
                                          },
                                          () => resolve()
                                        );
                                      });
                                    } else if (child.isDirectory) {
                                      const nested = await collectDirEntries(
                                        child,
                                        relPath
                                      );
                                      for (let k = 0; k < nested.length; k++) {
                                        out.push(nested[k]);
                                      }
                                    }
                                  }
                                } while (batch.length > 0);
                                return out;
                              };

                              const resultingItems: UploadSelectionItem[] = [];
                              for (const entry of topEntries) {
                                if (
                                  abortCtrl.signal.aborted ||
                                  uploadScanSeqRef.current !== seq
                                ) {
                                  throw new Error('SCAN_ABORTED');
                                }
                                if (entry.isFile) {
                                  await new Promise<void>((resolve) => {
                                    entry.file(
                                      (f: File) => {
                                        resultingItems.push({
                                          kind: 'file',
                                          name: f.name,
                                          size: f.size,
                                          mtime: Math.floor(f.lastModified / 1000),
                                          rawFile: f,
                                          files: [
                                            {
                                              relativePath: f.name,
                                              name: f.name,
                                              size: f.size,
                                              mtime: Math.floor(
                                                f.lastModified / 1000
                                              ),
                                              rawFile: f,
                                            },
                                          ],
                                        });
                                        resolve();
                                      },
                                      () => resolve()
                                    );
                                  });
                                } else if (entry.isDirectory) {
                                  const folderFiles = await collectDirEntries(
                                    entry,
                                    ''
                                  );
                                  const totalSize = folderFiles.reduce(
                                    (acc, f) => acc + f.size,
                                    0
                                  );
                                  resultingItems.push({
                                    kind: 'folder',
                                    name: entry.name,
                                    size: totalSize,
                                    files: folderFiles,
                                  });
                                }
                              }

                              if (
                                uploadScanSeqRef.current === seq &&
                                resultingItems.length > 0
                              ) {
                                handleUploadItemsAdded(resultingItems);
                              }
                            } catch {
                              // Aborted or failed
                            } finally {
                              if (uploadScanSeqRef.current === seq) {
                                uploadScanAbortRef.current = null;
                                setIsScanningUploadDrop(false);
                              }
                            }
                            return;
                          }
                        }

                        if (e.dataTransfer.files?.length) {
                          handleFilesAdded(e.dataTransfer.files);
                        }
                      }}
                      onClick={() => {
                        if (!isScanningUploadDrop) {
                          fileInputRef.current?.click();
                        }
                      }}
                      className={`dropzone-container rounded-xl p-8 text-center transition select-none ${
                        isScanningUploadDrop ? 'cursor-default' : 'cursor-pointer'
                      } ${isDraggingFiles ? 'is-drag-over' : ''}`}
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
                      <input
                        ref={uploadFolderInputRef}
                        type="file"
                        // @ts-expect-error webkitdirectory is supported across desktop browsers
                        webkitdirectory="true"
                        directory="true"
                        multiple
                        className="hidden"
                        onChange={handleUploadFallbackWebkitDirectory}
                      />

                      {isScanningUploadDrop ? (
                        <div className="space-y-3 py-1">
                          <Loader2 className="w-8 h-8 icon-upload mx-auto animate-spin" />
                          <div className="text-sm font-semibold text-white">
                            Scanning folder...
                          </div>
                          <div>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleAbortUploadScan();
                              }}
                              className="btn-modal-action px-3.5 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                            >
                              <X className="w-3.5 h-3.5" />
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <Upload className="w-8 h-8 icon-upload mx-auto mb-2.5 dropzone-icon transition-transform pointer-events-none" />
                          <div className="text-sm font-semibold text-white dropzone-title transition-colors pointer-events-none">
                            {isDraggingFiles
                              ? 'Drop files or folders here to select'
                              : 'Click to choose files or drag & drop here'}
                          </div>
                          <div className="text-xs text-gray-500 mt-1 pointer-events-none">
                            Select one or multiple files or folders from your device
                          </div>
                          <div className="mt-3 flex items-center justify-center gap-2">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handlePickUploadFolders();
                              }}
                              className="btn-modal-action px-3 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                            >
                              <Folder className="w-3.5 h-3.5 icon-upload" />
                              Choose Folder
                            </button>
                          </div>
                        </>
                      )}
                    </div>

                    {/* Picked Files & Folders List */}
                    {pickedItems.length > 0 && (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-gray-300">
                            Selected Items ({pickedItems.length}) — Total:{' '}
                            {formatBytes(
                              pickedItems.reduce((acc, item) => acc + item.size, 0)
                            )}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              setPickedItems([]);
                              setExpandedUploadFolders(new Set());
                              setCustomImageName('');
                            }}
                            className="text-xs text-gray-400 hover:text-white cursor-pointer"
                          >
                            Clear all
                          </button>
                        </div>

                        <div className="max-h-72 overflow-y-auto divide-y divide-[#30363d] bg-[#0d1117] rounded-md border border-[#30363d]">
                          {pickedItems.map((item, idx) => {
                            const isExpanded = expandedUploadFolders.has(idx);
                            const isLoadingFiles = loadingUploadFolders.has(idx);

                            return (
                              <div
                                key={`${item.kind}-${item.name}-${idx}`}
                                className="px-3.5 py-2.5 text-xs"
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-2 min-w-0">
                                    {item.kind === 'folder' ? (
                                      <Folder className="w-4 h-4 icon-upload shrink-0" />
                                    ) : (
                                      <FileIcon className="w-4 h-4 icon-upload shrink-0" />
                                    )}
                                    <span className="truncate text-white font-medium">
                                      {item.name}
                                    </span>
                                    {item.kind === 'folder' && (
                                      <span className="text-[10px] px-2 py-0.5 rounded border border-[#30363d] bg-[#161b22] text-gray-300 font-medium shrink-0">
                                        Folder ({item.files.length} file
                                        {item.files.length === 1 ? '' : 's'})
                                      </span>
                                    )}
                                    <span className="text-gray-500 shrink-0">
                                      ({formatBytes(item.size)})
                                    </span>
                                  </div>

                                  <div className="flex items-center gap-2 shrink-0">
                                    {item.kind === 'folder' && (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          handleToggleUploadFolderExpand(idx)
                                        }
                                        className="btn-modal-action text-xs px-2 py-1 rounded flex items-center gap-1 cursor-pointer"
                                      >
                                        {isLoadingFiles ? (
                                          <Loader2 className="w-3.5 h-3.5 animate-spin theme-spinner" />
                                        ) : isExpanded ? (
                                          <ChevronDown className="w-3.5 h-3.5" />
                                        ) : (
                                          <ChevronRight className="w-3.5 h-3.5" />
                                        )}
                                        Files
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => handleRemovePickedItem(idx)}
                                      className="modal-close-btn p-1"
                                    >
                                      <X className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                </div>

                                {item.kind === 'folder' && isExpanded && (
                                  <SubfolderFileTree
                                    files={item.files}
                                    iconClassName="icon-upload"
                                  />
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Image / Package Name Input */}
                    {pickedItems.length > 0 && (
                      <div className="p-4 rounded-md bg-[#0d1117] border border-[#30363d] space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                          <div className="sm:col-span-3">
                            <label className="block text-xs font-semibold text-gray-200 mb-1">
                              Image & Package Name
                            </label>
                            <input
                              type="text"
                              value={customImageName}
                              onChange={(e) => setCustomImageName(e.target.value)}
                              placeholder={
                                pickedItems.length === 1
                                  ? pickedItems[0].name
                                  : 'Enter a name for this multi-item image (e.g. release-bundle)'
                              }
                              className="w-full px-3.5 py-2 rounded-md bg-[#161b22] border border-[#30363d] text-sm text-white focus:outline-none"
                            />
                          </div>

                          <div>
                            <label className="block text-xs font-semibold text-gray-200 mb-1">
                              Tag
                            </label>
                            <input
                              type="text"
                              value={imageTag}
                              onChange={(e) => setImageTag(e.target.value)}
                              placeholder="latest"
                              className="w-full px-3 py-2 rounded-md bg-[#161b22] border border-[#30363d] text-sm text-white font-mono focus:outline-none"
                            />
                          </div>
                        </div>

                        {fileNamingValidation.valid ? (
                          <div className="flex flex-wrap items-center gap-2 text-xs bg-[#161b22] px-3.5 py-2.5 rounded-md border border-[#30363d]">
                            <span className="text-gray-400 shrink-0">
                              Resulting Package & Image Name:
                            </span>
                            <code className="text-white font-mono font-semibold break-all">
                              ghcr.io/{selectedRepo.owner.login.toLowerCase()}/
                              {fileNamingValidation.ociPackageName}:
                              {imageTag.trim() || 'latest'}
                            </code>
                          </div>
                        ) : (
                          <div className="text-xs text-gray-400 flex items-center gap-1.5">
                            <Info className="w-4 h-4 shrink-0" />
                            {fileNamingValidation.error}
                          </div>
                        )}

                        {uploadError && (
                          <div className="p-3 rounded-md theme-error-banner text-xs flex items-start gap-2">
                            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                            <span>{uploadError}</span>
                          </div>
                        )}

                        {uploadProgress && (
                          <div className="space-y-1.5">
                            <div className="flex justify-between text-xs text-gray-300">
                              <span>{uploadProgress.message}</span>
                              <span>{uploadProgress.percent}%</span>
                            </div>
                            <div className="w-full h-2 bg-[#161b22] rounded-full overflow-hidden border border-[#30363d]">
                              <div
                                className="h-full tab-indicator transition-all duration-300"
                                style={{ width: `${uploadProgress.percent}%` }}
                              />
                            </div>
                          </div>
                        )}

                        {uploadSuccess && (
                          <div className="p-3.5 rounded-md theme-success-banner text-xs flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2">
                              <CheckCircle2 className="w-4 h-4 shrink-0" />
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
                              className="btn-modal-action px-2.5 py-1 rounded-md font-medium shrink-0 cursor-pointer"
                            >
                              View in Packages →
                            </button>
                          </div>
                        )}

                        <button
                          type="button"
                          disabled={!fileNamingValidation.valid || !!uploadProgress}
                          onClick={handleUploadSelectedFiles}
                          className="w-full py-2.5 px-4 rounded-md bg-blue-600 font-semibold text-xs transition flex items-center justify-center gap-2 cursor-pointer"
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
                              {fileNamingValidation.ociPackageName || '...'}&quot; &
                              Upload to Repo Packages
                            </>
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* ==================== TAB 2: SYNC ROOT FOLDER (DESKTOP) ==================== */}
                {activeTab === 'sync-folder' && (
                  <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-6 shadow-md space-y-6">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <h3 className="text-base font-bold text-white flex items-center gap-2">
                          <FolderSync className="w-5 h-5 icon-sync" />
                          Root Folder Auto-Image Sync (Windows, Linux, macOS)
                        </h3>
                        <p className="text-xs text-gray-400 mt-1">
                          Choose a root folder on your computer and press{' '}
                          <span className="text-white font-semibold">Sync Folder</span>.
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
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
                            onMouseEnter={() =>
                              isScanningFolder && setIsHoveringScanAbort(true)
                            }
                            onMouseLeave={() => setIsHoveringScanAbort(false)}
                            title={
                              isScanningFolder
                                ? 'Click to abort scanning'
                                : 'Rescan root folder'
                            }
                            className="btn-modal-action px-3 py-2 rounded-md text-xs font-semibold inline-grid items-center justify-items-center cursor-pointer transition-colors"
                          >
                            <span
                              className={`col-start-1 row-start-1 flex items-center justify-center gap-1.5 ${
                                !isScanningFolder
                                  ? 'visible'
                                  : 'invisible pointer-events-none select-none'
                              }`}
                            >
                              <RefreshCw className="w-3.5 h-3.5 shrink-0" />
                              <span>Rescan</span>
                            </span>
                            <span
                              className={`col-start-1 row-start-1 flex items-center justify-center gap-1.5 ${
                                isScanningFolder && !isHoveringScanAbort
                                  ? 'visible'
                                  : 'invisible pointer-events-none select-none'
                              }`}
                            >
                              <Loader2 className="w-3.5 h-3.5 animate-spin theme-spinner shrink-0" />
                              <span>Scanning...</span>
                            </span>
                            <span
                              className={`col-start-1 row-start-1 flex items-center justify-center gap-1.5 ${
                                isScanningFolder && isHoveringScanAbort
                                  ? 'visible'
                                  : 'invisible pointer-events-none select-none'
                              }`}
                            >
                              <X className="w-3.5 h-3.5 shrink-0" />
                              <span>Cancel</span>
                            </span>
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={isSyncingFolder || isScanningFolder}
                          onClick={handlePickRootFolder}
                          className="px-4 py-2 rounded-md btn-sync-green text-xs font-semibold text-white flex items-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <Folder className="w-4 h-4" />
                          {rootScan ? 'Change Root Folder' : 'Choose Root Folder'}
                        </button>
                      </div>
                    </div>

                    {syncError && (
                      <div className="p-3.5 rounded-md theme-error-banner text-xs flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                        <span>{syncError}</span>
                      </div>
                    )}

                    {!rootScan ? (
                      <div
                        onClick={() => {
                          if (!isScanningFolder) {
                            handlePickRootFolder();
                          }
                        }}
                        onDragEnter={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (isScanningFolder) return;
                          rootFolderDragCounter.current += 1;
                          if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
                            setIsDraggingRootFolder(true);
                          }
                        }}
                        onDragLeave={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          rootFolderDragCounter.current -= 1;
                          if (rootFolderDragCounter.current <= 0) {
                            rootFolderDragCounter.current = 0;
                            setIsDraggingRootFolder(false);
                          }
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          e.dataTransfer.dropEffect = 'copy';
                        }}
                        onDrop={async (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          rootFolderDragCounter.current = 0;
                          setIsDraggingRootFolder(false);
                          if (isScanningFolder) return;
                          const firstFile = e.dataTransfer.files?.[0] as any;
                          if (firstFile?.path && window.electronAPI?.rescanRootFolder) {
                            const seq = ++scanSequenceRef.current;
                            const scanId = `root-drop-${Date.now()}-${seq}`;
                            activeScanIdRef.current = scanId;
                            setIsScanningFolder(true);
                            setIsHoveringScanAbort(false);
                            try {
                              await new Promise((r) =>
                                requestAnimationFrame(() => setTimeout(r, 0))
                              );
                              const scan = await window.electronAPI.rescanRootFolder(
                                firstFile.path,
                                scanId
                              );
                              if (scanSequenceRef.current === seq && scan) {
                                applyRootScan(scan);
                              }
                            } catch (err: unknown) {
                              if (
                                !(
                                  err instanceof Error &&
                                  err.message === 'SCAN_ABORTED'
                                ) &&
                                scanSequenceRef.current === seq
                              ) {
                                handlePickRootFolder();
                              }
                            } finally {
                              if (scanSequenceRef.current === seq) {
                                activeScanIdRef.current = null;
                                setIsScanningFolder(false);
                                setIsHoveringScanAbort(false);
                              }
                            }
                          } else {
                            handlePickRootFolder();
                          }
                        }}
                        className={`dropzone-container dropzone-container-sync rounded-xl p-10 text-center transition select-none ${
                          isScanningFolder ? 'cursor-default' : 'cursor-pointer'
                        } ${isDraggingRootFolder ? 'is-drag-over' : ''}`}
                      >
                        {isScanningFolder ? (
                          <div className="space-y-3 py-1">
                            <Loader2 className="w-9 h-9 icon-sync mx-auto animate-spin" />
                            <div className="text-sm font-semibold text-white">
                              Scanning root folder...
                            </div>
                            <div>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleAbortScan();
                                }}
                                className="btn-modal-action px-3.5 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                              >
                                <X className="w-3.5 h-3.5" />
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <HardDrive className="w-9 h-9 icon-sync mx-auto mb-3 dropzone-icon transition-transform pointer-events-none" />
                            <div className="text-sm font-semibold text-white dropzone-title transition-colors pointer-events-none">
                              {isDraggingRootFolder
                                ? 'Drop root folder here to scan'
                                : 'Select a Root Folder to Scan'}
                            </div>
                            <p className="text-xs text-gray-500 max-w-md mx-auto mt-1 pointer-events-none">
                              Detects all direct files and immediate sub-folders and prepares
                              an OCI package image for each one.
                            </p>
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-4">
                        <div className="flex flex-wrap items-center justify-between gap-2 bg-[#0d1117] px-4 py-3 rounded-md border border-[#30363d]">
                          <div className="flex items-center gap-2 min-w-0">
                            <Folder className="w-4 h-4 icon-sync shrink-0" />
                            <span className="text-xs text-gray-400">Root Folder:</span>
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
                              className="text-gray-300 hover:text-white font-semibold cursor-pointer"
                            >
                              Select All ({rootScan.items.length})
                            </button>
                            <span className="text-gray-600">|</span>
                            <button
                              type="button"
                              onClick={() => setSelectedSyncIndices(new Set())}
                              className="text-gray-400 hover:text-gray-200 cursor-pointer"
                            >
                              None
                            </button>
                            <span className="text-gray-600">|</span>
                            <button
                              type="button"
                              disabled={isSyncingFolder || isScanningFolder}
                              onClick={handleRemoveRootFolder}
                              title="Remove root folder"
                              className="text-gray-400 hover:text-red-400 flex items-center gap-1 cursor-pointer transition-colors"
                            >
                              <X className="w-3.5 h-3.5" />
                              Remove
                            </button>
                          </div>
                        </div>

                        {rootScan.items.length === 0 ? (
                          <div className="p-8 text-center text-xs text-gray-500 bg-[#0d1117] rounded-md border border-[#30363d]">
                            The selected root folder is empty. Add files or sub-folders
                            and click Rescan.
                          </div>
                        ) : (
                          <div className="divide-y divide-[#30363d] bg-[#0d1117] rounded-md border border-[#30363d] overflow-hidden">
                            {rootScan.items.map((item, idx) => {
                              const ociName = toOciImageName(item.name);
                              const isChecked = selectedSyncIndices.has(idx);
                              const isExpanded = expandedSubfolders.has(idx);
                              const isLoadingFiles = loadingSubfolders.has(idx);
                              const status = syncStatuses[idx];

                              return (
                                <div
                                  key={`${item.kind}-${item.name}-${idx}`}
                                  className="p-3.5"
                                >
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
                                        className="custom-checkbox shrink-0"
                                      />

                                      {item.kind === 'root-file' ? (
                                        <FileIcon className="w-4 h-4 icon-upload shrink-0" />
                                      ) : (
                                        <Folder className="w-4 h-4 icon-sync shrink-0" />
                                      )}

                                      <div className="min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                          <span className="text-xs font-semibold text-white">
                                            {item.name}
                                          </span>
                                          <span className="text-[10px] px-2 py-0.5 rounded border border-[#30363d] bg-[#161b22] text-gray-300 font-medium">
                                            {item.kind === 'root-file'
                                              ? 'Root File → 1 Image'
                                              : `Sub-folder (${item.files.length} file${
                                                  item.files.length === 1 ? '' : 's'
                                                }) → 1 Image`}
                                          </span>
                                          <span className="text-xs text-gray-500">
                                            ({formatBytes(item.size)})
                                          </span>
                                        </div>

                                        <div className="text-[11px] text-gray-400 font-mono mt-0.5">
                                          Package / Image:{' '}
                                          <span className="text-white font-semibold">
                                            {ociName}
                                          </span>
                                        </div>
                                      </div>
                                    </div>

                                    <div className="flex items-center gap-2">
                                      {status?.state === 'uploading' && (
                                        <span className="text-xs text-gray-300 flex items-center gap-1.5">
                                          <Loader2 className="w-3.5 h-3.5 animate-spin theme-spinner" />
                                          {status.percent ?? 0}%
                                        </span>
                                      )}
                                      {status?.state === 'done' && (
                                        <span className="text-xs status-badge-valid px-2 py-0.5 rounded flex items-center gap-1 font-medium">
                                          <CheckCircle2 className="w-3.5 h-3.5" />
                                          Synced
                                        </span>
                                      )}
                                      {status?.state === 'error' && (
                                        <span
                                          title={status.message}
                                          className="text-xs status-badge-error px-2 py-0.5 rounded flex items-center gap-1"
                                        >
                                          <AlertCircle className="w-3.5 h-3.5" />
                                          Failed
                                        </span>
                                      )}

                                      {item.kind === 'root-subfolder' && (
                                        <button
                                          type="button"
                                          onClick={() =>
                                            handleToggleSubfolderExpand(idx)
                                          }
                                          className="btn-modal-action text-xs px-2 py-1 rounded flex items-center gap-1 cursor-pointer"
                                        >
                                          {isLoadingFiles ? (
                                            <Loader2 className="w-3.5 h-3.5 animate-spin theme-spinner" />
                                          ) : isExpanded ? (
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
                                    <div className="mt-2 text-[11px] theme-error-banner px-3 py-1.5 rounded">
                                      {status.message}
                                    </div>
                                  )}

                                  {item.kind === 'root-subfolder' && isExpanded && (
                                    <SubfolderFileTree files={item.files} />
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
                            className="w-full py-3 px-5 rounded-md btn-sync-green font-semibold text-xs transition flex items-center justify-center gap-2 cursor-pointer"
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

                {/* ==================== TAB 3: REPO PACKAGES ==================== */}
                {activeTab === 'packages' && (
                  <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-6 shadow-md space-y-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h3 className="text-base font-bold text-white flex items-center gap-2">
                          <Layers className="w-5 h-5 icon-packages" />
                          Packages in {selectedRepo.full_name}
                        </h3>
                        <p className="text-xs text-gray-400 mt-0.5">
                          Search packages or files inside images, inspect layers, download &
                          extract, or remove packages.
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        {otherPackages.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setShowOtherPackages(!showOtherPackages)}
                            className="btn-modal-action px-3 py-1.5 rounded-md text-xs cursor-pointer"
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
                          className="btn-modal-action px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
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

                    {/* Search Bar (Searches Package Names, Original Names, and Files Inside Images) */}
                    {(repoPackages.length > 0 ||
                      (showOtherPackages && otherPackages.length > 0)) && (
                      <div className="relative">
                        <Search className="w-4 h-4 text-gray-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          value={packageSearch}
                          onChange={(e) => setPackageSearch(e.target.value)}
                          placeholder="Search by package name or file name inside images (e.g. config.json, .pdf)..."
                          className="w-full pl-10 pr-9 py-2 rounded-md bg-[#0d1117] border border-[#30363d] text-xs text-white focus:outline-none"
                        />
                        {packageSearch && (
                          <button
                            type="button"
                            onClick={() => setPackageSearch('')}
                            className="modal-close-btn absolute right-2.5 top-1/2 -translate-y-1/2 p-1"
                            title="Clear search"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    )}

                    {actionBanner && (
                      <div
                        className={`p-3.5 rounded-md text-xs flex items-center justify-between gap-2 ${
                          actionBanner.type === 'success'
                            ? 'theme-success-banner'
                            : 'theme-error-banner'
                        }`}
                      >
                        <span>{actionBanner.text}</span>
                        <button
                          type="button"
                          onClick={() => setActionBanner(null)}
                          className="modal-close-btn p-1"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    )}

                    {packagesError && (
                      <div className="p-3.5 rounded-md theme-error-banner text-xs">
                        {packagesError}
                      </div>
                    )}

                    {confirmDeletePkg && (
                      <div className="p-4 rounded-md theme-error-banner flex flex-wrap items-center justify-between gap-3">
                        <div className="text-xs">
                          Are you sure you want to permanently remove package{' '}
                          <strong className="font-mono">{confirmDeletePkg.name}</strong>{' '}
                          from GitHub Packages?
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setConfirmDeletePkg(null)}
                            className="btn-modal-action px-3 py-1.5 rounded-md text-xs cursor-pointer"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              handleDeletePackageConfirmed(confirmDeletePkg)
                            }
                            className="px-3 py-1.5 rounded-md bg-blue-600 text-xs font-semibold text-white cursor-pointer"
                          >
                            Confirm Remove
                          </button>
                        </div>
                      </div>
                    )}

                    {packagesLoading ? (
                      <div className="p-12 flex flex-col items-center justify-center text-gray-400 gap-2">
                        <Loader2 className="w-6 h-6 animate-spin theme-spinner" />
                        <span className="text-xs">Loading packages from GitHub...</span>
                      </div>
                    ) : repoPackages.length === 0 && !showOtherPackages ? (
                      <div className="p-10 rounded-md bg-[#0d1117] border border-[#30363d] text-center space-y-2">
                        <Package className="w-8 h-8 text-gray-500 mx-auto" />
                        <div className="text-sm font-semibold text-gray-300">
                          No packages linked to {selectedRepo.full_name} yet
                        </div>
                        <p className="text-xs text-gray-500 max-w-md mx-auto">
                          Use the &quot;Upload File(s)&quot; or &quot;Sync Root
                          Folder&quot; tabs to create and push your first container
                          package image.
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {[
                          ...repoPackages,
                          ...(showOtherPackages ? otherPackages : []),
                        ]
                          .filter((pkg) => {
                            const q = packageSearch.trim().toLowerCase();
                            if (!q) return true;
                            const details = inspectedManifests[pkg.name];
                            const nameMatch = pkg.name.toLowerCase().includes(q);
                            const origMatch = details?.originalName
                              ?.toLowerCase()
                              .includes(q);
                            const fileMatch = details?.files?.some((f) =>
                              f.path.toLowerCase().includes(q)
                            );
                            return Boolean(nameMatch || origMatch || fileMatch);
                          })
                          .map((pkg) => {
                            const details = inspectedManifests[pkg.name];
                            const q = packageSearch.trim().toLowerCase();
                            const hasMatchingInnerFile = Boolean(
                              q &&
                                details?.files?.some((f) =>
                                  f.path.toLowerCase().includes(q)
                                )
                            );
                            const isDetailsExpanded =
                              expandedPackages.has(pkg.name) || hasMatchingInnerFile;
                            const pullCmd = `docker pull ghcr.io/${pkg.owner.login.toLowerCase()}/${pkg.name}:latest`;
                            const settingsUrl = `${pkg.html_url}/settings`;

                            return (
                              <div
                                key={pkg.id}
                                className="p-4 rounded-md bg-[#0d1117] border border-[#30363d] space-y-3"
                              >
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                  <div className="space-y-1">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <Package className="w-4 h-4 icon-packages" />
                                      <span className="text-sm font-bold text-white font-mono">
                                        {pkg.name}
                                      </span>
                                      <span
                                        className={`text-[10px] px-2 py-0.5 rounded border ${
                                          pkg.visibility === 'private'
                                            ? 'status-badge-warning'
                                            : 'status-badge-valid'
                                        }`}
                                      >
                                        {pkg.visibility === 'private' && (
                                          <Lock className="w-2.5 h-2.5 inline mr-1" />
                                        )}
                                        {pkg.visibility}
                                      </span>
                                      <a
                                        href={settingsUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        title="Open package settings on GitHub (e.g. to change Private/Public visibility)"
                                        className="text-[11px] text-gray-400 hover:text-white inline-flex items-center gap-1 underline"
                                      >
                                        Visibility Settings
                                        <ExternalLink className="w-3 h-3" />
                                      </a>
                                    </div>

                                    <div className="flex items-center gap-2 text-[11px] text-gray-500 font-mono">
                                      <span>{pullCmd}</span>
                                      <button
                                        type="button"
                                        onClick={() => copyToClipboard(pullCmd)}
                                        className="text-gray-400 hover:text-white cursor-pointer"
                                        title="Copy docker pull command"
                                      >
                                        {copiedText === pullCmd ? (
                                          <Check className="w-3.5 h-3.5 rename-check-icon" />
                                        ) : (
                                          <Copy className="w-3.5 h-3.5" />
                                        )}
                                      </button>
                                    </div>
                                  </div>

                                  <div className="flex items-center gap-2 flex-wrap">
                                    {indexingPkgNames.has(pkg.name) && !details ? (
                                      <button
                                        type="button"
                                        disabled
                                        className="btn-modal-action px-3 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5"
                                      >
                                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                        Indexing...
                                      </button>
                                    ) : details?.needsManualLargeLayerLoad ? (
                                      inspectingPkgName === pkg.name ? (
                                        <div className="flex items-center gap-1.5">
                                          <span className="btn-modal-action px-3 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5">
                                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                            Scanning ({inspectProgress}%)
                                          </span>
                                          <button
                                            type="button"
                                            onClick={handleCancelInspect}
                                            className="btn-modal-action px-2.5 py-1.5 rounded-md text-xs font-medium flex items-center gap-1 cursor-pointer"
                                            title="Cancel scanning layer headers"
                                          >
                                            <X className="w-3.5 h-3.5" />
                                            Cancel
                                          </button>
                                        </div>
                                      ) : (
                                        <button
                                          type="button"
                                          disabled={inspectingPkgName !== null}
                                          onClick={() =>
                                            handleLoadLargeExternalPackage(
                                              pkg.name,
                                              pkg.owner.login
                                            )
                                          }
                                          className="btn-modal-action px-3 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 cursor-pointer"
                                          title="External image over 50 MB: click to stream file headers without loading full file contents into RAM"
                                        >
                                          <ChevronRight className="w-3.5 h-3.5" />
                                          Load Files ({formatBytes(details.compressedSize)})
                                        </button>
                                      )
                                    ) : details ? (
                                      <button
                                        type="button"
                                        onClick={() => handleTogglePackageFiles(pkg.name)}
                                        className="btn-modal-action px-3 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 cursor-pointer"
                                      >
                                        {isDetailsExpanded ? (
                                          <ChevronDown className="w-3.5 h-3.5" />
                                        ) : (
                                          <ChevronRight className="w-3.5 h-3.5" />
                                        )}
                                        {isDetailsExpanded
                                          ? 'Hide Files'
                                          : `Files (${details.files.length})`}
                                      </button>
                                    ) : (
                                      <button
                                        type="button"
                                        disabled={inspectingPkgName !== null}
                                        onClick={() =>
                                          handleLoadLargeExternalPackage(
                                            pkg.name,
                                            pkg.owner.login
                                          )
                                        }
                                        className="btn-modal-action px-3 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 cursor-pointer"
                                      >
                                        {inspectingPkgName === pkg.name ? (
                                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                        ) : (
                                          <ChevronRight className="w-3.5 h-3.5" />
                                        )}
                                        Load Files
                                      </button>
                                    )}

                                    <button
                                      type="button"
                                      disabled={downloadingPkgName === pkg.name}
                                      onClick={() => handleDownloadPackage(pkg.name)}
                                      className="px-3 py-1.5 rounded-md bg-blue-600 text-xs font-semibold text-white flex items-center gap-1.5 cursor-pointer"
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
                                      className="btn-modal-action p-1.5 rounded-md hover:text-red-400 transition cursor-pointer"
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

                                {details && isDetailsExpanded && (
                                  <div className="mt-3 pt-3 border-t border-[#30363d] space-y-2 text-xs">
                                    <div className="flex flex-wrap gap-4 text-gray-400">
                                      <span>
                                        Original Name:{' '}
                                        <strong className="text-gray-200">
                                          {details.originalName}
                                        </strong>
                                      </span>
                                      <span>
                                        Mode:{' '}
                                        <strong className="text-white">
                                          {details.mode}
                                        </strong>
                                      </span>
                                      <span>
                                        Files:{' '}
                                        <strong className="text-gray-200">
                                          {details.fileCount}
                                        </strong>
                                      </span>
                                      <span>
                                        Layer Size:{' '}
                                        <strong className="text-gray-200">
                                          {formatBytes(details.compressedSize)}
                                        </strong>{' '}
                                        (Uncompressed:{' '}
                                        {formatBytes(details.totalUncompressedBytes)})
                                      </span>
                                    </div>

                                    {details.files.length > 0 && (
                                      <div className="bg-[#161b22] rounded-md p-2.5 border border-[#30363d] max-h-40 overflow-y-auto space-y-1">
                                        <div className="text-[11px] font-semibold text-gray-400 mb-1">
                                          Files inside image layer:
                                        </div>
                                        {details.files.map((f, i) => {
                                          const matchesQuery =
                                            q && f.path.toLowerCase().includes(q);
                                          return (
                                            <div
                                              key={`${f.path}-${i}`}
                                              className={`flex items-center justify-between text-[11px] font-mono px-1.5 py-0.5 rounded ${
                                                matchesQuery
                                                  ? 'active-variant font-bold'
                                                  : 'text-gray-300'
                                              }`}
                                            >
                                              <span className="truncate">{f.path}</span>
                                              <span className="text-gray-500 shrink-0 ml-2">
                                                {formatBytes(f.size)}
                                              </span>
                                            </div>
                                          );
                                        })}
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
        </>
      )}

      {/* Modals */}
      <SettingsModal
        isOpen={showSettingsModal}
        onClose={() => setShowSettingsModal(false)}
        settings={settings}
        setSettings={setSettings}
        isDarkMode={isDarkMode}
        setIsDarkMode={setIsDarkMode}
      />

      <HelpModal
        isOpen={showHelpModal}
        onClose={() => setShowHelpModal(false)}
      />

      <AboutModal
        isOpen={showAboutModal}
        onClose={() => setShowAboutModal(false)}
      />
    </div>
  );
}
