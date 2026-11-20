import React, { useEffect } from 'react';
import {
  HelpCircle,
  X,
  KeyRound,
  Upload,
  FolderSync,
  Layers,
  Pencil,
  Settings,
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
                    Sign in immediately using a classic GitHub Personal Access Token (<code>ghp_...</code>) with read/write repository access (<code>repo</code>) and package scopes (<code>write:packages</code>, <code>read:packages</code>, and <code>delete:packages</code>), or a fine-grained PAT with <code>Contents: Read and write</code> and <code>Packages: Read and write</code>. Repositories must have at least 1 commit to be selected.
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
                    <strong>Automatic Naming:</strong> Saved PATs and OAuth Client IDs are stored under your GitHub username with a masked suffix (for example, <code>nitaidor/ghp_••••x9a2</code> or <code>nitaidor/Ov23••••4f1a</code>).
                  </li>
                  <li>
                    <strong>Quick Re-Login on Sign Out:</strong> When you click <strong>Sign Out</strong>, saved credentials appear below their respective sign-in input for one-click sign-in and account switching.
                  </li>
                  <li>
                    <strong>Inline Rename &amp; Delete:</strong> Click the <Pencil className="inline w-3.5 h-3.5 text-gray-400 align-text-bottom" /> icon on any saved credential row to set a nickname (e.g., <code>nitaidor/Desktop PAT</code>), or click the trash icon to remove it.
                  </li>
                </ul>
              </div>
            </div>
          </section>

          {/* 2. Upload Files Tab */}
          <section className="bg-[#161b22] border border-[#30363d] rounded-xl p-6 shadow-md">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2 icon-upload">
              <Upload className="w-5 h-5 icon-upload" /> 2. Upload Files Tab (Naming, Tags &amp; Version Replace)
            </h2>
            <p className="text-sm text-gray-400 mb-4">
              Available on Windows, Linux, macOS, Android, and iOS (multi-GB packages require the Desktop app). Confirm your target repository in <strong>App Settings</strong> (shown in the top badge as <code>&lt;username&gt; (&lt;reponame&gt;)</code>), choose or drag-and-drop files or folders (expandable to preview nested contents), review the package name, and click <strong>Create Image</strong>:
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-[#0d1117] border border-[#30363d] p-4 rounded-md shadow-sm">
                <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                  Single Item Selected
                </h4>
                <p className="text-sm text-gray-300">
                  Picking <strong>1 file or folder</strong> pre-fills the Image &amp; Package Name automatically from that item&apos;s name, and you can edit it before creating the image.
                </p>
              </div>
              <div className="bg-[#0d1117] border border-[#30363d] p-4 rounded-md shadow-sm">
                <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                  Multiple Items Selected
                </h4>
                <p className="text-sm text-gray-300">
                  Picking <strong>2 or more items</strong> bundles them into a single OCI image, and you <strong>must</strong> enter a package name before clicking <strong>Create Image</strong>.
                </p>
              </div>
            </div>
            <ul className="text-xs text-gray-400 mt-4 bg-[#0d1117] p-3.5 rounded border border-[#30363d] space-y-1.5 list-disc list-inside">
              <li>
                <strong>Live Version Check &amp; Replace:</strong> Clicking <strong>Create Image</strong> checks GitHub live for existing versions of that package (click any version to inspect its files). Keep all versions with <strong>New image</strong>, or select one or more existing versions to delete after upload succeeds (requires <code>delete:packages</code>).
              </li>
              <li>
                <strong>Live Timestamp Tag:</strong> The version tag defaults to a live-ticking timestamp (using your <strong>App Settings</strong> format) until manually edited. Choosing a tag already used by an unselected version is blocked unless you replace that version or pick another tag. Selected items clear automatically after upload.
              </li>
              <li>
                <strong>Cancel &amp; Multi-PC Coordination:</strong> Click <strong>Cancel</strong> at any time while an upload is running. If another PC is actively uploading or deleting the same package, your upload waits until it finishes and refreshes the version list if changes occurred.
              </li>
              <li>
                <strong>Close Protection:</strong> Closing the Desktop app is blocked while an upload, Root Folder Sync, or repository index upload is in progress until you cancel the upload or wait for it to finish (read-only index downloads remain interruptible).
              </li>
            </ul>
          </section>

          {/* 3. Sync Root Folder Tab */}
          <section className="bg-[#161b22] border border-[#30363d] rounded-xl p-6 shadow-md">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2 icon-sync">
              <FolderSync className="w-5 h-5 icon-sync" /> 3. Sync Root Folder Tab (Desktop Folder Auto-Sync)
            </h2>
            <p className="text-sm text-gray-400 mb-4">
              On Windows, Linux, and macOS, click <strong>Choose Root Folder</strong> to scan a directory, select which items to include (and expand sub-folders to preview nested trees), then press <strong>Sync Folder</strong> to review tags and GitHub version conflicts before uploading:
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-[#0d1117] border border-[#30363d] p-4 rounded-md shadow-sm">
                <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                  Rule 1: Direct Files in Root Folder
                </h4>
                <p className="text-sm text-gray-300">
                  Every direct file inside the root folder becomes its <strong>own separate image and package</strong> named after that file.
                </p>
              </div>
              <div className="bg-[#0d1117] border border-[#30363d] p-4 rounded-md shadow-sm">
                <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                  Rule 2: Sub-Folders in Root Folder
                </h4>
                <p className="text-sm text-gray-300">
                  Every immediate sub-folder bundles <strong>all nested files and directories inside it</strong> into <strong>one single package</strong> named after that sub-folder.
                </p>
              </div>
            </div>
            <p className="text-xs text-gray-400 mt-4 bg-[#0d1117] p-3.5 rounded border border-[#30363d]">
              In the review popup, set a shared <strong>Batch Tag</strong> (or override tags per item), inspect any existing GitHub versions, and choose <strong>New image</strong>, <strong>Replace</strong> (requires <code>delete:packages</code>), or <strong>Skip</strong> for each item before syncing. Active syncs can be cancelled mid-batch while keeping completed items uploaded and indexed, and closing the app is blocked while a sync or final index upload is running until you cancel or wait for it to finish.
            </p>
          </section>

          {/* 4. Repo Packages Tab */}
          <section className="bg-[#161b22] border border-[#30363d] rounded-xl p-6 shadow-md">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2 icon-packages">
              <Layers className="w-5 h-5 icon-packages" /> 4. Repo Packages Tab (Search, Inspect, Download &amp; Remove)
            </h2>
            <ul className="text-sm text-gray-300 space-y-3 list-disc list-inside">
              <li>
                <strong>Automatic Repository Linking:</strong> Uploaded images include <code>org.opencontainers.image.source</code> labels and annotations so GitHub automatically links them to the selected repository.
              </li>
              <li>
                <strong>Shared Repo Index, Folder Trees &amp; Search:</strong> Switching to <strong>Repo Packages</strong> or clicking <strong>Refresh</strong> loads your repository&apos;s compressed <code>GHCR Manager Index</code> image into RAM (keeping the newest 5 checkpoints) so file lists and inner-folder search work immediately without storing path caches on your device. Any unindexed image loads on demand when you click <strong>Load Files</strong> (streaming only archive headers) and syncs into the shared index across devices automatically.
              </li>
              <li>
                <strong>Download &amp; Extract:</strong> Pulls any selected version&apos;s <code>.tar.gz</code> OCI layer from <code>ghcr.io</code> and extracts files into a named <code>&lt;package&gt;</code> folder on Desktop (supporting multi-GB images, mid-transfer <strong>Cancel</strong>, and a <strong>Save as &quot;&lt;name&gt; (1)&quot; / Replace Existing / Cancel</strong> prompt if the folder already exists), or downloads the file / <code>.zip</code> bundle on Web and Mobile.
              </li>
              <li>
                <strong>Confirmed Deletion:</strong> Removing a single version or an entire package opens a confirmation popup before permanently deleting it on GitHub (requires <code>delete:packages</code>).
              </li>
            </ul>
          </section>

          {/* 5. Application Settings */}
          <section className="bg-[#161b22] border border-[#30363d] rounded-xl p-6 shadow-md">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2 header-logo">
              <Settings className="w-5 h-5 header-logo" /> 5. Application Settings
            </h2>
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-[#0d1117] border border-[#30363d] p-4 rounded-md shadow-sm">
                  <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                    Target Repository
                  </h4>
                  <p className="text-sm text-gray-300">
                    Switch your active repository when signed in, filter repositories by name, refresh your repository list, or open <strong>View Packages on GitHub</strong>. The active repository is shown in the header badge, and only repositories with read/write access and at least 1 commit can be selected.
                  </p>
                </div>
                <div className="bg-[#0d1117] border border-[#30363d] p-4 rounded-md shadow-sm">
                  <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                    Upload Transfer Mode
                  </h4>
                  <p className="text-sm text-gray-300">
                    On Desktop, choose <strong>Fast Stream</strong> (default) to compress and stream directly from disk with zero temporary archive files on your OS drive, fast compression for large files (<code>&ge; 64 MiB</code>), automatic retry on transient drops, and <code>4 MiB</code> chunked fallback. Switch to <strong>Chunked (4 MiB)</strong> on slower or unstable connections (uploads over ~10 minutes) to skip streaming attempts. On Mobile and Web, <strong>Chunked (4 MiB)</strong> is always active and <strong>Fast Stream</strong> is disabled (<strong>Desktop only</strong>).
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-[#0d1117] border border-[#30363d] p-4 rounded-md shadow-sm">
                  <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                    Appearance &amp; 5 Themes
                  </h4>
                  <p className="text-sm text-gray-300">
                    Switch between Dark and Light mode and pick from five color schemes: <strong>Default Dark</strong>, <strong>Green on Black</strong>, <strong>Red on Black</strong>, <strong>Default Light</strong>, and <strong>Black on White (Monochrome)</strong>.
                  </p>
                </div>
                <div className="bg-[#0d1117] border border-[#30363d] p-4 rounded-md shadow-sm">
                  <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                    Default Timestamp Tags
                  </h4>
                  <p className="text-sm text-gray-300">
                    Choose <strong>12-Hour (AM/PM)</strong> or <strong>24-Hour</strong> time and <code>YYYY-MM-DD</code>, <code>YY-MM-DD</code>, <code>DD-MM-YYYY</code>, or <code>DD-MM-YY</code> date layouts with a live preview. This also controls how version upload timestamps are displayed across the app, while existing tags on GitHub remain unchanged.
                  </p>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

export default HelpModal;
