import React, { useState, useMemo } from 'react';
import { Folder, FolderOpen, FileText, ChevronDown, ChevronRight } from 'lucide-react';
import { formatBytes } from '../lib/github-oci';
import type { DesktopRootFolderItem } from '../lib/http';

type FileEntry = DesktopRootFolderItem['files'][0];

interface TreeNode {
  name: string;
  path: string;
  size: number;
  subfolders: Map<string, TreeNode>;
  files: FileEntry[];
}

function buildTree(files: FileEntry[]): TreeNode {
  const root: TreeNode = {
    name: '',
    path: '',
    size: 0,
    subfolders: new Map(),
    files: [],
  };

  for (const f of files) {
    const cleanPath = f.relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const segments = cleanPath.split('/').filter(Boolean);
    root.size += f.size;

    if (segments.length <= 1) {
      // Direct file in this subfolder
      root.files.push(f);
      continue;
    }

    // Traverse intermediate folders
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
          subfolders: new Map(),
          files: [],
        };
        current.subfolders.set(seg, next);
      }
      next.size += f.size;
      current = next;
    }
    current.files.push(f);
  }

  return root;
}

interface TreeNodeViewProps {
  node: TreeNode;
  depth: number;
}

const TreeNodeView: React.FC<TreeNodeViewProps> = ({ node, depth }) => {
  const [isExpanded, setIsExpanded] = useState<boolean>(true);
  const subfolderList = useMemo(
    () => Array.from(node.subfolders.values()).sort((a, b) => a.name.localeCompare(b.name)),
    [node.subfolders]
  );
  const sortedFiles = useMemo(
    () => [...node.files].sort((a, b) => a.name.localeCompare(b.name)),
    [node.files]
  );

  return (
    <div className="space-y-1">
      {/* If this is not the invisible root node, render the folder header */}
      {depth > 0 && (
        <div
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center justify-between py-1 px-1.5 rounded hover:bg-[#161b22] cursor-pointer transition text-xs select-none"
        >
          <div className="flex items-center gap-1.5 min-w-0">
            {isExpanded ? (
              <ChevronDown className="w-3 h-3 text-gray-500 shrink-0" />
            ) : (
              <ChevronRight className="w-3 h-3 text-gray-500 shrink-0" />
            )}
            {isExpanded ? (
              <FolderOpen className="w-3.5 h-3.5 icon-sync shrink-0" />
            ) : (
              <Folder className="w-3.5 h-3.5 icon-sync shrink-0" />
            )}
            <span className="font-semibold text-gray-200 truncate">{node.name}/</span>
          </div>
          <span className="text-[10px] text-gray-500 font-mono shrink-0 ml-2">
            {formatBytes(node.size)}
          </span>
        </div>
      )}

      {/* Children: subfolders and files */}
      {isExpanded && (
        <div className={depth > 0 ? 'pl-4 border-l border-[#30363d] ml-2 space-y-1' : 'space-y-1'}>
          {subfolderList.map((child) => (
            <TreeNodeView key={child.path} node={child} depth={depth + 1} />
          ))}

          {sortedFiles.map((file, idx) => (
            <div
              key={`${file.relativePath}-${idx}`}
              className="flex items-center justify-between py-0.5 px-1.5 text-[11px] text-gray-400 font-mono hover:text-gray-200 transition"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <FileText className="w-3 h-3 text-gray-500 shrink-0" />
                <span className="truncate">{file.name}</span>
              </div>
              <span className="text-gray-500 shrink-0 ml-2 text-[10px]">
                {formatBytes(file.size)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export interface SubfolderFileTreeProps {
  files: FileEntry[];
}

export const SubfolderFileTree: React.FC<SubfolderFileTreeProps> = ({ files }) => {
  const root = useMemo(() => buildTree(files), [files]);

  return (
    <div className="mt-3 pl-3 pr-2 py-2 max-h-56 overflow-y-auto border-l-2 border-[#30363d] ml-3 bg-[#0d1117] rounded-r-md">
      <TreeNodeView node={root} depth={0} />
    </div>
  );
};

export default SubfolderFileTree;
