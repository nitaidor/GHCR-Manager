import React, { useEffect } from 'react';
import {
  HelpCircle,
  X,
  KeyRound,
  Upload,
  FolderSync,
  Layers,
  Pencil,
} from 'lucide-react';

interface HelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const HelpModal: React.FC<HelpModalProps> = ({ isOpen, onClose }) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] overflow-y-auto transition-colors duration-200 bg-[#0d1117] text-[#c9d1d9] theme-bg-override">
      <div className="max-w-4xl mx-auto py-10 px-4">
        <div className="flex items-center justify-between mb-8 pb-4 border-b border-[#30363d]">
          <h1 className="text-2xl font-bold flex items-center gap-3 text-white">
            <HelpCircle className="w-8 h-8 header-logo" /> GHCR Manager Documentation
          </h1>
          <button
            type="button"
            onClick={onClose}
            className="p-2 bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] rounded-md transition-colors flex items-center gap-2 text-sm font-medium text-gray-200 hover:text-white shadow-md cursor-pointer"
          >
            <X className="w-4 h-4" /> Close Guide
          </button>
        </div>

        <div className="space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-300">
          <section>
            <p className="text-base leading-relaxed text-gray-400">
              Welcome to <strong>GHCR Manager</strong>. This tool lets you package single files, multi-file bundles, and entire desktop root folders into standard Open Container Initiative (OCI) images and push them directly to <strong>GitHub Packages (<code>ghcr.io</code>)</strong> without needing Docker installed.
            </p>
          </section>

          {/* 1. Authentication & Saved Credentials */}
          <section className="bg-[#161b22] border border-[#30363d] rounded-xl p-6 shadow-md">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2 icon-upload">
              <KeyRound className="w-5 h-5 icon-upload" /> 1. Sign-In & Saved Credentials
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-[#0d1117] border border-[#30363d] p-4 rounded-md flex flex-col gap-4 shadow-sm">
                <div>
                  <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                    Personal Access Token (PAT)
                  </h4>
                  <p className="text-sm text-gray-300">
                    Sign in immediately using a classic GitHub Personal Access Token (<code>ghp_...</code>) with the four required scopes: <code>repo</code>, <code>write:packages</code>, <code>read:packages</code>, and <code>delete:packages</code>.
                  </p>
                </div>
                <div className="border-t border-[#30363d] pt-4">
                  <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                    OAuth Device Flow (Client ID)
                  </h4>
                  <p className="text-sm text-gray-300">
                    Alternatively, enter a GitHub OAuth App Client ID (with Device Flow enabled) to generate a one-time 8-character login code and authorize in your browser.
                  </p>
                </div>
              </div>

              <div className="bg-[#0d1117] border border-[#30363d] p-4 rounded-md shadow-sm">
                <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                  Saved Credentials When Signing Out
                </h4>
                <ul className="text-sm text-gray-300 space-y-3 list-disc list-inside">
                  <li>
                    <strong>Automatic Naming:</strong> Whenever you sign in, your credential is automatically saved under your GitHub username and masked key suffix (for example, <code>nitaidor/ghp_••••x9a2</code>).
                  </li>
                  <li>
                    <strong>Quick Re-Login on Sign Out:</strong> When you click <strong>Sign Out</strong>, all saved PATs and OAuth Client IDs appear directly below the input box on their respective sign-in tab so you can sign back in or switch accounts with a single click.
                  </li>
                  <li>
                    <strong>Inline Rename & Delete:</strong> Click the <Pencil className="inline w-3.5 h-3.5 text-gray-400 align-text-bottom" /> icon on any saved credential row to give it a custom nickname (e.g., <code>nitaidor/Desktop PAT</code>), or click the trash icon to remove it.
                  </li>
                </ul>
              </div>
            </div>
          </section>

          {/* 2. Upload Files Tab */}
          <section className="bg-[#161b22] border border-[#30363d] rounded-xl p-6 shadow-md">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2 icon-upload">
              <Upload className="w-5 h-5 icon-upload" /> 2. Upload Files Tab — Naming, Tags &amp; Version Replace
            </h2>
            <p className="text-sm text-gray-400 mb-4">
              Available on Windows, Linux, macOS, Android, and iOS. Select your target repository at the top, pick or drag-and-drop one or more files or folders, then click <strong>Create Image</strong>:
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-[#0d1117] border border-[#30363d] p-4 rounded-md shadow-sm">
                <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                  Single Item Selected
                </h4>
                <p className="text-sm text-gray-300">
                  When you pick <strong>1 file or folder</strong>, the Image &amp; Package Name field automatically defaults to its name. You can either keep it as-is or type a custom name for the image.
                </p>
              </div>
              <div className="bg-[#0d1117] border border-[#30363d] p-4 rounded-md shadow-sm">
                <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                  Multiple Items Selected
                </h4>
                <p className="text-sm text-gray-300">
                  When you pick <strong>2 or more items</strong>, they are bundled together into a single OCI image, and you <strong>must</strong> enter a name for the image before creating it.
                </p>
              </div>
            </div>
            <p className="text-xs text-gray-400 mt-4 font-mono bg-[#0d1117] p-3 rounded border border-[#30363d]">
              Clicking Create Image verifies the package name live on GitHub, lets you inspect or replace any existing tagged versions of that package (or keep all existing versions with New Image), and defaults the tag to a live timestamp (configurable as 24h/12h and YYYY-MM-DD / YY-MM-DD / DD-MM-YYYY / DD-MM-YY in App Settings).
            </p>
          </section>

          {/* 3. Sync Root Folder Tab */}
          <section className="bg-[#161b22] border border-[#30363d] rounded-xl p-6 shadow-md">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2 icon-sync">
              <FolderSync className="w-5 h-5 icon-sync" /> 3. Sync Root Folder Tab (Desktop Folder Auto-Sync)
            </h2>
            <p className="text-sm text-gray-400 mb-4">
              On Windows, Linux, and macOS, click <strong>Choose Root Folder</strong> to select a local directory. When you click <strong>Sync Folder</strong>, GHCR Manager automatically creates and uploads images according to two rules:
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-[#0d1117] border border-[#30363d] p-4 rounded-md shadow-sm">
                <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                  Rule 1: Direct Files in Root Folder
                </h4>
                <p className="text-sm text-gray-300">
                  Every file placed directly inside the chosen root folder becomes its <strong>own separate image and package</strong>. The name of the image/package is the <strong>name of the file</strong>.
                </p>
              </div>
              <div className="bg-[#0d1117] border border-[#30363d] p-4 rounded-md shadow-sm">
                <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                  Rule 2: Sub-Folders in Root Folder
                </h4>
                <p className="text-sm text-gray-300">
                  Every immediate sub-folder inside the root folder bundles <strong>all files inside that sub-folder</strong> (including nested sub-directories) into <strong>one single image and package</strong>. The name of the image/package is the <strong>name of the sub-folder</strong>.
                </p>
              </div>
            </div>
          </section>

          {/* 4. Repo Packages Tab */}
          <section className="bg-[#161b22] border border-[#30363d] rounded-xl p-6 shadow-md">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2 icon-packages">
              <Layers className="w-5 h-5 icon-packages" /> 4. Repo Packages Tab (Auto-Indexing, Search, Download & Remove)
            </h2>
            <ul className="text-sm text-gray-300 space-y-3 list-disc list-inside">
              <li>
                <strong>Automatic Repository Linking:</strong> Every uploaded image includes the <code>org.opencontainers.image.source</code> label and annotation so it automatically links to your selected GitHub repository.
              </li>
              <li>
                <strong>Automatic File Indexing & Deep Search Across Versions:</strong> Switching to the <strong>Repo Packages</strong> tab or clicking <strong>Refresh</strong> lists all versions and tags for every package and indexes their file lists by SHA-256 digest—so every timestamped upload and tag is visible and searchable in nested folder trees. External images under 50 MB are streamed automatically in the background (with images over 50 MB available via on-demand <strong>Load Files</strong> header streaming without loading full contents into RAM). Typing in the search bar filters package names, version tags, and inner files, automatically expanding matching folders.
              </li>
              <li>
                <strong>Download & Extract:</strong> Pulls any selected version&apos;s <code>.tar.gz</code> OCI layer from <code>ghcr.io</code> and extracts your original files—saving them directly to a destination folder on Desktop, or downloading the original file / <code>.zip</code> bundle on Web and Mobile.
              </li>
              <li>
                <strong>Remove Version or Package:</strong> Permanently delete an individual tagged/untagged version, or remove an entire package and all of its versions using the <code>delete:packages</code> scope.
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
};

export default HelpModal;
