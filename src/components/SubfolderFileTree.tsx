import React, { useState, useMemo, useEffect } from 'react';
import {
  Folder,
  FolderOpen,
  FileText,
  ChevronDown,
  ChevronRight,
  Loader2,
} from 'lucide-react';
import { formatBytes } from '../lib/github-oci';
import type { DesktopRootFolderFileEntry } from '../lib/http';

interface TreeNode {
  name: string;
  path: string;
  size: number;
  fileCount: number;
  subfolders: Map<string, TreeNode>;
  files: DesktopRootFolderFileEntry[];
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

function buildTree(files: DesktopRootFolderFileEntry[]): TreeNode {
  const root: TreeNode = {
    name: '',
    path: '',
    size: 0,
    fileCount: 0,
    subfolders: new Map(),
    files: [],
  };

  for (let idx = 0; idx < files.length; idx++) {
    const f = files[idx];
    const cleanPath = normalizePath(f.relativePath);
    const segments = cleanPath.split('/').filter(Boolean);
    root.size += f.size;
    root.fileCount += 1;

    if (segments.length <= 1) {
      root.files.push(f);
      continue;
    }

    let current = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      const currentPath = segments.slice(0, i + 1).join('/');
      let next = current.subfolders.get(seg);
      if (!next) {
        next = {
          name: seg,
          path: currentPath,
          size: 0,
          fileCount: 0,
          subfolders: new Map(),
          files: [],
        };
        current.subfolders.set(seg, next);
      }
      next.size += f.size;
      next.fileCount += 1;
      current = next;
    }
    current.files.push(f);
  }

  return root;
}

/** Collect every folder path that contains (at any depth) a file matching the query */
function collectMatchedFolders(
  files: DesktopRootFolderFileEntry[],
  query: string
): Set<string> {
  const matched = new Set<string>();
  if (!query) return matched;
  for (const f of files) {
    const clean = normalizePath(f.relativePath);
    if (!clean.toLowerCase().includes(query)) continue;
    const segments = clean.split('/').filter(Boolean);
    for (let i = 1; i < segments.length; i++) {
      matched.add(segments.slice(0, i).join('/'));
    }
  }
  return matched;
}

const PAGE_BATCH_SIZE = 100;

interface TreeNodeViewProps {
  node: TreeNode;
  depth: number;
  iconClassName: string;
  query: string;
  matchedFolders: Set<string>;
}

