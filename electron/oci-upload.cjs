const http = require('node:http');
const https = require('node:https');
const {
  createAbortError,
  streamOciLayerContinuous,
  streamOciLayerInChunks,
  writeStreamChunk,
} = require('./streaming-tar.cjs');

const BLOB_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024; // 4 MiB - GHCR/Azure max PATCH body limit
const MIN_ADAPTIVE_CHUNK_BYTES = 256 * 1024; // 256 KiB adaptive floor
const DEFAULT_INACTIVITY_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_DELAY_MS = 1_500;
const DEFAULT_FALLBACK_DELAY_MS = 500;

function createHttpError(message, statusCode, bodyText = '') {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.bodyText = bodyText;
  err.isHttpError = true;
  return err;
}

function isChunkTooLargeResponse(status, bodyText) {
  if (status === 413) return true;
  if (
    status === 416 &&
    /exceeds the maximum permissible limit|too large|maximum.*limit/i.test(bodyText || '')
  ) {
    return true;
  }
  return false;
}

function parseRangeEndOffset(rangeHeader) {
  if (!rangeHeader || typeof rangeHeader !== 'string') return null;
  const match = rangeHeader.trim().match(/^(?:bytes=)?0-(\d+)$/i);
  if (!match) return null;
  const endByte = Number(match[1]);
  if (!Number.isFinite(endByte) || endByte < 0) return null;
  return endByte + 1;
}

function isTransientHttpStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isNonRetryableLocalOrFatalError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.name === 'AbortError') return true;
  const localCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'ENOSPC']);
  if (typeof err.code === 'string' && localCodes.has(err.code)) return true;
  if (
    typeof err.message === 'string' &&
    err.message.includes('changed size while reading')
  ) {
    return true;
  }
  const status = Number(err.statusCode);
  return status === 403 || status === 404;
}

function shouldFallbackImmediatelyToChunked(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.isTimeoutError === true) return true;
  const status = Number(err.statusCode);
  return (
    status === 400 ||
    status === 401 ||
    status === 405 ||
    status === 408 ||
    status === 411 ||
    status === 413 ||
    status === 416 ||
    status === 501 ||
    status === 504
  );
}

function sleepAbortable(ms, signal) {
  if (signal?.aborted) {
    return Promise.reject(createAbortError('Upload cancelled'));
  }
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError('Upload cancelled'));
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Shared OCI session helpers (auth retry, session initiation, and final PUT commit).
 */
