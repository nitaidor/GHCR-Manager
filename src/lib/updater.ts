/**
 * GHCR Manager Update Checker Service
 * Compares semantic versioning (SemVer) against GitHub Releases.
 */

export const GITHUB_RELEASES_OWNER = 'nitaidor';
export const GITHUB_RELEASES_REPO = 'GHCR-Manager';

export type UpdateCheckStatus = 'checking' | 'update-available' | 'up-to-date' | 'error';

export interface GitHubReleaseEntry {
  tag_name?: string;
  name?: string | null;
  html_url?: string;
  published_at?: string;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
}

export interface UpdateCheckResult {
  status: Exclude<UpdateCheckStatus, 'checking'>;
  currentVersion: string;
  latestVersion?: string;
  rawTag?: string;
  releaseName?: string;
  releaseUrl?: string;
  publishedAt?: string;
  error?: string;
}

export function cleanVersion(v?: string | null): string {
  return (v || '').trim().replace(/^v/i, '');
}

/**
 * Compares two semantic version strings numerically.
 * Returns 1 if v1 > v2, -1 if v1 < v2, or 0 if equal.
 */
export function compareVersions(v1: string, v2: string): -1 | 0 | 1 {
  const parse = (v: string) =>
    cleanVersion(v)
      .split(/[-+]/)[0]
      .split('.')
      .map((n) => parseInt(n, 10) || 0);

  const p1 = parse(v1);
  const p2 = parse(v2);
  const len = Math.max(p1.length, p2.length);

  for (let i = 0; i < len; i++) {
    const n1 = p1[i] || 0;
    const n2 = p2[i] || 0;
    if (n1 > n2) return 1;
    if (n1 < n2) return -1;
  }
  return 0;
}

/**
 * Resolves update availability from a raw GitHub Releases payload.
 */
export function resolveUpdateCheckFromReleases(
  currentVersion: string,
  releases: readonly GitHubReleaseEntry[] | null | undefined
): UpdateCheckResult {
  const cleanCurrent = cleanVersion(currentVersion);

  if (!Array.isArray(releases) || releases.length === 0) {
    return {
      status: 'up-to-date',
      currentVersion: cleanCurrent,
      latestVersion: cleanCurrent,
    };
  }

  const validReleases = releases
    .filter(
      (r): r is GitHubReleaseEntry & { tag_name: string } =>
        !r.draft && Boolean(r.tag_name) && /^v?\d+(\.\d+)+/i.test(r.tag_name!)
    )
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name));

  if (validReleases.length === 0) {
    return {
      status: 'up-to-date',
      currentVersion: cleanCurrent,
      latestVersion: cleanCurrent,
    };
  }

  const latest = validReleases[0];
  const latestClean = cleanVersion(latest.tag_name);
  const hasNewerVersion = compareVersions(latest.tag_name, cleanCurrent) > 0;

  return {
    status: hasNewerVersion ? 'update-available' : 'up-to-date',
    currentVersion: cleanCurrent,
    latestVersion: latestClean,
    rawTag: latest.tag_name,
    releaseName: latest.name || `Version ${latest.tag_name}`,
    releaseUrl:
      latest.html_url ||
      `https://github.com/${GITHUB_RELEASES_OWNER}/${GITHUB_RELEASES_REPO}/releases/tag/${encodeURIComponent(
        latest.tag_name
      )}`,
    publishedAt: latest.published_at || '',
  };
}

/**
 * Checks GitHub repository releases for a newer release with a SemVer tag.
 */
export async function checkForUpdates(currentVersion: string): Promise<UpdateCheckResult> {
  const cleanCurrent = cleanVersion(currentVersion);

  // Instant offline check if browser/device reports disconnected
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return {
      status: 'error',
      currentVersion: cleanCurrent,
      error: 'No internet connection',
    };
  }

  let releases: GitHubReleaseEntry[] | null = null;

  // 1. In Electron Desktop: route through Main Process IPC (no CORS limits, direct network, cache-busted)
  if (
    typeof window !== 'undefined' &&
    window.electronAPI &&
    typeof window.electronAPI.checkForUpdates === 'function'
  ) {
    const ipcRes = await window.electronAPI.checkForUpdates();
    if (!ipcRes.ok) {
      return {
        status: 'error',
        currentVersion: cleanCurrent,
        error: ipcRes.error || 'Failed to check for updates',
      };
    }
    releases = (ipcRes.releases as GitHubReleaseEntry[]) || [];
  } else {
    // 2. Web / Mobile Fallback: Simple GET request with cache-busting query (no CORS-preflight headers)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const timestamp = Date.now();
      const url = `https://api.github.com/repos/${GITHUB_RELEASES_OWNER}/${GITHUB_RELEASES_REPO}/releases?per_page=15&_t=${timestamp}`;
      const res = await fetch(url, {
        cache: 'no-store',
        headers: {
          Accept: 'application/vnd.github+json',
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`GitHub API returned status ${res.status}`);
      }

      releases = (await res.json()) as GitHubReleaseEntry[];
    } catch (err: unknown) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
      const rawMsg = err instanceof Error ? err.message : String(err);
      let errorMessage = rawMsg || 'Failed to check for updates';
      if (isAbort) {
        errorMessage = 'Connection timed out';
      } else if (isOffline || errorMessage === 'Failed to fetch') {
        errorMessage = 'Failed to fetch';
      }
      return {
        status: 'error',
        currentVersion: cleanCurrent,
        error: errorMessage,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return resolveUpdateCheckFromReleases(cleanCurrent, releases);
}