const TreeNodeView: React.FC<TreeNodeViewProps> = ({
  node,
  depth,
  iconClassName,
  query,
  matchedFolders,
}) => {
  const containsMatch = depth > 0 && matchedFolders.has(node.path);

  // Only top-level container (depth === 0) is open initially so deeply nested folders never freeze the DOM
  const [isExpanded, setIsExpanded] = useState<boolean>(depth === 0 || containsMatch);
  const [isExpandingNode, setIsExpandingNode] = useState<boolean>(false);
  const [visibleLimit, setVisibleLimit] = useState<number>(PAGE_BATCH_SIZE);

  // Auto-expand folders that contain search matches
  useEffect(() => {
    if (containsMatch) setIsExpanded(true);
  }, [containsMatch]);

  const subfolderList = useMemo(
    () =>
      Array.from(node.subfolders.values()).sort((a, b) =>
        a.name.localeCompare(b.name)
      ),
    [node.subfolders]
  );

  const sortedFiles = useMemo(
    () =>
      isExpanded
        ? [...node.files].sort((a, b) => a.name.localeCompare(b.name))
        : [],
    [node.files, isExpanded]
  );

  const handleToggleFolder = () => {
    if (isExpanded) {
      setIsExpanded(false);
      return;
    }
    setIsExpandingNode(true);
    requestAnimationFrame(() => {
      setTimeout(() => {
        setIsExpanded(true);
        setIsExpandingNode(false);
      }, 16);
    });
  };

  const visibleSubfolders = subfolderList.slice(0, visibleLimit);
  const remainingSlots = Math.max(0, visibleLimit - visibleSubfolders.length);
  const visibleFiles = sortedFiles.slice(0, remainingSlots);
  const totalItemsAtLevel = subfolderList.length + sortedFiles.length;
  const hiddenCount = Math.max(0, totalItemsAtLevel - visibleLimit);

  return (
    <div className="space-y-1">
      {depth > 0 && (
        <div
          onClick={handleToggleFolder}
          className="tree-node-row flex items-center justify-between py-1 px-1.5 rounded cursor-pointer transition text-xs select-none"
        >
          <div className="flex items-center gap-1.5 min-w-0">
            {isExpandingNode ? (
              <Loader2 className="w-3 h-3 animate-spin theme-spinner shrink-0" />
            ) : isExpanded ? (
              <ChevronDown className="w-3 h-3 text-gray-500 shrink-0" />
            ) : (
              <ChevronRight className="w-3 h-3 text-gray-500 shrink-0" />
            )}
            {isExpanded ? (
              <FolderOpen className={`w-3.5 h-3.5 ${iconClassName} shrink-0`} />
            ) : (
              <Folder className={`w-3.5 h-3.5 ${iconClassName} shrink-0`} />
            )}
            <span className="font-semibold truncate tree-node-label">
              {node.name}/
            </span>
            <span className="text-[10px] shrink-0 tree-node-sub">
              ({node.fileCount} file{node.fileCount === 1 ? '' : 's'})
            </span>
          </div>
          <span className="text-[10px] font-mono shrink-0 ml-2 tree-node-sub">
            {formatBytes(node.size)}
          </span>
        </div>
      )}

      {isExpanded && (
        <div
          className={
            depth > 0
              ? 'pl-4 border-l border-[#30363d] ml-2 space-y-1'
              : 'space-y-1'
          }
        >
          {visibleSubfolders.map((child) => (
            <TreeNodeView
              key={child.path}
              node={child}
              depth={depth + 1}
              iconClassName={iconClassName}
              query={query}
              matchedFolders={matchedFolders}
            />
          ))}

          {visibleFiles.map((file, idx) => {
            const isMatch =
              !!query &&
              normalizePath(file.relativePath).toLowerCase().includes(query);
            return (
              <div
                key={`${file.relativePath}-${idx}`}
                className={`tree-node-row flex items-center justify-between py-0.5 px-1.5 rounded text-[11px] font-mono transition ${
                  isMatch ? 'active-variant font-bold' : ''
                }`}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <FileText className="w-3 h-3 text-gray-500 shrink-0" />
                  <span className="truncate tree-node-label">{file.name}</span>
                </div>
                <span className="shrink-0 ml-2 text-[10px] tree-node-sub">
                  {formatBytes(file.size)}
                </span>
              </div>
            );
          })}

          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setVisibleLimit((prev) => prev + PAGE_BATCH_SIZE);
              }}
              className="btn-modal-action px-2.5 py-1 rounded text-[11px] font-medium cursor-pointer mt-1"
            >
              Show more ({hiddenCount} remaining)...
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export interface SubfolderFileTreeProps {
  files: DesktopRootFolderFileEntry[];
  iconClassName?: string;
  /** Lower-cased search text: matching files get highlighted and their folders auto-expand */
  highlightQuery?: string;
  /** Optional heading rendered above the tree */
  title?: string;
  /** Total files in archive when only a preview subset is indexed in manifest annotations */
  totalArchiveFileCount?: number;
  /** Override the outer container classes */
  containerClassName?: string;
}

export const SubfolderFileTree: React.FC<SubfolderFileTreeProps> = ({
  files,
  iconClassName = 'icon-sync',
  highlightQuery = '',
  title,
  totalArchiveFileCount,
  containerClassName,
}) => {
  const root = useMemo(() => buildTree(files), [files]);
  const query = highlightQuery.trim().toLowerCase();
  const matchedFolders = useMemo(
    () => collectMatchedFolders(files, query),
    [files, query]
  );
  const unshownCount =
    totalArchiveFileCount && totalArchiveFileCount > files.length
      ? totalArchiveFileCount - files.length
      : 0;

  return (
    <div
      className={
        containerClassName ??
        'mt-3 pl-3 pr-2 py-2 max-h-60 overflow-y-auto border-l-2 border-[#30363d] ml-3 bg-[#0d1117] rounded-r-md'
      }
    >
      {title && (
        <div className="text-[11px] font-semibold text-gray-400 mb-1">{title}</div>
      )}
      <TreeNodeView
        node={root}
        depth={0}
        iconClassName={iconClassName}
        query={query}
        matchedFolders={matchedFolders}
      />
      {unshownCount > 0 && (
        <div className="mt-1.5 pt-1.5 border-t border-[#30363d] px-1.5 text-[11px] font-mono text-gray-400">
          ... and {unshownCount.toLocaleString()} more file{unshownCount === 1 ? '' : 's'} ({totalArchiveFileCount!.toLocaleString()} total in archive)
        </div>
      )}
    </div>
  );
};

const treeEntriesCache = new WeakMap<
  ReadonlyArray<{ path: string; size: number }>,
  DesktopRootFolderFileEntry[]
>();

/**
 * Converts a flat manifest file list into cached entries for SubfolderFileTree.
 */
export function toTreeEntries(
  files: ReadonlyArray<{ path: string; size: number }>
): DesktopRootFolderFileEntry[] {
  const cached = treeEntriesCache.get(files);
  if (cached) return cached;
  const entries = files.map((f) => {
    const clean = normalizePath(f.path);
    return {
      relativePath: clean,
      name: clean.split('/').pop() || clean,
      size: f.size,
    };
  });
  treeEntriesCache.set(files, entries);
  return entries;
}

export default SubfolderFileTree;