function createOciSessionClient({
  uploadInitUrl,
  registryToken,
  refreshToken,
  fetchFn = fetch,
  signal,
}) {
  let token = registryToken;
  let sessionUrl = '';

  async function sendRequestWithAuthRetry(url, initBuilder) {
    if (signal?.aborted) {
      throw createAbortError('Upload cancelled');
    }
    let res = await fetchFn(url, {
      ...initBuilder(token),
      signal,
    });
    if (res.status === 401 && typeof refreshToken === 'function') {
      const nextToken = await refreshToken();
      if (nextToken) {
        token = nextToken;
        if (signal?.aborted) {
          throw createAbortError('Upload cancelled');
        }
        res = await fetchFn(url, {
          ...initBuilder(token),
          signal,
        });
      }
    }
    return res;
  }

  async function startSession() {
    let startRes = null;
    for (let attempt = 0; attempt <= 3; attempt++) {
      startRes = null;
      try {
        startRes = await sendRequestWithAuthRetry(uploadInitUrl, (tok) => ({
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tok}`,
            'Content-Length': '0',
          },
        }));
        if (startRes.status === 202) break;
        const errBody = await startRes.text().catch(() => '');
        if (isTransientHttpStatus(startRes.status) && attempt < 3) {
          await sleepAbortable(800 * (attempt + 1), signal);
          continue;
        }
        throw createHttpError(
          `Failed to initiate blob upload to ghcr.io (HTTP ${startRes.status}): ${errBody}`,
          startRes.status,
          errBody
        );
      } catch (err) {
        if (signal?.aborted || (err && err.name === 'AbortError')) {
          throw err;
        }
        if (attempt < 3 && !startRes) {
          await sleepAbortable(800 * (attempt + 1), signal);
          continue;
        }
        throw err;
      }
    }

    const locationHeader = startRes.headers.get('location');
    if (!locationHeader) {
      throw new Error('ghcr.io blob upload response missing Location header.');
    }
    sessionUrl = new URL(locationHeader, uploadInitUrl).toString();
    await startRes.text().catch(() => '');
    return sessionUrl;
  }

  async function commitPut(digest, monolithicBody = null, onMonolithicTooLarge = null) {
    for (let attempt = 0; attempt <= 3; attempt++) {
      if (signal?.aborted) {
        throw createAbortError('Upload cancelled');
      }
      const putUrlObj = new URL(sessionUrl);
      putUrlObj.searchParams.set('digest', digest);
      const hasBody = Boolean(monolithicBody && monolithicBody.length > 0);

      let putRes;
      try {
        putRes = await sendRequestWithAuthRetry(putUrlObj.toString(), (tok) => ({
          method: 'PUT',
          headers: hasBody
            ? {
                Authorization: `Bearer ${tok}`,
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(monolithicBody.length),
              }
            : {
                Authorization: `Bearer ${tok}`,
                'Content-Length': '0',
              },
          ...(hasBody ? { body: monolithicBody } : {}),
        }));
      } catch (err) {
        if (signal?.aborted || (err && err.name === 'AbortError')) {
          throw err;
        }
        if (attempt < 3) {
          await sleepAbortable(800 * (attempt + 1), signal);
          continue;
        }
        throw err;
      }

      if (putRes.status === 201 || putRes.status === 202) {
        await putRes.text().catch(() => '');
        return;
      }

      const bodyText = await putRes.text().catch(() => '');

      if (
        hasBody &&
        isChunkTooLargeResponse(putRes.status, bodyText) &&
        typeof onMonolithicTooLarge === 'function'
      ) {
        return await onMonolithicTooLarge();
      }

      if (isTransientHttpStatus(putRes.status) && attempt < 3) {
        await sleepAbortable(800 * (attempt + 1), signal);
        continue;
      }

      throw createHttpError(
        `Failed to commit blob upload to ghcr.io (HTTP ${putRes.status}): ${bodyText}`,
        putRes.status,
        bodyText
      );
    }
  }

  async function deleteSessionBestEffort() {
    if (!sessionUrl) return;
    await fetchFn(sessionUrl, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }

  return {
    getToken: () => token,
    getSessionUrl: () => sessionUrl,
    updateLocation: (loc) => {
      if (loc) {
        sessionUrl = new URL(loc, sessionUrl || uploadInitUrl).toString();
      }
    },
    sendRequestWithAuthRetry,
    startSession,
    commitPut,
    deleteSessionBestEffort,
  };
}

/**
 * Opens a single continuous HTTP/1.1 Transfer-Encoding: chunked PATCH request
 * (no Content-Length or Content-Range) using Node's native http/https module so
 * long multi-minute streams do not hit undici fetch headersTimeout limits.
 */
function openStreamingPatchRequest({
  url,
  token,
  signal,
  inactivityTimeoutMs = DEFAULT_INACTIVITY_TIMEOUT_MS,
  onEarlyError,
}) {
  if (signal?.aborted) {
    throw createAbortError('Upload cancelled');
  }

  const parsedUrl = new URL(url);
  const transport = parsedUrl.protocol === 'http:' ? http : https;
  let earlyError = null;
  let earlyResponseStatus = 0;
  let settled = false;
  let finishRequested = false;
  let resolveResp;
  let rejectResp;

  const responsePromise = new Promise((resolve, reject) => {
    resolveResp = resolve;
    rejectResp = reject;
  });
  // Prevent unhandled rejection crashes if server rejects before finish() is awaited
  responsePromise.catch(() => {});

  const req = transport.request(parsedUrl, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
    },
  });

  const cleanupSignal = () => {
    try {
      req.setTimeout(0);
    } catch {
      // ignore
    }
    if (signal) {
      signal.removeEventListener('abort', onSignalAbort);
    }
  };

  const failStream = (err, callEarlyCb = true) => {
    if (earlyResponseStatus && err && !err.statusCode) {
      err.statusCode = earlyResponseStatus;
    }
    if (!earlyError) {
      earlyError = err;
    }
    if (!settled) {
      settled = true;
      cleanupSignal();
      rejectResp(earlyError);
    }
    if (!req.destroyed) {
      req.destroy();
    }
    if (callEarlyCb && typeof onEarlyError === 'function') {
      try {
        onEarlyError(earlyError);
      } catch {
        // ignore
      }
    }
  };

  const onSignalAbort = () => {
    failStream(createAbortError('Upload cancelled'), true);
  };
  if (signal) {
    signal.addEventListener('abort', onSignalAbort, { once: true });
  }

  req.setTimeout(inactivityTimeoutMs, () => {
    const timeoutErr = new Error(
      `Streaming PATCH upload timed out after ${inactivityTimeoutMs}ms of inactivity`
    );
    timeoutErr.isTimeoutError = true;
    timeoutErr.code = 'ETIMEDOUT';
    failStream(timeoutErr, true);
  });

  req.on('error', (err) => {
    failStream(err, true);
  });

  req.on('response', (res) => {
    const status = res.statusCode || 0;
    if (status >= 400) {
      earlyResponseStatus = status;
    }
    const chunks = [];
    res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    res.on('error', (err) => failStream(err, !finishRequested));
    res.on('aborted', () => {
      const err = new Error('Streaming PATCH response aborted');
      err.code = 'ECONNRESET';
      failStream(err, !finishRequested);
    });
    res.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      if (status === 201 || status === 202 || status === 204) {
        if (!settled) {
          settled = true;
          cleanupSignal();
          resolveResp({
            status,
            location: res.headers.location || null,
          });
        }
        return;
      }
      const httpErr = createHttpError(
        `Streaming layer upload rejected (HTTP ${status}): ${bodyText}`,
        status,
        bodyText
      );
      failStream(httpErr, !finishRequested);
    });
  });

  req.on('close', () => {
    if (!settled) {
      const err = new Error('Streaming PATCH connection closed unexpectedly');
      err.code = 'ECONNRESET';
      failStream(err, true);
    }
  });

  return {
    async write(buf) {
      if (signal?.aborted) {
        throw createAbortError('Upload cancelled');
      }
      if (earlyError) {
        throw earlyError;
      }
      if (req.destroyed) {
        throw earlyError || Object.assign(new Error('Upload stream destroyed'), { code: 'ECONNRESET' });
      }
      await writeStreamChunk(req, buf);
      if (earlyError) {
        throw earlyError;
      }
    },
    async finish() {
      if (signal?.aborted) {
        throw createAbortError('Upload cancelled');
      }
      if (earlyError) {
        throw earlyError;
      }
      finishRequested = true;
      req.end();
      return await responsePromise;
    },
    destroy(err) {
      failStream(err || createAbortError('Upload cancelled'), false);
    },
  };
}

/**
 * Fallback/chunked uploader: streams TAR + gzip from disk into 4 MiB OCI PATCH chunks
 * with zero temp files written to disk.
 */
async function streamAndUploadOciLayerChunked({
  files,
  uploadInitUrl,
  registryToken,
  refreshToken,
  fetchFn = fetch,
  chunkBytes = BLOB_UPLOAD_CHUNK_BYTES,
  gzipLevel,
  onProgress,
  signal,
}) {
  if (signal?.aborted) {
    throw createAbortError('Upload cancelled');
  }

  const session = createOciSessionClient({
    uploadInitUrl,
    registryToken,
    refreshToken,
    fetchFn,
    signal,
  });
  let activeMaxPatchBytes = Math.min(chunkBytes, BLOB_UPLOAD_CHUNK_BYTES);

  async function syncServerUploadOffset() {
    const url = session.getSessionUrl();
    if (!url) return null;
    try {
      const res = await session.sendRequestWithAuthRetry(url, (tok) => ({
        method: 'GET',
        headers: {
          Authorization: `Bearer ${tok}`,
        },
      }));
      if (res.status === 200 || res.status === 204) {
        session.updateLocation(res.headers.get('location'));
        return parseRangeEndOffset(res.headers.get('range'));
      }
      await res.text().catch(() => '');
      return null;
    } catch (err) {
      if (signal?.aborted || (err && err.name === 'AbortError')) {
        throw err;
      }
      return null;
    }
  }

  async function sendPatchBuffer(buf, startOffset) {
    let localPos = 0;
    while (localPos < buf.length) {
      let attempt = 0;
      while (true) {
        if (signal?.aborted) {
          throw createAbortError('Upload cancelled');
        }
        const sliceLen = Math.min(activeMaxPatchBytes, buf.length - localPos);
        const rangeStart = startOffset + localPos;
        const rangeEnd = rangeStart + sliceLen - 1;
        const sub = buf.subarray(localPos, localPos + sliceLen);

        let patchRes;
        try {
          patchRes = await session.sendRequestWithAuthRetry(session.getSessionUrl(), (tok) => ({
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${tok}`,
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(sliceLen),
              'Content-Range': `${rangeStart}-${rangeEnd}`,
            },
            body: sub,
          }));
        } catch (err) {
          if (signal?.aborted || (err && err.name === 'AbortError')) {
            throw err;
          }
          if (attempt < 3) {
            attempt += 1;
            await sleepAbortable(800 * attempt, signal);
            const serverOff = await syncServerUploadOffset();
            if (
              serverOff !== null &&
              serverOff > rangeStart &&
              serverOff <= startOffset + buf.length
            ) {
              localPos = serverOff - startOffset;
              break;
            }
            continue;
          }
          throw err;
        }

        if (
          patchRes.status === 202 ||
          patchRes.status === 201 ||
          patchRes.status === 204
        ) {
          session.updateLocation(patchRes.headers.get('location'));
          await patchRes.text().catch(() => '');
          localPos += sliceLen;
          break;
        }

        const bodyText = await patchRes.text().catch(() => '');

        if (
          isChunkTooLargeResponse(patchRes.status, bodyText) &&
          sliceLen > MIN_ADAPTIVE_CHUNK_BYTES
        ) {
          activeMaxPatchBytes = Math.max(
            MIN_ADAPTIVE_CHUNK_BYTES,
            Math.floor(sliceLen / 2)
          );
          attempt = 0;
          continue;
        }

        if (patchRes.status === 416) {
          const serverOff =
            parseRangeEndOffset(patchRes.headers.get('range')) ??
            (await syncServerUploadOffset());
          if (
            serverOff !== null &&
            serverOff > rangeStart &&
            serverOff <= startOffset + buf.length
          ) {
            localPos = serverOff - startOffset;
            break;
          }
        }

        if (isTransientHttpStatus(patchRes.status) && attempt < 3) {
          attempt += 1;
          await sleepAbortable(800 * attempt, signal);
          const serverOff = await syncServerUploadOffset();
          if (
            serverOff !== null &&
            serverOff > rangeStart &&
            serverOff <= startOffset + buf.length
          ) {
            localPos = serverOff - startOffset;
            break;
          }
          continue;
        }

        throw createHttpError(
          `Failed to upload layer chunk at byte ${rangeStart} (HTTP ${patchRes.status}): ${bodyText}`,
          patchRes.status,
          bodyText
        );
      }
    }
  }

  try {
    await session.startSession();

    const layerResult = await streamOciLayerInChunks({
      files,
      chunkBytes,
      gzipLevel,
      signal,
      onProgress,
      onChunk: async ({ chunk, offset, isFinal, isMonolithic, compressedDigest }) => {
        if (isFinal && isMonolithic) {
          await session.commitPut(compressedDigest, chunk, async () => {
            activeMaxPatchBytes = Math.max(
              MIN_ADAPTIVE_CHUNK_BYTES,
              Math.min(
                activeMaxPatchBytes,
                Math.floor(chunk.length / 2) || MIN_ADAPTIVE_CHUNK_BYTES
              )
            );
            await sendPatchBuffer(chunk, 0);
            return session.commitPut(compressedDigest, null);
          });
          return;
        }
        if (isFinal) {
          if (chunk.length > 0) {
            await sendPatchBuffer(chunk, offset);
          }
          await session.commitPut(compressedDigest, null);
          return;
        }
        await sendPatchBuffer(chunk, offset);
      },
    });

    return {
      ...layerResult,
      registryToken: session.getToken(),
      uploadMode: 'chunked',
    };
  } catch (err) {
    if (signal?.aborted) {
      await session.deleteSessionBestEffort();
    }
    throw err;
  }
}

