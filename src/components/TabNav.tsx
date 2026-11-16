import React from 'react';
import { Upload, FolderSync, Layers } from 'lucide-react';

export type ActiveTab = 'upload-files' | 'sync-folder' | 'packages';

interface TabNavProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  packageCount: number;
  isDesktop: boolean;
}

export const TabNav: React.FC<TabNavProps> = ({
  activeTab,
  setActiveTab,
  packageCount,
  isDesktop,
}) => {
  return (
    <nav className="w-full max-w-4xl flex justify-start items-center gap-8 border-b border-[#30363d] -mt-1.5 mb-8 overflow-x-auto no-scrollbar relative z-10">
      {/* 1. Upload File(s) */}
      <button
        type="button"
        onClick={() => setActiveTab('upload-files')}
        className={`pb-[18px] font-medium text-sm flex items-center gap-2 transition-colors relative whitespace-nowrap cursor-pointer ${
          activeTab === 'upload-files'
            ? 'tab-active font-bold'
            : 'text-gray-500 hover:text-gray-300'
        }`}
      >
        <Upload className="w-4 h-4" /> Upload File(s)
        {activeTab === 'upload-files' && (
          <div className="absolute bottom-0 left-0 w-full h-0.5 tab-indicator rounded-t-md z-20"></div>
        )}
      </button>

      {/* 2. Sync Root Folder (Desktop Only — Disabled & Theme-Adherent in WebView) */}
      <button
        type="button"
        disabled={!isDesktop}
        title={
          !isDesktop
            ? 'This feature requires running GHCR Manager as a desktop application.'
            : ''
        }
        onClick={() => {
          if (!isDesktop) return;
          setActiveTab('sync-folder');
        }}
        className={`pb-[18px] font-medium text-sm flex items-center gap-2 transition-colors relative whitespace-nowrap ${
          !isDesktop
            ? 'tab-disabled-webview'
            : activeTab === 'sync-folder'
              ? 'tab-active font-bold cursor-pointer'
              : 'text-gray-500 hover:text-gray-300 cursor-pointer'
        }`}
      >
        <FolderSync className="w-4 h-4" /> Sync Root Folder (Desktop)
        {isDesktop && activeTab === 'sync-folder' && (
          <div className="absolute bottom-0 left-0 w-full h-0.5 tab-indicator rounded-t-md z-20"></div>
        )}
      </button>

      {/* 3. Repo Packages */}
      <button
        type="button"
        onClick={() => setActiveTab('packages')}
        className={`pb-[18px] font-medium text-sm flex items-center gap-2 transition-colors relative whitespace-nowrap cursor-pointer ${
          activeTab === 'packages'
            ? 'tab-active font-bold'
            : 'text-gray-500 hover:text-gray-300'
        }`}
      >
        <Layers className="w-4 h-4" /> Repo Packages ({packageCount})
        {activeTab === 'packages' && (
          <div className="absolute bottom-0 left-0 w-full h-0.5 tab-indicator rounded-t-md z-20"></div>
        )}
      </button>
    </nav>
  );
};

export default TabNav;
