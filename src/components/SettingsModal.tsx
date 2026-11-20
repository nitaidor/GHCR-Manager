import React, { useEffect, useMemo, useState } from 'react';
import {
  Settings,
  X,
  Clock,
  Calendar,
  Package,
  Search,
  RefreshCw,
  ExternalLink,
  Check,
  Upload,
} from 'lucide-react';
import {
  isUnlinkedPackagesRepo,
  type AccountPackageCountsSummary,
  type GitHubRepo,
} from '../lib/github-oci';
import type { AppSettings, UploadTransferMode } from './Header';
import {
  formatTimestampTag,
  type ClockFormat,
  type DateFormat,
} from '../lib/naming';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
  isDarkMode: boolean;
  setIsDarkMode: (val: boolean) => void;
  isSignedIn: boolean;
  isDesktopEnv?: boolean;
  repos: GitHubRepo[];
  selectedRepo: GitHubRepo | null;
  onSelectRepo: (repo: GitHubRepo) => void;
  reposLoading: boolean;
  onRefreshRepos: () => void;
  unlinkedPackagesCount?: number;
  unlinkedRepoOption?: GitHubRepo | null;
  repoPackageCounts?: AccountPackageCountsSummary | null;
}

const DATE_FORMAT_OPTIONS: Array<{ value: DateFormat; label: string; sample: string }> = [
  { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD', sample: '2026-11-16' },
  { value: 'YY-MM-DD', label: 'YY-MM-DD', sample: '26-11-16' },
  { value: 'DD-MM-YYYY', label: 'DD-MM-YYYY', sample: '16-11-2026' },
  { value: 'DD-MM-YY', label: 'DD-MM-YY', sample: '16-11-26' },
];

const CLOCK_FORMAT_OPTIONS: Array<{ value: ClockFormat; label: string; sample: string }> = [
  { value: '12h', label: '12-Hour (AM/PM)', sample: '01.05.09pm' },
  { value: '24h', label: '24-Hour', sample: '13.05.09' },
];

const UPLOAD_TRANSFER_MODE_OPTIONS: Array<{
  value: UploadTransferMode;
  label: string;
  description: string;
}> = [
  {
    value: 'stream',
    label: 'Fast Stream',
    description: 'Continuous stream with auto 4 MiB fallback (fastest)',
  },
  {
    value: 'chunked',
    label: 'Chunked (4 MiB)',
    description: 'Best for slower/unstable networks or >10 min uploads',
  },
];

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  setSettings,
  isDarkMode,
  setIsDarkMode,
  isSignedIn,
  isDesktopEnv = false,
  repos,
  selectedRepo,
  onSelectRepo,
  reposLoading,
  onRefreshRepos,
  unlinkedPackagesCount = 0,
  unlinkedRepoOption = null,
  repoPackageCounts = null,
}) => {
  const [previewNow, setPreviewNow] = useState<Date>(() => new Date());
  const [repoSearch, setRepoSearch] = useState<string>('');

  const filteredRepos = useMemo(() => {
    const q = repoSearch.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter(
      (r) =>
        r.full_name.toLowerCase().includes(q) ||
        (r.description && r.description.toLowerCase().includes(q))
    );
  }, [repos, repoSearch]);

  const showUnlinkedRow = useMemo(() => {
    if (!unlinkedRepoOption) return false;
    const q = repoSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      unlinkedRepoOption.full_name.toLowerCase().includes(q) ||
      (unlinkedRepoOption.description?.toLowerCase().includes(q) ?? false)
    );
  }, [unlinkedRepoOption, repoSearch]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    setRepoSearch('');
    setPreviewNow(new Date());
    const timer = setInterval(() => setPreviewNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-[#161b22] border border-[#30363d] w-full max-w-2xl rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#30363d] bg-[#0d1117]">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Settings className="w-6 h-6 text-gray-400" /> Application Settings
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="modal-close-btn p-2"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-6 flex-1">
          {/* Target Repository Section (when signed in) */}
          {isSignedIn && (
            <section>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3 border-b border-[#30363d] pb-2">
                <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider flex items-center gap-2">
                  <Package className="w-4 h-4 icon-packages" />
                  Target Repository ({repos.length})
                </h3>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={reposLoading}
                    onClick={onRefreshRepos}
                    title="Refresh repositories"
                    className="btn-modal-action px-2.5 py-1 rounded text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <RefreshCw
                      className={`w-3 h-3 ${reposLoading ? 'animate-spin' : ''}`}
                    />
                    Refresh
                  </button>
                </div>
              </div>

              <div className="bg-[#0d1117] border border-[#30363d] rounded-md overflow-hidden">
                <div className="p-2.5 border-b border-[#30363d] bg-[#161b22]">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={repoSearch}
                      onChange={(e) => setRepoSearch(e.target.value)}
                      placeholder="Filter repositories..."
                      className="w-full pl-8 pr-3 py-1.5 rounded bg-[#0d1117] border border-[#30363d] text-xs text-white focus:outline-none"
                    />
                  </div>
                </div>

                <div className="max-h-56 overflow-y-auto divide-y divide-[#30363d]">
                  {reposLoading && repos.length === 0 ? (
                    <div className="p-4 text-center text-xs text-gray-500">
                      Loading repositories...
                    </div>
                  ) : filteredRepos.length === 0 && !showUnlinkedRow ? (
                    <div className="p-4 text-center text-xs text-gray-500">
                      No matching repositories.
                    </div>
                  ) : (
                    <>
                      {showUnlinkedRow && unlinkedRepoOption && (() => {
                        const isSelected = isUnlinkedPackagesRepo(selectedRepo);
                        return (
                          <div
                            key="unlinked-packages"
                            role="button"
                            tabIndex={0}
                            onClick={() => onSelectRepo(unlinkedRepoOption)}
                            onKeyDown={(e) => {
                              if (
                                e.target === e.currentTarget &&
                                (e.key === 'Enter' || e.key === ' ')
                              ) {
                                e.preventDefault();
                                onSelectRepo(unlinkedRepoOption);
                              }
                            }}
                            className={`w-full text-left px-3.5 py-2.5 text-xs flex items-center justify-between gap-2 transition ${
                              isSelected
                                ? 'active-variant font-bold cursor-pointer'
                                : 'hover:bg-[#21262d] text-gray-300 cursor-pointer'
                            }`}
                          >
                            <div className="min-w-0 flex items-center gap-2">
                              {isSelected && <Check className="w-3.5 h-3.5 shrink-0" />}
                              <div className="min-w-0">
                                <div className="truncate">Unlinked Packages</div>
                                <div className="text-[11px] text-gray-500 truncate">
                                  Container packages not linked to any GitHub repository
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <span className="text-[10px] px-1.5 py-0.5 rounded border border-[#30363d] bg-[#0d1117] text-gray-400">
                                {unlinkedPackagesCount}{' '}
                                {unlinkedPackagesCount === 1 ? 'package' : 'packages'}
                              </span>
                              <span className="text-[10px] px-1.5 py-0.5 rounded border border-[#30363d] bg-[#0d1117] text-gray-400">
                                Unlinked
                              </span>
                              <a
                                href={unlinkedRepoOption.html_url}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="btn-modal-action text-[10px] px-2 py-0.5 rounded font-semibold inline-flex items-center gap-1 whitespace-nowrap cursor-pointer"
                              >
                                View on GitHub
                                <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                              </a>
                            </div>
                          </div>
                        );
                      })()}
                      {filteredRepos.map((repo) => {
                        const isSelected = selectedRepo?.id === repo.id;
                        const hasNoCommits = repo.hasCommits === false;
                        const needsRepoWrite = repo.permissions?.push === false;
                        const isDisabledRepo = hasNoCommits || needsRepoWrite;
                        const repoPkgCount = repoPackageCounts
                          ? (repoPackageCounts.byRepoId[repo.id] ??
                            repoPackageCounts.byRepoFullName[repo.full_name.toLowerCase()] ??
                            0)
                          : null;
                        const showPkgCount =
                          repoPkgCount !== null && (!isDisabledRepo || repoPkgCount > 0);
                        const disabledTooltip = hasNoCommits
                          ? 'Requires at least 1 commit in this repository before it can be selected.'
                          : needsRepoWrite
                          ? 'Requires read/write access to this repository.'
                          : undefined;

                        return (
                          <div
                            key={repo.id}
                            role="button"
                            aria-disabled={isDisabledRepo}
                            tabIndex={isDisabledRepo ? -1 : 0}
                            title={disabledTooltip}
                            onClick={() => {
                              if (isDisabledRepo) return;
                              onSelectRepo(repo);
                            }}
                            onKeyDown={(e) => {
                              if (
                                isDisabledRepo ||
                                e.target !== e.currentTarget ||
                                (e.key !== 'Enter' && e.key !== ' ')
                              ) {
                                return;
                              }
                              e.preventDefault();
                              onSelectRepo(repo);
                            }}
                            className={`w-full text-left px-3.5 py-2.5 text-xs flex items-center justify-between gap-2 transition ${
                              isDisabledRepo
                                ? 'repo-option-disabled'
                                : isSelected
                                ? 'active-variant font-bold cursor-pointer'
                                : 'hover:bg-[#21262d] text-gray-300 cursor-pointer'
                            }`}
                          >
                            <div className="min-w-0 flex items-center gap-2">
                              {isSelected && !isDisabledRepo && (
                                <Check className="w-3.5 h-3.5 shrink-0" />
                              )}
                              <div className="min-w-0">
                                <div className="truncate">{repo.full_name}</div>
                                {repo.description && (
                                  <div className="text-[11px] text-gray-500 truncate">
                                    {repo.description}
                                  </div>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              {showPkgCount && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded border border-[#30363d] bg-[#0d1117] text-gray-400">
                                  {repoPkgCount}{' '}
                                  {repoPkgCount === 1 ? 'package' : 'packages'}
                                </span>
                              )}
                              {hasNoCommits && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded border border-[#30363d] bg-[#0d1117]">
                                  0 commits
                                </span>
                              )}
                              {!hasNoCommits && needsRepoWrite && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded border border-[#30363d] bg-[#0d1117]">
                                  Read-only
                                </span>
                              )}
                              <span className="text-[10px] px-1.5 py-0.5 rounded border border-[#30363d] bg-[#0d1117] text-gray-400">
                                {repo.private ? 'Private' : 'Public'}
                              </span>
                              <a
                                href={`${repo.html_url}/packages`}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="btn-modal-action text-[10px] px-2 py-0.5 rounded font-semibold inline-flex items-center gap-1 whitespace-nowrap cursor-pointer"
                              >
                                View on GitHub
                                <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                              </a>
                            </div>
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>
              </div>
            </section>
          )}

          {/* Appearance Section (5 Themes + Clock & Date Format) */}
          <section>
            <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3 border-b border-[#30363d] pb-2">
              Appearance
            </h3>
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between bg-[#0d1117] p-4 rounded-md border border-[#30363d]">
                <div>
                  <p className="font-medium text-gray-200">Application Theme</p>
                  <p className="text-xs text-gray-500">
                    Toggle between dark and light themes.
                  </p>
                </div>
                <div
                  className="flex items-center gap-3 select-none cursor-pointer"
                  onClick={() => setIsDarkMode(!isDarkMode)}
                >
                  <span
                    className={`text-sm font-bold ${
                      isDarkMode ? 'theme-active-toggle' : 'text-gray-500'
                    }`}
                  >
                    Dark
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={!isDarkMode}
                    aria-label="Toggle dark and light theme"
                    className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors border theme-toggle-track cursor-pointer"
                  >
                    <span
                      className={`theme-toggle-knob inline-block h-4 w-4 transform rounded-full transition-transform ${
                        !isDarkMode ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                  <span
                    className={`text-sm font-bold ${
                      !isDarkMode ? 'theme-active-toggle' : 'text-gray-500'
                    }`}
                  >
                    Light
                  </span>
                </div>
              </div>

              {/* Color Scheme Variant (5 Themes) */}
              <div className="bg-[#0d1117] p-4 rounded-md border border-[#30363d] animate-in fade-in">
                <p className="font-medium text-gray-200 mb-3 text-sm">
                  Color Scheme Variant
                </p>
                {isDarkMode ? (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setSettings((prev) => ({ ...prev, darkTheme: 'default' }))
                      }
                      className={`p-2.5 text-xs rounded border font-medium transition-colors cursor-pointer ${
                        settings.darkTheme === 'default'
                          ? 'active-variant'
                          : 'border-[#30363d] text-gray-400 hover:border-gray-500'
                      }`}
                    >
                      Default Dark
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setSettings((prev) => ({ ...prev, darkTheme: 'green' }))
                      }
                      className={`p-2.5 text-xs rounded border font-medium transition-colors cursor-pointer ${
                        settings.darkTheme === 'green'
                          ? 'active-variant'
                          : 'border-[#30363d] text-gray-400 hover:border-gray-500'
                      }`}
                    >
                      Green on Black
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setSettings((prev) => ({ ...prev, darkTheme: 'red' }))
                      }
                      className={`p-2.5 text-xs rounded border font-medium transition-colors cursor-pointer ${
                        settings.darkTheme === 'red'
                          ? 'active-variant'
                          : 'border-[#30363d] text-gray-400 hover:border-gray-500'
                      }`}
                    >
                      Red on Black
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setSettings((prev) => ({ ...prev, lightTheme: 'default' }))
                      }
                      className={`p-2.5 text-xs rounded border font-medium transition-colors cursor-pointer ${
                        settings.lightTheme === 'default'
                          ? 'active-variant'
                          : 'border-[#30363d] text-gray-400 hover:border-gray-500'
                      }`}
                    >
                      Default Light
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setSettings((prev) => ({ ...prev, lightTheme: 'monochrome' }))
                      }
                      className={`p-2.5 text-xs rounded border font-medium transition-colors cursor-pointer ${
                        settings.lightTheme === 'monochrome'
                          ? 'active-variant'
                          : 'border-[#30363d] text-gray-400 hover:border-gray-500'
                      }`}
                    >
                      Black on White (Monochrome)
                    </button>
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Timestamp Tags Section (Clock & Date Formats) */}
          <section>
            <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3 border-b border-[#30363d] pb-2">
              Default Timestamp Tags
            </h3>
            <div className="flex flex-col gap-3">
              <div className="bg-[#0d1117] p-4 rounded-md border border-[#30363d]">
                <div className="flex items-center gap-2 mb-1">
                  <Clock className="w-4 h-4 text-gray-400" />
                  <p className="font-medium text-gray-200 text-sm">Clock Format</p>
                </div>
                <p className="text-xs text-gray-500 mb-3">
                  Time format used for new timestamp tags. Changing this does not alter existing tags on GitHub.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {CLOCK_FORMAT_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() =>
                        setSettings((prev) => ({ ...prev, clockFormat: opt.value }))
                      }
                      className={`p-2.5 text-xs rounded border font-medium transition-colors cursor-pointer flex items-center justify-between gap-2 ${
                        settings.clockFormat === opt.value
                          ? 'active-variant'
                          : 'border-[#30363d] text-gray-400 hover:border-gray-500'
                      }`}
                    >
                      <span>{opt.label}</span>
                      <code className="font-mono text-[11px] opacity-80">{opt.sample}</code>
                    </button>
                  ))}
                </div>
              </div>

              <div className="bg-[#0d1117] p-4 rounded-md border border-[#30363d]">
                <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <Calendar className="w-4 h-4 text-gray-400" />
                      <p className="font-medium text-gray-200 text-sm">Date Format</p>
                    </div>
                    <p className="text-xs text-gray-500">
                      Date layout used when generating default upload tags.
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs shrink-0">
                    <span className="text-gray-400">Preview:</span>
                    <code className="px-2 py-0.5 rounded bg-[#161b22] border border-[#30363d] text-white font-mono font-semibold">
                      {formatTimestampTag(
                        previewNow,
                        settings.clockFormat,
                        settings.dateFormat
                      )}
                    </code>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {DATE_FORMAT_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() =>
                        setSettings((prev) => ({ ...prev, dateFormat: opt.value }))
                      }
                      className={`p-2.5 text-xs rounded border font-medium transition-colors cursor-pointer flex flex-col items-center gap-1 ${
                        settings.dateFormat === opt.value
                          ? 'active-variant'
                          : 'border-[#30363d] text-gray-400 hover:border-gray-500'
                      }`}
                    >
                      <span className="font-mono">{opt.label}</span>
                      <span className="text-[10px] opacity-75 font-mono">{opt.sample}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>

          {/* Upload Transfer Mode Section */}
          {(() => {
            const effectiveTransferMode: UploadTransferMode = isDesktopEnv
              ? settings.uploadTransferMode
              : 'chunked';

            return (
              <section>
                <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3 border-b border-[#30363d] pb-2">
                  Uploads
                </h3>
                <div className="bg-[#0d1117] p-4 rounded-md border border-[#30363d]">
                  <div className="flex items-center gap-2 mb-1">
                    <Upload className="w-4 h-4 text-gray-400" />
                    <p className="font-medium text-gray-200 text-sm">
                      Upload Transfer Mode
                    </p>
                  </div>
                  <p className="text-xs text-gray-500 mb-3">
                    Choose how large image layers (&gt; 4 MiB) are uploaded to GitHub Packages.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {UPLOAD_TRANSFER_MODE_OPTIONS.map((opt) => {
                      const isDisabled = !isDesktopEnv && opt.value === 'stream';
                      const isActive = effectiveTransferMode === opt.value;

                      return (
                        <button
                          key={opt.value}
                          type="button"
                          disabled={isDisabled}
                          aria-disabled={isDisabled}
                          title={
                            isDisabled
                              ? 'Fast Stream requires running GHCR Manager as a desktop application.'
                              : undefined
                          }
                          onClick={() => {
                            if (isDisabled) return;
                            setSettings((prev) => ({
                              ...prev,
                              uploadTransferMode: opt.value,
                            }));
                          }}
                          className={`p-2.5 text-left text-xs rounded border font-medium transition-colors flex flex-col gap-1 ${
                            isDisabled
                              ? 'border-[#30363d] repo-option-disabled'
                              : isActive
                                ? 'active-variant cursor-pointer'
                                : 'border-[#30363d] text-gray-400 hover:border-gray-500 cursor-pointer'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2 w-full">
                            <span className="font-semibold">{opt.label}</span>
                            {isDisabled && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded border border-[#30363d] bg-[#0d1117]">
                                Desktop only
                              </span>
                            )}
                          </div>
                          <span className="text-[11px] opacity-80 leading-snug">
                            {opt.description}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </section>
            );
          })()}
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