/**
 * Single attempt at continuous streaming PATCH upload (Transfer-Encoding: chunked).
 */
async function streamAndUploadOciLayerContinuousAttempt({
  files,
  uploadInitUrl,
  registryToken,
  refreshToken,
  fetchFn = fetch,
  gzipLevel,
  inactivityTimeoutMs = DEFAULT_INACTIVITY_TIMEOUT_MS,
  onProgress,
  signal,
}) {
  if (signal?.aborted) {
    throw createAbortError('Upload cancelled');
  }

  const session = createOciSessionClient({
    uploadInitUrl,
    registryToken,
    refreshToken,
    fetchFn,
    signal,
  });

  let streamHandle = null;

  try {
    await session.startSession();

    const layerResult = await streamOciLayerContinuous({
      files,
      monolithicThresholdBytes: BLOB_UPLOAD_CHUNK_BYTES,
      gzipLevel,
      signal,
      onProgress,
      onStartStream: async ({ abortPipeline }) => {
        const rawHandle = openStreamingPatchRequest({
          url: session.getSessionUrl(),
          token: session.getToken(),
          signal,
          inactivityTimeoutMs,
          onEarlyError: abortPipeline,
        });
        streamHandle = {
          write: (buf) => rawHandle.write(buf),
          finish: async () => {
            const resInfo = await rawHandle.finish();
            if (resInfo?.location) {
              session.updateLocation(resInfo.location);
            }
            return resInfo;
          },
          destroy: (err) => rawHandle.destroy(err),
        };
        return streamHandle;
      },
      onMonolithic: async ({ body, compressedDigest }) => {
        await session.commitPut(compressedDigest, body);
      },
      onCommitStreamed: async ({ compressedDigest }) => {
        await session.commitPut(compressedDigest, null);
      },
    });

    return {
      ...layerResult,
      registryToken: session.getToken(),
      uploadMode: 'continuous',
    };
  } catch (err) {
    if (err && typeof err === 'object') {
      err.latestToken = session.getToken();
    }
    await session.deleteSessionBestEffort();
    throw err;
  }
}

