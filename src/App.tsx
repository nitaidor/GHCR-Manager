import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
import UploadVersionModal, {
  makeVersionStateKey,
} from './components/UploadVersionModal';
import SyncFolderReviewModal, {
  type SyncBatchItemPlan,
  type SyncRootSelectedItem,
} from './components/SyncFolderReviewModal';
import {
  VersionFileDetailsPanel,
  VersionInspectButton,
} from './components/VersionInspectButton';
import {
  buildAndPushOciImage,
  deleteGitHubPackage,
  deletePackageVersion,
  deleteReplacedVersions,
  downloadAndExtractPackage,
  downloadAndExtractPackageToDiskDesktop,
  fetchGitHubAuthInfo,
  fetchLatestRepoIndex,
  fetchLivePackageState,
  formatBytes,
  getVersionReferenceInfo,
  indexRecordToOciDetails,
  inspectPackageManifest,
  listPackageVersions,
  listPackagesForRepo,
  listUserRepositories,
  ociDetailsToIndexRecord,
  pollGitHubDeviceFlowToken,
  publishRepoIndexSnapshot,
  sortPackageVersionsNewestFirst,
  startGitHubDeviceFlow,
  type DesktopStreamingInputFile,
  type GitHubPackageItem,
  type GitHubPackageVersion,
  type GitHubRepo,
  type GitHubUser,
  type LivePackageState,
  type OciPackageDetails,
  type PushProgressUpdate,
  type RepoIndexPayload,
  type RepoIndexVersionRecord,
} from './lib/github-oci';
import {
  mapWithConcurrency,
  scanBrowserDirectoryHandle,
  scanBrowserDirectoryForUpload,
  type DesktopRootFolderFileEntry,
  type DesktopRootFolderItem,
  type DesktopRootFolderScanResult,
  type UploadSelectionItem,
} from './lib/http';
import { isAbortError } from './lib/http';
import {
  getRepoIndexDisplayTitle,
  getRepoIndexPackageName,
  isRepoIndexPackageName,
  REPO_INDEX_KEEP_VERSIONS,
  toOciImageName,
  validateFilesSelectionName,
  type DateFormat,
} from './lib/naming';
import {
  createZipFromExtractedFiles,
  normalizeMemoryLimitError,
  summarizeArchiveEntries,
  type TarInputFile,
} from './lib/tar';

function formatFolderSummaryBadge(
  entries: ReadonlyArray<DesktopRootFolderFileEntry>,
  baseLabel: string
): string {
  const regularCount = entries.filter((e) => !e.isDirectory).length;
  const emptyDirCount = entries.filter((e) => e.isDirectory).length;
  if (regularCount === 0 && emptyDirCount === 0) {
    return `${baseLabel} (empty)`;
  }
  if (regularCount === 0) {
    return `${baseLabel} (${emptyDirCount} empty subfolder${
      emptyDirCount === 1 ? '' : 's'
    })`;
  }
  if (emptyDirCount > 0) {
    return `${baseLabel} (${regularCount} file${
      regularCount === 1 ? '' : 's'
    }, ${emptyDirCount} empty subfolder${emptyDirCount === 1 ? '' : 's'})`;
  }
  return `${baseLabel} (${regularCount} file${regularCount === 1 ? '' : 's'})`;
}

function formatExtractionNoticeText(
  regularFileCount: number,
  emptyFolderCount: number,
  displayLabel: string,
  outputPath?: string
): string {
  const destSuffix = outputPath ? ` to ${outputPath}` : '';
  if (regularFileCount > 0 && emptyFolderCount > 0) {
    return `Extracted ${regularFileCount} file(s) and ${emptyFolderCount} empty folder(s) from "${displayLabel}"${destSuffix}`;
  }
  if (regularFileCount === 0) {
    if (emptyFolderCount > 0) {
      return `Extracted ${emptyFolderCount} empty folder(s) from "${displayLabel}"${destSuffix}`;
    }
    return `Extracted empty folder from "${displayLabel}"${destSuffix}`;
  }
  return `Extracted ${regularFileCount} file(s) from "${displayLabel}"${destSuffix}`;
}

