const {
  createAbortError,
  streamOciLayerInChunks,
} = require('./streaming-tar.cjs');

const BLOB_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024; // 4 MiB - GHCR/Azure max PATCH body limit
const MIN_ADAPTIVE_CHUNK_BYTES = 256 * 1024; // 256 KiB adaptive floor

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

function sleepAbortable(ms, signal) {
  if (signal?.aborted) {
    return Promise.reject(createAbortError('Upload cancelled'));
  }
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
 * Streams TAR + gzip directly from disk into 4 MiB OCI PATCH chunks without writing
 * any temporary archive file to local storage.
 */
async function streamAndUploadOciLayer({
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

  let token = registryToken;
  let sessionUrl = '';
  let activeMaxPatchBytes = Math.min(chunkBytes, BLOB_UPLOAD_CHUNK_BYTES);

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

  async function syncServerUploadOffset() {
    if (!sessionUrl) return null;
    try {
      const res = await sendRequestWithAuthRetry(sessionUrl, (tok) => ({
        method: 'GET',
        headers: {
          Authorization: `Bearer ${tok}`,
        },
      }));
      if (res.status === 200 || res.status === 204) {
        const nextLoc = res.headers.get('location');
        if (nextLoc) {
          sessionUrl = new URL(nextLoc, sessionUrl).toString();
        }
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
          patchRes = await sendRequestWithAuthRetry(sessionUrl, (tok) => ({
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
          const nextLoc = patchRes.headers.get('location');
          if (nextLoc) {
            sessionUrl = new URL(nextLoc, sessionUrl).toString();
          }
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

        throw new Error(
          `Failed to upload layer chunk at byte ${rangeStart} (HTTP ${patchRes.status}): ${bodyText}`
        );
      }
    }
  }

  async function commitUpload(digest, monolithicBody = null) {
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

      if (hasBody && isChunkTooLargeResponse(putRes.status, bodyText)) {
        activeMaxPatchBytes = Math.max(
          MIN_ADAPTIVE_CHUNK_BYTES,
          Math.min(
            activeMaxPatchBytes,
            Math.floor(monolithicBody.length / 2) || MIN_ADAPTIVE_CHUNK_BYTES
          )
        );
        await sendPatchBuffer(monolithicBody, 0);
        return commitUpload(digest, null);
      }

      if (isTransientHttpStatus(putRes.status) && attempt < 3) {
        await sleepAbortable(800 * (attempt + 1), signal);
        continue;
      }

      throw new Error(
        `Failed to commit blob upload to ghcr.io (HTTP ${putRes.status}): ${bodyText}`
      );
    }
  }

  try {
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
        throw new Error(
          `Failed to initiate blob upload to ghcr.io (HTTP ${startRes.status}): ${errBody}`
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

    const layerResult = await streamOciLayerInChunks({
      files,
      chunkBytes,
      gzipLevel,
      signal,
      onProgress,
      onChunk: async ({ chunk, offset, isFinal, isMonolithic, compressedDigest }) => {
        if (isFinal && isMonolithic) {
          await commitUpload(compressedDigest, chunk);
          return;
        }
        if (isFinal) {
          if (chunk.length > 0) {
            await sendPatchBuffer(chunk, offset);
          }
          await commitUpload(compressedDigest, null);
          return;
        }
        await sendPatchBuffer(chunk, offset);
      },
    });

    return {
      ...layerResult,
      registryToken: token,
    };
  } catch (err) {
    if (signal?.aborted && sessionUrl) {
      await fetchFn(sessionUrl, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
    throw err;
  }
}

module.exports = {
  BLOB_UPLOAD_CHUNK_BYTES,
  MIN_ADAPTIVE_CHUNK_BYTES,
  isChunkTooLargeResponse,
  parseRangeEndOffset,
  streamAndUploadOciLayer,
};
