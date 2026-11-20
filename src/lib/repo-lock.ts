import {
  crossPlatformHttpRequest,
  decodeJson,
  type HttpResponseData,
} from './http.ts';
import { getPackageLockKey, REPO_INDEX_LOCK_KEY } from './naming.ts';

export const DEFAULT_LOCK_TTL_MS = 45_000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 12_000;
export const DEFAULT_POLL_INTERVAL_MS = 1_500;
const LOCK_REFS_NAMESPACE = 'ghcr-manager/locks';

export type RepoLockOperation = 'upload' | 'sync' | 'delete' | 'index';

export interface RepoLockRepoTarget {
  id: number;
  name: string;
  full_name: string;
  owner: {
    login: string;
  };
}

export interface RepoLockLeasePayload {
  schemaVersion: 1;
  status: 'locked' | 'unlocked';
  lockKey: string;
  packageName?: string;
  ownerLogin: string;
  sessionId: string;
  operation: RepoLockOperation;
  leaseTtlMs: number;
  acquiredAt: number;
  heartbeatAt: number;
}

export interface RepoLockWaitInfo {
  lockKey: string;
  packageName?: string;
  holderOwner: string;
  operation: string;
  acquiredAt: number;
  remainingMs: number;
}

export interface ActiveRepoLock {
  lockKey: string;
  packageName?: string;
  hadToWait: boolean;
  isLeaseLost: () => boolean;
  verifyHeld: () => Promise<void>;
  release: () => Promise<void>;
}

export interface ActiveRepoLockBundle {
  locks: ActiveRepoLock[];
  hadToWait: boolean;
  isAnyLeaseLost: () => boolean;
  verifyAllHeld: () => Promise<void>;
  releaseAll: () => Promise<void>;
}

export type HttpRequestFn = typeof crossPlatformHttpRequest;

const lockTreeShaCache = new Map<string, string>();
let appSessionId: string | null = null;
const unloadReleaseHandlers = new Set<() => void>();
let unloadListenerRegistered = false;

