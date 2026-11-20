import React from 'react';
import { ChevronDown, ChevronRight, Loader2, X } from 'lucide-react';
import { formatBytes, type OciPackageDetails } from '../lib/github-oci';
import { summarizeArchiveEntries } from '../lib/tar';
import { SubfolderFileTree, toTreeEntries } from './SubfolderFileTree';

interface VersionInspectButtonProps {
  details?: OciPackageDetails;
  isIndexing: boolean;
  isScanning: boolean;
  scanProgress: number;
  isExpanded: boolean;
  disableLoad: boolean;
  onToggleExpand: () => void;
  onLoadFiles: () => void;
  onCancelScan: () => void;
}

/**
 * Shared inspect / load / expand button group for a package version row,
 * used in both Repo Packages and the Upload Version popup.
 */
export const VersionInspectButton: React.FC<VersionInspectButtonProps> = ({
  details,
  isIndexing,
  isScanning,
  scanProgress,
  isExpanded,
  disableLoad,
  onToggleExpand,
  onLoadFiles,
  onCancelScan,
}) => {
  if (isIndexing && !details) {
    return (
      <button
        type="button"
        disabled
        className="btn-modal-action px-3 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5"
      >
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Indexing...
      </button>
    );
  }

  if (isScanning) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="btn-modal-action px-3 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Scanning ({scanProgress}%)
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onCancelScan();
          }}
          className="btn-modal-action px-2.5 py-1.5 rounded-md text-xs font-medium flex items-center gap-1 cursor-pointer"
          title="Cancel scanning layer headers"
        >
          <X className="w-3.5 h-3.5" />
          Cancel
        </button>
      </div>
    );
  }

  if (details?.needsManualLoad) {
    return (
      <button
        type="button"
        disabled={disableLoad}
        onClick={(e) => {
          e.stopPropagation();
          onLoadFiles();
        }}
        className="btn-modal-action px-3 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 cursor-pointer"
        title="Click to stream file headers from this image layer into RAM"
      >
        <ChevronRight className="w-3.5 h-3.5" />
        Load Files ({formatBytes(details.compressedSize)})
      </button>
    );
  }

  if (details) {
    const { regularFileCount, emptyFolderCount } = summarizeArchiveEntries(details.files);
    const displayedFileCount = Math.max(details.fileCount, regularFileCount);
    const hasOnlyRootEmptyFolder =
      displayedFileCount === 0 && emptyFolderCount === 0 && details.files.length > 0;
    const label =
      displayedFileCount === 0 && (emptyFolderCount > 0 || hasOnlyRootEmptyFolder)
        ? `Empty Folder${emptyFolderCount > 1 ? `s (${emptyFolderCount})` : ''}`
        : `Files (${displayedFileCount})`;
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleExpand();
        }}
        className="btn-modal-action px-3 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 cursor-pointer"
      >
        {isExpanded ? (
          <ChevronDown className="w-3.5 h-3.5" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5" />
        )}
        {isExpanded ? 'Hide Files' : label}
      </button>
    );
  }

  return (
    <button
      type="button"
      disabled={disableLoad}
      onClick={(e) => {
        e.stopPropagation();
        onLoadFiles();
      }}
      className="btn-modal-action px-3 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 cursor-pointer"
    >
      <ChevronRight className="w-3.5 h-3.5" />
      Load Files
    </button>
  );
};

export function makeVersionStateKey(pkgName: string, versionDigest: string): string {
  return `${pkgName.toLowerCase()}@${versionDigest}`;
}

export interface VersionFileDetailsPanelProps {
  details: OciPackageDetails;
  highlightQuery?: string;
  containerBgClass?: string;
}

/**
 * Shared expanded version details panel (metadata summary + nested folder tree).
 */
export const VersionFileDetailsPanel: React.FC<VersionFileDetailsPanelProps> = ({
  details,
  highlightQuery = '',
  containerBgClass = 'bg-[#0d1117]',
}) => {
  if (details.needsManualLoad) return null;
  const { emptyFolderCount } = summarizeArchiveEntries(details.files);
  return (
    <div className="pt-2 border-t border-[#30363d] space-y-2">
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-gray-400">
        <span>
          Original Name:{' '}
          <strong className="text-gray-200">{details.originalName}</strong>
        </span>
        <span>
          Mode: <strong className="text-white">{details.mode}</strong>
        </span>
        <span>
          Files: <strong className="text-gray-200">{details.fileCount}</strong>
        </span>
        {emptyFolderCount > 0 && (
          <span>
            Empty folders:{' '}
            <strong className="text-gray-200">{emptyFolderCount}</strong>
          </span>
        )}
        <span>
          Image Size:{' '}
          <strong className="text-gray-200">
            {formatBytes(details.compressedSize)}
          </strong>
        </span>
        <span>
          Uncompressed:{' '}
          <strong className="text-gray-200">
            {formatBytes(details.totalUncompressedBytes)}
          </strong>
        </span>
      </div>

      {details.files.length > 0 ? (
        <SubfolderFileTree
          files={toTreeEntries(details.files)}
          iconClassName="icon-packages"
          highlightQuery={highlightQuery}
          title="Files inside image layer:"
          totalArchiveFileCount={details.fileCount}
          containerClassName={`${containerBgClass} rounded-md p-2.5 border border-[#30363d] max-h-60 overflow-y-auto`}
        />
      ) : (
        <div
          className={`${containerBgClass} rounded-md p-2.5 border border-[#30363d] text-[11px] text-gray-500`}
        >
          No files indexed inside this image layer.
        </div>
      )}
    </div>
  );
};

export default VersionInspectButton;
