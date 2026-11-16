import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  File as FileIcon,
  Folder,
  FolderSync,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import {
  formatBytes,
  getVersionReferenceInfo,
  type GitHubPackageVersion,
  type GitHubRepo,
  type LivePackageState,
  type OciPackageDetails,
} from '../lib/github-oci';
import type { DesktopRootFolderItem } from '../lib/http';
import {
  formatTimestampTag,
  validateOciTag,
  type ClockFormat,
  type DateFormat,
} from '../lib/naming';
import { useLiveTimestampTag } from '../lib/useLiveTimestampTag';
import {
  makeVersionStateKey,
  VersionFileDetailsPanel,
  VersionInspectButton,
} from './VersionInspectButton';

export type SyncConflictAction = 'new' | 'replace' | 'skip';

export interface SyncRootSelectedItem {
  idx: number;
  item: DesktopRootFolderItem;
  ociName: string;
}

export interface SyncBatchItemPlan {
  idx: number;
  item: DesktopRootFolderItem;
  ociName: string;
  action: SyncConflictAction;
  tag: string;
  replaceVersions: GitHubPackageVersion[];
  packageOwnerLogin: string;
  packageOwnerType: 'User' | 'Organization';
}

interface ItemDecision {
  action: SyncConflictAction;
  replaceIds: Set<number>;
  customTag?: string;
  showTagEditor?: boolean;
}

export interface SyncFolderReviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  repo: GitHubRepo;
  selectedItems: SyncRootSelectedItem[];
  clockFormat: ClockFormat;
  dateFormat: DateFormat;
  canDeletePackages: boolean;

  // Live GitHub batch check state
  lookupLoading: boolean;
  lookupDoneCount: number;
  lookupTotalCount: number;
  lookupError: string | null;
  liveStatesByIndex: Record<number, LivePackageState>;
  onRetryLookup: () => void;

  // Shared inspect/tree state
  inspectedByKey: Record<string, OciPackageDetails>;
  indexingKeys: Set<string>;
  inspectingKey: string | null;
  inspectProgress: number;
  onLoadVersionFiles: (
    pkgName: string,
    ownerLogin: string,
    version: GitHubPackageVersion
  ) => void;
  onCancelInspect: () => void;

  // Batch sync progress & submit
  isSyncing: boolean;
  syncOverallProgress: {
    current: number;
    total: number;
    message: string;
    percent: number;
  } | null;
  syncModalError: string | null;
  onConfirmSync: (plans: SyncBatchItemPlan[]) => Promise<void>;
}

