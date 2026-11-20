<h1><img src="assets/icon.svg" alt="GHCR Manager" width="30" height="30" align="absmiddle"> GHCR Manager</h1>

A package manager to build, sync, inspect, download, and manage OCI container images on GitHub Packages (ghcr.io).

## About The Project
Pushing compiled binaries, build outputs, configs, or project folders to GitHub Packages (`ghcr.io`) traditionally requires running a Docker daemon or complex command-line tools like `oras` and `skopeo`, making quick uploads tedious on desktop and impossible on mobile devices. **GHCR Manager** turns GitHub Container Registry into a straightforward visual file and artifact package manager, building OCI container layers cleanly (zero-temp-file streaming with `4 MiB` chunked fallback on Desktop, or in-memory `4 MiB` chunked uploads on Mobile and Web) and linking them automatically to your GitHub repositories.

## Key Features

* **File, Folder & Artifact Builder:** Package a single file/folder or bundle multiple items into one OCI image, inspect nested folder trees, check existing versions live on GitHub, and tag with live timestamps or replace older versions.
* **Desktop Root Folder Auto-Sync:** Choose a root directory on Windows, Linux, or macOS, select specific files or sub-folders, preview nested contents, and review tags, conflicts, and replacements before pushing, turning direct files into separate packages and immediate sub-folders into bundled packages.
* **Package Explorer & Extractor:** Browse packages across all tagged and untagged versions, inspect nested file trees (loading unindexed image headers on demand), search package names/tags/files, extract contents into `<package>` folders on Desktop (with rename/replace prompts if a folder exists) or file / `.zip` (Mobile & local web dev), and remove individual versions or whole packages.
* **Multi-Device Shared Index & Safe Locking:** Syncs package file lists across devices inside a shared compressed OCI repository index image (`GHCR Manager Index`, keeping the newest 5 checkpoints) held in RAM with no persistent local path cache, uses account-wide per-package and index Git-ref locks to prevent concurrent overwrites across PCs, and guards against accidental app closing during active uploads and index writes.
* **Zero-Docker Architecture:** Generates POSIX USTAR/PAX `.tar.gz` layers, SHA-256 digests, and OCI manifests without Docker, using zero-temp-file continuous streaming uploads (with adaptive fast gzip compression for large files and automatic `4 MiB` chunked fallback) and disk-streamed extractions on Desktop for multi-GB packages (up to GHCR's 10 GB layer limit), plus `4 MiB` chunked uploads on Mobile and Web.
* **Saved Credentials Manager:** Supports GitHub Personal Access Tokens and OAuth Device Flow, automatically saving credentials under your username with masked suffixes (`ghp_••••xxxx` / `Ov23••••xxxx`), inline renaming, and one-click sign-in.
* **Target Repository, Transfer Mode, Timestamps & 5 Themes:** Switch target repositories, toggle **Upload Transfer Mode** (**Fast Stream** vs **Chunked (4 MiB)** on Desktop; **Chunked (4 MiB)** on Mobile/Web), customize hour and date formatting for live timestamp tags and version upload timestamps, and choose from Dark, Light, Green on Black, Red on Black, or Monochrome themes.

## Live Demo
Run GHCR Manager directly in your browser: [nitaidor.github.io/GHCR-Manager](https://nitaidor.github.io/GHCR-Manager/)

* **Supported in Live Demo:** Personal Access Token sign-in, repository browsing, viewing linked packages & versions, and removing versions or packages.
* **Requires Installed App or Local `npm run dev`:** OCI image creation & uploads, layer file inspection (`Load Files`), package downloads & extraction from `ghcr.io`, and OAuth Device Flow (blocked by browser CORS on static GitHub Pages).
* **Requires Desktop App:** Root Folder Auto-Sync (`Sync Root Folder` tab), direct extraction to a destination disk folder, and multi-GB package uploads, downloads, and external layer inspection (zero-temp-file streaming instead of held in browser/mobile RAM).

## Installation
### Option 1: Download Pre-Built Executables
Download the latest installer or portable executable directly from the [Releases page](https://github.com/nitaidor/GHCR-Manager/releases/latest).

### Option 2: Build from Source
Before you begin, ensure you have Node.js installed.

1. Clone the repository:
   ```bash
   git clone git@github.com:nitaidor/GHCR-Manager.git      # SSH
   git clone https://github.com/nitaidor/GHCR-Manager.git  # HTTPS
   ```
2. Navigate to the project directory:
   ```bash
   cd GHCR-Manager
   ```
3. Install dependencies and package the Windows desktop executables using the provided batch file:
   ```bash
   install.bat
   ```

## Usage (Development)

* Install dependencies:
   ```bash
   npm install
   ```
* Start the browser dev server (`http://localhost:5173`):
   ```bash
   npm run dev
   ```
* Start the Electron desktop app with live reload:
   ```bash
   npm run electron:dev
   ```
* Run unit tests:
   ```bash
   npm test
   ```
* Build the production web bundle (`dist/`):
   ```bash
   npm run build
   ```
* Build and launch the compiled Electron desktop app locally:
   ```bash
   npm run electron:start
   ```
* Package desktop installers/executables (`dist-exe/`):
   ```bash
   npm run dist        # Windows (alias for npm run dist:win)
   npm run dist:linux  # Linux (AppImage & deb)
   npm run dist:mac    # macOS (dmg & zip)
   ```
* Sync the web bundle into Capacitor mobile platforms (after adding `android` / `ios` with `npx cap add`):
   ```bash
   npm run cap:sync
   ```

## License
Distributed under the MIT License. See `LICENSE` for more information.

## Acknowledgments

* Desktop framework by [Electron](https://www.electronjs.org) (MIT License).
* Packaging tool by [electron-builder](https://github.com/electron-userland/electron-builder) (MIT License).
* Mobile runtime by [Capacitor](https://capacitorjs.com) (MIT License).
* Frontend library by [React](https://react.dev) (MIT License).
* Build tool by [Vite](https://vite.dev) (MIT License).
* Language by [TypeScript](https://www.typescriptlang.org) (Apache-2.0 License).
* UI framework by [Tailwind CSS](https://tailwindcss.com) (MIT License).
* Icons by [Lucide](https://lucide.dev) (ISC License).
* Compression engine by [fflate](https://github.com/101arrowz/fflate) (MIT License).

## Disclaimer
This project is an independent, open-source OCI package manager client built for use with GitHub Packages (`ghcr.io`). It is not affiliated with, endorsed by, or an official product of GitHub, Inc.
