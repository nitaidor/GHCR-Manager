import { crossPlatformHttpRequest, decodeJson, decodeText } from './http';
import {
  buildOciLayerFromFiles,
  extractFileMetaListStreaming,
  extractFilesFromOciLayer,
  normalizeMemoryLimitError,
  sha256Hex,
  summarizeArchiveEntries,
  type TarInputFile,
} from './tar';
import {
  formatTimestampTag,
  getRepoIndexDisplayTitle,
  getRepoIndexPackageName,
  REPO_INDEX_KEEP_VERSIONS,
  REPO_INDEX_MODE,
  toOciImageName,
  type ClockFormat,
  type DateFormat,
} from './naming';
import pkg from '../../package.json';

export interface GitHubUser {
  login: string;
  id: number;
  avatar_url: string;
  name: string | null;
  html_url: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  description: string | null;
  updated_at: string;
  owner: {
    login: string;
    avatar_url: string;
    type: 'User' | 'Organization';
  };
}

export interface GitHubPackageItem {
  id: number;
  name: string;
  package_type: string;
  visibility: 'public' | 'private' | 'internal';
  html_url: string;
  created_at: string;
  updated_at: string;
  owner: {
    login: string;
    type: 'User' | 'Organization';
  };
  repository?: {
    id: number;
    name: string;
    full_name: string;
    html_url: string;
  } | null;
}

export interface GitHubPackageVersion {
  id: number;
  /** Manifest digest string returned by GitHub Packages API (e.g. "sha256:...") */
  name: string;
  url?: string;
  package_html_url?: string;
  html_url?: string;
  created_at: string;
  updated_at: string;
  metadata?: {
    package_type?: string;
    container?: {
      tags?: string[];
    };
  };
}

export interface LivePackageState {
  exists: boolean;
  packageItem: GitHubPackageItem | null;
  versions: GitHubPackageVersion[];
}

export interface GitHubAuthInfo {
  user: GitHubUser;
  /** Lower-cased OAuth scopes reported by GitHub, or null when omitted (e.g. fine-grained PAT). */
  oauthScopes: string[] | null;
}

export function getVersionReferenceInfo(version: GitHubPackageVersion): {
  tags: string[];
  primaryTag: string;
  isUntagged: boolean;
  shortDigest: string;
  inspectRef: string;
  pullSuffix: string;
} {
  const tags = (version.metadata?.container?.tags || []).filter(Boolean);
  const primaryTag = tags[0] || '';
  const isUntagged = tags.length === 0;
  const digest = version.name || '';
  const shortDigest = digest.startsWith('sha256:')
    ? `${digest.slice(0, 19)}…`
    : digest.slice(0, 16);
  const inspectRef = digest.startsWith('sha256:') ? digest : primaryTag || digest;
  const pullSuffix = primaryTag ? `:${primaryTag}` : `@${digest}`;
  return { tags, primaryTag, isUntagged, shortDigest, inspectRef, pullSuffix };
}

export interface OciManifestFileMeta {
  path: string;
  size: number;
  isDirectory?: boolean;
}

export interface OciPackageDetails {
  packageName: string;
  tag: string;
  manifestDigest?: string;
  layerDigest: string;
  compressedSize: number;
  totalUncompressedBytes: number;
  fileCount: number;
  originalName: string;
  mode: string;
  createdAt: string;
  sourceRepoUrl: string;
  files: OciManifestFileMeta[];
  needsManualLoad?: boolean;
}

export type PushProgressStage =
  | 'archiving'
  | 'authenticating'
  | 'uploading-config'
  | 'uploading-layer'
  | 'publishing-manifest'
  | 'done';

export interface PushProgressUpdate {
  stage: PushProgressStage;
  message: string;
  percent: number;
}

export interface DesktopStreamingInputFile {
  fullPath: string;
  relativePath: string;
  size?: number;
  mtime?: number;
  isDirectory?: boolean;
}

const encoder = new TextEncoder();

function toBase64(str: string): string {
  const bytes = encoder.encode(str);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function githubApiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token.trim()}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': `GHCR-Manager/${pkg.version}`,
  };
}

/**
 * Verifies the GitHub token, fetches the authenticated user profile, and reads reported OAuth scopes.
 */
