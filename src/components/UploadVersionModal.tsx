import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  Clock,
  Loader2,
  Package,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  getVersionReferenceInfo,
  type GitHubPackageItem,
  type GitHubPackageVersion,
  type GitHubRepo,
  type OciPackageDetails,
  type PushProgressUpdate,
} from '../lib/github-oci';
import {
  formatTimestampTag,
  validateOciTag,
  type ClockFormat,
  type DateFormat,
} from '../lib/naming';
import {
  VersionFileDetailsPanel,
  VersionInspectButton,
} from './VersionInspectButton';

export function makeVersionStateKey(pkgName: string, versionDigest: string): string {
  return `${pkgName.toLowerCase()}@${versionDigest}`;
}

export interface UploadVersionModalProps {
  isOpen: boolean;
  onClose: () => void;
  repo: GitHubRepo;
  packageName: string;
  rawImageName: string;
  clockFormat: ClockFormat;
  dateFormat: DateFormat;
  canDeletePackages: boolean;

  // Live GitHub lookup state
  lookupLoading: boolean;
  lookupError: string | null;
  livePackageItem: GitHubPackageItem | null;
  existingVersions: GitHubPackageVersion[];
  onRetryLookup: () => void;

  // Shared inspect/tree state (same caching & streaming engine as Repo Packages)
  inspectedByKey: Record<string, OciPackageDetails>;
  indexingKeys: Set<string>;
  inspectingKey: string | null;
  inspectProgress: number;
  onLoadVersionFiles: (pkgName: string, ownerLogin: string, version: GitHubPackageVersion) => void;
  onCancelInspect: () => void;

  // Upload submission
  isUploading: boolean;
  uploadProgress: PushProgressUpdate | null;
  uploadError: string | null;
  onConfirmUpload: (opts: {
    tag: string;
    replaceVersions: GitHubPackageVersion[];
  }) => Promise<void>;
}