export const SyncFolderReviewModal: React.FC<SyncFolderReviewModalProps> = ({
  isOpen,
  onClose,
  repo,
  selectedItems,
  clockFormat,
  dateFormat,
  canDeletePackages,
  lookupLoading,
  lookupDoneCount,
  lookupTotalCount,
  lookupError,
  liveStatesByIndex,
  onRetryLookup,
  inspectedByKey,
  indexingKeys,
  inspectingKey,
  inspectProgress,
  onLoadVersionFiles,
  onCancelInspect,
  isSyncing,
  syncOverallProgress,
  syncModalError,
  onConfirmSync,
}) => {
  const [decisions, setDecisions] = useState<Record<number, ItemDecision>>({});
  const [expandedItemIndices, setExpandedItemIndices] = useState<Set<number>>(new Set());
  const [expandedVersionKeys, setExpandedVersionKeys] = useState<Set<string>>(new Set());

  const resetSignature = useMemo(
    () => selectedItems.map((s) => `${s.idx}:${s.ociName}`).join('|'),
    [selectedItems]
  );

  const {
    tagInput: batchTagInput,
    isManuallyEdited: isBatchTagEdited,
    setCustomTag: setBatchCustomTag,
    resumeLiveClock: resumeBatchLiveClock,
  } = useLiveTimestampTag({
    isOpen,
    isBusy: isSyncing,
    clockFormat,
    dateFormat,
    resetKey: resetSignature,
  });

  // Reset per-item decisions when modal opens
  useEffect(() => {
    if (!isOpen) return;
    setDecisions({});
    setExpandedItemIndices(new Set());
    setExpandedVersionKeys(new Set());
  }, [isOpen, resetSignature]);

  // Escape closes when not actively syncing
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSyncing) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSyncing, onClose]);

  const getDecision = (idx: number): ItemDecision =>
    decisions[idx] || { action: 'new', replaceIds: new Set<number>() };

  const conflictingItems = useMemo(
    () =>
      selectedItems.filter((entry) => {
        const live = liveStatesByIndex[entry.idx];
        return Boolean(live?.exists && live.versions.length > 0);
      }),
    [selectedItems, liveStatesByIndex]
  );

  const batchTagValidation = useMemo(
    () => validateOciTag(batchTagInput),
    [batchTagInput]
  );

  // Per-item resolved tag, GitHub conflict, and same-batch collision check
  const validationSummary = useMemo(() => {
    const perItem: Record<
      number,
      {
        resolvedTag: string;
        tagValid: boolean;
        tagError?: string;
        githubTagConflict: boolean;
        overwritesCheckedTag: boolean;
        batchDuplicate: boolean;
      }
    > = {};

    const seenTargets = new Map<string, number>();
    let activeCount = 0;
    let skippedCount = 0;
    let totalReplaceCount = 0;
    let anyUsingBatchTag = false;
    let hasAnyError = false;

    for (const entry of selectedItems) {
      const dec = getDecision(entry.idx);
      if (dec.action === 'skip') {
        skippedCount += 1;
        perItem[entry.idx] = {
          resolvedTag: '',
          tagValid: true,
          githubTagConflict: false,
          overwritesCheckedTag: false,
          batchDuplicate: false,
        };
        continue;
      }

      activeCount += 1;
      if (dec.customTag === undefined) {
        anyUsingBatchTag = true;
      }
      const rawTag =
        dec.customTag !== undefined ? dec.customTag : batchTagInput;
      const vRes = validateOciTag(rawTag);
      const liveVersions = liveStatesByIndex[entry.idx]?.versions || [];

      let githubTagConflict = false;
      let overwritesCheckedTag = false;
      if (vRes.valid) {
        for (const v of liveVersions) {
          const tags = v.metadata?.container?.tags || [];
          if (tags.includes(vRes.tag)) {
            if (dec.action === 'replace' && dec.replaceIds.has(v.id)) {
              overwritesCheckedTag = true;
            } else {
              githubTagConflict = true;
            }
          }
        }
      }

      let batchDuplicate = false;
      if (vRes.valid) {
        const targetKey = `${entry.ociName}:${vRes.tag}`;
        const prevIdx = seenTargets.get(targetKey);
        if (prevIdx !== undefined) {
          batchDuplicate = true;
          perItem[prevIdx].batchDuplicate = true;
          hasAnyError = true;
        } else {
          seenTargets.set(targetKey, entry.idx);
        }
      }

      if (dec.action === 'replace') {
        totalReplaceCount += dec.replaceIds.size;
        if (dec.replaceIds.size === 0) {
          // If marked 'replace' with 0 boxes checked, treat cleanly as warning/error or no-op?
          // Keep clean: only count checked versions; if user unchecks all we flip action back to 'new'.
        }
      }

      if (!vRes.valid || githubTagConflict || batchDuplicate) {
        hasAnyError = true;
      }

      perItem[entry.idx] = {
        resolvedTag: vRes.tag,
        tagValid: vRes.valid,
        tagError: vRes.error,
        githubTagConflict,
        overwritesCheckedTag,
        batchDuplicate,
      };
    }

    return {
      perItem,
      activeCount,
      skippedCount,
      totalReplaceCount,
      anyUsingBatchTag,
      hasAnyError,
    };
  }, [selectedItems, decisions, batchTagInput, liveStatesByIndex]);

  if (!isOpen) return null;

  const ownerLower = repo.owner.login.toLowerCase();

  const updateDecision = (
    idx: number,
    updater: (prev: ItemDecision) => ItemDecision
  ) => {
    setDecisions((prev) => ({
      ...prev,
      [idx]: updater(prev[idx] || { action: 'new', replaceIds: new Set<number>() }),
    }));
  };

  const applyBulkToConflicts = (mode: SyncConflictAction) => {
    if (isSyncing) return;
    if (mode === 'replace' && !canDeletePackages) return;

    setDecisions((prev) => {
      const next = { ...prev };
      for (const entry of conflictingItems) {
        const existing = next[entry.idx] || {
          action: 'new' as SyncConflictAction,
          replaceIds: new Set<number>(),
        };
        const liveVersions = liveStatesByIndex[entry.idx]?.versions || [];
        next[entry.idx] = {
          ...existing,
          action: mode,
          replaceIds:
            mode === 'replace'
              ? new Set(liveVersions.map((v) => v.id))
              : new Set<number>(),
        };
      }
      return next;
    });

    if (mode === 'replace') {
      // Keep list compact if many conflicts, or expand when <= 4 so user sees right away
      if (conflictingItems.length <= 4) {
        setExpandedItemIndices(new Set(conflictingItems.map((c) => c.idx)));
      }
    }
  };

  const toggleItemVersionExpand = (itemIdx: number) => {
    setExpandedItemIndices((prev) => {
      const next = new Set(prev);
      if (next.has(itemIdx)) next.delete(itemIdx);
      else next.add(itemIdx);
      return next;
    });
  };

  const toggleReplaceVersion = (itemIdx: number, versionId: number) => {
    if (isSyncing || !canDeletePackages) return;
    updateDecision(itemIdx, (prev) => {
      const nextIds = new Set(prev.replaceIds);
      if (nextIds.has(versionId)) nextIds.delete(versionId);
      else nextIds.add(versionId);
      return {
        ...prev,
        action: nextIds.size > 0 ? 'replace' : 'new',
        replaceIds: nextIds,
      };
    });
  };

  const toggleVersionFilesExpand = (vKey: string) => {
    setExpandedVersionKeys((prev) => {
      const next = new Set(prev);
      if (next.has(vKey)) next.delete(vKey);
      else next.add(vKey);
      return next;
    });
  };

  const canSubmit =
    !lookupLoading &&
    !lookupError &&
    !isSyncing &&
    validationSummary.activeCount > 0 &&
    !validationSummary.hasAnyError;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    const plans: SyncBatchItemPlan[] = selectedItems.map((entry) => {
      const dec = getDecision(entry.idx);
      const val = validationSummary.perItem[entry.idx];
      const liveState = liveStatesByIndex[entry.idx];
      const liveVersions = liveState?.versions || [];
      const replaceTargets =
        dec.action === 'replace'
          ? liveVersions.filter((v) => dec.replaceIds.has(v.id))
          : [];

      return {
        idx: entry.idx,
        item: entry.item,
        ociName: entry.ociName,
        action: dec.action,
        tag: val.resolvedTag,
        replaceVersions: replaceTargets,
        packageOwnerLogin: liveState?.packageItem?.owner.login || repo.owner.login,
        packageOwnerType: liveState?.packageItem?.owner.type || repo.owner.type,
      };
    });

    onConfirmSync(plans);
  };

  const existingCount = conflictingItems.length;
  const newCount = selectedItems.length - existingCount;

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={() => {
        if (!isSyncing) onClose();
      }}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="bg-[#161b22] border border-[#30363d] w-full max-w-3xl max-h-[85vh] rounded-xl shadow-2xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150"
      >
        {/* ==================== STATIC HEADER ==================== */}
        <div className="shrink-0 p-5 border-b border-[#30363d] bg-[#0d1117] space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <FolderSync className="w-5 h-5 icon-sync shrink-0" />
              <div className="min-w-0">
                <h3 className="text-base font-bold text-white truncate">
                  Sync {selectedItems.length} Item
                  {selectedItems.length === 1 ? '' : 's'} to {repo.full_name}
                </h3>
              </div>
            </div>
            <button
              type="button"
              disabled={isSyncing}
              onClick={onClose}
              aria-label="Close sync dialog"
              className="modal-close-btn p-1.5"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {lookupLoading && (
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <Loader2 className="w-3.5 h-3.5 animate-spin theme-spinner shrink-0" />
              <span>
                Checking GitHub Packages ({lookupDoneCount} / {lookupTotalCount})...
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

          {!lookupLoading && !lookupError && existingCount > 0 && (
            <div className="p-3 rounded-md theme-warning-banner text-xs space-y-2.5">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <p>
                  <strong>
                    {existingCount} of {selectedItems.length}
                  </strong>{' '}
                  item{existingCount === 1 ? '' : 's'} already exist on GitHub (
                  {newCount} brand new). Pick per item below, or apply a bulk choice to existing packages:
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 pl-6">
                <button
                  type="button"
                  disabled={isSyncing}
                  onClick={() => applyBulkToConflicts('new')}
                  className="btn-modal-action px-2.5 py-1 rounded text-[11px] font-semibold cursor-pointer"
                >
                  Keep All Existing (New Versions)
                </button>
                <button
                  type="button"
                  disabled={isSyncing || !canDeletePackages}
                  onClick={() => applyBulkToConflicts('replace')}
                  className="btn-modal-action px-2.5 py-1 rounded text-[11px] font-semibold cursor-pointer"
                  title={
                    !canDeletePackages
                      ? "Requires 'delete:packages' token scope"
                      : 'Replace all existing versions after each new push completes'
                  }
                >
                  Replace All Old Versions
                </button>
                <button
                  type="button"
                  disabled={isSyncing}
                  onClick={() => applyBulkToConflicts('skip')}
                  className="btn-modal-action px-2.5 py-1 rounded text-[11px] font-semibold cursor-pointer"
                >
                  Skip All Existing
                </button>
              </div>
            </div>
          )}

          {!lookupLoading && !lookupError && existingCount > 0 && !canDeletePackages && (
            <div className="p-2.5 rounded-md theme-error-banner text-xs flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                Replacing old versions is disabled because your GitHub token does not include{' '}
                <code>delete:packages</code>.
              </span>
            </div>
          )}
        </div>

        {/* ==================== SCROLLABLE ITEMS LIST ==================== */}
        {!lookupLoading && !lookupError && (
          <div className="flex-1 min-h-[140px] overflow-y-auto p-4 space-y-2.5 bg-[#161b22]">
            {selectedItems.map((entry) => {
              const dec = getDecision(entry.idx);
              const val = validationSummary.perItem[entry.idx];
              const liveState = liveStatesByIndex[entry.idx];
              const liveVersions = liveState?.versions || [];
              const exists = Boolean(liveState?.exists && liveVersions.length > 0);
              const linkedElsewhere =
                liveState?.packageItem?.repository?.full_name &&
                liveState.packageItem.repository.full_name.toLowerCase() !==
                  repo.full_name.toLowerCase()
                  ? liveState.packageItem.repository.full_name
                  : null;
              const isVersionsExpanded = expandedItemIndices.has(entry.idx);
              const isReplacing = dec.action === 'replace' && dec.replaceIds.size > 0;
              const isSkipped = dec.action === 'skip';
              const pkgOwnerLogin =
                liveState?.packageItem?.owner.login || repo.owner.login;

              return (
                <div
                  key={`${entry.item.kind}-${entry.idx}-${entry.ociName}`}
                  className={`p-3 rounded-md border transition space-y-2.5 ${
                    isSkipped
                      ? 'bg-[#0d1117] border-[#30363d] opacity-60'
                      : isReplacing
                        ? 'saved-item-active'
                        : 'bg-[#0d1117] border-[#30363d]'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2.5">
                    <div className="flex items-start gap-2.5 min-w-0 flex-1">
                      {entry.item.kind === 'root-file' ? (
                        <FileIcon className="w-4 h-4 icon-upload shrink-0 mt-0.5" />
                      ) : (
                        <Folder className="w-4 h-4 icon-sync shrink-0 mt-0.5" />
                      )}
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <code className="text-xs font-mono font-bold text-white break-all">
                            {entry.ociName}
                            {!isSkipped && `:${val.resolvedTag || '...'}`}
                          </code>
                          {!exists ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded status-badge-valid font-semibold">
                              New package
                            </span>
                          ) : isSkipped ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded border border-[#30363d] bg-[#161b22] text-gray-400 font-semibold">
                              Skipped
                            </span>
                          ) : isReplacing ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded status-badge-warning inline-flex items-center gap-1 font-semibold">
                              <Trash2 className="w-2.5 h-2.5" />
                              Replacing {dec.replaceIds.size} of {liveVersions.length}
                            </span>
                          ) : (
                            <span className="text-[10px] px-1.5 py-0.5 rounded status-badge-checking font-semibold">
                              Exists ({liveVersions.length}) · Adding new version
                            </span>
                          )}
                          <span className="text-[11px] text-gray-500">
                            ({formatBytes(entry.item.size)})
                          </span>
                        </div>

                        {linkedElsewhere && (
                          <div className="text-[11px] text-gray-400">
                            Linked to{' '}
                            <span className="font-mono font-semibold">
                              {linkedElsewhere}
                            </span>{' '}
                            under {repo.owner.login}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Per-item controls */}
                    <div className="flex items-center gap-1.5 flex-wrap shrink-0">
                      {!isSkipped && (
                        <button
                          type="button"
                          disabled={isSyncing}
                          onClick={() =>
                            updateDecision(entry.idx, (prev) => ({
                              ...prev,
                              showTagEditor: !prev.showTagEditor,
                              customTag:
                                prev.customTag !== undefined
                                  ? prev.customTag
                                  : batchTagInput,
                            }))
                          }
                          className="btn-modal-action px-2 py-1 rounded text-[11px] font-medium flex items-center gap-1 cursor-pointer"
                          title="Override tag just for this item"
                        >
                          <Pencil className="w-3 h-3" />
                          Tag
                        </button>
                      )}

                      {exists && (
                        <>
                          <button
                            type="button"
                            onClick={() => toggleItemVersionExpand(entry.idx)}
                            className="btn-modal-action px-2 py-1 rounded text-[11px] font-medium flex items-center gap-1 cursor-pointer"
                          >
                            {isVersionsExpanded ? (
                              <ChevronDown className="w-3.5 h-3.5" />
                            ) : (
                              <ChevronRight className="w-3.5 h-3.5" />
                            )}
                            Versions ({liveVersions.length})
                          </button>

                          <button
                            type="button"
                            disabled={isSyncing}
                            onClick={() =>
                              updateDecision(entry.idx, (prev) => ({
                                ...prev,
                                action: prev.action === 'skip' ? 'new' : 'skip',
                                replaceIds:
                                  prev.action === 'skip'
                                    ? prev.replaceIds
                                    : new Set<number>(),
                              }))
                            }
                            className="btn-modal-action px-2 py-1 rounded text-[11px] font-medium cursor-pointer"
                          >
                            {isSkipped ? 'Include' : 'Skip'}
                          </button>
                        </>
                      )}

                      {!exists && (
                        <button
                          type="button"
                          disabled={isSyncing}
                          onClick={() =>
                            updateDecision(entry.idx, (prev) => ({
                              ...prev,
                              action: prev.action === 'skip' ? 'new' : 'skip',
                            }))
                          }
                          className="btn-modal-action px-2 py-1 rounded text-[11px] font-medium cursor-pointer"
                        >
                          {isSkipped ? 'Include' : 'Skip'}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Per-item optional custom tag override */}
                  {!isSkipped && dec.showTagEditor && (
                    <div className="pt-1 flex flex-wrap items-center gap-2">
                      <input
                        type="text"
                        disabled={isSyncing}
                        value={dec.customTag ?? batchTagInput}
                        onChange={(e) =>
                          updateDecision(entry.idx, (prev) => ({
                            ...prev,
                            customTag: e.target.value,
                          }))
                        }
                        className="flex-1 min-w-[180px] px-2.5 py-1.5 rounded bg-[#161b22] border border-[#30363d] text-xs text-white font-mono focus:outline-none"
                        placeholder={batchTagInput}
                      />
                      <button
                        type="button"
                        disabled={isSyncing}
                        onClick={() =>
                          updateDecision(entry.idx, (prev) => ({
                            ...prev,
                            customTag: undefined,
                            showTagEditor: false,
                          }))
                        }
                        className="btn-modal-action px-2.5 py-1.5 rounded text-[11px] cursor-pointer"
                      >
                        Use batch tag
                      </button>
                    </div>
                  )}

                  {/* Per-item validation notices */}
                  {!isSkipped && !val.tagValid && (
                    <div className="text-[11px] text-gray-400 flex items-center gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                      <span>{val.tagError}</span>
                    </div>
                  )}
                  {!isSkipped && val.githubTagConflict && (
                    <div className="p-2 rounded-md theme-error-banner text-[11px] flex items-center gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        Tag <code>{val.resolvedTag}</code> already exists on an unchecked version of <code>{entry.ociName}</code>. Expand Versions to replace it, or change the tag.
                      </span>
                    </div>
                  )}
                  {!isSkipped && val.batchDuplicate && (
                    <div className="p-2 rounded-md theme-error-banner text-[11px] flex items-center gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        Duplicate image target <code>{entry.ociName}:{val.resolvedTag}</code> in this batch. Edit this item&apos;s tag or skip one.
                      </span>
                    </div>
                  )}
                  {!isSkipped && val.overwritesCheckedTag && (
                    <div className="p-2 rounded-md theme-warning-banner text-[11px] flex items-center gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        Tag <code>{val.resolvedTag}</code> will move to this upload and remove the old replaced version.
                      </span>
                    </div>
                  )}

                  {/* Existing GitHub Versions for this item (expandable with checkboxes + Files tree) */}
                  {exists && !isSkipped && isVersionsExpanded && (
                    <div className="pt-2 border-t border-[#30363d] space-y-2 pl-2">
                      <div className="flex items-center justify-between gap-2 text-[11px] text-gray-400">
                        <span>Existing GitHub versions (tick any to replace after upload):</span>
                        {dec.replaceIds.size > 0 && !isSyncing && (
                          <button
                            type="button"
                            onClick={() =>
                              updateDecision(entry.idx, (prev) => ({
                                ...prev,
                                action: 'new',
                                replaceIds: new Set<number>(),
                              }))
                            }
                            className="btn-saved-action cursor-pointer font-medium"
                          >
                            Clear replace ({dec.replaceIds.size})
                          </button>
                        )}
                      </div>

                      {liveVersions.map((version) => {
                        const info = getVersionReferenceInfo(version);
                        const vKey = makeVersionStateKey(entry.ociName, version.name);
                        const details = inspectedByKey[vKey];
                        const isChecked = dec.replaceIds.has(version.id);
                        const isFilesExpanded = expandedVersionKeys.has(vKey);
                        const createdLabel = version.created_at
                          ? new Date(version.created_at).toLocaleString(undefined, {
                              hour12: clockFormat === '12h',
                            })
                          : '';

                        return (
                          <div
                            key={version.id}
                            className={`p-2.5 rounded border transition space-y-2 ${
                              isChecked
                                ? 'saved-item-active'
                                : 'bg-[#161b22] border-[#30363d]'
                            }`}
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div
                                onClick={() =>
                                  toggleReplaceVersion(entry.idx, version.id)
                                }
                                className={`flex items-start gap-2 min-w-0 flex-1 ${
                                  isSyncing || !canDeletePackages
                                    ? 'cursor-not-allowed'
                                    : 'cursor-pointer'
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  disabled={isSyncing || !canDeletePackages}
                                  onChange={() =>
                                    toggleReplaceVersion(entry.idx, version.id)
                                  }
                                  onClick={(e) => e.stopPropagation()}
                                  aria-label={`Select ${entry.ociName}${info.pullSuffix} for replacement`}
                                  className="custom-checkbox shrink-0 mt-0.5"
                                />
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <code className="text-[11px] font-mono font-semibold text-white break-all">
                                      {info.isUntagged
                                        ? `${entry.ociName} (untagged · ${info.shortDigest})`
                                        : `${entry.ociName}:${info.tags.join(', ')}`}
                                    </code>
                                    {isChecked && (
                                      <span className="text-[10px] px-1.5 py-0.5 rounded status-badge-warning font-semibold">
                                        Will replace
                                      </span>
                                    )}
                                  </div>
                                  {createdLabel && (
                                    <div className="text-[10px] text-gray-500">
                                      Uploaded {createdLabel}
                                    </div>
                                  )}
                                </div>
                              </div>

                              <div className="shrink-0">
                                <VersionInspectButton
                                  details={details}
                                  isIndexing={indexingKeys.has(vKey)}
                                  isScanning={inspectingKey === vKey}
                                  scanProgress={inspectProgress}
                                  isExpanded={isFilesExpanded}
                                  disableLoad={
                                    inspectingKey !== null && inspectingKey !== vKey
                                  }
                                  onToggleExpand={() => toggleVersionFilesExpand(vKey)}
                                  onLoadFiles={() => {
                                    onLoadVersionFiles(
                                      entry.ociName,
                                      pkgOwnerLogin,
                                      version
                                    );
                                    setExpandedVersionKeys((prev) =>
                                      new Set(prev).add(vKey)
                                    );
                                  }}
                                  onCancelScan={onCancelInspect}
                                />
                              </div>
                            </div>

                            {isFilesExpanded && details && (
                              <VersionFileDetailsPanel
                                details={details}
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
            })}
          </div>
        )}

        {/* ==================== STATIC FOOTER (BATCH TAG + UPLOAD) ==================== */}
        <div className="shrink-0 p-5 border-t border-[#30363d] bg-[#0d1117] space-y-3.5">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="sync-batch-tag-input"
                className="text-xs font-semibold text-gray-200"
              >
                Batch Tag (applied to synced items)
              </label>
              <div className="flex items-center gap-2 text-[11px]">
                {isBatchTagEdited ? (
                  <button
                    type="button"
                    disabled={isSyncing}
                    onClick={resumeBatchLiveClock}
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
              id="sync-batch-tag-input"
              type="text"
              disabled={isSyncing}
              value={batchTagInput}
              onChange={(e) => setBatchCustomTag(e.target.value)}
              placeholder={formatTimestampTag(new Date(), clockFormat, dateFormat)}
              className="w-full px-3.5 py-2 rounded-md bg-[#161b22] border border-[#30363d] text-sm text-white font-mono focus:outline-none"
            />

            {!batchTagValidation.valid && validationSummary.anyUsingBatchTag && (
              <div className="text-xs text-gray-400 flex items-center gap-1.5 pt-0.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{batchTagValidation.error}</span>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs bg-[#161b22] px-3.5 py-2 rounded-md border border-[#30363d]">
            <span className="text-gray-400">
              Target prefix:{' '}
              <code className="text-white font-mono font-semibold">
                ghcr.io/{ownerLower}/&lt;item&gt;:{batchTagValidation.tag || '...'}
              </code>
            </span>
            <span className="text-gray-400">
              {validationSummary.activeCount} uploading
              {validationSummary.skippedCount > 0
                ? `, ${validationSummary.skippedCount} skipped`
                : ''}
              {validationSummary.totalReplaceCount > 0
                ? `, ${validationSummary.totalReplaceCount} old version(s) replaced`
                : ''}
            </span>
          </div>

          {syncModalError && (
            <div className="p-3 rounded-md theme-error-banner text-xs flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{syncModalError}</span>
            </div>
          )}

          {syncOverallProgress && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-gray-300">
                <span>
                  ({syncOverallProgress.current}/{syncOverallProgress.total}){' '}
                  {syncOverallProgress.message}
                </span>
                <span>{syncOverallProgress.percent}%</span>
              </div>
              <div className="w-full h-2 bg-[#161b22] rounded-full overflow-hidden border border-[#30363d]">
                <div
                  className="h-full tab-indicator transition-all duration-300"
                  style={{ width: `${syncOverallProgress.percent}%` }}
                />
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full py-2.5 px-4 rounded-md btn-sync-green font-semibold text-xs text-white transition flex items-center justify-center gap-2 cursor-pointer"
          >
            {isSyncing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Syncing Selected Items to Repo Packages...
              </>
            ) : (
              <>
                <FolderSync className="w-4 h-4" />
                {validationSummary.totalReplaceCount > 0
                  ? `Sync ${validationSummary.activeCount} Image${
                      validationSummary.activeCount === 1 ? '' : 's'
                    } (Replacing ${validationSummary.totalReplaceCount} Old)`
                  : `Sync ${validationSummary.activeCount} Image${
                      validationSummary.activeCount === 1 ? '' : 's'
                    } to Repo Packages`}
              </>
            )}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
};

export default SyncFolderReviewModal;