export async function fetchGitHubAuthInfo(token: string): Promise<GitHubAuthInfo> {
  const res = await crossPlatformHttpRequest({
    url: 'https://api.github.com/user',
    method: 'GET',
    headers: githubApiHeaders(token),
  });

  if (res.status !== 200) {
    let msg = `GitHub authentication failed (HTTP ${res.status})`;
    try {
      const errJson = decodeJson<{ message?: string }>(res.body);
      if (errJson.message) msg = errJson.message;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }

  const rawScopes = res.headers['x-oauth-scopes'];
  const oauthScopes =
    typeof rawScopes === 'string'
      ? rawScopes
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      : null;

  return {
    user: decodeJson<GitHubUser>(res.body),
    oauthScopes,
  };
}

/**
 * Verifies the GitHub token and fetches the authenticated user profile.
 */
export async function fetchGitHubUser(token: string): Promise<GitHubUser> {
  const { user } = await fetchGitHubAuthInfo(token);
  return user;
}

/**
 * Initiates GitHub OAuth Device Flow using a GitHub OAuth App Client ID.
 */
export async function startGitHubDeviceFlow(clientId: string): Promise<{
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}> {
  const body = new URLSearchParams({
    client_id: clientId.trim(),
    scope: 'repo write:packages read:packages delete:packages',
  }).toString();

  const res = await crossPlatformHttpRequest({
    url: 'https://github.com/login/device/code',
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (res.status !== 200) {
    throw new Error(`Failed to initiate GitHub Device Flow (HTTP ${res.status})`);
  }

  const data = decodeJson<{
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
    error_description?: string;
  }>(res.body);

  if (data.error || !data.device_code || !data.user_code) {
    throw new Error(data.error_description || data.error || 'Invalid Device Flow response');
  }

  return {
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: data.verification_uri || 'https://github.com/login/device',
    expires_in: data.expires_in || 900,
    interval: data.interval || 5,
  };
}

/**
 * Polls GitHub OAuth Device Flow once for an access token.
 */
export async function pollGitHubDeviceFlowToken(
  clientId: string,
  deviceCode: string
): Promise<{ status: 'pending' | 'slow_down' | 'success'; accessToken?: string }> {
  const body = new URLSearchParams({
    client_id: clientId.trim(),
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  }).toString();

  const res = await crossPlatformHttpRequest({
    url: 'https://github.com/login/oauth/access_token',
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const data = decodeJson<{
    access_token?: string;
    error?: string;
    error_description?: string;
  }>(res.body);

  if (data.access_token) {
    return { status: 'success', accessToken: data.access_token };
  }
  if (data.error === 'authorization_pending') {
    return { status: 'pending' };
  }
  if (data.error === 'slow_down') {
    return { status: 'slow_down' };
  }
  throw new Error(data.error_description || data.error || 'Device flow authorization failed');
}

/**
 * Lists repositories accessible to the authenticated user.
 */
export async function listUserRepositories(token: string): Promise<GitHubRepo[]> {
  const res = await crossPlatformHttpRequest({
    url: 'https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member',
    method: 'GET',
    headers: githubApiHeaders(token),
  });

  if (res.status !== 200) {
    throw new Error(`Failed to fetch repositories (HTTP ${res.status})`);
  }

  return decodeJson<GitHubRepo[]>(res.body);
}

/**
 * Exchanges a GitHub token for a ghcr.io OCI Bearer token for the given owner/package and scopes.
 */
async function getGhcrBearerToken(
  username: string,
  githubToken: string,
  owner: string,
  ociPackageName: string,
  scopes: string = 'pull,push'
): Promise<string> {
  const ownerLower = owner.toLowerCase();
  const pkgLower = toOciImageName(ociPackageName);
  const scopeParam = encodeURIComponent(`repository:${ownerLower}/${pkgLower}:${scopes}`);
  const url = `https://ghcr.io/token?service=ghcr.io&scope=${scopeParam}`;

  const basic = toBase64(`${username}:${githubToken.trim()}`);
  const res = await crossPlatformHttpRequest({
    url,
    method: 'GET',
    headers: {
      Authorization: `Basic ${basic}`,
      Accept: 'application/json',
    },
  });

  if (res.status !== 200) {
    const errText = decodeText(res.body);
    throw new Error(
      `Failed to authenticate with ghcr.io (HTTP ${res.status}). Make sure your GitHub token has 'write:packages' and 'read:packages' scopes. Details: ${errText}`
    );
  }

  const data = decodeJson<{ token?: string; access_token?: string }>(res.body);
  const bearer = data.token || data.access_token;
  if (!bearer) {
    throw new Error('ghcr.io did not return a valid registry bearer token.');
  }
  return bearer;
}

/**
 * Uploads a single blob (config or layer) to ghcr.io using POST + PUT monolithic upload.
 */
async function uploadBlobToGhcr(
  registryToken: string,
  ownerLower: string,
  pkgLower: string,
  digest: string,
  blobBytes: Uint8Array,
  signal?: AbortSignal
): Promise<void> {
  // 1. Check if blob already exists in registry
  const headRes = await crossPlatformHttpRequest({
    url: `https://ghcr.io/v2/${ownerLower}/${pkgLower}/blobs/${digest}`,
    method: 'HEAD',
    headers: {
      Authorization: `Bearer ${registryToken}`,
    },
    signal,
  });
  if (headRes.status === 200) {
    return; // Already uploaded!
  }

  // 2. Initiate upload session
  const startRes = await crossPlatformHttpRequest({
    url: `https://ghcr.io/v2/${ownerLower}/${pkgLower}/blobs/uploads/`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${registryToken}`,
      'Content-Length': '0',
    },
    signal,
  });

  if (startRes.status !== 202) {
    const bodyText = decodeText(startRes.body);
    throw new Error(
      `Failed to initiate blob upload to ghcr.io (HTTP ${startRes.status}): ${bodyText}`
    );
  }

  const locationHeader = startRes.headers['location'];
  if (!locationHeader) {
    throw new Error('ghcr.io blob upload response missing Location header.');
  }

  const uploadUrlObj = new URL(locationHeader, 'https://ghcr.io');
  uploadUrlObj.searchParams.set('digest', digest);

  // 3. Complete upload with PUT
  const putRes = await crossPlatformHttpRequest({
    url: uploadUrlObj.toString(),
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${registryToken}`,
      'Content-Type': 'application/octet-stream',
    },
    body: blobBytes,
    signal,
  });

  if (putRes.status !== 201 && putRes.status !== 202) {
    const bodyText = decodeText(putRes.body);
    throw new Error(
      `Failed to finish blob upload to ghcr.io (HTTP ${putRes.status}): ${bodyText}`
    );
  }
}

/**
 * Creates an OCI container image from the given files (or Desktop disk paths for zero-RAM streaming)
 * and pushes it to GitHub Packages (ghcr.io), automatically linking it to the selected GitHub repository.
 *
 * Package Name === Image Name (normalized for OCI compliance).
 */
export async function buildAndPushOciImage(opts: {
  username: string;
  githubToken: string;
  repo: GitHubRepo;
  rawImageName: string;
  ociPackageNameOverride?: string;
  tag?: string;
  mode: 'single-file' | 'multi-file' | 'root-file' | 'root-subfolder' | 'repo-index';
  files?: TarInputFile[];
  desktopFiles?: DesktopStreamingInputFile[];
  onProgress?: (update: PushProgressUpdate) => void;
  signal?: AbortSignal;
}): Promise<OciPackageDetails> {
  const {
    username,
    githubToken,
    repo,
    rawImageName,
    ociPackageNameOverride,
    tag = 'latest',
    mode,
    files = [],
    desktopFiles,
    onProgress,
    signal,
  } = opts;

  if (signal?.aborted) {
    throw new DOMException('Upload cancelled', 'AbortError');
  }

  const canStreamDesktop =
    Boolean(desktopFiles && desktopFiles.length > 0) &&
    Boolean(window.electronAPI?.buildOciLayerFile) &&
    Boolean(window.electronAPI?.uploadBlobFromFile);

  const sourceEntries = canStreamDesktop ? desktopFiles! : files;
  if (sourceEntries.length === 0) {
    throw new Error('Cannot create an image with zero files or folders.');
  }

  const { regularFileCount: itemCount, emptyFolderCount } = summarizeArchiveEntries(
    sourceEntries.map((f) => ({
      path: f.relativePath,
      isDirectory: f.isDirectory,
    }))
  );

  const ociPackageName = ociPackageNameOverride || toOciImageName(rawImageName);
  if (!ociPackageName) {
    throw new Error(`Invalid image name: "${rawImageName}"`);
  }

  const ownerLower = repo.owner.login.toLowerCase();
  const requestId = `push_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const unsubscribeProgress =
    canStreamDesktop && window.electronAPI?.onTransferProgress
      ? window.electronAPI.onTransferProgress((payload) => {
          if (payload.requestId !== requestId) return;
          onProgress?.({
            stage:
              payload.stage === 'uploading-layer' ? 'uploading-layer' : 'archiving',
            message: payload.message,
            percent: payload.percent,
          });
        })
      : undefined;

  const abortHandler = signal
    ? () => {
        window.electronAPI?.cancelTransfer?.(requestId);
      }
    : undefined;
  if (signal && abortHandler) {
    signal.addEventListener('abort', abortHandler, { once: true });
  }

  let tempLayerPath: string | null = null;

  try {
    onProgress?.({
      stage: 'archiving',
      message:
        itemCount > 0
          ? `Building OCI image "${ociPackageName}" from ${itemCount} file(s)...`
          : `Building OCI image "${ociPackageName}" (empty folder${
              emptyFolderCount === 1 ? '' : 's'
            })...`,
      percent: 10,
    });

    // 1. Build .tar.gz layer (streaming via disk on Desktop, or in-memory on Web/Mobile)
    let uncompressedDigest: string;
    let compressedDigest: string;
    let compressedSize: number;
    let totalFileBytes: number;
    let fileMetaList: OciManifestFileMeta[];
    let inMemoryTargz: Uint8Array | null = null;

    if (canStreamDesktop) {
      const built = await window.electronAPI!.buildOciLayerFile!({
        files: desktopFiles!,
        requestId,
      });
      tempLayerPath = built.tempPath;
      uncompressedDigest = built.uncompressedDigest;
      compressedDigest = built.compressedDigest;
      compressedSize = built.compressedSize;
      totalFileBytes = built.totalFileBytes;
      fileMetaList = built.fileMetaList;
    } else {
      let layer;
      try {
        layer = await buildOciLayerFromFiles(files);
      } catch (err) {
        throw normalizeMemoryLimitError(err, 'upload');
      }
      uncompressedDigest = layer.uncompressedDigest;
      compressedDigest = layer.compressedDigest;
      compressedSize = layer.compressedSize;
      totalFileBytes = layer.totalFileBytes;
      inMemoryTargz = layer.targzBytes;
      fileMetaList = files.map((f) => {
        const clean =
          f.relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || '.';
        return f.isDirectory
          ? { path: clean, size: 0, isDirectory: true }
          : { path: clean, size: f.data.byteLength };
      });
    }

    const createdAt = new Date().toISOString();

    // 2. Build OCI Image Config JSON
    // Including "org.opencontainers.image.source" links the package to the chosen GitHub repo!
    const configObj = {
      created: createdAt,
      architecture: 'amd64',
      os: 'linux',
      config: {
        Labels: {
          'org.opencontainers.image.source': repo.html_url,
          'org.opencontainers.image.title': ociPackageName,
          'org.opencontainers.image.description': `Created by GHCR Manager (${itemCount} file(s), mode: ${mode})`,
          'io.ghpm.original-name': rawImageName,
          'io.ghpm.mode': mode,
          'io.ghpm.file-count': String(itemCount),
          'io.ghpm.total-bytes': String(totalFileBytes),
        },
      },
      rootfs: {
        type: 'layers',
        diff_ids: [uncompressedDigest],
      },
      history: [
        {
          created: createdAt,
          created_by: `ghcr-manager (${mode})`,
        },
      ],
    };

    const configBytes = encoder.encode(JSON.stringify(configObj));
    const configHex = await sha256Hex(configBytes);
    const configDigest = `sha256:${configHex}`;

    // 3. Build OCI Image Manifest JSON
    const manifestObj = {
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: {
        mediaType: 'application/vnd.oci.image.config.v1+json',
        size: configBytes.byteLength,
        digest: configDigest,
      },
      layers: [
        {
          mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
          size: compressedSize,
          digest: compressedDigest,
          annotations: {
            'org.opencontainers.image.title': `${ociPackageName}.tar.gz`,
          },
        },
      ],
      annotations: {
        'org.opencontainers.image.source': repo.html_url,
        'org.opencontainers.image.created': createdAt,
        'org.opencontainers.image.title': ociPackageName,
        'org.opencontainers.image.description': `Package "${rawImageName}" (${itemCount} file(s)) linked to ${repo.full_name}`,
        'io.ghpm.original-name': rawImageName,
        'io.ghpm.mode': mode,
        'io.ghpm.file-count': String(itemCount),
        'io.ghpm.total-bytes': String(totalFileBytes),
      },
    };

    const manifestBytes = encoder.encode(JSON.stringify(manifestObj, null, 2));

    // 4. Authenticate with ghcr.io
    onProgress?.({
      stage: 'authenticating',
      message: `Authenticating with ghcr.io/${ownerLower}/${ociPackageName}...`,
      percent: 48,
    });

    let registryToken = await getGhcrBearerToken(
      username,
      githubToken,
      ownerLower,
      ociPackageName,
      'pull,push'
    );

    // 5. Upload Config Blob
    if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
    onProgress?.({
      stage: 'uploading-config',
      message: `Uploading image configuration (${configBytes.byteLength} B)...`,
      percent: 52,
    });

    await uploadBlobToGhcr(
      registryToken,
      ownerLower,
      ociPackageName,
      configDigest,
      configBytes,
      signal
    );

    // 6. Upload Layer Blob (.tar.gz)
    if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
    onProgress?.({
      stage: 'uploading-layer',
      message: `Uploading compressed image layer (${formatBytes(compressedSize)})...`,
      percent: 55,
    });

    if (canStreamDesktop && tempLayerPath) {
      const headRes = await crossPlatformHttpRequest({
        url: `https://ghcr.io/v2/${ownerLower}/${ociPackageName}/blobs/${compressedDigest}`,
        method: 'HEAD',
        headers: { Authorization: `Bearer ${registryToken}` },
        signal,
      });

      if (headRes.status !== 200) {
        const uploadResult = await window.electronAPI!.uploadBlobFromFile!({
          tempPath: tempLayerPath,
          uploadInitUrl: `https://ghcr.io/v2/${ownerLower}/${ociPackageName}/blobs/uploads/`,
          digest: compressedDigest,
          registryToken,
          basicAuthHeader: `Basic ${toBase64(`${username}:${githubToken.trim()}`)}`,
          scopeParam: `repository:${ownerLower}/${ociPackageName}:pull,push`,
          compressedSize,
          requestId,
        });
        if (uploadResult?.registryToken) {
          registryToken = uploadResult.registryToken;
        }
      }
    } else if (inMemoryTargz) {
      try {
        await uploadBlobToGhcr(
          registryToken,
          ownerLower,
          ociPackageName,
          compressedDigest,
          inMemoryTargz,
          signal
        );
      } catch (err) {
        throw normalizeMemoryLimitError(err, 'upload');
      }
    }

    // 7. Publish Manifest
    if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
    onProgress?.({
      stage: 'publishing-manifest',
      message: `Publishing manifest ghcr.io/${ownerLower}/${ociPackageName}:${tag}...`,
      percent: 94,
    });

    const manifestRes = await crossPlatformHttpRequest({
      url: `https://ghcr.io/v2/${ownerLower}/${ociPackageName}/manifests/${encodeURIComponent(tag)}`,
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${registryToken}`,
        'Content-Type': 'application/vnd.oci.image.manifest.v1+json',
      },
      body: manifestBytes,
      signal,
    });

    if (manifestRes.status !== 201 && manifestRes.status !== 200) {
      const errText = decodeText(manifestRes.body);
      throw new Error(
        `Failed to publish image manifest to ghcr.io (HTTP ${manifestRes.status}): ${errText}`
      );
    }

    const manifestDigest =
      manifestRes.headers['docker-content-digest'] || `sha256:${await sha256Hex(manifestBytes)}`;

    onProgress?.({
      stage: 'done',
      message: `Successfully uploaded package "${ociPackageName}"!`,
      percent: 100,
    });

    return {
      packageName: ociPackageName,
      tag,
      manifestDigest,
      layerDigest: compressedDigest,
      compressedSize,
      totalUncompressedBytes: totalFileBytes,
      fileCount: itemCount,
      originalName: rawImageName,
      mode,
      createdAt,
      sourceRepoUrl: repo.html_url,
      files: fileMetaList,
    };
  } finally {
    unsubscribeProgress?.();
    if (signal && abortHandler) {
      signal.removeEventListener('abort', abortHandler);
    }
    if (tempLayerPath && window.electronAPI?.deleteTempFile) {
      await window.electronAPI.deleteTempFile(tempLayerPath).catch(() => {});
    }
  }
}

/**
 * Lists container packages for the selected repository's owner, separating those linked
 * directly to the chosen repository and any other container packages owned by the user/org.
 */
export async function listPackagesForRepo(
  githubToken: string,
  currentUserLogin: string,
  repo: GitHubRepo
): Promise<{
  repoPackages: GitHubPackageItem[];
  otherOwnerPackages: GitHubPackageItem[];
}> {
  const ownerLogin = repo.owner.login;
  const isCurrentUser = ownerLogin.toLowerCase() === currentUserLogin.toLowerCase();

  let endpoint = 'https://api.github.com/user/packages?package_type=container&per_page=100';
  if (!isCurrentUser) {
    endpoint =
      repo.owner.type === 'Organization'
        ? `https://api.github.com/orgs/${encodeURIComponent(ownerLogin)}/packages?package_type=container&per_page=100`
        : `https://api.github.com/users/${encodeURIComponent(ownerLogin)}/packages?package_type=container&per_page=100`;
  }

  const res = await crossPlatformHttpRequest({
    url: endpoint,
    method: 'GET',
    headers: githubApiHeaders(githubToken),
  });

  if (res.status !== 200) {
    // If token lacks read:packages or user has 0 packages, handle gracefully
    const errText = decodeText(res.body);
    throw new Error(
      `Failed to list packages (HTTP ${res.status}). Ensure your token includes 'read:packages'. Details: ${errText}`
    );
  }

  const allPackages = decodeJson<GitHubPackageItem[]>(res.body);
  const repoPackages: GitHubPackageItem[] = [];
  const otherOwnerPackages: GitHubPackageItem[] = [];

  for (const pkg of allPackages) {
    const matchesRepo =
      pkg.repository &&
      (pkg.repository.id === repo.id ||
        pkg.repository.full_name.toLowerCase() === repo.full_name.toLowerCase());

    if (matchesRepo) {
      repoPackages.push(pkg);
    } else {
      otherOwnerPackages.push(pkg);
    }
  }

  return { repoPackages, otherOwnerPackages };
}

export interface RepoIndexVersionRecord {
  packageName: string;
  manifestDigest: string;
  layerDigest: string;
  compressedSize: number;
  totalUncompressedBytes: number;
  fileCount: number;
  originalName: string;
  mode: string;
  createdAt: string;
  sourceRepoUrl: string;
  files: OciManifestFileMeta[];
}

export interface RepoIndexPayload {
  schemaVersion: 1;
  repoFullName: string;
  updatedAt: string;
  /** Keyed by `${packageName.toLowerCase()}@${manifestDigest}` */
  versions: Record<string, RepoIndexVersionRecord>;
}

export function sortPackageVersionsNewestFirst(
  versions: GitHubPackageVersion[],
  prioritizeDigest?: string
): GitHubPackageVersion[] {
  return [...versions].sort((a, b) => {
    if (prioritizeDigest) {
      if (a.name === prioritizeDigest && b.name !== prioritizeDigest) return -1;
      if (b.name === prioritizeDigest && a.name !== prioritizeDigest) return 1;
    }
    const ta = new Date(a.updated_at || a.created_at || 0).getTime();
    const tb = new Date(b.updated_at || b.created_at || 0).getTime();
    if (tb !== ta) return tb - ta;
    return b.id - a.id;
  });
}

export function ociDetailsToIndexRecord(
  pkgName: string,
  manifestDigest: string,
  details: OciPackageDetails
): RepoIndexVersionRecord {
  return {
    packageName: pkgName.toLowerCase(),
    manifestDigest,
    layerDigest: details.layerDigest,
    compressedSize: details.compressedSize,
    totalUncompressedBytes: details.totalUncompressedBytes,
    fileCount: details.fileCount,
    originalName: details.originalName,
    mode: details.mode,
    createdAt: details.createdAt,
    sourceRepoUrl: details.sourceRepoUrl,
    files: details.files,
  };
}

export function indexRecordToOciDetails(
  record: RepoIndexVersionRecord,
  tag: string
): OciPackageDetails {
  return {
    packageName: record.packageName,
    tag,
    manifestDigest: record.manifestDigest,
    layerDigest: record.layerDigest,
    compressedSize: record.compressedSize,
    totalUncompressedBytes: record.totalUncompressedBytes,
    fileCount: record.fileCount,
    originalName: record.originalName,
    mode: record.mode,
    createdAt: record.createdAt,
    sourceRepoUrl: record.sourceRepoUrl,
    files: record.files,
    needsManualLoad: false,
  };
}

/**
 * Inspects an OCI package's manifest on ghcr.io to retrieve its file list, sizes, and metadata.
 */
export async function inspectPackageManifest(opts: {
  username: string;
  githubToken: string;
  owner: string;
  packageName: string;
  tag?: string;
  reference?: string;
  forceLoadLayer?: boolean;
  skipLayerScan?: boolean;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
  requestId?: string;
}): Promise<OciPackageDetails> {
  const {
    username,
    githubToken,
    owner,
    packageName,
    tag = 'latest',
    reference,
    forceLoadLayer = false,
    skipLayerScan = false,
    onProgress,
    signal,
    requestId,
  } = opts;
  const ownerLower = owner.toLowerCase();
  const pkgLower = packageName.toLowerCase();
  const manifestRef = reference || tag;

  if (signal?.aborted) {
    throw new DOMException('Layer scan aborted', 'AbortError');
  }

  const registryToken = await getGhcrBearerToken(
    username,
    githubToken,
    ownerLower,
    pkgLower,
    'pull'
  );

  const res = await crossPlatformHttpRequest({
    url: `https://ghcr.io/v2/${ownerLower}/${pkgLower}/manifests/${encodeURIComponent(manifestRef)}`,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${registryToken}`,
      Accept:
        'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json',
    },
  });

  if (res.status !== 200) {
    throw new Error(
      `Could not fetch manifest for ${pkgLower}:${tag || manifestRef} (HTTP ${res.status})`
    );
  }

  const manifest = decodeJson<{
    layers?: Array<{ digest: string; size: number }>;
    annotations?: Record<string, string>;
  }>(res.body);

  const firstLayer = manifest.layers?.[0];
  const annotations = manifest.annotations || {};
  const compressedSize = firstLayer?.size || 0;
  const layerDigest = firstLayer?.digest || '';

  let files: OciManifestFileMeta[] = [];
  let needsManualLoad = false;

  if (annotations['io.ghpm.file-list'] && !forceLoadLayer) {
    try {
      files = JSON.parse(annotations['io.ghpm.file-list']) as OciManifestFileMeta[];
    } catch {
      files = [];
    }
  } else if (layerDigest && !skipLayerScan) {
    if (!forceLoadLayer) {
      needsManualLoad = true;
    } else {
      const layerUrl = `https://ghcr.io/v2/${ownerLower}/${pkgLower}/blobs/${layerDigest}`;
      if (typeof window !== 'undefined' && window.electronAPI?.streamLayerFileList) {
        const reqId =
          requestId || `stream_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        let unsubProgress: (() => void) | undefined;
        let abortHandler: (() => void) | undefined;

        if (onProgress && window.electronAPI.onLayerStreamProgress) {
          unsubProgress = window.electronAPI.onLayerStreamProgress((p) => {
            if (p.requestId === reqId) onProgress(p.percent);
          });
        }

        if (signal) {
          if (signal.aborted) {
            unsubProgress?.();
            throw new DOMException('Layer scan aborted', 'AbortError');
          }
          abortHandler = () => {
            window.electronAPI?.cancelLayerStream?.(reqId);
          };
          signal.addEventListener('abort', abortHandler, { once: true });
        }

        try {
          const streamRes = await window.electronAPI.streamLayerFileList({
            url: layerUrl,
            registryToken,
            expectedSize: compressedSize,
            requestId: reqId,
          });
          files = streamRes.files;
        } finally {
          unsubProgress?.();
          if (signal && abortHandler) {
            signal.removeEventListener('abort', abortHandler);
          }
        }
      } else {
        if (signal?.aborted) {
          throw new DOMException('Layer scan aborted', 'AbortError');
        }
        onProgress?.(5);
        try {
          const blobRes = await crossPlatformHttpRequest({
            url: layerUrl,
            method: 'GET',
            headers: {
              Authorization: `Bearer ${registryToken}`,
            },
            signal,
          });
          if (signal?.aborted) {
            throw new DOMException('Layer scan aborted', 'AbortError');
          }
          if (blobRes.status !== 200) {
            throw new Error(`Failed to download layer blob (HTTP ${blobRes.status})`);
          }
          files = await extractFileMetaListStreaming(blobRes.body, {
            onProgress: (pct) => onProgress?.(Math.max(5, pct)),
            signal,
          });
        } catch (err) {
          throw normalizeMemoryLimitError(err, 'inspect');
        }
      }
    }
  }

  const { regularFileCount } = summarizeArchiveEntries(files);
  const computedTotalBytes =
    files.length > 0
      ? files.reduce((acc, f) => acc + (f.isDirectory ? 0 : f.size), 0)
      : compressedSize;
  const hasTotalBytesAnnotation =
    annotations['io.ghpm.total-bytes'] !== undefined &&
    annotations['io.ghpm.total-bytes'] !== '' &&
    Number.isFinite(Number(annotations['io.ghpm.total-bytes']));
  const totalUncompressedBytes = hasTotalBytesAnnotation
    ? Number(annotations['io.ghpm.total-bytes'])
    : computedTotalBytes;

  const hasFileCountAnnotation =
    annotations['io.ghpm.file-count'] !== undefined &&
    annotations['io.ghpm.file-count'] !== '' &&
    Number.isFinite(Number(annotations['io.ghpm.file-count']));
  const fileCount = hasFileCountAnnotation
    ? Number(annotations['io.ghpm.file-count'])
    : files.length > 0
    ? regularFileCount
    : 0;

  return {
    packageName: pkgLower,
    tag,
    manifestDigest:
      res.headers['docker-content-digest'] ||
      (manifestRef.startsWith('sha256:') ? manifestRef : undefined),
    layerDigest,
    compressedSize,
    totalUncompressedBytes,
    fileCount,
    originalName: annotations['io.ghpm.original-name'] || pkgLower,
    mode: annotations['io.ghpm.mode'] || 'external-oci-image',
    createdAt: annotations['org.opencontainers.image.created'] || '',
    sourceRepoUrl: annotations['org.opencontainers.image.source'] || '',
    files,
    needsManualLoad,
  };
}

/**
 * Fetches and parses the newest snapshot from `ghcr-manager-index_<repo>` into RAM.
 */
export async function fetchLatestRepoIndex(opts: {
  username: string;
  githubToken: string;
  owner: string;
  packageName: string;
  versions: GitHubPackageVersion[];
}): Promise<{
  payload: RepoIndexPayload | null;
  latestVersion: GitHubPackageVersion | null;
  indexDetails: OciPackageDetails | null;
}> {
  const sorted = sortPackageVersionsNewestFirst(opts.versions);
  const latest = sorted[0] || null;
  if (!latest) {
    return { payload: null, latestVersion: null, indexDetails: null };
  }

  const info = getVersionReferenceInfo(latest);
  const manifestDetails = await inspectPackageManifest({
    username: opts.username,
    githubToken: opts.githubToken,
    owner: opts.owner,
    packageName: opts.packageName,
    tag: info.primaryTag || info.shortDigest,
    reference: info.inspectRef,
    skipLayerScan: true,
  });

  if (!manifestDetails.layerDigest) {
    return { payload: null, latestVersion: latest, indexDetails: manifestDetails };
  }

  const ownerLower = opts.owner.toLowerCase();
  const pkgLower = opts.packageName.toLowerCase();
  const registryToken = await getGhcrBearerToken(
    opts.username,
    opts.githubToken,
    ownerLower,
    pkgLower,
    'pull'
  );

  const blobRes = await crossPlatformHttpRequest({
    url: `https://ghcr.io/v2/${ownerLower}/${pkgLower}/blobs/${manifestDetails.layerDigest}`,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${registryToken}`,
    },
  });

  if (blobRes.status !== 200) {
    throw new Error(`Failed to fetch repository index blob (HTTP ${blobRes.status})`);
  }

  const extracted = extractFilesFromOciLayer(blobRes.body);
  const indexFile = extracted.find(
    (f) => !f.isDirectory && f.relativePath.replace(/^\/+/, '') === 'index.json'
  );
  if (!indexFile) {
    return { payload: null, latestVersion: latest, indexDetails: manifestDetails };
  }

  const parsed = decodeJson<RepoIndexPayload>(indexFile.data);
  const normalizedDetails: OciPackageDetails = {
    ...manifestDetails,
    files: extracted.map((f) => ({
      path: f.relativePath,
      size: f.isDirectory ? 0 : f.data.byteLength,
      ...(f.isDirectory ? { isDirectory: true } : {}),
    })),
    needsManualLoad: false,
  };

  return {
    payload:
      parsed && typeof parsed === 'object' && parsed.versions && typeof parsed.versions === 'object'
        ? parsed
        : null,
    latestVersion: latest,
    indexDetails: normalizedDetails,
  };
}

/**
 * Uploads a new timestamped `GHCR Manager Index - <repo>` snapshot and prunes older
 * checkpoints beyond the newest 5 versions only after the upload succeeds.
 */
export async function publishRepoIndexSnapshot(opts: {
  username: string;
  githubToken: string;
  currentUserLogin: string;
  repo: GitHubRepo;
  payload: RepoIndexPayload;
  clockFormat: ClockFormat;
  dateFormat: DateFormat;
  canDeletePackages: boolean;
}): Promise<{
  indexPackage: GitHubPackageItem | null;
  versions: GitHubPackageVersion[];
  indexDetails: OciPackageDetails;
}> {
  const ociIndexPkgName = getRepoIndexPackageName(opts.repo.name);
  const jsonBytes = encoder.encode(JSON.stringify(opts.payload));
  const tag = formatTimestampTag(new Date(), opts.clockFormat, opts.dateFormat);

  const details = await buildAndPushOciImage({
    username: opts.username,
    githubToken: opts.githubToken,
    repo: opts.repo,
    rawImageName: getRepoIndexDisplayTitle(opts.repo.name),
    ociPackageNameOverride: ociIndexPkgName,
    tag,
    mode: REPO_INDEX_MODE,
    files: [
      {
        relativePath: 'index.json',
        data: jsonBytes,
        mtime: Math.floor(Date.now() / 1000),
      },
    ],
  });

  const live = await fetchLivePackageState({
    githubToken: opts.githubToken,
    currentUserLogin: opts.currentUserLogin,
    owner: opts.repo.owner.login,
    ownerType: opts.repo.owner.type,
    packageName: ociIndexPkgName,
  });

  const sorted = sortPackageVersionsNewestFirst(live.versions, details.manifestDigest);
  const obsolete = sorted.slice(REPO_INDEX_KEEP_VERSIONS);
  const deletedIds = new Set<number>();

  if (obsolete.length > 0 && opts.canDeletePackages) {
    const ownerLogin = live.packageItem?.owner.login || opts.repo.owner.login;
    const ownerType = live.packageItem?.owner.type || opts.repo.owner.type;
    await deleteReplacedVersions({
      githubToken: opts.githubToken,
      currentUserLogin: opts.currentUserLogin,
      owner: ownerLogin,
      ownerType,
      packageName: ociIndexPkgName,
      newManifestDigest: details.manifestDigest,
      targets: obsolete,
      onDeleted: (ver) => deletedIds.add(ver.id),
    }).catch(() => {});
  }

  return {
    indexPackage: live.packageItem,
    versions: sorted.filter((v) => !deletedIds.has(v.id)),
    indexDetails: details,
  };
}

/**
 * Streams a remote OCI image layer from ghcr.io directly to a user-selected Desktop folder
 * without buffering the archive in RAM.
 */
export async function downloadAndExtractPackageToDiskDesktop(opts: {
  username: string;
  githubToken: string;
  owner: string;
  packageName: string;
  tag?: string;
  reference?: string;
  preloadedDetails?: OciPackageDetails;
  parentDir: string;
  folderName: string;
  replaceExisting?: boolean;
  signal?: AbortSignal;
  onProgress?: (update: { message: string; percent: number }) => void;
}): Promise<{
  details: OciPackageDetails;
  saved: boolean;
  outputPath?: string;
  fileCount: number;
  emptyFolderCount: number;
}> {
  if (!window.electronAPI?.downloadAndExtractLayer) {
    throw new Error('Desktop streaming extraction API is unavailable.');
  }
  if (opts.signal?.aborted) {
    throw new DOMException('Download cancelled', 'AbortError');
  }

  const details =
    opts.preloadedDetails ||
    (await inspectPackageManifest({
      username: opts.username,
      githubToken: opts.githubToken,
      owner: opts.owner,
      packageName: opts.packageName,
      tag: opts.tag,
      reference: opts.reference,
      skipLayerScan: true,
    }));
  if (!details.layerDigest) {
    throw new Error('Package manifest does not contain a downloadable layer.');
  }

  const ownerLower = opts.owner.toLowerCase();
  const pkgLower = opts.packageName.toLowerCase();

  const registryToken = await getGhcrBearerToken(
    opts.username,
    opts.githubToken,
    ownerLower,
    pkgLower,
    'pull'
  );

  if (opts.signal?.aborted) {
    throw new DOMException('Download cancelled', 'AbortError');
  }

  const requestId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const unsubscribe = window.electronAPI.onTransferProgress?.((payload) => {
    if (payload.requestId !== requestId) return;
    opts.onProgress?.({ message: payload.message, percent: payload.percent });
  });

  const abortHandler = opts.signal
    ? () => {
        window.electronAPI?.cancelTransfer?.(requestId);
      }
    : undefined;
  if (opts.signal && abortHandler) {
    opts.signal.addEventListener('abort', abortHandler, { once: true });
  }

  try {
    const res = await window.electronAPI.downloadAndExtractLayer({
      url: `https://ghcr.io/v2/${ownerLower}/${pkgLower}/blobs/${details.layerDigest}`,
      registryToken,
      parentDir: opts.parentDir,
      folderName: opts.folderName,
      replaceExisting: opts.replaceExisting,
      expectedSize: details.compressedSize,
      requestId,
    });

    const extractedSummary = summarizeArchiveEntries(
      res.files.length > 0 ? res.files : details.files
    );

    if (res.saved && res.files.length > 0 && details.files.length === 0) {
      details.files = res.files;
      details.fileCount = extractedSummary.regularFileCount;
      details.totalUncompressedBytes = res.files.reduce(
        (acc, f) => acc + (f.isDirectory ? 0 : f.size),
        0
      );
      details.needsManualLoad = false;
    }

    return {
      details,
      saved: res.saved,
      outputPath: res.outputPath,
      fileCount:
        res.files.length > 0 ? extractedSummary.regularFileCount : details.fileCount,
      emptyFolderCount: extractedSummary.emptyFolderCount,
    };
  } finally {
    unsubscribe?.();
    if (opts.signal && abortHandler) {
      opts.signal.removeEventListener('abort', abortHandler);
    }
  }
}

/**
 * Downloads the OCI image layer from ghcr.io and extracts all original files from the .tar.gz layer.
 */
export async function downloadAndExtractPackage(opts: {
  username: string;
  githubToken: string;
  owner: string;
  packageName: string;
  tag?: string;
  reference?: string;
  signal?: AbortSignal;
}): Promise<{
  details: OciPackageDetails;
  extractedFiles: TarInputFile[];
}> {
  if (opts.signal?.aborted) {
    throw new DOMException('Download cancelled', 'AbortError');
  }

  const details = await inspectPackageManifest({
    username: opts.username,
    githubToken: opts.githubToken,
    owner: opts.owner,
    packageName: opts.packageName,
    tag: opts.tag,
    reference: opts.reference,
    skipLayerScan: true,
    signal: opts.signal,
  });
  if (!details.layerDigest) {
    throw new Error('Package manifest does not contain a downloadable layer.');
  }

  const ownerLower = opts.owner.toLowerCase();
  const pkgLower = opts.packageName.toLowerCase();

  const registryToken = await getGhcrBearerToken(
    opts.username,
    opts.githubToken,
    ownerLower,
    pkgLower,
    'pull'
  );

  let extractedFiles: TarInputFile[];
  try {
    const blobRes = await crossPlatformHttpRequest({
      url: `https://ghcr.io/v2/${ownerLower}/${pkgLower}/blobs/${details.layerDigest}`,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${registryToken}`,
      },
      signal: opts.signal,
    });

    if (blobRes.status !== 200) {
      throw new Error(`Failed to download layer blob (HTTP ${blobRes.status})`);
    }

    extractedFiles = extractFilesFromOciLayer(blobRes.body);
  } catch (err) {
    throw normalizeMemoryLimitError(err, 'download');
  }

  if (details.files.length === 0 && extractedFiles.length > 0) {
    const fileMeta: OciManifestFileMeta[] = extractedFiles.map((f) => ({
      path: f.relativePath,
      size: f.isDirectory ? 0 : f.data.byteLength,
      ...(f.isDirectory ? { isDirectory: true } : {}),
    }));
    const { regularFileCount } = summarizeArchiveEntries(fileMeta);
    details.files = fileMeta;
    details.fileCount = regularFileCount;
    details.totalUncompressedBytes = fileMeta.reduce(
      (acc, f) => acc + (f.isDirectory ? 0 : f.size),
      0
    );
    details.needsManualLoad = false;
  }
  return { details, extractedFiles };
}

function buildPackageApiUrl(opts: {
  currentUserLogin: string;
  owner: string;
  ownerType: 'User' | 'Organization';
  packageName: string;
}): string {
  const encodedPkg = encodeURIComponent(opts.packageName);
  const isCurrentUser =
    opts.owner.toLowerCase() === opts.currentUserLogin.toLowerCase();
  if (isCurrentUser) {
    return `https://api.github.com/user/packages/container/${encodedPkg}`;
  }
  return opts.ownerType === 'Organization'
    ? `https://api.github.com/orgs/${encodeURIComponent(opts.owner)}/packages/container/${encodedPkg}`
    : `https://api.github.com/users/${encodeURIComponent(opts.owner)}/packages/container/${encodedPkg}`;
}

function extractGitHubApiErrorDetail(body: Uint8Array, status: number): string {
  let detail = `HTTP ${status}`;
  try {
    const errObj = decodeJson<{ message?: string }>(body);
    if (errObj.message) detail = errObj.message;
  } catch {
    // ignore
  }
  return detail;
}

/**
 * Fetches all versions for a given container package directly from the GitHub Packages REST API.
 */
export async function listPackageVersions(opts: {
  githubToken: string;
  currentUserLogin: string;
  owner: string;
  ownerType: 'User' | 'Organization';
  packageName: string;
}): Promise<GitHubPackageVersion[]> {
  const baseUrl = buildPackageApiUrl(opts);
  const allVersions: GitHubPackageVersion[] = [];

  for (let page = 1; page <= 10; page++) {
    const res = await crossPlatformHttpRequest({
      url: `${baseUrl}/versions?per_page=100&page=${page}`,
      method: 'GET',
      headers: githubApiHeaders(opts.githubToken),
    });

    if (res.status === 404) {
      return [];
    }
    if (res.status !== 200) {
      const detail = extractGitHubApiErrorDetail(res.body, res.status);
      throw new Error(
        `Failed to fetch versions for package "${opts.packageName}" (${detail}).`
      );
    }

    const batch = decodeJson<GitHubPackageVersion[]>(res.body);
    allVersions.push(...batch);
    if (batch.length < 100) break;
  }

  return allVersions;
}

/**
 * Checks GitHub live (not local caches) whether the normalized package name exists under `owner`
 * and retrieves its linked repository info and all existing versions.
 */
export async function fetchLivePackageState(opts: {
  githubToken: string;
  currentUserLogin: string;
  owner: string;
  ownerType: 'User' | 'Organization';
  packageName: string;
}): Promise<LivePackageState> {
  const baseUrl = buildPackageApiUrl(opts);
  const res = await crossPlatformHttpRequest({
    url: baseUrl,
    method: 'GET',
    headers: githubApiHeaders(opts.githubToken),
  });

  if (res.status === 404) {
    return { exists: false, packageItem: null, versions: [] };
  }
  if (res.status !== 200) {
    const detail = extractGitHubApiErrorDetail(res.body, res.status);
    throw new Error(
      `Failed to verify package "${opts.packageName}" on GitHub (${detail}).`
    );
  }

  const packageItem = decodeJson<GitHubPackageItem>(res.body);
  const versions = await listPackageVersions(opts);
  return { exists: true, packageItem, versions };
}

/**
 * Deletes a specific version of a container package from GitHub Packages.
 * GitHub forbids deleting the last remaining version directly; caller pushes replacement first
 * or deletes the whole package when removing the final version.
 */
export async function deletePackageVersion(opts: {
  githubToken: string;
  currentUserLogin: string;
  owner: string;
  ownerType: 'User' | 'Organization';
  packageName: string;
  versionId: number;
}): Promise<{ alreadyDeleted: boolean }> {
  const baseUrl = buildPackageApiUrl(opts);
  const res = await crossPlatformHttpRequest({
    url: `${baseUrl}/versions/${encodeURIComponent(String(opts.versionId))}`,
    method: 'DELETE',
    headers: githubApiHeaders(opts.githubToken),
  });

  if (res.status === 404) {
    return { alreadyDeleted: true };
  }
  if (res.status !== 204 && res.status !== 200) {
    const detail = extractGitHubApiErrorDetail(res.body, res.status);
    throw new Error(
      `Failed to delete version ${opts.versionId} of "${opts.packageName}" (${detail}). Ensure your token has the 'delete:packages' scope.`
    );
  }
  return { alreadyDeleted: false };
}

/**
 * Deletes replaced package versions after a new push has succeeded,
 * skipping any version whose digest matches the newly pushed manifest
 * and returning human-readable error strings for any version that failed to delete.
 */
export async function deleteReplacedVersions(opts: {
  githubToken: string;
  currentUserLogin: string;
  owner: string;
  ownerType: 'User' | 'Organization';
  packageName: string;
  newManifestDigest?: string;
  targets: GitHubPackageVersion[];
  onDeleted?: (version: GitHubPackageVersion) => void;
}): Promise<string[]> {
  const toDelete = opts.targets.filter((v) => v.name !== opts.newManifestDigest);
  const errors: string[] = [];

  for (const oldVer of toDelete) {
    try {
      await deletePackageVersion({
        githubToken: opts.githubToken,
        currentUserLogin: opts.currentUserLogin,
        owner: opts.owner,
        ownerType: opts.ownerType,
        packageName: opts.packageName,
        versionId: oldVer.id,
      });
      opts.onDeleted?.(oldVer);
    } catch (delErr: unknown) {
      const info = getVersionReferenceInfo(oldVer);
      const label = info.primaryTag || info.shortDigest;
      errors.push(
        `${label}: ${delErr instanceof Error ? delErr.message : String(delErr)}`
      );
    }
  }

  return errors;
}

/**
 * Deletes an entire container package from GitHub Packages.
 * Requires the 'delete:packages' scope on the GitHub token.
 */
export async function deleteGitHubPackage(opts: {
  githubToken: string;
  currentUserLogin: string;
  owner: string;
  ownerType: 'User' | 'Organization';
  packageName: string;
}): Promise<void> {
  const url = buildPackageApiUrl(opts);

  const res = await crossPlatformHttpRequest({
    url,
    method: 'DELETE',
    headers: githubApiHeaders(opts.githubToken),
  });

  if (res.status !== 204 && res.status !== 200) {
    const detail = extractGitHubApiErrorDetail(res.body, res.status);
    throw new Error(
      `Failed to delete package "${opts.packageName}" (${detail}). Ensure your token has the 'delete:packages' scope.`
    );
  }
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${sizes[i]}`;
}