export const UploadVersionModal: React.FC<UploadVersionModalProps> = ({
  isOpen,
  onClose,
  repo,
  packageName,
  clockFormat,
  dateFormat,
  canDeletePackages,
  lookupLoading,
  lookupError,
  livePackageItem,
  existingVersions,
  onRetryLookup,
  inspectedByKey,
  indexingKeys,
  inspectingKey,
  inspectProgress,
  onLoadVersionFiles,
  onCancelInspect,
  isUploading,
  uploadProgress,
  uploadError,
  onConfirmUpload,
}) => {
  const [selectedReplaceIds, setSelectedReplaceIds] = useState<Set<number>>(new Set());
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [tagInput, setTagInput] = useState<string>(() =>
    formatTimestampTag(new Date(), clockFormat, dateFormat)
  );
  const [isTagManuallyEdited, setIsTagManuallyEdited] = useState<boolean>(false);

  // Reset local modal selections whenever it opens or target package changes
  useEffect(() => {
    if (!isOpen) return;
    setSelectedReplaceIds(new Set());
    setExpandedKeys(new Set());
    setIsTagManuallyEdited(false);
    setTagInput(formatTimestampTag(new Date(), clockFormat, dateFormat));
  }, [isOpen, packageName, clockFormat, dateFormat]);

  // Keep timestamp tag ticking live every second until user manually edits (or while upload starts)
  useEffect(() => {
    if (!isOpen || isTagManuallyEdited || isUploading) return;
    setTagInput(formatTimestampTag(new Date(), clockFormat, dateFormat));
    const timer = setInterval(() => {
      setTagInput(formatTimestampTag(new Date(), clockFormat, dateFormat));
    }, 1000);
    return () => clearInterval(timer);
  }, [isOpen, isTagManuallyEdited, isUploading, clockFormat, dateFormat]);

  // Allow Escape to close when not actively uploading
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isUploading) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isUploading, onClose]);

  const ownerLower = repo.owner.login.toLowerCase();
  const tagValidation = useMemo(() => validateOciTag(tagInput), [tagInput]);

  // Check tag collision with existing versions on GitHub
  const { conflictWithUnchecked, overwritesCheckedTag } = useMemo(() => {
    if (!tagValidation.valid) {
      return { conflictWithUnchecked: false, overwritesCheckedTag: false };
    }
    let uncheckedHit = false;
    let checkedHit = false;
    for (const v of existingVersions) {
      const tags = v.metadata?.container?.tags || [];
      if (tags.includes(tagValidation.tag)) {
        if (selectedReplaceIds.has(v.id)) {
          checkedHit = true;
        } else {
          uncheckedHit = true;
        }
      }
    }
    return {
      conflictWithUnchecked: uncheckedHit,
      overwritesCheckedTag: checkedHit && !uncheckedHit,
    };
  }, [tagValidation, existingVersions, selectedReplaceIds]);

  if (!isOpen) return null;

  const replaceCount = selectedReplaceIds.size;
  const hasExistingVersions = existingVersions.length > 0;
  const linkedRepoFullName = livePackageItem?.repository?.full_name;
  const isLinkedElsewhere = Boolean(
    linkedRepoFullName &&
      linkedRepoFullName.toLowerCase() !== repo.full_name.toLowerCase()
  );

  const toggleReplaceVersion = (versionId: number) => {
    if (isUploading || !canDeletePackages) return;
    setSelectedReplaceIds((prev) => {
      const next = new Set(prev);
      if (next.has(versionId)) next.delete(versionId);
      else next.add(versionId);
      return next;
    });
  };

  const toggleExpandVersion = (key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const canSubmit =
    !lookupLoading &&
    !lookupError &&
    !isUploading &&
    tagValidation.valid &&
    !conflictWithUnchecked;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const replaceTargets = existingVersions.filter((v) =>
      selectedReplaceIds.has(v.id)
    );
    onConfirmUpload({
      tag: tagValidation.tag,
      replaceVersions: replaceTargets,
    });
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={() => {
        if (!isUploading) onClose();
      }}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="bg-[#161b22] border border-[#30363d] w-full max-w-2xl max-h-[85vh] rounded-xl shadow-2xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150"
      >
        {/* ==================== STATIC HEADER ==================== */}
        <div className="shrink-0 p-5 border-b border-[#30363d] bg-[#0d1117] space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <Package className="w-5 h-5 icon-upload shrink-0" />
              <h3 className="text-base font-bold text-white truncate">
                Create Image &quot;{packageName}&quot;
              </h3>
            </div>
            <button
              type="button"
              disabled={isUploading}
              onClick={onClose}
              aria-label="Close upload dialog"
              className="modal-close-btn p-1.5"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {lookupLoading && (
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <Loader2 className="w-3.5 h-3.5 animate-spin theme-spinner shrink-0" />
              <span>
                Checking GitHub Packages for existing versions of &quot;{packageName}&quot;...
              </span>
            </div>
          )}

          {lookupError && (
            <div className="p-3 rounded-md theme-error-banner text-xs flex items-center justify-between gap-3">
              <div className="flex items-start gap-2 min-w-0">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="break-words">{lookupError}</span>
              </div>
              <button
                type="button"
                onClick={onRetryLookup}
                className="btn-modal-action px-2.5 py-1 rounded text-xs font-medium flex items-center gap-1 shrink-0 cursor-pointer"
              >
                <RefreshCw className="w-3 h-3" />
                Retry
              </button>
            </div>
          )}

          {!lookupLoading && !lookupError && hasExistingVersions && (
            <div className="p-3 rounded-md theme-warning-banner text-xs flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-semibold">
                  Package &quot;{packageName}&quot; already exists (
                  {existingVersions.length} version
                  {existingVersions.length === 1 ? '' : 's'} on GitHub).
                </p>
                {isLinkedElsewhere ? (
                  <p className="opacity-90">
                    Note: This package is currently linked to{' '}
                    <span className="font-mono font-semibold">
                      {linkedRepoFullName}
                    </span>
                    . Because ghcr.io package names are shared per owner, uploading will add a version to that package.
                  </p>
                ) : (
                  <p className="opacity-90">
                    Select one or more existing versions below to replace (delete after upload succeeds), or leave <strong>New image</strong> active to keep all existing versions.
                  </p>
                )}
              </div>
            </div>
          )}

          {!lookupLoading && !lookupError && hasExistingVersions && !canDeletePackages && (
            <div className="p-2.5 rounded-md theme-error-banner text-xs flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                Version replacement is disabled because your GitHub token does not have the{' '}
                <code>delete:packages</code> scope. You can still upload as a new image version.
              </span>
            </div>
          )}
        </div>

        {/* ==================== SCROLLABLE MIDDLE: EXISTING VERSIONS ==================== */}
        {!lookupLoading && !lookupError && hasExistingVersions && (
          <div className="flex-1 min-h-[120px] overflow-y-auto p-4 space-y-2.5 bg-[#161b22]">
            {existingVersions.map((version) => {
              const info = getVersionReferenceInfo(version);
              const stateKey = makeVersionStateKey(packageName, version.name);
              const details = inspectedByKey[stateKey];
              const isIndexing = indexingKeys.has(stateKey);
              const isScanning = inspectingKey === stateKey;
              const isExpanded = expandedKeys.has(stateKey);
              const isChecked = selectedReplaceIds.has(version.id);
              const createdLabel = version.created_at
                ? new Date(version.created_at).toLocaleString(undefined, {
                    hour12: clockFormat === '12h',
                  })
                : '';

              return (
                <div
                  key={version.id}
                  className={`p-3 rounded-md border transition space-y-2 ${
                    isChecked
                      ? 'saved-item-active'
                      : 'bg-[#0d1117] border-[#30363d]'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div
                      onClick={() => toggleReplaceVersion(version.id)}
                      className={`flex items-start gap-2.5 min-w-0 flex-1 ${
                        isUploading || !canDeletePackages
                          ? 'cursor-not-allowed'
                          : 'cursor-pointer'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={isUploading || !canDeletePackages}
                        onChange={() => toggleReplaceVersion(version.id)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Select ${packageName}${info.pullSuffix} for replacement`}
                        className="custom-checkbox shrink-0 mt-0.5"
                      />

                      <div className="min-w-0 space-y-0.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <code className="text-xs font-mono font-bold text-white break-all">
                            {info.isUntagged
                              ? `${packageName} (untagged · ${info.shortDigest})`
                              : `${packageName}:${info.tags.join(', ')}`}
                          </code>
                          {isChecked && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded status-badge-warning inline-flex items-center gap-1 font-semibold">
                              <Trash2 className="w-2.5 h-2.5" />
                              Will replace
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-gray-500 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                          {createdLabel && <span>Uploaded {createdLabel}</span>}
                          {!info.isUntagged && (
                            <span className="font-mono">{info.shortDigest}</span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="shrink-0">
                      <VersionInspectButton
                        details={details}
                        isIndexing={isIndexing}
                        isScanning={isScanning}
                        scanProgress={inspectProgress}
                        isExpanded={isExpanded}
                        disableLoad={inspectingKey !== null && inspectingKey !== stateKey}
                        onToggleExpand={() => toggleExpandVersion(stateKey)}
                        onLoadFiles={() => {
                          onLoadVersionFiles(packageName, repo.owner.login, version);
                          setExpandedKeys((prev) => new Set(prev).add(stateKey));
                        }}
                        onCancelScan={onCancelInspect}
                      />
                    </div>
                  </div>

                  {isExpanded && details && (
                    <VersionFileDetailsPanel
                      details={details}
                      containerBgClass="bg-[#161b22]"
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ==================== STATIC FOOTER (NEW IMAGE + TAG + UPLOAD) ==================== */}
        <div className="shrink-0 p-5 border-t border-[#30363d] bg-[#0d1117] space-y-4">
          {hasExistingVersions && (
            <button
              type="button"
              disabled={isUploading}
              onClick={() => setSelectedReplaceIds(new Set())}
              className={`w-full text-left p-3 rounded-md border transition flex items-center justify-between gap-2 cursor-pointer disabled:cursor-not-allowed ${
                replaceCount === 0
                  ? 'saved-item-active'
                  : 'bg-[#161b22] border-[#30363d] hover:border-gray-500'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <div>
                  <div className="text-xs font-bold text-white">New image</div>
                  <div className="text-[11px] text-gray-400">
                    {replaceCount === 0
                      ? 'Keep all existing versions and upload this as a separate tagged image'
                      : `Click to keep all existing versions instead of replacing (${replaceCount} selected)`}
                  </div>
                </div>
              </div>
              <span
                className={`text-[11px] font-semibold px-2 py-0.5 rounded shrink-0 ${
                  replaceCount === 0
                    ? 'saved-item-badge'
                    : 'border border-[#30363d] bg-[#0d1117] text-gray-300'
                }`}
              >
                {replaceCount === 0 ? 'Selected' : 'Keep all'}
              </span>
            </button>
          )}

          {/* Tag Input */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="upload-version-tag-input"
                className="text-xs font-semibold text-gray-200 flex items-center gap-1.5"
              >
                Tag
              </label>
              <div className="flex items-center gap-2 text-[11px]">
                {isTagManuallyEdited ? (
                  <button
                    type="button"
                    disabled={isUploading}
                    onClick={() => {
                      setIsTagManuallyEdited(false);
                      setTagInput(
                        formatTimestampTag(new Date(), clockFormat, dateFormat)
                      );
                    }}
                    className="btn-saved-action inline-flex items-center gap-1 cursor-pointer font-medium"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Resume live timestamp
                  </button>
                ) : (
                  <span className="text-gray-400 inline-flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    Live timestamp ({dateFormat}, {clockFormat})
                  </span>
                )}
              </div>
            </div>

            <input
              id="upload-version-tag-input"
              type="text"
              disabled={isUploading}
              value={tagInput}
              onChange={(e) => {
                setIsTagManuallyEdited(true);
                setTagInput(e.target.value);
              }}
              placeholder={formatTimestampTag(new Date(), clockFormat, dateFormat)}
              className="w-full px-3.5 py-2 rounded-md bg-[#161b22] border border-[#30363d] text-sm text-white font-mono focus:outline-none"
            />

            {!tagValidation.valid && (
              <div className="text-xs text-gray-400 flex items-center gap-1.5 pt-0.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{tagValidation.error}</span>
              </div>
            )}

            {tagValidation.valid && conflictWithUnchecked && (
              <div className="p-2.5 rounded-md theme-error-banner text-xs flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  Tag <code>{tagValidation.tag}</code> already belongs to an unselected existing version above. Tick that version to replace it, or use a different tag.
                </span>
              </div>
            )}

            {tagValidation.valid && overwritesCheckedTag && (
              <div className="p-2 rounded-md theme-warning-banner text-[11px] flex items-center gap-2">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>
                  Tag <code>{tagValidation.tag}</code> will move to this new upload and the replaced version will be deleted.
                </span>
              </div>
            )}
          </div>

          {/* Resulting Package & Image Name Preview */}
          <div className="flex flex-wrap items-center gap-2 text-xs bg-[#161b22] px-3.5 py-2 rounded-md border border-[#30363d]">
            <span className="text-gray-400 shrink-0">
              Resulting Package & Image Name:
            </span>
            <code className="text-white font-mono font-semibold break-all">
              ghcr.io/{ownerLower}/{packageName}:{tagValidation.tag || '...'}
            </code>
          </div>

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

          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full py-2.5 px-4 rounded-md bg-blue-600 font-semibold text-xs text-white transition flex items-center justify-center gap-2 cursor-pointer"
          >
            {isUploading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {replaceCount > 0
                  ? 'Uploading & Replacing Selected Versions...'
                  : 'Building & Uploading OCI Image...'}
              </>
            ) : (
              <>
                <Upload className="w-4 h-4" />
                {replaceCount > 0
                  ? `Upload to Repo Packages (Replacing ${replaceCount})`
                  : 'Upload to Repo Packages'}
              </>
            )}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
};

export default UploadVersionModal;