export function getAppLockSessionId(): string {
  if (!appSessionId) {
    appSessionId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
  return appSessionId;
}

function registerUnloadRelease(handler: () => void) {
  unloadReleaseHandlers.add(handler);
  if (!unloadListenerRegistered && typeof window !== 'undefined') {
    unloadListenerRegistered = true;
    window.addEventListener('beforeunload', () => {
      for (const fn of Array.from(unloadReleaseHandlers)) {
        try {
          fn();
        } catch {
          // Best-effort cleanup on close
        }
      }
    });
  }
}

function unregisterUnloadRelease(handler: () => void) {
  unloadReleaseHandlers.delete(handler);
}

function githubLockHeaders(token: string, noCache = false): Record<string, string> {
  return {
    Authorization: `Bearer ${token.trim()}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'GHCR-Manager',
    ...(noCache
      ? {
          'Cache-Control': 'no-cache, no-store, max-age=0',
          Pragma: 'no-cache',
        }
      : {}),
  };
}

function extractApiDetail(body: Uint8Array, status: number): string {
  try {
    const parsed = decodeJson<{ message?: string }>(body);
    if (parsed?.message) return `HTTP ${status}: ${parsed.message}`;
  } catch {
    // ignore JSON parse failure
  }
  return `HTTP ${status}`;
}

function isEmptyRepoResponse(status: number, body: Uint8Array): boolean {
  if (status !== 409) return false;
  try {
    const parsed = decodeJson<{ message?: string }>(body);
    return Boolean(parsed?.message && /empty/i.test(parsed.message));
  } catch {
    return true;
  }
}

function buildEmptyRepoError(repoFullName: string): Error {
  return new Error(
    `Multi-PC locking stores a hidden Git ref in "${repoFullName}", which GitHub blocks on completely empty (0-commit) repositories. Create at least one initial commit (such as a README) in this repository on GitHub and try again.`
  );
}

function safeParseLease(rawMessage: unknown): RepoLockLeasePayload | null {
  if (typeof rawMessage !== 'string') return null;
  try {
    const parsed = JSON.parse(rawMessage) as Partial<RepoLockLeasePayload>;
    if (
      parsed &&
      parsed.schemaVersion === 1 &&
      (parsed.status === 'locked' || parsed.status === 'unlocked') &&
      typeof parsed.lockKey === 'string' &&
      typeof parsed.sessionId === 'string'
    ) {
      return parsed as RepoLockLeasePayload;
    }
  } catch {
    // Not valid JSON lease payload
  }
  return null;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Operation aborted', 'AbortError'));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Operation aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function readLockRefCommitSha(opts: {
  httpRequest: HttpRequestFn;
  githubToken: string;
  owner: string;
  repoName: string;
  repoFullName: string;
  refSubPath: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  const fullRef = `refs/${opts.refSubPath}`;
  const cacheBust = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const res = await opts.httpRequest({
    url: `https://api.github.com/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(
      opts.repoName
    )}/git/ref/${opts.refSubPath}?_cb=${cacheBust}`,
    method: 'GET',
    headers: githubLockHeaders(opts.githubToken, true),
    signal: opts.signal,
  });

  if (res.status === 404) return null;
  if (isEmptyRepoResponse(res.status, res.body)) {
    throw buildEmptyRepoError(opts.repoFullName);
  }
  if (res.status !== 200) {
    throw new Error(
      `Failed to check lock state for "${opts.repoFullName}" (${extractApiDetail(
        res.body,
        res.status
      )}). Ensure your token has the 'repo' scope with write access.`
    );
  }

  const parsed = decodeJson<
    | { ref?: string; object?: { sha?: string; type?: string } }
    | Array<{ ref?: string; object?: { sha?: string; type?: string } }>
  >(res.body);

  if (Array.isArray(parsed)) {
    const exact = parsed.find((item) => item.ref === fullRef);
    return exact?.object?.sha || null;
  }
  if (parsed.ref && parsed.ref !== fullRef) {
    return null;
  }
  return parsed.object?.sha || null;
}

interface ParsedLockCommitState {
  commitSha: string;
  treeSha: string;
  lease: RepoLockLeasePayload | null;
  isFreeOrExpired: boolean;
  remainingMs: number;
}

function evaluateLeaseFreshness(opts: {
  lease: RepoLockLeasePayload | null;
  commitServerDateHeader?: string;
  responseDateHeader?: string;
  fallbackTtlMs: number;
  nowMs?: number;
}): { isFreeOrExpired: boolean; remainingMs: number } {
  const { lease, commitServerDateHeader, responseDateHeader, fallbackTtlMs } = opts;
  const nowMs = opts.nowMs ?? Date.now();

  if (lease?.status === 'unlocked') {
    return { isFreeOrExpired: true, remainingMs: 0 };
  }

  const ttlMs =
    lease?.leaseTtlMs && lease.leaseTtlMs > 0 ? lease.leaseTtlMs : fallbackTtlMs;

  // Prefer comparing GitHub server timestamps (`Date` header vs `commit.committer.date`)
  // so PC clock skew never triggers premature lock theft or hung waiting.
  const commitMs = commitServerDateHeader ? Date.parse(commitServerDateHeader) : NaN;
  const serverNowMs = responseDateHeader ? Date.parse(responseDateHeader) : NaN;
  if (Number.isFinite(commitMs) && Number.isFinite(serverNowMs)) {
    const elapsedMs = Math.max(0, serverNowMs - commitMs);
    const remainingMs = Math.max(0, ttlMs - elapsedMs);
    return {
      isFreeOrExpired: elapsedMs >= ttlMs,
      remainingMs,
    };
  }

  if (!lease) {
    return { isFreeOrExpired: true, remainingMs: 0 };
  }

  const expiresAt = lease.heartbeatAt + ttlMs;
  const remainingMs = Math.max(0, expiresAt - nowMs);
  return {
    isFreeOrExpired: nowMs >= expiresAt,
    remainingMs,
  };
}

async function readLockCommitState(opts: {
  httpRequest: HttpRequestFn;
  githubToken: string;
  owner: string;
  repoName: string;
  repoFullName: string;
  commitSha: string;
  fallbackTtlMs: number;
  signal?: AbortSignal;
}): Promise<ParsedLockCommitState> {
  const cacheBust = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const res = await opts.httpRequest({
    url: `https://api.github.com/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(
      opts.repoName
    )}/git/commits/${encodeURIComponent(opts.commitSha)}?_cb=${cacheBust}`,
    method: 'GET',
    headers: githubLockHeaders(opts.githubToken, true),
    signal: opts.signal,
  });

  if (isEmptyRepoResponse(res.status, res.body)) {
    throw buildEmptyRepoError(opts.repoFullName);
  }
  if (res.status !== 200) {
    throw new Error(
      `Failed to read lock commit in "${opts.repoFullName}" (${extractApiDetail(
        res.body,
        res.status
      )}).`
    );
  }

  const data = decodeJson<{
    sha?: string;
    message?: string;
    tree?: { sha?: string };
    committer?: { date?: string };
    author?: { date?: string };
  }>(res.body);

  const treeSha = data.tree?.sha || '';
  if (treeSha) {
    lockTreeShaCache.set(`${opts.owner}/${opts.repoName}`.toLowerCase(), treeSha);
  }

  const lease = safeParseLease(data.message);
  const { isFreeOrExpired, remainingMs } = evaluateLeaseFreshness({
    lease,
    commitServerDateHeader: data.committer?.date || data.author?.date,
    responseDateHeader: res.headers['date'],
    fallbackTtlMs: opts.fallbackTtlMs,
  });

  return {
    commitSha: opts.commitSha,
    treeSha,
    lease,
    isFreeOrExpired,
    remainingMs,
  };
}

async function ensureLockTreeSha(opts: {
  httpRequest: HttpRequestFn;
  githubToken: string;
  owner: string;
  repoName: string;
  repoFullName: string;
  signal?: AbortSignal;
}): Promise<string> {
  const cacheKey = `${opts.owner}/${opts.repoName}`.toLowerCase();
  const cached = lockTreeShaCache.get(cacheKey);
  if (cached) return cached;

  const res = await opts.httpRequest({
    url: `https://api.github.com/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(
      opts.repoName
    )}/git/trees`,
    method: 'POST',
    headers: githubLockHeaders(opts.githubToken),
    body: JSON.stringify({
      tree: [
        {
          path: 'lock.txt',
          mode: '100644',
          type: 'blob',
          content: 'GHCR Manager distributed lock state',
        },
      ],
    }),
    signal: opts.signal,
  });

  if (isEmptyRepoResponse(res.status, res.body)) {
    throw buildEmptyRepoError(opts.repoFullName);
  }
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(
      `Failed to initialize repository lock in "${opts.repoFullName}" (${extractApiDetail(
        res.body,
        res.status
      )}). Ensure your GitHub token has 'repo' write permission.`
    );
  }

  const data = decodeJson<{ sha?: string }>(res.body);
  if (!data.sha) {
    throw new Error(`GitHub did not return a tree SHA for "${opts.repoFullName}".`);
  }
  lockTreeShaCache.set(cacheKey, data.sha);
  return data.sha;
}

async function createLockCommit(opts: {
  httpRequest: HttpRequestFn;
  githubToken: string;
  owner: string;
  repoName: string;
  repoFullName: string;
  treeSha: string;
  parents: string[];
  payload: RepoLockLeasePayload;
  signal?: AbortSignal;
}): Promise<string> {
  const res = await opts.httpRequest({
    url: `https://api.github.com/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(
      opts.repoName
    )}/git/commits`,
    method: 'POST',
    headers: githubLockHeaders(opts.githubToken),
    body: JSON.stringify({
      message: JSON.stringify(opts.payload),
      tree: opts.treeSha,
      parents: opts.parents,
    }),
    signal: opts.signal,
  });

  if (isEmptyRepoResponse(res.status, res.body)) {
    throw buildEmptyRepoError(opts.repoFullName);
  }
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(
      `Failed to create lock commit in "${opts.repoFullName}" (${extractApiDetail(
        res.body,
        res.status
      )}).`
    );
  }

  const data = decodeJson<{ sha?: string }>(res.body);
  if (!data.sha) {
    throw new Error(`GitHub did not return a commit SHA for "${opts.repoFullName}".`);
  }
  return data.sha;
}

async function tryCreateLockRef(opts: {
  httpRequest: HttpRequestFn;
  githubToken: string;
  owner: string;
  repoName: string;
  repoFullName: string;
  refSubPath: string;
  commitSha: string;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; status: number; detail?: string }> {
  const res: HttpResponseData = await opts.httpRequest({
    url: `https://api.github.com/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(
      opts.repoName
    )}/git/refs`,
    method: 'POST',
    headers: githubLockHeaders(opts.githubToken),
    body: JSON.stringify({
      ref: `refs/${opts.refSubPath}`,
      sha: opts.commitSha,
    }),
    signal: opts.signal,
  });

  if (res.status === 201 || res.status === 200) return { ok: true, status: res.status };
  if (res.status === 422) {
    return {
      ok: false,
      status: res.status,
      detail: extractApiDetail(res.body, res.status),
    };
  }
  if (isEmptyRepoResponse(res.status, res.body)) {
    throw buildEmptyRepoError(opts.repoFullName);
  }
  throw new Error(
    `Failed to acquire lock ref in "${opts.repoFullName}" (${extractApiDetail(
      res.body,
      res.status
    )}).`
  );
}

/**
 * Atomically fast-forwards the lock ref without force so concurrent claimers
 * or stale-holder releases are strictly rejected by GitHub with HTTP 422.
 */
async function tryFastForwardLockRef(opts: {
  httpRequest: HttpRequestFn;
  githubToken: string;
  owner: string;
  repoName: string;
  repoFullName: string;
  refSubPath: string;
  commitSha: string;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; status: number; detail?: string }> {
  const res = await opts.httpRequest({
    url: `https://api.github.com/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(
      opts.repoName
    )}/git/refs/${opts.refSubPath}`,
    method: 'PATCH',
    headers: githubLockHeaders(opts.githubToken),
    body: JSON.stringify({
      sha: opts.commitSha,
      force: false,
    }),
    signal: opts.signal,
  });

  if (res.status === 200) return { ok: true, status: res.status };
  if (res.status === 422 || res.status === 404) {
    return {
      ok: false,
      status: res.status,
      detail: extractApiDetail(res.body, res.status),
    };
  }
  if (isEmptyRepoResponse(res.status, res.body)) {
    throw buildEmptyRepoError(opts.repoFullName);
  }
  throw new Error(
    `Failed to update lock ref in "${opts.repoFullName}" (${extractApiDetail(
      res.body,
      res.status
    )}).`
  );
}

function createActiveRepoLockHandle(opts: {
  httpRequest: HttpRequestFn;
  githubToken: string;
  owner: string;
  repoName: string;
  repoFullName: string;
  refSubPath: string;
  lockKey: string;
  packageName?: string;
  ownerLogin: string;
  sessionId: string;
  operation: RepoLockOperation;
  hadToWait: boolean;
  initialCommitSha: string;
  treeSha: string;
  acquiredAt: number;
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
  onLeaseLost?: () => void;
}): ActiveRepoLock {
  let currentSha = opts.initialCommitSha;
  let released = false;
  let leaseLost = false;
  let lastConfirmedAt = Date.now();
  let releasePromise: Promise<void> | null = null;
  let opChain: Promise<void> = Promise.resolve();

  const enqueueOp = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = opChain.then(fn, fn);
    opChain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };

  const markLeaseLost = () => {
    if (leaseLost) return;
    leaseLost = true;
    clearInterval(hbTimer);
    opts.onLeaseLost?.();
  };

  const renewOnce = async (strictNetwork: boolean): Promise<boolean> => {
    if (released || leaseLost) return false;
    if (Date.now() - lastConfirmedAt >= opts.leaseTtlMs) {
      markLeaseLost();
      return false;
    }
    try {
      const hbPayload: RepoLockLeasePayload = {
        schemaVersion: 1,
        status: 'locked',
        lockKey: opts.lockKey,
        ...(opts.packageName ? { packageName: opts.packageName } : {}),
        ownerLogin: opts.ownerLogin,
        sessionId: opts.sessionId,
        operation: opts.operation,
        leaseTtlMs: opts.leaseTtlMs,
        acquiredAt: opts.acquiredAt,
        heartbeatAt: Date.now(),
      };
      const hbSha = await createLockCommit({
        httpRequest: opts.httpRequest,
        githubToken: opts.githubToken,
        owner: opts.owner,
        repoName: opts.repoName,
        repoFullName: opts.repoFullName,
        treeSha: opts.treeSha,
        parents: [currentSha],
        payload: hbPayload,
      });
      const result = await tryFastForwardLockRef({
        httpRequest: opts.httpRequest,
        githubToken: opts.githubToken,
        owner: opts.owner,
        repoName: opts.repoName,
        repoFullName: opts.repoFullName,
        refSubPath: opts.refSubPath,
        commitSha: hbSha,
      });
      if (!result.ok) {
        markLeaseLost();
        return false;
      }
      currentSha = hbSha;
      lastConfirmedAt = Date.now();
      return true;
    } catch (err) {
      if (Date.now() - lastConfirmedAt >= opts.leaseTtlMs) {
        markLeaseLost();
        return false;
      }
      if (strictNetwork) {
        throw err;
      }
      return !leaseLost;
    }
  };

  const runHeartbeat = () => {
    if (released || leaseLost) return;
    if (Date.now() - lastConfirmedAt >= opts.leaseTtlMs) {
      markLeaseLost();
      return;
    }
    void enqueueOp(() => renewOnce(false));
  };

  const verifyHeld = async (): Promise<void> => {
    const ok = await enqueueOp(() => renewOnce(true));
    if (!ok) {
      throw new DOMException('Lock lease lost', 'AbortError');
    }
  };

  const hbTimer = setInterval(runHeartbeat, opts.heartbeatIntervalMs);
  (hbTimer as unknown as { unref?: () => void }).unref?.();

  const release = (): Promise<void> => {
    if (releasePromise) return releasePromise;
    released = true;
    clearInterval(hbTimer);
    unregisterUnloadRelease(unloadHandler);

    releasePromise = enqueueOp(async () => {
      if (leaseLost) return;
      try {
        const unlockPayload: RepoLockLeasePayload = {
          schemaVersion: 1,
          status: 'unlocked',
          lockKey: opts.lockKey,
          ...(opts.packageName ? { packageName: opts.packageName } : {}),
          ownerLogin: opts.ownerLogin,
          sessionId: opts.sessionId,
          operation: opts.operation,
          leaseTtlMs: opts.leaseTtlMs,
          acquiredAt: opts.acquiredAt,
          heartbeatAt: Date.now(),
        };
        const unlockSha = await createLockCommit({
          httpRequest: opts.httpRequest,
          githubToken: opts.githubToken,
          owner: opts.owner,
          repoName: opts.repoName,
          repoFullName: opts.repoFullName,
          treeSha: opts.treeSha,
          parents: [currentSha],
          payload: unlockPayload,
        });
        await tryFastForwardLockRef({
          httpRequest: opts.httpRequest,
          githubToken: opts.githubToken,
          owner: opts.owner,
          repoName: opts.repoName,
          repoFullName: opts.repoFullName,
          refSubPath: opts.refSubPath,
          commitSha: unlockSha,
        });
      } catch {
        // Best-effort release so teardown never masks real operation errors
      }
    });
    return releasePromise;
  };

  const unloadHandler = () => {
    void release();
  };
  registerUnloadRelease(unloadHandler);

  return {
    lockKey: opts.lockKey,
    packageName: opts.packageName,
    hadToWait: opts.hadToWait,
    isLeaseLost: () => leaseLost,
    verifyHeld,
    release,
  };
}

/**
 * Acquires an exclusive distributed lock stored in a hidden Git ref
 * (`refs/ghcr-manager/locks/<lockKey>`) on the target repository, polling cleanly
 * until free or aborted and maintaining a lease heartbeat until `release()`.
 */
export async function acquireRepoLock(opts: {
  repo: RepoLockRepoTarget;
  githubToken: string;
  ownerLogin: string;
  lockKey: string;
  packageName?: string;
  operation: RepoLockOperation;
  sessionId?: string;
  signal?: AbortSignal;
  onWaiting?: (info: RepoLockWaitInfo) => void;
  onLeaseLost?: () => void;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  confirmSettleMs?: number;
  httpRequest?: HttpRequestFn;
}): Promise<ActiveRepoLock> {
  const httpRequest = opts.httpRequest || crossPlatformHttpRequest;
  const leaseTtlMs = opts.leaseTtlMs ?? DEFAULT_LOCK_TTL_MS;
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sessionId = opts.sessionId || getAppLockSessionId();
  const owner = opts.repo.owner.login;
  const repoName = opts.repo.name;
  const repoFullName = opts.repo.full_name;
  const refSubPath = `${LOCK_REFS_NAMESPACE}/${opts.lockKey}`;

  const bestEffortReleaseClaimedSha = async (
    ownedSha: string,
    treeSha: string,
    acquiredAt: number
  ) => {
    try {
      const unlockPayload: RepoLockLeasePayload = {
        schemaVersion: 1,
        status: 'unlocked',
        lockKey: opts.lockKey,
        ...(opts.packageName ? { packageName: opts.packageName } : {}),
        ownerLogin: opts.ownerLogin,
        sessionId,
        operation: opts.operation,
        leaseTtlMs,
        acquiredAt,
        heartbeatAt: Date.now(),
      };
      const unlockSha = await createLockCommit({
        httpRequest,
        githubToken: opts.githubToken,
        owner,
        repoName,
        repoFullName,
        treeSha,
        parents: [ownedSha],
        payload: unlockPayload,
      });
      await tryFastForwardLockRef({
        httpRequest,
        githubToken: opts.githubToken,
        owner,
        repoName,
        repoFullName,
        refSubPath,
        commitSha: unlockSha,
      });
    } catch {
      // Best-effort cleanup so abort rollback never masks AbortError
    }
  };

  /**
   * 2-phase post-claim fencing: waits for concurrent writers to settle, verifies
   * the ref still points to `claimSha`, appends a child confirmation commit via
   * fast-forward PATCH, and re-verifies HEAD before granting ownership.
   */
  const confirmLockOwnership = async (
    claimSha: string,
    treeSha: string,
    acquiredAt: number
  ): Promise<string | null> => {
    const settleMs =
      opts.confirmSettleMs ??
      (opts.httpRequest ? 15 : 300 + Math.floor(Math.random() * 150));

    let currentOwnedSha = claimSha;
    try {
      await abortableSleep(settleMs, opts.signal);

      const verifySha1 = await readLockRefCommitSha({
        httpRequest,
        githubToken: opts.githubToken,
        owner,
        repoName,
        repoFullName,
        refSubPath,
        signal: opts.signal,
      });
      if (verifySha1 !== claimSha) {
        return null;
      }

      const confirmPayload: RepoLockLeasePayload = {
        schemaVersion: 1,
        status: 'locked',
        lockKey: opts.lockKey,
        ...(opts.packageName ? { packageName: opts.packageName } : {}),
        ownerLogin: opts.ownerLogin,
        sessionId,
        operation: opts.operation,
        leaseTtlMs,
        acquiredAt,
        heartbeatAt: Date.now(),
      };
      const confirmSha = await createLockCommit({
        httpRequest,
        githubToken: opts.githubToken,
        owner,
        repoName,
        repoFullName,
        treeSha,
        parents: [claimSha],
        payload: confirmPayload,
        signal: opts.signal,
      });

      const confirmRes = await tryFastForwardLockRef({
        httpRequest,
        githubToken: opts.githubToken,
        owner,
        repoName,
        repoFullName,
        refSubPath,
        commitSha: confirmSha,
        signal: opts.signal,
      });
      if (!confirmRes.ok) {
        return null;
      }
      currentOwnedSha = confirmSha;

      const verifySha2 = await readLockRefCommitSha({
        httpRequest,
        githubToken: opts.githubToken,
        owner,
        repoName,
        repoFullName,
        refSubPath,
        signal: opts.signal,
      });
      if (verifySha2 !== confirmSha) {
        return null;
      }

      if (opts.signal?.aborted) {
        await bestEffortReleaseClaimedSha(confirmSha, treeSha, acquiredAt);
        throw new DOMException('Operation aborted', 'AbortError');
      }

      return confirmSha;
    } catch (err) {
      if (opts.signal?.aborted) {
        const liveSha = await readLockRefCommitSha({
          httpRequest,
          githubToken: opts.githubToken,
          owner,
          repoName,
          repoFullName,
          refSubPath,
        }).catch(() => null);
        if (liveSha === currentOwnedSha || liveSha === claimSha) {
          await bestEffortReleaseClaimedSha(liveSha, treeSha, acquiredAt);
        }
      }
      throw err;
    }
  };

  let hadToWait = false;
  let uncontendedRejects = 0;

  while (true) {
    if (opts.signal?.aborted) {
      throw new DOMException('Operation aborted', 'AbortError');
    }

    const existingSha = await readLockRefCommitSha({
      httpRequest,
      githubToken: opts.githubToken,
      owner,
      repoName,
      repoFullName,
      refSubPath,
      signal: opts.signal,
    });

    let candidateTreeSha: string | null = null;
    let parents: string[] | null = null;
    let activeHolderState: ParsedLockCommitState | null = null;

    if (!existingSha) {
      candidateTreeSha = await ensureLockTreeSha({
        httpRequest,
        githubToken: opts.githubToken,
        owner,
        repoName,
        repoFullName,
        signal: opts.signal,
      });
      parents = [];
    } else {
      const state = await readLockCommitState({
        httpRequest,
        githubToken: opts.githubToken,
        owner,
        repoName,
        repoFullName,
        commitSha: existingSha,
        fallbackTtlMs: leaseTtlMs,
        signal: opts.signal,
      });
      if (state.isFreeOrExpired) {
        candidateTreeSha =
          state.treeSha ||
          (await ensureLockTreeSha({
            httpRequest,
            githubToken: opts.githubToken,
            owner,
            repoName,
            repoFullName,
            signal: opts.signal,
          }));
        parents = [state.commitSha];
      } else {
        activeHolderState = state;
      }
    }

    if (candidateTreeSha && parents) {
      const now = Date.now();
      const payload: RepoLockLeasePayload = {
        schemaVersion: 1,
        status: 'locked',
        lockKey: opts.lockKey,
        ...(opts.packageName ? { packageName: opts.packageName } : {}),
        ownerLogin: opts.ownerLogin,
        sessionId,
        operation: opts.operation,
        leaseTtlMs,
        acquiredAt: now,
        heartbeatAt: now,
      };
      const commitSha = await createLockCommit({
        httpRequest,
        githubToken: opts.githubToken,
        owner,
        repoName,
        repoFullName,
        treeSha: candidateTreeSha,
        parents,
        payload,
        signal: opts.signal,
      });

      let claimRes: { ok: boolean; status: number; detail?: string };
      try {
        claimRes =
          parents.length === 0
            ? await tryCreateLockRef({
                httpRequest,
                githubToken: opts.githubToken,
                owner,
                repoName,
                repoFullName,
                refSubPath,
                commitSha,
                signal: opts.signal,
              })
            : await tryFastForwardLockRef({
                httpRequest,
                githubToken: opts.githubToken,
                owner,
                repoName,
                repoFullName,
                refSubPath,
                commitSha,
                signal: opts.signal,
              });
      } catch (err) {
        if (opts.signal?.aborted) {
          const liveSha = await readLockRefCommitSha({
            httpRequest,
            githubToken: opts.githubToken,
            owner,
            repoName,
            repoFullName,
            refSubPath,
          }).catch(() => null);
          if (liveSha === commitSha) {
            await bestEffortReleaseClaimedSha(commitSha, candidateTreeSha, now);
          }
        }
        throw err;
      }

      if (claimRes.ok) {
        if (opts.signal?.aborted) {
          await bestEffortReleaseClaimedSha(commitSha, candidateTreeSha, now);
          throw new DOMException('Operation aborted', 'AbortError');
        }
        const confirmedSha = await confirmLockOwnership(
          commitSha,
          candidateTreeSha,
          now
        );
        if (!confirmedSha) {
          uncontendedRejects = 0;
          hadToWait = true;
          await abortableSleep(40 + Math.floor(Math.random() * 60), opts.signal);
          continue;
        }
        return createActiveRepoLockHandle({
          httpRequest,
          githubToken: opts.githubToken,
          owner,
          repoName,
          repoFullName,
          refSubPath,
          lockKey: opts.lockKey,
          packageName: opts.packageName,
          ownerLogin: opts.ownerLogin,
          sessionId,
          operation: opts.operation,
          hadToWait,
          initialCommitSha: confirmedSha,
          treeSha: candidateTreeSha,
          acquiredAt: now,
          leaseTtlMs,
          heartbeatIntervalMs,
          onLeaseLost: opts.onLeaseLost,
        });
      }

      // Guard against non-contention 422s (e.g. repo ruleset blocking hidden refs)
      const latestAfterReject = await readLockRefCommitSha({
        httpRequest,
        githubToken: opts.githubToken,
        owner,
        repoName,
        repoFullName,
        refSubPath,
        signal: opts.signal,
      });
      if (latestAfterReject === existingSha) {
        uncontendedRejects += 1;
        if (uncontendedRejects >= 3) {
          throw new Error(
            `GitHub rejected creating/updating lock ref in "${repoFullName}" (${
              claimRes.detail || `HTTP ${claimRes.status}`
            }).`
          );
        }
      } else {
        uncontendedRejects = 0;
      }

      hadToWait = true;
      await abortableSleep(30 + Math.floor(Math.random() * 50), opts.signal);
      continue;
    }

    uncontendedRejects = 0;
    hadToWait = true;
    const holder = activeHolderState?.lease;
    const remainingMs = activeHolderState?.remainingMs ?? pollIntervalMs;
    opts.onWaiting?.({
      lockKey: opts.lockKey,
      packageName: opts.packageName || holder?.packageName,
      holderOwner: holder?.ownerLogin || owner,
      operation: holder?.operation || 'upload',
      acquiredAt: holder?.acquiredAt || Date.now(),
      remainingMs,
    });

    const jitter = Math.floor(Math.random() * Math.min(350, pollIntervalMs));
    const waitMs = Math.min(
      pollIntervalMs + jitter,
      Math.max(250, remainingMs + 200)
    );
    await abortableSleep(waitMs, opts.signal);
  }
}

/**
 * Acquires the distributed lock protecting `ghcr-manager-index_<repo>` snapshots.
 */
export function acquireRepoIndexLock(opts: {
  repo: RepoLockRepoTarget;
  githubToken: string;
  ownerLogin: string;
  signal?: AbortSignal;
  onWaiting?: (info: RepoLockWaitInfo) => void;
  onLeaseLost?: () => void;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  confirmSettleMs?: number;
  httpRequest?: HttpRequestFn;
}): Promise<ActiveRepoLock> {
  return acquireRepoLock({
    ...opts,
    lockKey: REPO_INDEX_LOCK_KEY,
    operation: 'index',
  });
}

/**
 * Acquires per-package locks in canonical alphabetical lock-key order to eliminate
 * cross-PC deadlocks on batch operations, rolling back acquired locks on failure/cancel.
 */
export async function acquireRepoPackageLocks(opts: {
  repo: RepoLockRepoTarget;
  githubToken: string;
  ownerLogin: string;
  packageNames: string[];
  operation: 'upload' | 'sync' | 'delete';
  sessionId?: string;
  signal?: AbortSignal;
  onWaiting?: (info: RepoLockWaitInfo) => void;
  onLeaseLost?: () => void;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  confirmSettleMs?: number;
  httpRequest?: HttpRequestFn;
}): Promise<ActiveRepoLockBundle> {
  const uniqueByLockKey = new Map<string, string>();
  for (const name of opts.packageNames) {
    const clean = name.trim().toLowerCase();
    if (!clean) continue;
    const lockKey = getPackageLockKey(clean);
    if (!uniqueByLockKey.has(lockKey)) {
      uniqueByLockKey.set(lockKey, clean);
    }
  }

  const orderedEntries = Array.from(uniqueByLockKey.entries()).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );

  const acquired: ActiveRepoLock[] = [];
  let hadToWait = false;

  try {
    for (const [lockKey, pkgName] of orderedEntries) {
      const handle = await acquireRepoLock({
        repo: opts.repo,
        githubToken: opts.githubToken,
        ownerLogin: opts.ownerLogin,
        lockKey,
        packageName: pkgName,
        operation: opts.operation,
        sessionId: opts.sessionId,
        signal: opts.signal,
        onWaiting: opts.onWaiting,
        onLeaseLost: opts.onLeaseLost,
        leaseTtlMs: opts.leaseTtlMs,
        heartbeatIntervalMs: opts.heartbeatIntervalMs,
        pollIntervalMs: opts.pollIntervalMs,
        confirmSettleMs: opts.confirmSettleMs,
        httpRequest: opts.httpRequest,
      });
      if (handle.hadToWait) hadToWait = true;
      acquired.push(handle);
    }
  } catch (err) {
    await Promise.allSettled(acquired.map((l) => l.release()));
    throw err;
  }

  return {
    locks: acquired,
    hadToWait,
    isAnyLeaseLost: () => acquired.some((l) => l.isLeaseLost()),
    verifyAllHeld: async () => {
      for (const lock of acquired) {
        await lock.verifyHeld();
      }
    },
    releaseAll: async () => {
      await Promise.allSettled(
        [...acquired].reverse().map((l) => l.release())
      );
    },
  };
}
