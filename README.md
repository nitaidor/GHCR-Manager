# GHCR Manager (v0.1.0)

A cross-platform **GHCR Manager** for **Windows, Linux, macOS, Android, and iOS** that builds and pushes standard OCI container images directly to **GitHub Packages (`ghcr.io`)** without needing Docker installed.

---

## Key Features & Naming Rules

1. **Sign in to GitHub & Pick a Repository**
   - Sign in with a GitHub Personal Access Token (`repo`, `write:packages`, `read:packages`, `delete:packages`) or via **GitHub OAuth Device Flow**.
   - Browse and select any repository in your account or organizations.
   - Every uploaded image includes the `"org.opencontainers.image.source"` label & annotation so GitHub automatically links the package to the selected repository.

2. **Upload File(s) (Windows, Linux, macOS, Android, iOS)**
   - **Single File Selected:** Defaults the image/package name to the file's name; you can keep it or enter another name.
   - **Multiple Files Selected:** Bundles all selected files into one image; you **must** enter a name for the image.
   - **Package Name = Image Name.**

3. **Sync Root Folder (Windows, Linux, macOS Desktop Mode)**
   - Choose a **Root Folder** on your computer and press **Sync Folder**:
     - **Direct files in the root folder:** Each file becomes its **own separate image/package**, named after the file.
     - **Sub-folders in the root folder:** All files inside each sub-folder (including nested files) are bundled into **one single image/package**, named after the sub-folder.

4. **View, Inspect, Download & Remove Packages**
   - **View & Inspect:** List all packages linked to the repository and inspect the exact files and sizes inside any OCI image layer.
   - **Download & Extract:** Pulls the image layer from `ghcr.io` and extracts the original files (directly to a folder on Desktop, or as the original file / `.zip` on Mobile & Web).
   - **Remove:** Deletes the container package from GitHub Packages via the GitHub REST API.

---

## Running & Building

```bash
# Run in development mode (Web / Vite with built-in OCI proxy)
npm run dev

# Run as a native Desktop app (Windows / Linux / macOS via Electron)
npm run electron:dev

# Run unit tests
npm test

# Build production bundle
npm run build
```

---

## Disclaimer

This project is an independent, open-source OCI package manager client built for use with GitHub Packages (`ghcr.io`). It is not affiliated with, endorsed by, or an official product of GitHub, Inc.