/**
 * Primary desktop streaming uploader:
 * 1. Tries continuous streaming PATCH (Transfer-Encoding: chunked, full upload speed, zero temp file).
 * 2. On transient connection drop (500/502/503/429/socket reset), retries once with continuous streaming.
 * 3. If the server/proxy rejects streaming (400/401/405/408/411/413/416/501/504 or timeout) or the
 *    second continuous attempt drops, automatically falls back to 4 MiB Content-Range PATCH chunks.
 */
async function streamAndUploadOciLayer(opts) {
  const {
    uploadMode = 'stream',
    refreshToken,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    fallbackDelayMs = DEFAULT_FALLBACK_DELAY_MS,
    inactivityTimeoutMs = DEFAULT_INACTIVITY_TIMEOUT_MS,
    onStatusMessage,
    signal,
  } = opts;

  if (uploadMode === 'chunked') {
    return await streamAndUploadOciLayerChunked(opts);
  }

  let currentToken = opts.registryToken;

  async function refreshIfNeeded(err) {
    if (Number(err?.statusCode) === 401 && typeof refreshToken === 'function') {
      const next = await refreshToken();
      if (next) {
        currentToken = next;
      }
    }
  }

  async function runChunkedFallback(causeErr, delayMs) {
    await refreshIfNeeded(causeErr);
    if (typeof onStatusMessage === 'function') {
      onStatusMessage('Switching to 4 MiB chunked upload...');
    }
    if (delayMs > 0) {
      await sleepAbortable(delayMs, signal);
    }
    return await streamAndUploadOciLayerChunked({
      ...opts,
      registryToken: currentToken,
    });
  }

  try {
    return await streamAndUploadOciLayerContinuousAttempt({
      ...opts,
      registryToken: currentToken,
      inactivityTimeoutMs,
    });
  } catch (err1) {
    if (err1?.latestToken) {
      currentToken = err1.latestToken;
    }
    if (signal?.aborted || isNonRetryableLocalOrFatalError(err1)) {
      throw err1;
    }
    if (shouldFallbackImmediatelyToChunked(err1)) {
      return await runChunkedFallback(err1, 0);
    }

    if (typeof onStatusMessage === 'function') {
      onStatusMessage('Connection interrupted - retrying continuous stream...');
    }
    await sleepAbortable(retryDelayMs, signal);

    try {
      return await streamAndUploadOciLayerContinuousAttempt({
        ...opts,
        registryToken: currentToken,
        inactivityTimeoutMs,
      });
    } catch (err2) {
      if (err2?.latestToken) {
        currentToken = err2.latestToken;
      }
      if (signal?.aborted || isNonRetryableLocalOrFatalError(err2)) {
        throw err2;
      }
      return await runChunkedFallback(err2, fallbackDelayMs);
    }
  }
}

module.exports = {
  BLOB_UPLOAD_CHUNK_BYTES,
  MIN_ADAPTIVE_CHUNK_BYTES,
  isChunkTooLargeResponse,
  parseRangeEndOffset,
  streamAndUploadOciLayer,
  streamAndUploadOciLayerChunked,
};
