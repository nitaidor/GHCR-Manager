<h1><img src="assets/icon.svg" alt="GHCR Manager" width="30" height="30" align="absmiddle"> GHCR Manager</h1>

A cross-platform package manager to build, sync, inspect, download, and manage OCI container images on GitHub Packages (`ghcr.io`) across Windows, Linux, macOS, Android, and iOS—without requiring Docker.

## About The Project
Pushing files or folders to GitHub Packages (`ghcr.io`) traditionally requires installing Docker or complex command-line tools like `oras` and `skopeo`, making it tedious on desktop and impossible on mobile devices. GHCR Manager was built to turn GitHub Container Registry into an effortless, visual file and folder package manager—building compliant OCI container layers directly in-memory and linking them automatically to your GitHub repositories.

## Key Features

* **File & Multi-File Image Builder:** Select a single file (keeping its file name or entering a custom image name) or bundle multiple files into a single named OCI container package.
* **Desktop Root Folder Auto-Sync:** Choose a root folder on Windows, Linux, or macOS and click **Sync Folder**—every direct file in the root folder becomes its own image, and every immediate sub-folder bundles all of its files into a single image named after the sub-folder.
* **Package Explorer & Extractor:** Browse packages linked to any repository, inspect the exact file tree and sizes inside each OCI manifest, download and extract files directly back to your device, or delete packages.
* **Zero-Docker Architecture:** Generates POSIX USTAR/PAX `.tar.gz` layers, SHA-256 digests, and OCI manifests natively in TypeScript.
* **Saved Credentials Manager:** Supports GitHub Personal Access Tokens and OAuth Device Flow, automatically saving credentials as `<username>/ghp_••••xxxx` with inline renaming and one-click sign-in.
* **5 Themes:** Dark, Light, Terminal Green, Terminal Red, and Monochrome.

## Live Demo
Run GHCR Manager directly in your browser: [nitaidor.github.io/GHCR-Manager](https://nitaidor.github.io/GHCR-Manager/)

* **Supported in Web & Mobile:** Repository browsing, single/multi-file OCI image creation & upload, manifest file inspection, `.zip`/file extraction downloads, and package removal.
* **Requires Desktop App:** Root Folder Auto-Sync (`Sync Root Folder` tab) and direct multi-file folder extraction to disk.

## Installation
### Option 1: Download Pre-Built Executables
Download the latest installer, portable executable, or mobile build directly from the [Releases page](https://github.com/nitaidor/GHCR-Manager/releases/latest).

### Option 2: Build from Source
Before you begin, ensure you have [Node.js](https://nodejs.org/) installed.

1. Clone the repository:

   **SSH:**
     ```bash
     git clone git@github.com:nitaidor/GHCR-Manager.git
     ```
   **HTTPS:**
     ```bash
     git clone https://github.com/nitaidor/GHCR-Manager.git
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

* To install dependencies manually, run:
   ```bash
   npm install
   ```
* To start the application in development mode, run:
   ```bash
   npm run dev
   ```
* To compile the production web bundle, run:
   ```bash
   npm run build
   ```
* To compile the bundle and package the Windows desktop executables, run:
   ```bash
   npm run dist
   ```

## License
Distributed under the MIT License. See `LICENSE` for more information.

## Acknowledgments

* Desktop framework by [Electron](https://www.electronjs.org) (MIT License).
* Mobile runtime by [Capacitor](https://capacitorjs.com) (MIT License).
* Frontend library by [React](https://react.dev) (MIT License).
* Build tool by [Vite](https://vite.dev) (MIT License).
* Language by [TypeScript](https://www.typescriptlang.org) (Apache-2.0 License).
* UI framework by [Tailwind CSS](https://tailwindcss.com) (MIT License).
* Icons by [Lucide](https://lucide.dev) (ISC License).
* Compression engine by [fflate](https://github.com/101arrowz/fflate) (MIT License).

## Disclaimer
This project is an independent, open-source OCI package manager client built for use with GitHub Packages (`ghcr.io`). It is not affiliated with, endorsed by, or an official product of GitHub, Inc.