interface SyncItemStatus {
  state: 'idle' | 'uploading' | 'done' | 'skipped' | 'error';
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

const VALID_DATE_FORMATS: ReadonlyArray<DateFormat> = [
  'YYYY-MM-DD',
  'YY-MM-DD',
  'DD-MM-YYYY',
  'DD-MM-YY',
];

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
          clockFormat: parsed.clockFormat === '12h' ? '12h' : '24h',
          dateFormat: VALID_DATE_FORMATS.includes(parsed.dateFormat)
            ? parsed.dateFormat
            : 'YYYY-MM-DD',
        };
      }
    } catch {
      // ignore
    }
    return {
      darkTheme: 'default',
      lightTheme: 'default',
      clockFormat: '24h',
      dateFormat: 'YYYY-MM-DD',
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
  const [oauthScopes, setOauthScopes] = useState<string[] | null>(null);
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
  const [uploadProgress, setUploadProgress] = useState<PushProgressUpdate | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<OciPackageDetails | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadFolderInputRef = useRef<HTMLInputElement | null>(null);
  const fileDragCounter = useRef<number>(0);
  const [isDraggingFiles, setIsDraggingFiles] = useState<boolean>(false);
  const [showUploadPickerPrompt, setShowUploadPickerPrompt] = useState<boolean>(false);
  const [showUploadVersionModal, setShowUploadVersionModal] = useState<boolean>(false);
  const [modalLookupLoading, setModalLookupLoading] = useState<boolean>(false);
  const [modalLookupError, setModalLookupError] = useState<string | null>(null);
  const [modalLivePkg, setModalLivePkg] = useState<GitHubPackageItem | null>(null);
  const [modalExistingVersions, setModalExistingVersions] = useState<GitHubPackageVersion[]>([]);
  const modalLookupSeqRef = useRef<number>(0);

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
  const fallbackFolderInputRef = useRef<HTMLInputElement | null>(null);
  const fallbackFileMapRef = useRef<Map<string, File>>(new Map());
  const [showSyncReviewModal, setShowSyncReviewModal] = useState<boolean>(false);
  const [syncReviewSelectedItems, setSyncReviewSelectedItems] = useState<
    SyncRootSelectedItem[]
  >([]);
  const [syncLookupLoading, setSyncLookupLoading] = useState<boolean>(false);
  const [syncLookupDoneCount, setSyncLookupDoneCount] = useState<number>(0);
  const [syncLookupTotalCount, setSyncLookupTotalCount] = useState<number>(0);
  const [syncLookupError, setSyncLookupError] = useState<string | null>(null);
  const [syncLiveStatesByIndex, setSyncLiveStatesByIndex] = useState<
    Record<number, LivePackageState>
  >({});
  const syncLookupSeqRef = useRef<number>(0);
  const [syncOverallProgress, setSyncOverallProgress] = useState<{
    current: number;
    total: number;
    message: string;
    percent: number;
  } | null>(null);
  const [syncModalError, setSyncModalError] = useState<string | null>(null);
  const [syncBatchSummary, setSyncBatchSummary] = useState<{
    syncedCount: number;
    skippedCount: number;
    replacedCount: number;
  } | null>(null);

  // --- TAB 3: Repo Packages state (Digest-keyed versions) ---
  const [repoPackages, setRepoPackages] = useState<GitHubPackageItem[]>([]);
  const [otherPackages, setOtherPackages] = useState<GitHubPackageItem[]>([]);
  const [showOtherPackages, setShowOtherPackages] = useState<boolean>(false);
  const [packageSearch, setPackageSearch] = useState<string>('');
  const [packageVersionsMap, setPackageVersionsMap] = useState<
    Record<string, GitHubPackageVersion[]>
  >({});
  const [expandedVersionKeys, setExpandedVersionKeys] = useState<Set<string>>(new Set());
  const [packagesLoading, setPackagesLoading] = useState<boolean>(false);
  const [packagesError, setPackagesError] = useState<string | null>(null);
  const [inspectedByKey, setInspectedByKey] = useState<Record<string, OciPackageDetails>>({});
  const inspectedByKeyRef = useRef<Record<string, OciPackageDetails>>({});
  inspectedByKeyRef.current = inspectedByKey;
  const [indexingKeys, setIndexingKeys] = useState<Set<string>>(new Set());
  const [inspectingKey, setInspectingKey] = useState<string | null>(null);
  const [inspectProgress, setInspectProgress] = useState<number>(0);
  const inspectAbortRef = useRef<AbortController | null>(null);
  const refreshSeqRef = useRef<number>(0);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<{
    message: string;
    percent: number;
  } | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const syncAbortRef = useRef<AbortController | null>(null);
  const downloadAbortRef = useRef<AbortController | null>(null);
  const [deletingPkgName, setDeletingPkgName] = useState<string | null>(null);
  const [deletingVersionKey, setDeletingVersionKey] = useState<string | null>(null);
  const [confirmDeletePkg, setConfirmDeletePkg] = useState<GitHubPackageItem | null>(null);
  const [confirmDeleteVersion, setConfirmDeleteVersion] = useState<{
    pkg: GitHubPackageItem;
    version: GitHubPackageVersion;
  } | null>(null);
  const [extractConflict, setExtractConflict] = useState<{
    pkg: GitHubPackageItem;
    version: GitHubPackageVersion;
    vKey: string;
    displayLabel: string;
    details: OciPackageDetails;
    parentDir: string;
    folderName: string;
    suggestedName: string;
  } | null>(null);

  type InlineNotice = { type: 'success' | 'warning' | 'error'; text: string };
  const [repoIndexPkg, setRepoIndexPkg] = useState<GitHubPackageItem | null>(null);
  const [repoIndexVersions, setRepoIndexVersions] = useState<GitHubPackageVersion[]>([]);
  const [repoIndexEntries, setRepoIndexEntries] = useState<
    Record<string, RepoIndexVersionRecord>
  >({});
  const repoIndexEntriesRef = useRef<Record<string, RepoIndexVersionRecord>>({});
  repoIndexEntriesRef.current = repoIndexEntries;
  const repoIndexLoadedForRepoIdRef = useRef<number | null>(null);
  const repoIndexLoadPromiseRef = useRef<{
    repoId: number;
    promise: Promise<Record<string, RepoIndexVersionRecord>>;
  } | null>(null);
  const repoIndexWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [repoIndexUpdating, setRepoIndexUpdating] = useState<boolean>(false);
  const [repoIndexNotice, setRepoIndexNotice] = useState<InlineNotice | null>(null);

  const [deletedPkgTombstones, setDeletedPkgTombstones] = useState<
    Record<
      string,
      {
        pkg: GitHubPackageItem;
        index: number;
        isOther: boolean;
        message: string;
      }
    >
  >({});
  const [pkgNotices, setPkgNotices] = useState<Record<string, InlineNotice>>({});
  const [versionNotices, setVersionNotices] = useState<Record<string, InlineNotice>>({});

  // Lock background page scroll whenever any modal is open
  const isAnyModalOpen =
    showSettingsModal ||
    showHelpModal ||
    showAboutModal ||
    showUploadPickerPrompt ||
    showUploadVersionModal ||
    showSyncReviewModal ||
    Boolean(extractConflict) ||
    Boolean(confirmDeletePkg) ||
    Boolean(confirmDeleteVersion);
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

  useEffect(() => {
    if (!confirmDeletePkg && !confirmDeleteVersion && !extractConflict) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setConfirmDeletePkg(null);
        setConfirmDeleteVersion(null);
        setExtractConflict(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [confirmDeletePkg, confirmDeleteVersion, extractConflict]);
  const [copiedText, setCopiedText] = useState<string | null>(null);

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
      const { user: ghUser, oauthScopes: reportedScopes } = await fetchGitHubAuthInfo(clean);
      setUser(ghUser);
      setOauthScopes(reportedScopes);
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
      setOauthScopes(null);
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
    setOauthScopes(null);
    setAuthToken('');
    setTokenInput('');
    setDeviceFlowInfo(null);
    setDevicePolling(false);
    setRepos([]);
    setSelectedRepo(null);
    setRepoPackages([]);
    setOtherPackages([]);
    setPackageVersionsMap({});
    setInspectedByKey({});
    setIndexingKeys(new Set());
    setExpandedVersionKeys(new Set());
    setShowUploadVersionModal(false);
    setShowSyncReviewModal(false);
    setSyncBatchSummary(null);
    setConfirmDeletePkg(null);
    setConfirmDeleteVersion(null);
    setExtractConflict(null);
    setDeletedPkgTombstones({});
    setPkgNotices({});
    setVersionNotices({});
    setRepoIndexPkg(null);
    setRepoIndexVersions([]);
    setRepoIndexEntries({});
    setRepoIndexNotice(null);
    repoIndexLoadedForRepoIdRef.current = null;
    repoIndexLoadPromiseRef.current = null;
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
      downloadAbortRef.current?.abort();
      setExpandedVersionKeys(new Set());
      setConfirmDeletePkg(null);
      setConfirmDeleteVersion(null);
      setExtractConflict(null);
      setRepoIndexPkg(null);
      setRepoIndexVersions([]);
      setRepoIndexEntries({});
      setRepoIndexNotice(null);
      repoIndexLoadedForRepoIdRef.current = null;
      repoIndexLoadPromiseRef.current = null;
      localStorage.setItem(STORAGE_REPO_KEY, String(selectedRepo.id));
      refreshPackages({ clearTransientNotices: true });
    }
  }, [selectedRepo, authToken, user]);

  useEffect(() => {
    if (activeTab === 'packages' && selectedRepo && authToken && user) {
      setExpandedVersionKeys(new Set());
      refreshPackages({ clearTransientNotices: true });
    }
  }, [activeTab]);

  function applyIndexEntriesToInspectedMap(
    rawMap: Record<string, RepoIndexVersionRecord>,
    liveVKeys?: Set<string>
  ) {
    const nextInspected: Record<string, OciPackageDetails> = {};
    for (const [k, rec] of Object.entries(rawMap)) {
      if (liveVKeys && !liveVKeys.has(k)) continue;
      nextInspected[k] = indexRecordToOciDetails(rec, '');
    }
    if (Object.keys(nextInspected).length === 0) return;
    setInspectedByKey((prev) => {
      const merged = { ...prev };
      for (const [k, det] of Object.entries(nextInspected)) {
        const existing = merged[k];
        if (!existing || existing.needsManualLoad || existing.files.length === 0) {
          merged[k] = det;
        }
      }
      return merged;
    });
  }

  async function ensureRepoIndexLoaded(
    repo: GitHubRepo,
    preloaded?: {
      pkg: GitHubPackageItem | null;
      versions: GitHubPackageVersion[];
      liveVKeys?: Set<string>;
    }
  ): Promise<Record<string, RepoIndexVersionRecord>> {
    if (!user || !authToken) return {};
    if (!preloaded && repoIndexLoadedForRepoIdRef.current === repo.id) {
      return repoIndexEntriesRef.current;
    }
    if (
      !preloaded &&
      repoIndexLoadPromiseRef.current &&
      repoIndexLoadPromiseRef.current.repoId === repo.id
    ) {
      return await repoIndexLoadPromiseRef.current.promise;
    }

    const runLoad = async (): Promise<Record<string, RepoIndexVersionRecord>> => {
      try {
        const ociIndexPkgName = getRepoIndexPackageName(repo.name);
        let idxPkg = preloaded?.pkg ?? null;
        let idxVersions = preloaded?.versions ?? [];

        if (!preloaded) {
          const live = await fetchLivePackageState({
            githubToken: authToken,
            currentUserLogin: user.login,
            owner: repo.owner.login,
            ownerType: repo.owner.type,
            packageName: ociIndexPkgName,
          });
          idxPkg = live.packageItem;
          idxVersions = live.versions;
        }

        const sortedIdxVersions = sortPackageVersionsNewestFirst(idxVersions);
        setRepoIndexPkg(idxPkg);
        setRepoIndexVersions(sortedIdxVersions);

        if (!idxPkg || sortedIdxVersions.length === 0) {
          setRepoIndexEntries({});
          repoIndexLoadedForRepoIdRef.current = repo.id;
          return {};
        }

        const fetched = await fetchLatestRepoIndex({
          username: user.login,
          githubToken: authToken,
          owner: idxPkg.owner.login,
          packageName: idxPkg.name,
          versions: sortedIdxVersions,
        });

        if (fetched.latestVersion && fetched.indexDetails) {
          const idxVKey = makeVersionStateKey(idxPkg.name, fetched.latestVersion.name);
          setInspectedByKey((prev) => ({
            ...prev,
            [idxVKey]: fetched.indexDetails!,
          }));
        }

        const rawMap = fetched.payload?.versions || {};
        applyIndexEntriesToInspectedMap(rawMap, preloaded?.liveVKeys);
        setRepoIndexEntries(rawMap);
        repoIndexLoadedForRepoIdRef.current = repo.id;
        return rawMap;
      } catch (err: unknown) {
        setRepoIndexNotice({
          type: 'warning',
          text: `Failed to load repository index: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
        return repoIndexEntriesRef.current;
      } finally {
        if (repoIndexLoadPromiseRef.current?.repoId === repo.id) {
          repoIndexLoadPromiseRef.current = null;
        }
      }
    };

    const promise = runLoad();
    repoIndexLoadPromiseRef.current = { repoId: repo.id, promise };
    return await promise;
  }

  function enqueueRepoIndexMutation(opts: {
    repo: GitHubRepo;
    addOrUpdate?: Array<{
      pkgName: string;
      manifestDigest: string;
      details: OciPackageDetails;
    }>;
    removeKeys?: string[];
    removePkgNames?: string[];
  }): Promise<void> {
    const task = repoIndexWriteQueueRef.current.then(async () => {
      if (!user || !authToken) return;
      setRepoIndexUpdating(true);
      setRepoIndexNotice(null);
      try {
        const baseEntries = {
          ...(await ensureRepoIndexLoaded(opts.repo)),
        };

        const rmPkgSet = new Set(
          (opts.removePkgNames || []).map((n) => n.toLowerCase())
        );
        if (rmPkgSet.size > 0) {
          for (const [k, rec] of Object.entries(baseEntries)) {
            if (rmPkgSet.has(rec.packageName.toLowerCase())) {
              delete baseEntries[k];
            }
          }
        }

        for (const rk of opts.removeKeys || []) {
          delete baseEntries[rk];
        }

        for (const item of opts.addOrUpdate || []) {
          if (isRepoIndexPackageName(item.pkgName) || !item.manifestDigest) continue;
          const vKey = makeVersionStateKey(item.pkgName, item.manifestDigest);
          baseEntries[vKey] = ociDetailsToIndexRecord(
            item.pkgName,
            item.manifestDigest,
            item.details
          );
        }

        const payload: RepoIndexPayload = {
          schemaVersion: 1,
          repoFullName: opts.repo.full_name,
          updatedAt: new Date().toISOString(),
          versions: baseEntries,
        };

        const canDelete =
          oauthScopes === null || oauthScopes.includes('delete:packages');

        const pushed = await publishRepoIndexSnapshot({
          username: user.login,
          githubToken: authToken,
          currentUserLogin: user.login,
          repo: opts.repo,
          payload,
          clockFormat: settings.clockFormat,
          dateFormat: settings.dateFormat,
          canDeletePackages: canDelete,
        });

        setRepoIndexEntries(baseEntries);
        repoIndexLoadedForRepoIdRef.current = opts.repo.id;
        if (pushed.indexPackage) {
          setRepoIndexPkg(pushed.indexPackage);
          setRepoIndexVersions(pushed.versions);
          if (pushed.indexDetails.manifestDigest) {
            const idxKey = makeVersionStateKey(
              pushed.indexPackage.name,
              pushed.indexDetails.manifestDigest
            );
            setInspectedByKey((prev) => ({
              ...prev,
              [idxKey]: pushed.indexDetails,
            }));
          }
        }
      } catch (err: unknown) {
        setRepoIndexNotice({
          type: 'warning',
          text: `Failed to update repository index: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      } finally {
        setRepoIndexUpdating(false);
      }
    });

    repoIndexWriteQueueRef.current = task.catch(() => {});
    return task;
  }

  /**
   * Fetches manifest summaries (requiring Load Files on unindexed layers) for versions not already
   * populated from GHCR Manager Index.
   */
  async function indexVersionList(
    pkgName: string,
    ownerLogin: string,
    versions: GitHubPackageVersion[],
    knownIndexEntries?: Record<string, RepoIndexVersionRecord>
  ) {
    if (!user || !authToken || versions.length === 0) return;

    let indexMap = knownIndexEntries;
    if (
      !indexMap &&
      selectedRepo &&
      repoIndexLoadedForRepoIdRef.current !== selectedRepo.id &&
      !isRepoIndexPackageName(pkgName)
    ) {
      indexMap = await ensureRepoIndexLoaded(selectedRepo);
    }

    const toFetch = versions.filter((v) => {
      const vKey = makeVersionStateKey(pkgName, v.name);
      const existing = inspectedByKeyRef.current[vKey];
      if (existing) return false;
      if (indexMap && indexMap[vKey]) return false;
      return true;
    });
    if (toFetch.length === 0) return;

    setIndexingKeys((prev) => {
      const next = new Set(prev);
      for (const v of toFetch) {
        next.add(makeVersionStateKey(pkgName, v.name));
      }
      return next;
    });

    for (const v of toFetch) {
      const vKey = makeVersionStateKey(pkgName, v.name);
      const info = getVersionReferenceInfo(v);
      inspectPackageManifest({
        username: user.login,
        githubToken: authToken,
        owner: ownerLogin,
        packageName: pkgName,
        tag: info.primaryTag || info.shortDigest,
        reference: info.inspectRef,
        forceLoadLayer: false,
      })
        .then((details) => {
          setInspectedByKey((prev) => ({
            ...prev,
            [vKey]: details,
          }));
        })
        .catch(() => {
          // ignore individual manifest background fetch errors
        })
        .finally(() => {
          setIndexingKeys((prev) => {
            const next = new Set(prev);
            next.delete(vKey);
            return next;
          });
        });
    }
  }

  async function refreshPackages(opts?: { clearTransientNotices?: boolean }) {
    if (!selectedRepo || !authToken || !user) return;
    if (opts?.clearTransientNotices) {
      setDeletedPkgTombstones({});
      setPkgNotices({});
      setVersionNotices({});
    }
    const seq = ++refreshSeqRef.current;
    setPackagesLoading(true);
    setPackagesError(null);
    try {
      const { repoPackages: rawLinked, otherOwnerPackages: rawOthers } =
        await listPackagesForRepo(authToken, user.login, selectedRepo);
      if (refreshSeqRef.current !== seq) return;

      const expectedIdxPkgName = getRepoIndexPackageName(
        selectedRepo.name
      ).toLowerCase();
      let matchedIndexPkg =
        rawLinked.find((p) => p.name.toLowerCase() === expectedIdxPkgName) ||
        rawOthers.find((p) => p.name.toLowerCase() === expectedIdxPkgName) ||
        null;
      let directIdxVersions: GitHubPackageVersion[] | null = null;

      if (!matchedIndexPkg) {
        const directIdx = await fetchLivePackageState({
          githubToken: authToken,
          currentUserLogin: user.login,
          owner: selectedRepo.owner.login,
          ownerType: selectedRepo.owner.type,
          packageName: expectedIdxPkgName,
        }).catch(() => null);
        if (refreshSeqRef.current !== seq) return;
        if (directIdx?.exists && directIdx.packageItem) {
          matchedIndexPkg = directIdx.packageItem;
          directIdxVersions = directIdx.versions;
        }
      }

      const linked = rawLinked.filter((p) => !isRepoIndexPackageName(p.name));
      const others = rawOthers.filter((p) => !isRepoIndexPackageName(p.name));
      setRepoPackages(linked);
      setOtherPackages(others);

      let indexVersions: GitHubPackageVersion[] = directIdxVersions || [];
      const fetchedVersionsByPkg: Record<string, GitHubPackageVersion[]> = {};
      const liveLinkedVKeys = new Set<string>();
      const succeededLinkedPkgNames = new Set<string>();

      const fetchList: GitHubPackageItem[] = [
        ...(matchedIndexPkg && directIdxVersions === null ? [matchedIndexPkg] : []),
        ...linked,
        ...others,
      ];
      const linkedNameSet = new Set(linked.map((p) => p.name.toLowerCase()));

      await Promise.all(
        fetchList.map(async (pkg) => {
          const isIdx =
            matchedIndexPkg && pkg.name.toLowerCase() === matchedIndexPkg.name.toLowerCase();
          try {
            const versions = await listPackageVersions({
              githubToken: authToken,
              currentUserLogin: user.login,
              owner: pkg.owner.login,
              ownerType: pkg.owner.type,
              packageName: pkg.name,
            });
            if (refreshSeqRef.current !== seq) return;
            if (isIdx) {
              indexVersions = versions;
            } else {
              const lowerName = pkg.name.toLowerCase();
              fetchedVersionsByPkg[lowerName] = versions;
              if (linkedNameSet.has(lowerName)) {
                succeededLinkedPkgNames.add(lowerName);
                for (const v of versions) {
                  liveLinkedVKeys.add(makeVersionStateKey(pkg.name, v.name));
                }
              }
              setPackageVersionsMap((prev) => ({
                ...prev,
                [lowerName]: versions,
              }));
            }
          } catch {
            // Leave out of succeededLinkedPkgNames so transient errors don't prune index entries
          }
        })
      );

      if (refreshSeqRef.current !== seq) return;

      // Verify any package in the loaded index that didn't appear in /user/packages yet
      const currentIndexMap = await ensureRepoIndexLoaded(selectedRepo, {
        pkg: matchedIndexPkg,
        versions: indexVersions,
      });

      if (refreshSeqRef.current !== seq) return;

      const missingFromListPkgNames = Array.from(
        new Set(
          Object.values(currentIndexMap)
            .map((rec) => rec.packageName.toLowerCase())
            .filter(
              (pkgLower) =>
                !linkedNameSet.has(pkgLower) &&
                !deletedPkgTombstones[pkgLower] &&
                !isRepoIndexPackageName(pkgLower)
            )
        )
      );

      if (missingFromListPkgNames.length > 0) {
        const directChecked = await Promise.all(
          missingFromListPkgNames.map(async (pkgLower) => {
            const live = await fetchLivePackageState({
              githubToken: authToken,
              currentUserLogin: user.login,
              owner: selectedRepo.owner.login,
              ownerType: selectedRepo.owner.type,
              packageName: pkgLower,
            }).catch(() => null);
            return { pkgLower, live };
          })
        );
        if (refreshSeqRef.current !== seq) return;

        for (const { pkgLower, live } of directChecked) {
          if (!live) continue;
          succeededLinkedPkgNames.add(pkgLower);
          if (live.exists && live.packageItem) {
            if (live.versions.length > 0) {
              linked.push(live.packageItem);
              linkedNameSet.add(pkgLower);
              fetchedVersionsByPkg[pkgLower] = live.versions;
              for (const v of live.versions) {
                liveLinkedVKeys.add(makeVersionStateKey(pkgLower, v.name));
              }
              setPackageVersionsMap((prev) => ({
                ...prev,
                [pkgLower]: live.versions,
              }));
            }
          }
        }
        setRepoPackages([...linked]);
      }

      const staleKeys = Object.entries(currentIndexMap)
        .filter(([k, rec]) => {
          const pkgLower = rec.packageName.toLowerCase();
          return succeededLinkedPkgNames.has(pkgLower) && !liveLinkedVKeys.has(k);
        })
        .map(([k]) => k);

      if (staleKeys.length > 0 && matchedIndexPkg) {
        void enqueueRepoIndexMutation({
          repo: selectedRepo,
          removeKeys: staleKeys,
        });
      }

      for (const pkg of [...linked, ...others]) {
        const versions = fetchedVersionsByPkg[pkg.name.toLowerCase()];
        if (versions && versions.length > 0) {
          void indexVersionList(pkg.name, pkg.owner.login, versions, currentIndexMap);
        }
      }
    } catch (err: unknown) {
      if (refreshSeqRef.current === seq) {
        setPackagesError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (refreshSeqRef.current === seq) {
        setPackagesLoading(false);
      }
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
    setShowUploadPickerPrompt(false);
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

  function getNativeFilePath(file: File): string | undefined {
    return (
      window.electronAPI?.getPathForFile?.(file) ||
      (file as unknown as { path?: string }).path ||
      undefined
    );
  }

  function handleFilesAdded(newFiles: FileList | File[]) {
    setShowUploadPickerPrompt(false);
    const incomingFiles = Array.from(newFiles);
    if (incomingFiles.length === 0) return;

    const items: UploadSelectionItem[] = incomingFiles.map((f) => {
      const nativePath = getNativeFilePath(f);
      return {
        kind: 'file',
        name: f.name,
        fullPath: nativePath,
        size: f.size,
        mtime: Math.floor(f.lastModified / 1000),
        rawFile: nativePath ? undefined : f,
        files: [
          {
            fullPath: nativePath,
            relativePath: f.name,
            name: f.name,
            size: f.size,
            mtime: Math.floor(f.lastModified / 1000),
            rawFile: nativePath ? undefined : f,
          },
        ],
      };
    });

    handleUploadItemsAdded(items);
  }

  async function handlePickUploadFolders() {
    setShowUploadPickerPrompt(false);
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

        const nativePath = getNativeFilePath(file);
        totalSize += file.size;
        entries.push({
          fullPath: nativePath,
          relativePath: relInside,
          name: lastPart,
          size: file.size,
          mtime: Math.floor(file.lastModified / 1000),
          rawFile: nativePath ? undefined : file,
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

  async function runLivePackageCheckForModal(pkgName: string) {
    if (!selectedRepo || !user || !authToken || !pkgName) return;
    const seq = ++modalLookupSeqRef.current;
    setModalLookupLoading(true);
    setModalLookupError(null);
    setModalLivePkg(null);
    setModalExistingVersions([]);

    try {
      const liveState = await fetchLivePackageState({
        githubToken: authToken,
        currentUserLogin: user.login,
        owner: selectedRepo.owner.login,
        ownerType: selectedRepo.owner.type,
        packageName: pkgName,
      });
      if (modalLookupSeqRef.current !== seq) return;
      if (liveState.exists) {
        setModalLivePkg(liveState.packageItem);
        setModalExistingVersions(liveState.versions);
        indexVersionList(
          pkgName,
          liveState.packageItem?.owner.login || selectedRepo.owner.login,
          liveState.versions
        );
      }
    } catch (err: unknown) {
      if (modalLookupSeqRef.current === seq) {
        setModalLookupError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (modalLookupSeqRef.current === seq) {
        setModalLookupLoading(false);
      }
    }
  }

  function handleOpenUploadVersionModal() {
    if (!selectedRepo || !user || !authToken) return;
    if (!fileNamingValidation.valid) {
      setUploadError(fileNamingValidation.error || 'Invalid image name.');
      return;
    }
    setUploadError(null);
    setUploadSuccess(null);
    setShowUploadVersionModal(true);
    runLivePackageCheckForModal(fileNamingValidation.ociPackageName);
  }

  function handleCancelUpload() {
    uploadAbortRef.current?.abort();
  }

  async function handleExecuteVersionedUpload(opts: {
    tag: string;
    replaceVersions: GitHubPackageVersion[];
  }) {
    if (!selectedRepo || !user || !authToken) return;
    if (!fileNamingValidation.valid) {
      setUploadError(fileNamingValidation.error || 'Invalid image name.');
      return;
    }

    const abortCtrl = new AbortController();
    uploadAbortRef.current = abortCtrl;
    setUploadError(null);
    setUploadSuccess(null);

    try {
      const isSingleFolderOnly =
        pickedItems.length === 1 && pickedItems[0].kind === 'folder';

      const pendingEntries: Array<{
        relativePath: string;
        mtime?: number;
        size: number;
        fullPath?: string;
        rawFile?: File;
        isDirectory?: boolean;
        entry: DesktopRootFolderFileEntry;
      }> = [];

      for (const item of pickedItems) {
        if (item.kind === 'file') {
          const entry = item.files[0];
          pendingEntries.push({
            relativePath: item.name,
            mtime: item.mtime,
            size: item.size,
            fullPath: entry?.fullPath || item.fullPath,
            rawFile: item.rawFile,
            entry,
          });
        } else if (item.files.length === 0) {
          const dirRelPath = isSingleFolderOnly ? '.' : item.name;
          pendingEntries.push({
            relativePath: dirRelPath,
            mtime: item.mtime,
            size: 0,
            fullPath: item.fullPath,
            isDirectory: true,
            entry: {
              fullPath: item.fullPath,
              relativePath: dirRelPath,
              name: item.name,
              size: 0,
              mtime: item.mtime,
              isDirectory: true,
            },
          });
        } else {
          for (const entry of item.files) {
            const archivePath = isSingleFolderOnly
              ? entry.relativePath
              : `${item.name}/${entry.relativePath}`;
            pendingEntries.push({
              relativePath: archivePath,
              mtime: entry.mtime,
              size: entry.isDirectory ? 0 : entry.size,
              fullPath: entry.fullPath,
              rawFile: entry.rawFile,
              isDirectory: Boolean(entry.isDirectory),
              entry,
            });
          }
        }
      }

      const canStreamDesktop =
        Boolean(window.electronAPI?.buildOciLayerFile) &&
        Boolean(window.electronAPI?.uploadBlobFromFile) &&
        pendingEntries.length > 0 &&
        pendingEntries.every((p) => Boolean(p.fullPath) || Boolean(p.isDirectory));

      let tarInputs: TarInputFile[] | undefined;
      let desktopFiles: DesktopStreamingInputFile[] | undefined;

      if (canStreamDesktop) {
        desktopFiles = pendingEntries.map((p) => ({
          fullPath: p.fullPath || '',
          relativePath: p.relativePath,
          size: p.isDirectory ? 0 : p.size,
          mtime: p.mtime,
          ...(p.isDirectory ? { isDirectory: true } : {}),
        }));
      } else {
        tarInputs = [];
        try {
          for (const p of pendingEntries) {
            if (abortCtrl.signal.aborted) {
              throw new DOMException('Upload cancelled', 'AbortError');
            }
            if (p.isDirectory) {
              tarInputs.push({
                relativePath: p.relativePath,
                data: new Uint8Array(0),
                mtime: p.mtime,
                isDirectory: true,
              });
              continue;
            }
            const bytes = p.rawFile
              ? new Uint8Array(await p.rawFile.arrayBuffer())
              : await readUploadEntryBytes(p.entry);
            tarInputs.push({
              relativePath: p.relativePath,
              data: bytes,
              mtime: p.mtime,
            });
          }
        } catch (err) {
          throw normalizeMemoryLimitError(err, 'upload');
        }
      }

      const details = await buildAndPushOciImage({
        username: user.login,
        githubToken: authToken,
        repo: selectedRepo,
        rawImageName: fileNamingValidation.effectiveRawName,
        tag: opts.tag,
        mode:
          pickedItems.length === 1 && pickedItems[0].kind === 'file'
            ? 'single-file'
            : 'multi-file',
        files: tarInputs,
        desktopFiles,
        signal: abortCtrl.signal,
        onProgress: (p) => setUploadProgress(p),
      });

      const pkgKey = details.packageName.toLowerCase();
      setDeletedPkgTombstones((prev) => {
        if (!prev[pkgKey]) return prev;
        const next = { ...prev };
        delete next[pkgKey];
        return next;
      });
      setPkgNotices((prev) => {
        if (!prev[pkgKey]) return prev;
        const next = { ...prev };
        delete next[pkgKey];
        return next;
      });

      if (details.manifestDigest) {
        const vKey = makeVersionStateKey(details.packageName, details.manifestDigest);
        setInspectedByKey((prev) => ({
          ...prev,
          [vKey]: details,
        }));
      }

      // Delete checked old versions ONLY after the new image push succeeded
      let deleteErrors: string[] = [];
      const deletedVersionKeys: string[] = [];
      if (opts.replaceVersions.length > 0) {
        const pkgOwnerLogin =
          modalLivePkg?.owner.login || selectedRepo.owner.login;
        const pkgOwnerType =
          modalLivePkg?.owner.type || selectedRepo.owner.type;

        setUploadProgress({
          stage: 'publishing-manifest',
          message: `Removing ${opts.replaceVersions.length} replaced version(s)...`,
          percent: 96,
        });

        deleteErrors = await deleteReplacedVersions({
          githubToken: authToken,
          currentUserLogin: user.login,
          owner: pkgOwnerLogin,
          ownerType: pkgOwnerType,
          packageName: details.packageName,
          newManifestDigest: details.manifestDigest,
          targets: opts.replaceVersions,
          onDeleted: (ver) =>
            deletedVersionKeys.push(makeVersionStateKey(details.packageName, ver.name)),
        });
      }

      if (details.manifestDigest) {
        setUploadProgress({
          stage: 'publishing-manifest',
          message: 'Updating repository file index...',
          percent: 98,
        });
        await enqueueRepoIndexMutation({
          repo: selectedRepo,
          addOrUpdate: [
            {
              pkgName: details.packageName,
              manifestDigest: details.manifestDigest,
              details,
            },
          ],
          removeKeys: deletedVersionKeys,
        });
      }

      setUploadSuccess(details);
      if (deleteErrors.length > 0) {
        setUploadError(
          `Uploaded ${details.packageName}:${details.tag}, but failed to remove ${deleteErrors.length} old version(s): ${deleteErrors.join('; ')}`
        );
      }
      setPickedItems([]);
      setExpandedUploadFolders(new Set());
      setLoadingUploadFolders(new Set());
      setCustomImageName('');
      setShowUploadVersionModal(false);
      await refreshPackages();
    } catch (err: unknown) {
      if (isAbortError(err)) {
        setUploadError('Upload cancelled.');
      } else {
        setUploadError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (uploadAbortRef.current === abortCtrl) {
        uploadAbortRef.current = null;
      }
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
    setSyncBatchSummary(null);
    setShowSyncReviewModal(false);
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
    setSyncBatchSummary(null);
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
    if (item.kind === 'root-subfolder' && item.files.length === 0) {
      return [
        {
          relativePath: '.',
          data: new Uint8Array(0),
          mtime: item.mtime,
          isDirectory: true,
        },
      ];
    }

    const result: TarInputFile[] = [];
    for (const entry of item.files) {
      if (entry.isDirectory) {
        result.push({
          relativePath: entry.relativePath,
          data: new Uint8Array(0),
          mtime: entry.mtime,
          isDirectory: true,
        });
        continue;
      }

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

  async function runLiveLookupForSyncModal(itemsList: SyncRootSelectedItem[]) {
    if (!selectedRepo || !user || !authToken || itemsList.length === 0) return;
    const seq = ++syncLookupSeqRef.current;
    setSyncLookupLoading(true);
    setSyncLookupError(null);
    setSyncLiveStatesByIndex({});
    setSyncLookupDoneCount(0);

    // Deduplicate normalized package names before querying GitHub API
    const uniquePkgNames = Array.from(new Set(itemsList.map((entry) => entry.ociName)));
    setSyncLookupTotalCount(uniquePkgNames.length);

    try {
      const statesByPkgName: Record<string, LivePackageState> = {};
      await mapWithConcurrency(uniquePkgNames, 4, async (pkgName) => {
        if (syncLookupSeqRef.current !== seq) return;
        const liveState = await fetchLivePackageState({
          githubToken: authToken,
          currentUserLogin: user.login,
          owner: selectedRepo.owner.login,
          ownerType: selectedRepo.owner.type,
          packageName: pkgName,
        });
        if (syncLookupSeqRef.current !== seq) return;
        statesByPkgName[pkgName] = liveState;
        setSyncLookupDoneCount((prev) => prev + 1);
        if (liveState.exists && liveState.versions.length > 0) {
          indexVersionList(
            pkgName,
            liveState.packageItem?.owner.login || selectedRepo.owner.login,
            liveState.versions
          );
        }
      });

      if (syncLookupSeqRef.current !== seq) return;
      const byIndex: Record<number, LivePackageState> = {};
      for (const entry of itemsList) {
        if (statesByPkgName[entry.ociName]) {
          byIndex[entry.idx] = statesByPkgName[entry.ociName];
        }
      }
      setSyncLiveStatesByIndex(byIndex);
    } catch (err: unknown) {
      if (syncLookupSeqRef.current === seq) {
        setSyncLookupError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (syncLookupSeqRef.current === seq) {
        setSyncLookupLoading(false);
      }
    }
  }

  function handleOpenSyncReviewModal() {
    if (!rootScan || !selectedRepo || !user || !authToken) return;
    const indicesToSync = Array.from(selectedSyncIndices).sort((a, b) => a - b);
    if (indicesToSync.length === 0) {
      setSyncError('Please select at least one item in the root folder to sync.');
      return;
    }

    const itemsList: SyncRootSelectedItem[] = [];
    for (const idx of indicesToSync) {
      const item = rootScan.items[idx];
      if (!item) continue;
      itemsList.push({
        idx,
        item,
        ociName: toOciImageName(item.name),
      });
    }

    if (itemsList.length === 0) return;
    setSyncError(null);
    setSyncModalError(null);
    setSyncBatchSummary(null);
    setSyncReviewSelectedItems(itemsList);
    setShowSyncReviewModal(true);
    runLiveLookupForSyncModal(itemsList);
  }

  function handleCancelSync() {
    syncAbortRef.current?.abort();
  }

  async function handleExecuteBatchSync(plans: SyncBatchItemPlan[]) {
    if (!selectedRepo || !user || !authToken) return;
    const activePlans = plans.filter((p) => p.action !== 'skip');
    if (activePlans.length === 0) return;

    const abortCtrl = new AbortController();
    syncAbortRef.current = abortCtrl;
    setIsSyncingFolder(true);
    setSyncError(null);
    setSyncModalError(null);
    setSyncBatchSummary(null);

    const initialStatuses: Record<number, SyncItemStatus> = {};
    for (const p of plans) {
      if (p.action === 'skip') {
        initialStatuses[p.idx] = { state: 'skipped', message: 'Skipped' };
      }
    }
    setSyncStatuses(initialStatuses);

    let syncedCount = 0;
    let totalReplacedCount = 0;
    let wasCancelled = false;
    const skippedCount = plans.length - activePlans.length;
    const batchErrors: string[] = [];
    const indexAddOrUpdate: Array<{
      pkgName: string;
      manifestDigest: string;
      details: OciPackageDetails;
    }> = [];
    const indexRemoveKeys: string[] = [];

    for (let i = 0; i < activePlans.length; i++) {
      if (abortCtrl.signal.aborted) {
        wasCancelled = true;
        break;
      }
      const plan = activePlans[i];
      const basePercent = Math.floor((i / activePlans.length) * 100);

      setSyncOverallProgress({
        current: i + 1,
        total: activePlans.length,
        message: `Reading files for ${plan.ociName}:${plan.tag}...`,
        percent: basePercent,
      });

      setSyncStatuses((prev) => ({
        ...prev,
        [plan.idx]: {
          state: 'uploading',
          message: 'Reading files...',
          percent: 5,
        },
      }));

      try {
        const isBareEmptyRootSubfolder =
          plan.item.kind === 'root-subfolder' && plan.item.files.length === 0;
        const canStreamDesktop =
          Boolean(window.electronAPI?.buildOciLayerFile) &&
          Boolean(window.electronAPI?.uploadBlobFromFile) &&
          (isBareEmptyRootSubfolder
            ? Boolean(plan.item.fullPath)
            : plan.item.files.length > 0 &&
              plan.item.files.every(
                (f) => Boolean(f.fullPath) || Boolean(f.isDirectory)
              ));

        let tarFiles: TarInputFile[] | undefined;
        let desktopFiles: DesktopStreamingInputFile[] | undefined;

        if (canStreamDesktop) {
          desktopFiles = isBareEmptyRootSubfolder
            ? [
                {
                  fullPath: plan.item.fullPath || '',
                  relativePath: '.',
                  size: 0,
                  mtime: plan.item.mtime,
                  isDirectory: true,
                },
              ]
            : plan.item.files.map((f) => ({
                fullPath: f.fullPath || '',
                relativePath: f.relativePath,
                size: f.isDirectory ? 0 : f.size,
                mtime: f.mtime,
                ...(f.isDirectory ? { isDirectory: true } : {}),
              }));
        } else {
          try {
            tarFiles = await readRootSyncItemFiles(plan.item);
          } catch (err) {
            throw normalizeMemoryLimitError(err, 'upload');
          }
        }

        const details = await buildAndPushOciImage({
          username: user.login,
          githubToken: authToken,
          repo: selectedRepo,
          rawImageName: plan.item.name,
          tag: plan.tag,
          mode: plan.item.kind,
          files: tarFiles,
          desktopFiles,
          signal: abortCtrl.signal,
          onProgress: (p) => {
            const overallPct = Math.min(
              99,
              Math.floor(((i + p.percent / 100) / activePlans.length) * 100)
            );
            setSyncOverallProgress({
              current: i + 1,
              total: activePlans.length,
              message: `${plan.ociName}:${plan.tag} - ${p.message}`,
              percent: overallPct,
            });
            setSyncStatuses((prev) => ({
              ...prev,
              [plan.idx]: {
                state: 'uploading',
                message: p.message,
                percent: p.percent,
              },
            }));
          },
        });

        const syncedPkgKey = details.packageName.toLowerCase();
        setDeletedPkgTombstones((prev) => {
          if (!prev[syncedPkgKey]) return prev;
          const next = { ...prev };
          delete next[syncedPkgKey];
          return next;
        });

        if (details.manifestDigest) {
          const vKey = makeVersionStateKey(details.packageName, details.manifestDigest);
          setInspectedByKey((prev) => ({
            ...prev,
            [vKey]: details,
          }));
          indexAddOrUpdate.push({
            pkgName: details.packageName,
            manifestDigest: details.manifestDigest,
            details,
          });
        }

        let deleteErrors: string[] = [];
        if (plan.replaceVersions.length > 0) {
          setSyncOverallProgress({
            current: i + 1,
            total: activePlans.length,
            message: `Removing ${plan.replaceVersions.length} old version(s) of ${plan.ociName}...`,
            percent: Math.min(
              99,
              Math.floor(((i + 0.96) / activePlans.length) * 100)
            ),
          });
          deleteErrors = await deleteReplacedVersions({
            githubToken: authToken,
            currentUserLogin: user.login,
            owner: plan.packageOwnerLogin,
            ownerType: plan.packageOwnerType,
            packageName: details.packageName,
            newManifestDigest: details.manifestDigest,
            targets: plan.replaceVersions,
            onDeleted: (ver) =>
              indexRemoveKeys.push(
                makeVersionStateKey(details.packageName, ver.name)
              ),
          });
          totalReplacedCount +=
            plan.replaceVersions.length - deleteErrors.length;
        }

        syncedCount += 1;

        if (deleteErrors.length > 0) {
          const msg = `Uploaded ${details.packageName}:${details.tag}, but failed to remove old version(s): ${deleteErrors.join('; ')}`;
          batchErrors.push(msg);
          setSyncStatuses((prev) => ({
            ...prev,
            [plan.idx]: { state: 'error', message: msg },
          }));
        } else {
          setSyncStatuses((prev) => ({
            ...prev,
            [plan.idx]: {
              state: 'done',
              message: `Uploaded ${details.packageName}:${details.tag}`,
              percent: 100,
            },
          }));
        }
      } catch (err: unknown) {
        if (isAbortError(err)) {
          wasCancelled = true;
          setSyncStatuses((prev) => ({
            ...prev,
            [plan.idx]: { state: 'error', message: 'Cancelled' },
          }));
          break;
        }
        const msg = err instanceof Error ? err.message : String(err);
        batchErrors.push(`${plan.ociName}: ${msg}`);
        setSyncStatuses((prev) => ({
          ...prev,
          [plan.idx]: { state: 'error', message: msg },
        }));
      }
    }

    if (indexAddOrUpdate.length > 0 || indexRemoveKeys.length > 0) {
      setSyncOverallProgress({
        current: activePlans.length,
        total: activePlans.length,
        message: 'Updating repository file index...',
        percent: 99,
      });
      await enqueueRepoIndexMutation({
        repo: selectedRepo,
        addOrUpdate: indexAddOrUpdate,
        removeKeys: indexRemoveKeys,
      });
    }

    if (syncAbortRef.current === abortCtrl) {
      syncAbortRef.current = null;
    }
    setSyncOverallProgress(null);
    setIsSyncingFolder(false);
    await refreshPackages();

    if (wasCancelled) {
      setSyncModalError(
        syncedCount > 0
          ? `Sync cancelled (${syncedCount} completed item(s) uploaded and indexed).`
          : 'Sync cancelled.'
      );
    } else if (batchErrors.length > 0) {
      setSyncModalError(batchErrors.join(' | '));
    } else {
      setShowSyncReviewModal(false);
      setSyncBatchSummary({
        syncedCount,
        skippedCount,
        replacedCount: totalReplacedCount,
      });
    }
  }

  // --- TAB 3 & MODAL: Version Inspect, Download, and Delete handlers ---
  function handleToggleVersionExpand(versionKey: string) {
    const next = new Set(expandedVersionKeys);
    if (next.has(versionKey)) {
      next.delete(versionKey);
    } else {
      next.add(versionKey);
    }
    setExpandedVersionKeys(next);
  }

  function handleCancelInspect() {
    if (inspectAbortRef.current) {
      inspectAbortRef.current.abort();
      inspectAbortRef.current = null;
    }
    setInspectingKey(null);
    setInspectProgress(0);
  }

  async function handleLoadVersionFiles(
    pkgName: string,
    ownerLogin: string,
    version: GitHubPackageVersion
  ) {
    if (!selectedRepo || !user || !authToken) return;
    if (inspectAbortRef.current) {
      inspectAbortRef.current.abort();
    }
    const vKey = makeVersionStateKey(pkgName, version.name);
    const info = getVersionReferenceInfo(version);
    const ac = new AbortController();
    inspectAbortRef.current = ac;
    setInspectingKey(vKey);
    setInspectProgress(0);
    setVersionNotices((prev) => {
      if (!prev[vKey]) return prev;
      const next = { ...prev };
      delete next[vKey];
      return next;
    });

    try {
      const details = await inspectPackageManifest({
        username: user.login,
        githubToken: authToken,
        owner: ownerLogin || selectedRepo.owner.login,
        packageName: pkgName,
        tag: info.primaryTag || info.shortDigest,
        reference: info.inspectRef,
        forceLoadLayer: true,
        onProgress: (pct) => setInspectProgress(pct),
        signal: ac.signal,
      });
      setInspectedByKey((prev) => ({
        ...prev,
        [vKey]: details,
      }));
      setExpandedVersionKeys((prev) => new Set(prev).add(vKey));

      const isOtherPkg = otherPackages.some(
        (p) => p.name.toLowerCase() === pkgName.toLowerCase()
      );
      if (!isRepoIndexPackageName(pkgName) && !isOtherPkg) {
        void enqueueRepoIndexMutation({
          repo: selectedRepo,
          addOrUpdate: [
            {
              pkgName,
              manifestDigest: details.manifestDigest || version.name,
              details,
            },
          ],
        });
      }
    } catch (err: unknown) {
      if (isAbortError(err)) {
        return;
      }
      setVersionNotices((prev) => ({
        ...prev,
        [vKey]: {
          type: 'error',
          text: err instanceof Error ? err.message : String(err),
        },
      }));
    } finally {
      if (inspectAbortRef.current === ac) {
        inspectAbortRef.current = null;
      }
      setInspectingKey(null);
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

  function handleCancelDownload() {
    downloadAbortRef.current?.abort();
  }

  async function runDesktopDownloadAndExtract(opts: {
    pkg: GitHubPackageItem;
    version: GitHubPackageVersion;
    vKey: string;
    displayLabel: string;
    details: OciPackageDetails;
    parentDir: string;
    folderName: string;
    replaceExisting: boolean;
  }) {
    if (!selectedRepo || !user || !authToken) return;
    const {
      pkg,
      version,
      vKey,
      displayLabel,
      details,
      parentDir,
      folderName,
      replaceExisting,
    } = opts;
    const info = getVersionReferenceInfo(version);
    const abortCtrl = new AbortController();
    downloadAbortRef.current = abortCtrl;
    setDownloadingKey(vKey);
    setDownloadProgress({ message: 'Preparing download...', percent: 1 });
    setVersionNotices((prev) => {
      const next = { ...prev };
      delete next[vKey];
      return next;
    });

    const wasUnindexed = Boolean(
      details.needsManualLoad || details.files.length === 0
    );

    try {
      const res = await downloadAndExtractPackageToDiskDesktop({
        username: user.login,
        githubToken: authToken,
        owner: pkg.owner.login,
        packageName: pkg.name,
        tag: info.primaryTag || info.shortDigest,
        reference: info.inspectRef,
        preloadedDetails: details,
        parentDir,
        folderName,
        replaceExisting,
        signal: abortCtrl.signal,
        onProgress: (p) => setDownloadProgress(p),
      });

      setInspectedByKey((prev) => ({
        ...prev,
        [vKey]: res.details,
      }));

      const isOtherPkg = otherPackages.some(
        (p) => p.name.toLowerCase() === pkg.name.toLowerCase()
      );
      if (
        res.saved &&
        wasUnindexed &&
        !isRepoIndexPackageName(pkg.name) &&
        !isOtherPkg
      ) {
        void enqueueRepoIndexMutation({
          repo: selectedRepo,
          addOrUpdate: [
            {
              pkgName: pkg.name,
              manifestDigest: res.details.manifestDigest || version.name,
              details: res.details,
            },
          ],
        });
      }

      if (res.saved) {
        setVersionNotices((prev) => ({
          ...prev,
          [vKey]: {
            type: 'success',
            text: formatExtractionNoticeText(
              res.fileCount,
              res.emptyFolderCount,
              displayLabel,
              res.outputPath
            ),
          },
        }));
      }
    } catch (err: unknown) {
      if (isAbortError(err)) {
        setVersionNotices((prev) => ({
          ...prev,
          [vKey]: {
            type: 'warning',
            text: 'Download cancelled.',
          },
        }));
      } else {
        const friendly = normalizeMemoryLimitError(err, 'download');
        setVersionNotices((prev) => ({
          ...prev,
          [vKey]: {
            type: 'error',
            text: friendly.message,
          },
        }));
      }
    } finally {
      if (downloadAbortRef.current === abortCtrl) {
        downloadAbortRef.current = null;
      }
      setDownloadingKey(null);
      setDownloadProgress(null);
    }
  }

  async function handleDownloadVersion(
    pkg: GitHubPackageItem,
    version: GitHubPackageVersion
  ) {
    if (!selectedRepo || !user || !authToken) return;
    const vKey = makeVersionStateKey(pkg.name, version.name);
    const info = getVersionReferenceInfo(version);
    const displayLabel = `${pkg.name}${info.pullSuffix}`;

    setVersionNotices((prev) => {
      const next = { ...prev };
      delete next[vKey];
      return next;
    });

    if (
      window.electronAPI?.prepareExtractDestination &&
      window.electronAPI?.downloadAndExtractLayer
    ) {
      setDownloadingKey(vKey);
      setDownloadProgress({ message: 'Fetching package metadata...', percent: 1 });
      try {
        const details =
          inspectedByKey[vKey] ||
          (await inspectPackageManifest({
            username: user.login,
            githubToken: authToken,
            owner: pkg.owner.login,
            packageName: pkg.name,
            tag: info.primaryTag || info.shortDigest,
            reference: info.inspectRef,
            skipLayerScan: true,
          }));

        if (!details.layerDigest) {
          throw new Error('Package manifest does not contain a downloadable layer.');
        }

        const prep = await window.electronAPI.prepareExtractDestination({
          defaultFolderName: details.originalName || pkg.name,
        });

        if (prep.canceled || !prep.parentDir || !prep.folderName) {
          setDownloadingKey(null);
          setDownloadProgress(null);
          return;
        }

        if (prep.exists && prep.suggestedName) {
          setDownloadingKey(null);
          setDownloadProgress(null);
          setExtractConflict({
            pkg,
            version,
            vKey,
            displayLabel,
            details,
            parentDir: prep.parentDir,
            folderName: prep.folderName,
            suggestedName: prep.suggestedName,
          });
          return;
        }

        await runDesktopDownloadAndExtract({
          pkg,
          version,
          vKey,
          displayLabel,
          details,
          parentDir: prep.parentDir,
          folderName: prep.folderName,
          replaceExisting: false,
        });
      } catch (err: unknown) {
        setDownloadingKey(null);
        setDownloadProgress(null);
        setVersionNotices((prev) => ({
          ...prev,
          [vKey]: {
            type: 'error',
            text: err instanceof Error ? err.message : String(err),
          },
        }));
      }
      return;
    }

    const abortCtrl = new AbortController();
    downloadAbortRef.current = abortCtrl;
    setDownloadingKey(vKey);
    setDownloadProgress(null);

    try {
      const prevDetails = inspectedByKeyRef.current[vKey];
      const wasUnindexed = Boolean(
        !prevDetails || prevDetails.needsManualLoad || prevDetails.files.length === 0
      );
      const { details, extractedFiles } = await downloadAndExtractPackage({
        username: user.login,
        githubToken: authToken,
        owner: pkg.owner.login,
        packageName: pkg.name,
        tag: info.primaryTag || info.shortDigest,
        reference: info.inspectRef,
        signal: abortCtrl.signal,
      });

      setInspectedByKey((prev) => ({
        ...prev,
        [vKey]: details,
      }));

      const isOtherPkg = otherPackages.some(
        (p) => p.name.toLowerCase() === pkg.name.toLowerCase()
      );
      if (wasUnindexed && !isRepoIndexPackageName(pkg.name) && !isOtherPkg) {
        void enqueueRepoIndexMutation({
          repo: selectedRepo,
          addOrUpdate: [
            {
              pkgName: pkg.name,
              manifestDigest: details.manifestDigest || version.name,
              details,
            },
          ],
        });
      }

      if (extractedFiles.length === 0) {
        throw new Error('No files or folders were found inside the image layer.');
      }

      const extractedSummary = summarizeArchiveEntries(
        extractedFiles.map((f) => ({
          path: f.relativePath,
          isDirectory: f.isDirectory,
        }))
      );

      if (window.electronAPI?.saveExtractedFiles) {
        const res = await window.electronAPI.saveExtractedFiles(
          details.originalName || pkg.name,
          extractedFiles
        );
        if (res.saved) {
          setVersionNotices((prev) => ({
            ...prev,
            [vKey]: {
              type: 'success',
              text: formatExtractionNoticeText(
                extractedSummary.regularFileCount,
                extractedSummary.emptyFolderCount,
                displayLabel,
                res.outputPath
              ),
            },
          }));
        }
        return;
      }

      if (extractedFiles.length === 1 && !extractedFiles[0].isDirectory) {
        const single = extractedFiles[0];
        const fileName = single.relativePath.split('/').pop() || pkg.name;
        triggerBrowserDownload(single.data, fileName);
        setVersionNotices((prev) => ({
          ...prev,
          [vKey]: {
            type: 'success',
            text: `Downloaded "${fileName}" (${formatBytes(single.data.byteLength)})`,
          },
        }));
      } else {
        const zipBytes = createZipFromExtractedFiles(extractedFiles);
        const zipName = `${details.originalName || pkg.name}.zip`;
        triggerBrowserDownload(zipBytes, zipName);
        setVersionNotices((prev) => ({
          ...prev,
          [vKey]: {
            type: 'success',
            text: `Downloaded ${extractedSummary.regularFileCount} file(s)${
              extractedSummary.emptyFolderCount > 0
                ? ` and ${extractedSummary.emptyFolderCount} empty folder(s)`
                : ''
            } from "${displayLabel}" as "${zipName}" (${formatBytes(
              zipBytes.byteLength
            )})`,
          },
        }));
      }
    } catch (err: unknown) {
      if (isAbortError(err)) {
        setVersionNotices((prev) => ({
          ...prev,
          [vKey]: {
            type: 'warning',
            text: 'Download cancelled.',
          },
        }));
      } else {
        const friendly = normalizeMemoryLimitError(err, 'download');
        setVersionNotices((prev) => ({
          ...prev,
          [vKey]: {
            type: 'error',
            text: friendly.message,
          },
        }));
      }
    } finally {
      if (downloadAbortRef.current === abortCtrl) {
        downloadAbortRef.current = null;
      }
      setDownloadingKey(null);
      setDownloadProgress(null);
    }
  }

  function recordDeletedPkgTombstone(pkg: GitHubPackageItem, message: string) {
    const pkgKey = pkg.name.toLowerCase();
    const repoIdx = repoPackages.findIndex((p) => p.name.toLowerCase() === pkgKey);
    const otherIdx = otherPackages.findIndex((p) => p.name.toLowerCase() === pkgKey);
    const isOther = repoIdx === -1 && otherIdx !== -1;
    const index = isOther ? otherIdx : Math.max(0, repoIdx);

    setDeletedPkgTombstones((prev) => ({
      ...prev,
      [pkgKey]: { pkg, index, isOther, message },
    }));
    setPkgNotices((prev) => {
      if (!prev[pkgKey]) return prev;
      const next = { ...prev };
      delete next[pkgKey];
      return next;
    });
  }

  function dismissDeletedTombstone(pkgName: string) {
    const pkgKey = pkgName.toLowerCase();
    setDeletedPkgTombstones((prev) => {
      const next = { ...prev };
      delete next[pkgKey];
      return next;
    });
    setRepoPackages((prev) => prev.filter((p) => p.name.toLowerCase() !== pkgKey));
    setOtherPackages((prev) => prev.filter((p) => p.name.toLowerCase() !== pkgKey));
  }

  function dismissPkgNotice(pkgKey: string) {
    setPkgNotices((prev) => {
      if (!prev[pkgKey]) return prev;
      const next = { ...prev };
      delete next[pkgKey];
      return next;
    });
  }

  function dismissVersionNotice(vKey: string) {
    setVersionNotices((prev) => {
      if (!prev[vKey]) return prev;
      const next = { ...prev };
      delete next[vKey];
      return next;
    });
  }

  function renderInlineNotice(
    notice: InlineNotice | undefined,
    onDismiss: () => void
  ) {
    if (!notice) return null;
    const bannerClass =
      notice.type === 'success'
        ? 'theme-success-banner'
        : notice.type === 'warning'
        ? 'theme-warning-banner'
        : 'theme-error-banner';
    const Icon = notice.type === 'success' ? CheckCircle2 : AlertCircle;

    return (
      <div
        className={`p-3 rounded-md text-xs flex items-center justify-between gap-2 ${bannerClass}`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Icon className="w-4 h-4 shrink-0" />
          <span className="break-words">{notice.text}</span>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="modal-close-btn p-1 shrink-0 cursor-pointer"
          title="Dismiss notice"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  }

  async function handleDeleteVersionConfirmed(target: {
    pkg: GitHubPackageItem;
    version: GitHubPackageVersion;
  }) {
    if (!selectedRepo || !user || !authToken) return;
    const { pkg, version } = target;
    const pkgKey = pkg.name.toLowerCase();
    const vKey = makeVersionStateKey(pkg.name, version.name);
    const info = getVersionReferenceInfo(version);
    const siblingVersions = packageVersionsMap[pkgKey] || [];

    setDeletingVersionKey(vKey);
    setConfirmDeleteVersion(null);
    setConfirmDeletePkg(null);
    setVersionNotices((prev) => {
      const next = { ...prev };
      delete next[vKey];
      return next;
    });

    const isOtherPkg = otherPackages.some(
      (p) => p.name.toLowerCase() === pkgKey
    );

    try {
      if (siblingVersions.length <= 1) {
        await deleteGitHubPackage({
          githubToken: authToken,
          currentUserLogin: user.login,
          owner: pkg.owner.login,
          ownerType: pkg.owner.type,
          packageName: pkg.name,
        });
        recordDeletedPkgTombstone(
          pkg,
          `Removed "${pkg.name}" (last remaining version deleted) from GitHub Packages.`
        );
        if (!isOtherPkg && !isRepoIndexPackageName(pkg.name)) {
          await enqueueRepoIndexMutation({
            repo: selectedRepo,
            removePkgNames: [pkg.name],
          });
        }
      } else {
        await deletePackageVersion({
          githubToken: authToken,
          currentUserLogin: user.login,
          owner: pkg.owner.login,
          ownerType: pkg.owner.type,
          packageName: pkg.name,
          versionId: version.id,
        });
        setPkgNotices((prev) => ({
          ...prev,
          [pkgKey]: {
            type: 'success',
            text: `Removed version "${pkg.name}${info.pullSuffix}" from GitHub Packages.`,
          },
        }));
        if (!isOtherPkg && !isRepoIndexPackageName(pkg.name)) {
          await enqueueRepoIndexMutation({
            repo: selectedRepo,
            removeKeys: [vKey],
          });
        }
      }
      await refreshPackages();
    } catch (err: unknown) {
      setVersionNotices((prev) => ({
        ...prev,
        [vKey]: {
          type: 'error',
          text: err instanceof Error ? err.message : String(err),
        },
      }));
    } finally {
      setDeletingVersionKey(null);
    }
  }

  async function handleDeletePackageConfirmed(pkg: GitHubPackageItem) {
    if (!selectedRepo || !user || !authToken) return;
    const pkgKey = pkg.name.toLowerCase();
    const isOtherPkg = otherPackages.some(
      (p) => p.name.toLowerCase() === pkgKey
    );
    setDeletingPkgName(pkg.name);
    setConfirmDeletePkg(null);
    try {
      await deleteGitHubPackage({
        githubToken: authToken,
        currentUserLogin: user.login,
        owner: pkg.owner.login,
        ownerType: pkg.owner.type,
        packageName: pkg.name,
      });
      recordDeletedPkgTombstone(
        pkg,
        `Removed package "${pkg.name}" from GitHub Packages.`
      );
      if (!isOtherPkg && !isRepoIndexPackageName(pkg.name)) {
        await enqueueRepoIndexMutation({
          repo: selectedRepo,
          removePkgNames: [pkg.name],
        });
      }
      await refreshPackages();
    } catch (err: unknown) {
      setPkgNotices((prev) => ({
        ...prev,
        [pkgKey]: {
          type: 'error',
          text: err instanceof Error ? err.message : String(err),
        },
      }));
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
                {/* ==================== TAB 1: UPLOAD FILES ==================== */}
                {activeTab === 'upload-files' && (
                  <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-6 shadow-md space-y-6">
                    <div>
                      <h3 className="text-base font-bold text-white flex items-center gap-2">
                        <FilePlus2 className="w-5 h-5 icon-upload" />
                        Upload Files as an Image
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
                          .map((f) => getNativeFilePath(f))
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
                                      if (nested.length === 0) {
                                        out.push({
                                          relativePath: relPath,
                                          name: child.name,
                                          size: 0,
                                          mtime: Math.floor(Date.now() / 1000),
                                          isDirectory: true,
                                        });
                                      } else {
                                        for (let k = 0; k < nested.length; k++) {
                                          out.push(nested[k]);
                                        }
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
                      onClick={(e) => {
                        if (isScanningUploadDrop) return;
                        if ((e.target as HTMLElement).closest('button')) return;
                        setShowUploadPickerPrompt(true);
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
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          setShowUploadPickerPrompt(false);
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
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          setShowUploadPickerPrompt(false);
                          handleUploadFallbackWebkitDirectory(e);
                        }}
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
                              : 'Click to choose files or folders, or drag & drop here'}
                          </div>
                          <div className="text-xs text-gray-500 mt-1 pointer-events-none">
                            Select one or multiple files or folders from your device
                          </div>
                          <div className="mt-3 flex items-center justify-center gap-2.5">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setShowUploadPickerPrompt(false);
                                fileInputRef.current?.click();
                              }}
                              className="btn-modal-action px-3 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                            >
                              <FileIcon className="w-3.5 h-3.5 icon-upload" />
                              Choose Files
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setShowUploadPickerPrompt(false);
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

                    {/* Upload Choice Modal (Triggered by Clicking Dropzone Area) — portaled to <body> so it covers the header too */}
                    {showUploadPickerPrompt && createPortal(
                      <div
                        className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
                        onClick={() => setShowUploadPickerPrompt(false)}
                      >
                        <div
                          className="bg-[#161b22] border border-[#30363d] rounded-xl p-6 max-w-sm w-full space-y-4 shadow-xl"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex items-center justify-between">
                            <h4 className="text-sm font-bold text-white flex items-center gap-2">
                              <Upload className="w-4 h-4 icon-upload" />
                              Choose from Device
                            </h4>
                            <button
                              type="button"
                              onClick={() => setShowUploadPickerPrompt(false)}
                              className="modal-close-btn p-1"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                          <p className="text-xs text-gray-400">
                            Select whether you want to choose individual files or a whole folder:
                          </p>
                          <div className="grid grid-cols-2 gap-3 pt-1">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setShowUploadPickerPrompt(false);
                                setTimeout(() => {
                                  fileInputRef.current?.click();
                                }, 20);
                              }}
                              className="btn-modal-action py-3 px-3 rounded-lg text-xs font-semibold flex flex-col items-center gap-2 cursor-pointer text-center"
                            >
                              <FileIcon className="w-6 h-6 icon-upload" />
                              <span>Choose Files</span>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setShowUploadPickerPrompt(false);
                                handlePickUploadFolders();
                              }}
                              className="btn-modal-action py-3 px-3 rounded-lg text-xs font-semibold flex flex-col items-center gap-2 cursor-pointer text-center"
                            >
                              <Folder className="w-6 h-6 icon-upload" />
                              <span>Choose Folder</span>
                            </button>
                          </div>
                        </div>
                      </div>,
                      document.body
                    )}

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
                                        {formatFolderSummaryBadge(item.files, 'Folder')}
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
                        <div>
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

                        {fileNamingValidation.valid ? (
                          <div className="flex flex-wrap items-center gap-2 text-xs bg-[#161b22] px-3.5 py-2.5 rounded-md border border-[#30363d]">
                            <span className="text-gray-400 shrink-0">
                              Resulting Package & Image Name:
                            </span>
                            <code className="text-white font-mono font-semibold break-all">
                              ghcr.io/{selectedRepo.owner.login.toLowerCase()}/
                              {fileNamingValidation.ociPackageName}
                            </code>
                          </div>
                        ) : (
                          <div className="text-xs text-gray-400 flex items-center gap-1.5">
                            <Info className="w-4 h-4 shrink-0" />
                            {fileNamingValidation.error}
                          </div>
                        )}

                        <button
                          type="button"
                          disabled={!fileNamingValidation.valid || !!uploadProgress}
                          onClick={handleOpenUploadVersionModal}
                          className="w-full py-2.5 px-4 rounded-md bg-blue-600 font-semibold text-xs transition flex items-center justify-center gap-2 cursor-pointer"
                        >
                          <Upload className="w-4 h-4" />
                          Create Image &quot;
                          {fileNamingValidation.ociPackageName || '...'}&quot;
                        </button>
                      </div>
                    )}

                    {uploadError && !showUploadVersionModal && (
                      <div className="p-3 rounded-md theme-error-banner text-xs flex items-center justify-between gap-2">
                        <div className="flex items-start gap-2">
                          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                          <span>{uploadError}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setUploadError(null)}
                          className="modal-close-btn p-1 shrink-0"
                          aria-label="Dismiss error"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    )}

                    {uploadSuccess && (
                      <div className="p-3.5 rounded-md theme-success-banner text-xs flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <CheckCircle2 className="w-4 h-4 shrink-0" />
                          <div>
                            <span className="font-semibold">
                              Image &quot;{uploadSuccess.packageName}:{uploadSuccess.tag}&quot; uploaded!
                            </span>{' '}
                            ({uploadSuccess.fileCount} file(s), compressed size{' '}
                            {formatBytes(uploadSuccess.compressedSize)})
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => setActiveTab('packages')}
                            className="btn-modal-action px-2.5 py-1 rounded-md font-medium cursor-pointer"
                          >
                            View in Packages →
                          </button>
                          <button
                            type="button"
                            onClick={() => setUploadSuccess(null)}
                            className="modal-close-btn p-1"
                            aria-label="Dismiss notice"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ==================== TAB 2: SYNC ROOT FOLDER ==================== */}
                {activeTab === 'sync-folder' && (
                  <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-6 shadow-md space-y-6">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <h3 className="text-base font-bold text-white flex items-center gap-2">
                          <FolderSync className="w-5 h-5 icon-sync" />
                          Sync Root Folder
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
                        className={`dropzone-container dropzone-container-sync rounded-xl p-10 text-center transition select-none ${
                          isScanningFolder ? 'cursor-default' : 'cursor-pointer'
                        }`}
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
                              Click to Choose a Root Folder to Scan
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
                                              : `${formatFolderSummaryBadge(
                                                  item.files,
                                                  'Sub-folder'
                                                )} → 1 Image`}
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
                                      {status?.state === 'skipped' && (
                                        <span className="text-xs px-2 py-0.5 rounded border border-[#30363d] bg-[#161b22] text-gray-400 font-medium">
                                          Skipped
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

                        {syncBatchSummary && (
                          <div className="p-3.5 rounded-md theme-success-banner text-xs flex flex-wrap items-center justify-between gap-3">
                            <div className="flex items-center gap-2">
                              <CheckCircle2 className="w-4 h-4 shrink-0" />
                              <div>
                                <span className="font-semibold">
                                  Synced {syncBatchSummary.syncedCount} image
                                  {syncBatchSummary.syncedCount === 1 ? '' : 's'}!
                                </span>
                                {syncBatchSummary.replacedCount > 0 && (
                                  <span>
                                    {' '}
                                    ({syncBatchSummary.replacedCount} old version
                                    {syncBatchSummary.replacedCount === 1 ? '' : 's'}{' '}
                                    replaced)
                                  </span>
                                )}
                                {syncBatchSummary.skippedCount > 0 && (
                                  <span>
                                    {' '}
                                    ({syncBatchSummary.skippedCount} skipped)
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <button
                                type="button"
                                onClick={() => setActiveTab('packages')}
                                className="btn-modal-action px-2.5 py-1 rounded-md font-medium cursor-pointer"
                              >
                                View in Packages →
                              </button>
                              <button
                                type="button"
                                onClick={() => setSyncBatchSummary(null)}
                                className="modal-close-btn p-1"
                                aria-label="Dismiss sync notice"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        )}

                        {rootScan.items.length > 0 && (
                          <button
                            type="button"
                            disabled={isSyncingFolder || selectedSyncIndices.size === 0}
                            onClick={handleOpenSyncReviewModal}
                            className="w-full py-3 px-5 rounded-md btn-sync-green font-semibold text-xs transition flex items-center justify-center gap-2 cursor-pointer"
                          >
                            <FolderSync className="w-4 h-4" />
                            Sync Folder — Review &amp; Upload {selectedSyncIndices.size}{' '}
                            Image{selectedSyncIndices.size === 1 ? '' : 's'} to Repo Packages
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
                          onClick={() => refreshPackages({ clearTransientNotices: true })}
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

                    {(() => {
                      type MergedPackageEntry =
                        | { kind: 'pkg'; pkg: GitHubPackageItem }
                        | {
                            kind: 'tombstone';
                            tombstone: {
                              pkg: GitHubPackageItem;
                              index: number;
                              isOther: boolean;
                              message: string;
                            };
                          };

                      const mergeWithTombstones = (
                        baseList: GitHubPackageItem[],
                        isOtherList: boolean
                      ): MergedPackageEntry[] => {
                        const seenPkgKeys = new Set<string>();
                        const entries: MergedPackageEntry[] = baseList.map((pkg) => {
                          const key = pkg.name.toLowerCase();
                          const tombstone = deletedPkgTombstones[key];
                          if (tombstone) {
                            seenPkgKeys.add(key);
                            return { kind: 'tombstone', tombstone };
                          }
                          return { kind: 'pkg', pkg };
                        });

                        const missingTombstones = Object.values(
                          deletedPkgTombstones
                        )
                          .filter(
                            (t) =>
                              t.isOther === isOtherList &&
                              !seenPkgKeys.has(t.pkg.name.toLowerCase())
                          )
                          .sort((a, b) => a.index - b.index);

                        for (const tombstone of missingTombstones) {
                          const insertAt = Math.max(
                            0,
                            Math.min(tombstone.index, entries.length)
                          );
                          entries.splice(insertAt, 0, {
                            kind: 'tombstone',
                            tombstone,
                          });
                        }

                        return entries;
                      };

                      const mergedEntries: MergedPackageEntry[] = [
                        ...mergeWithTombstones(repoPackages, false),
                        ...(showOtherPackages
                          ? mergeWithTombstones(otherPackages, true)
                          : []),
                      ];

                      const renderRepoPackageCard = ({
                        pkg,
                        allVersions,
                        displayedVersions,
                        q,
                        allowDelete,
                        isIndexCard = false,
                        displayTitleOverride,
                      }: {
                        pkg: GitHubPackageItem;
                        allVersions: GitHubPackageVersion[];
                        displayedVersions: GitHubPackageVersion[];
                        q: string;
                        allowDelete: boolean;
                        isIndexCard?: boolean;
                        displayTitleOverride?: string;
                      }) => {
                        const pkgKey = pkg.name.toLowerCase();
                        const settingsUrl = `${pkg.html_url}/settings`;
                        const outerCardClass = isIndexCard
                          ? 'p-4 rounded-md theme-index-card space-y-3'
                          : 'p-4 rounded-md bg-[#0d1117] border border-[#30363d] space-y-3';
                        const versionCardClass = isIndexCard
                          ? 'p-3 rounded-md theme-index-version-row space-y-2.5'
                          : 'p-3 rounded-md bg-[#161b22] border border-[#30363d] space-y-2.5';

                        return (
                          <div key={pkg.id} className={outerCardClass}>
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <div className="flex items-center gap-2 flex-wrap">
                                <Package className="w-4 h-4 icon-packages" />
                                {displayTitleOverride ? (
                                  <>
                                    <span className="text-sm font-bold text-gray-300">
                                      {displayTitleOverride}
                                    </span>
                                    <span className="text-[11px] font-mono text-gray-400">
                                      ({pkg.name})
                                    </span>
                                  </>
                                ) : (
                                  <span className="text-sm font-bold text-white font-mono">
                                    {pkg.name}
                                  </span>
                                )}
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
                                <span className="text-[10px] px-2 py-0.5 rounded border border-[#30363d] bg-[#161b22] text-gray-300 font-medium">
                                  {allVersions.length} version
                                  {allVersions.length === 1 ? '' : 's'}
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

                              {allowDelete && (
                                <button
                                  type="button"
                                  disabled={deletingPkgName === pkg.name}
                                  onClick={() => {
                                    setConfirmDeleteVersion(null);
                                    setConfirmDeletePkg(pkg);
                                  }}
                                  className="btn-modal-action px-2.5 py-1 rounded-md text-xs hover:text-red-400 transition cursor-pointer flex items-center gap-1.5"
                                  title="Remove entire package and all its versions from GitHub"
                                >
                                  {deletingPkgName === pkg.name ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    <Trash2 className="w-3.5 h-3.5" />
                                  )}
                                  Remove Package
                                </button>
                              )}
                            </div>

                            {renderInlineNotice(pkgNotices[pkgKey], () =>
                              dismissPkgNotice(pkgKey)
                            )}

                            {displayedVersions.length === 0 ? (
                              <div className="p-3 rounded-md bg-[#161b22] border border-[#30363d] text-xs text-gray-500">
                                No tagged or untagged versions returned for this package.
                              </div>
                            ) : (
                              <div className="space-y-2">
                                {displayedVersions.map((version) => {
                                  const vKey = makeVersionStateKey(pkg.name, version.name);
                                  const info = getVersionReferenceInfo(version);
                                  const details = inspectedByKey[vKey];
                                  const hasMatchingInnerFile = Boolean(
                                    q &&
                                      details?.files?.some((f) =>
                                        f.path.toLowerCase().includes(q)
                                      )
                                  );
                                  const isDetailsExpanded =
                                    expandedVersionKeys.has(vKey) || hasMatchingInnerFile;
                                  const pullCmd = `docker pull ghcr.io/${pkg.owner.login.toLowerCase()}/${pkg.name}${info.pullSuffix}`;
                                  const uploadedAt = version.created_at
                                    ? new Date(version.created_at).toLocaleString(
                                        undefined,
                                        { hour12: settings.clockFormat === '12h' }
                                      )
                                    : '';

                                  return (
                                    <div key={version.id} className={versionCardClass}>
                                      <div className="flex flex-wrap items-start justify-between gap-3">
                                        <div className="space-y-1 min-w-0">
                                          <div className="flex items-center gap-2 flex-wrap">
                                            <code className="text-xs font-bold text-white font-mono break-all">
                                              {info.isUntagged
                                                ? `${pkg.name} (untagged · ${info.shortDigest})`
                                                : `${pkg.name}:${info.tags.join(', ')}`}
                                            </code>
                                            {uploadedAt && (
                                              <span className="text-[11px] text-gray-500">
                                                {uploadedAt}
                                              </span>
                                            )}
                                          </div>

                                          <div className="flex items-center gap-2 text-[11px] text-gray-500 font-mono">
                                            <span className="break-all">{pullCmd}</span>
                                            <button
                                              type="button"
                                              onClick={() => copyToClipboard(pullCmd)}
                                              className="text-gray-400 hover:text-white cursor-pointer shrink-0"
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

                                        <div className="flex items-center gap-2 flex-wrap shrink-0">
                                          <VersionInspectButton
                                            details={details}
                                            isIndexing={indexingKeys.has(vKey)}
                                            isScanning={inspectingKey === vKey}
                                            scanProgress={inspectProgress}
                                            isExpanded={isDetailsExpanded}
                                            disableLoad={inspectingKey !== null}
                                            onToggleExpand={() =>
                                              handleToggleVersionExpand(vKey)
                                            }
                                            onLoadFiles={() =>
                                              handleLoadVersionFiles(
                                                pkg.name,
                                                pkg.owner.login,
                                                version
                                              )
                                            }
                                            onCancelScan={handleCancelInspect}
                                          />

                                          <button
                                            type="button"
                                            disabled={downloadingKey !== null}
                                            onClick={() =>
                                              handleDownloadVersion(pkg, version)
                                            }
                                            className="px-3 py-1.5 rounded-md bg-blue-600 text-xs font-semibold text-white flex items-center gap-1.5 cursor-pointer"
                                          >
                                            {downloadingKey === vKey ? (
                                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                            ) : (
                                              <Download className="w-3.5 h-3.5" />
                                            )}
                                            Download & Extract
                                          </button>

                                          {downloadingKey === vKey && (
                                            <button
                                              type="button"
                                              onClick={handleCancelDownload}
                                              className="btn-modal-action px-2.5 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1 cursor-pointer"
                                              title="Cancel active download"
                                            >
                                              <X className="w-3.5 h-3.5" />
                                              Cancel
                                            </button>
                                          )}

                                          {allowDelete && (
                                            <button
                                              type="button"
                                              disabled={deletingVersionKey === vKey}
                                              onClick={() => {
                                                setConfirmDeletePkg(null);
                                                setConfirmDeleteVersion({
                                                  pkg,
                                                  version,
                                                });
                                              }}
                                              className="btn-modal-action p-1.5 rounded-md hover:text-red-400 transition cursor-pointer"
                                              title="Remove this version from GitHub"
                                            >
                                              {deletingVersionKey === vKey ? (
                                                <Loader2 className="w-4 h-4 animate-spin" />
                                              ) : (
                                                <Trash2 className="w-4 h-4" />
                                              )}
                                            </button>
                                          )}
                                        </div>
                                      </div>

                                      {downloadingKey === vKey && downloadProgress && (
                                        <div className="space-y-1.5">
                                          <div className="flex justify-between text-xs text-gray-300">
                                            <span>{downloadProgress.message}</span>
                                            <span>{downloadProgress.percent}%</span>
                                          </div>
                                          <div className="w-full h-2 bg-[#0d1117] rounded-full overflow-hidden border border-[#30363d]">
                                            <div
                                              className="h-full tab-indicator transition-all duration-300"
                                              style={{
                                                width: `${downloadProgress.percent}%`,
                                              }}
                                            />
                                          </div>
                                        </div>
                                      )}

                                      {renderInlineNotice(
                                        versionNotices[vKey],
                                        () => dismissVersionNotice(vKey)
                                      )}

                                      {details && isDetailsExpanded && (
                                        <VersionFileDetailsPanel
                                          details={details}
                                          highlightQuery={q}
                                          containerBgClass="bg-[#0d1117]"
                                        />
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      };

                      return (
                        <>
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

                          {packagesError && (
                            <div className="p-3.5 rounded-md theme-error-banner text-xs">
                              {packagesError}
                            </div>
                          )}

                          {packagesLoading ? (
                            <div className="p-12 flex flex-col items-center justify-center text-gray-400 gap-2">
                              <Loader2 className="w-6 h-6 animate-spin theme-spinner" />
                              <span className="text-xs">Loading packages from GitHub...</span>
                            </div>
                          ) : mergedEntries.length === 0 && !showOtherPackages ? (
                            <div className="p-10 rounded-md bg-[#0d1117] border border-[#30363d] text-center space-y-2">
                              <Package className="w-8 h-8 text-gray-500 mx-auto" />
                              <div className="text-sm font-semibold text-gray-300">
                                No packages linked to {selectedRepo.full_name} yet
                              </div>
                              <p className="text-xs text-gray-500 max-w-md mx-auto">
                                Use the &quot;Upload Files&quot; or &quot;Sync Root
                                Folder&quot; tabs to create and push your first container
                                package image.
                              </p>
                            </div>
                          ) : (
                            <div className="space-y-3">
                              {mergedEntries
                                .filter((entry) => {
                                  const q = packageSearch.trim().toLowerCase();
                                  if (!q) return true;
                                  if (entry.kind === 'tombstone') {
                                    return entry.tombstone.pkg.name
                                      .toLowerCase()
                                      .includes(q);
                                  }
                                  const { pkg } = entry;
                                  if (pkg.name.toLowerCase().includes(q)) return true;
                                  const versions =
                                    packageVersionsMap[pkg.name.toLowerCase()] || [];
                                  return versions.some((v) => {
                                    const tags = v.metadata?.container?.tags || [];
                                    if (tags.some((t) => t.toLowerCase().includes(q))) {
                                      return true;
                                    }
                                    if (v.name.toLowerCase().includes(q)) return true;
                                    const details =
                                      inspectedByKey[
                                        makeVersionStateKey(pkg.name, v.name)
                                      ];
                                    if (!details) return false;
                                    return (
                                      details.originalName?.toLowerCase().includes(q) ||
                                      details.files?.some((f) =>
                                        f.path.toLowerCase().includes(q)
                                      )
                                    );
                                  });
                                })
                                .map((entry) => {
                                  if (entry.kind === 'tombstone') {
                                    const { tombstone } = entry;
                                    return (
                                      <div
                                        key={`deleted-${tombstone.pkg.name.toLowerCase()}`}
                                        className="p-4 rounded-md theme-success-banner text-xs flex items-center justify-between gap-3"
                                      >
                                        <div className="flex items-center gap-2.5 min-w-0">
                                          <CheckCircle2 className="w-4 h-4 shrink-0" />
                                          <span className="font-semibold break-words [overflow-wrap:anywhere]">
                                            {tombstone.message}
                                          </span>
                                        </div>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            dismissDeletedTombstone(tombstone.pkg.name)
                                          }
                                          className="modal-close-btn p-1 shrink-0 cursor-pointer"
                                          title="Dismiss confirmation"
                                        >
                                          <X className="w-4 h-4" />
                                        </button>
                                      </div>
                                    );
                                  }

                                  const { pkg } = entry;
                                  const pkgKey = pkg.name.toLowerCase();
                                  const q = packageSearch.trim().toLowerCase();
                                  const pkgMatchesDirectly =
                                    !q || pkgKey.includes(q);
                                  const allVersions =
                                    packageVersionsMap[pkgKey] || [];
                                  const displayedVersions = pkgMatchesDirectly
                                    ? allVersions
                                    : allVersions.filter((v) => {
                                        const tags = v.metadata?.container?.tags || [];
                                        if (
                                          tags.some((t) => t.toLowerCase().includes(q))
                                        ) {
                                          return true;
                                        }
                                        if (v.name.toLowerCase().includes(q)) return true;
                                        const details =
                                          inspectedByKey[
                                            makeVersionStateKey(pkg.name, v.name)
                                          ];
                                        return Boolean(
                                          details?.originalName
                                            ?.toLowerCase()
                                            .includes(q) ||
                                            details?.files?.some((f) =>
                                              f.path.toLowerCase().includes(q)
                                            )
                                        );
                                      });
                                  return renderRepoPackageCard({
                                    pkg,
                                    allVersions,
                                    displayedVersions,
                                    q,
                                    allowDelete: true,
                                    isIndexCard: false,
                                  });
                                })}
                            </div>
                          )}

                          {!packagesLoading && (repoIndexPkg || repoIndexNotice || repoIndexUpdating) && (
                            <div className="border-t border-[#30363d] pt-5 mt-5 space-y-3">
                              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-400">
                                <span className="font-semibold flex items-center gap-1.5">
                                  <Layers className="w-3.5 h-3.5" />
                                  Repository File Index
                                </span>
                                <span className="text-[11px]">
                                  {repoIndexUpdating
                                    ? 'Updating index...'
                                    : `Keeps latest ${REPO_INDEX_KEEP_VERSIONS} timestamped checkpoints (delete disabled in app)`}
                                </span>
                              </div>

                              {repoIndexNotice &&
                                renderInlineNotice(repoIndexNotice, () =>
                                  setRepoIndexNotice(null)
                                )}

                              {repoIndexPkg &&
                                (() => {
                                  const sortedIndexVersions =
                                    sortPackageVersionsNewestFirst(repoIndexVersions);
                                  return renderRepoPackageCard({
                                    pkg: repoIndexPkg,
                                    allVersions: sortedIndexVersions,
                                    displayedVersions: sortedIndexVersions,
                                    q: '',
                                    allowDelete: false,
                                    isIndexCard: true,
                                    displayTitleOverride: getRepoIndexDisplayTitle(
                                      selectedRepo.name
                                    ),
                                  });
                                })()}
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}
              </>
            )}
          </main>
        </>
      )}

      {/* Modals */}
      {(confirmDeletePkg || confirmDeleteVersion) && (() => {
        const isPackageDelete = Boolean(confirmDeletePkg);
        const pkgName = confirmDeletePkg
          ? confirmDeletePkg.name
          : confirmDeleteVersion!.pkg.name;
        const info = confirmDeleteVersion
          ? getVersionReferenceInfo(confirmDeleteVersion.version)
          : null;
        const siblingCount = confirmDeleteVersion
          ? (packageVersionsMap[pkgName.toLowerCase()] || []).length
          : 0;
        const closeDeleteModal = () => {
          setConfirmDeletePkg(null);
          setConfirmDeleteVersion(null);
        };
        const handleConfirm = () => {
          if (confirmDeletePkg) {
            handleDeletePackageConfirmed(confirmDeletePkg);
          } else if (confirmDeleteVersion) {
            handleDeleteVersionConfirmed(confirmDeleteVersion);
          }
        };

        return createPortal(
          <div
            className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={closeDeleteModal}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="bg-[#161b22] border border-[#30363d] rounded-xl w-full max-w-md overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-150"
            >
              <div className="flex items-center justify-between p-5 border-b border-[#30363d] bg-[#0d1117]">
                <h4 className="text-sm font-bold text-white flex items-center gap-2">
                  <Trash2 className="w-4 h-4 icon-packages" />
                  {isPackageDelete ? 'Remove Package' : 'Remove Image Version'}
                </h4>
                <button
                  type="button"
                  onClick={closeDeleteModal}
                  aria-label="Close confirmation dialog"
                  className="modal-close-btn p-1"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-5 space-y-4">
                <div className="p-3.5 rounded-md theme-error-banner text-xs leading-relaxed">
                  {isPackageDelete ? (
                    <>
                      Are you sure you want to permanently remove the entire package{' '}
                      <strong className="font-mono">{pkgName}</strong> and all of its versions from GitHub Packages?
                    </>
                  ) : (
                    <>
                      Are you sure you want to permanently remove{' '}
                      <strong className="font-mono">
                        {pkgName}
                        {info?.pullSuffix}
                      </strong>
                      ?
                      {siblingCount <= 1 && (
                        <span className="block mt-1.5">
                          Since this is the only version remaining, this will permanently delete package{' '}
                          <strong className="font-mono">{pkgName}</strong> from GitHub Packages.
                        </span>
                      )}
                    </>
                  )}
                </div>

                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={closeDeleteModal}
                    className="btn-modal-action px-3.5 py-1.5 rounded-md text-xs font-semibold cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirm}
                    className="px-3.5 py-1.5 rounded-md bg-blue-600 text-xs font-semibold text-white cursor-pointer"
                  >
                    Confirm Remove
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body
        );
      })()}

      {extractConflict &&
        createPortal(
          <div
            className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={() => setExtractConflict(null)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="bg-[#161b22] border border-[#30363d] rounded-xl w-full max-w-md overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-150"
            >
              <div className="flex items-center justify-between p-5 border-b border-[#30363d] bg-[#0d1117]">
                <h4 className="text-sm font-bold text-white flex items-center gap-2">
                  <Folder className="w-4 h-4 icon-packages" />
                  Folder Already Exists
                </h4>
                <button
                  type="button"
                  onClick={() => setExtractConflict(null)}
                  aria-label="Close folder conflict dialog"
                  className="modal-close-btn p-1"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-5 space-y-4">
                <div className="p-3.5 rounded-md theme-warning-banner text-xs leading-relaxed">
                  A folder named{' '}
                  <strong className="font-mono break-all">
                    {extractConflict.folderName}
                  </strong>{' '}
                  already exists inside{' '}
                  <span className="font-mono break-all">
                    {extractConflict.parentDir}
                  </span>
                  .
                </div>

                <p className="text-xs text-gray-300 leading-relaxed">
                  How would you like to extract{' '}
                  <strong className="font-mono break-all">
                    {extractConflict.displayLabel}
                  </strong>
                  ?
                </p>

                <div className="flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setExtractConflict(null)}
                    className="btn-modal-action px-3.5 py-1.5 rounded-md text-xs font-semibold cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const pending = extractConflict;
                      setExtractConflict(null);
                      void runDesktopDownloadAndExtract({
                        pkg: pending.pkg,
                        version: pending.version,
                        vKey: pending.vKey,
                        displayLabel: pending.displayLabel,
                        details: pending.details,
                        parentDir: pending.parentDir,
                        folderName: pending.folderName,
                        replaceExisting: true,
                      });
                    }}
                    className="btn-modal-action px-3.5 py-1.5 rounded-md text-xs font-semibold hover:text-red-400 transition cursor-pointer"
                  >
                    Replace Existing
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const pending = extractConflict;
                      setExtractConflict(null);
                      void runDesktopDownloadAndExtract({
                        pkg: pending.pkg,
                        version: pending.version,
                        vKey: pending.vKey,
                        displayLabel: pending.displayLabel,
                        details: pending.details,
                        parentDir: pending.parentDir,
                        folderName: pending.suggestedName,
                        replaceExisting: false,
                      });
                    }}
                    className="px-3.5 py-1.5 rounded-md bg-blue-600 text-xs font-semibold text-white cursor-pointer"
                  >
                    Save as &quot;{extractConflict.suggestedName}&quot;
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}

      {selectedRepo && (
        <UploadVersionModal
          isOpen={showUploadVersionModal}
          onClose={() => {
            if (!uploadProgress) {
              handleCancelInspect();
              setShowUploadVersionModal(false);
            }
          }}
          repo={selectedRepo}
          packageName={fileNamingValidation.ociPackageName}
          rawImageName={fileNamingValidation.effectiveRawName}
          clockFormat={settings.clockFormat}
          dateFormat={settings.dateFormat}
          canDeletePackages={
            oauthScopes === null || oauthScopes.includes('delete:packages')
          }
          lookupLoading={modalLookupLoading}
          lookupError={modalLookupError}
          livePackageItem={modalLivePkg}
          existingVersions={modalExistingVersions}
          onRetryLookup={() =>
            runLivePackageCheckForModal(fileNamingValidation.ociPackageName)
          }
          inspectedByKey={inspectedByKey}
          indexingKeys={indexingKeys}
          inspectingKey={inspectingKey}
          inspectProgress={inspectProgress}
          onLoadVersionFiles={handleLoadVersionFiles}
          onCancelInspect={handleCancelInspect}
          isUploading={!!uploadProgress}
          uploadProgress={uploadProgress}
          uploadError={uploadError}
          onConfirmUpload={handleExecuteVersionedUpload}
          onCancelUpload={handleCancelUpload}
        />
      )}

      {selectedRepo && (
        <SyncFolderReviewModal
          isOpen={showSyncReviewModal}
          onClose={() => {
            if (!isSyncingFolder) {
              handleCancelInspect();
              setShowSyncReviewModal(false);
            }
          }}
          repo={selectedRepo}
          selectedItems={syncReviewSelectedItems}
          clockFormat={settings.clockFormat}
          dateFormat={settings.dateFormat}
          canDeletePackages={
            oauthScopes === null || oauthScopes.includes('delete:packages')
          }
          lookupLoading={syncLookupLoading}
          lookupDoneCount={syncLookupDoneCount}
          lookupTotalCount={syncLookupTotalCount}
          lookupError={syncLookupError}
          liveStatesByIndex={syncLiveStatesByIndex}
          onRetryLookup={() => runLiveLookupForSyncModal(syncReviewSelectedItems)}
          inspectedByKey={inspectedByKey}
          indexingKeys={indexingKeys}
          inspectingKey={inspectingKey}
          inspectProgress={inspectProgress}
          onLoadVersionFiles={handleLoadVersionFiles}
          onCancelInspect={handleCancelInspect}
          isSyncing={isSyncingFolder}
          syncOverallProgress={syncOverallProgress}
          syncModalError={syncModalError}
          onConfirmSync={handleExecuteBatchSync}
          onCancelSync={handleCancelSync}
        />
      )}

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
