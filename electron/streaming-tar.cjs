const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MAX_USTAR_OCTAL_SIZE = 0o77777777777; // 8,589,934,591 bytes (~8 GiB)
const READ_CHUNK_BYTES = 1024 * 1024; // 1 MiB read chunks
const DEFAULT_STREAM_CHUNK_BYTES = 4 * 1024 * 1024; // 4 MiB max GHCR PATCH chunk
const ADAPTIVE_GZIP_FAST_THRESHOLD_BYTES = 64 * 1024 * 1024; // >= 64 MiB uses fast level-1 gzip

function writeAscii(buf, str, offset, length) {
  const bytes = Buffer.from(str, 'utf8');
  const len = Math.min(bytes.length, length);
  bytes.copy(buf, offset, 0, len);
}

function writeOctal(buf, value, offset, length) {
  const safeVal = Math.max(0, Math.floor(value));
  const oct = safeVal.toString(8).padStart(length - 1, '0');
  writeAscii(buf, oct, offset, length - 1);
  buf[offset + length - 1] = 0;
}

function finalizeTarHeaderChecksum(header) {
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    sum += header[i];
  }
  const oct = sum.toString(8).padStart(6, '0');
  writeAscii(header, oct, 148, 6);
  header[154] = 0;
  header[155] = 0x20;
}

function createUstarHeaderNode(name, size, mtime, typeflag = '0', mode = null) {
  const header = Buffer.alloc(512);
  const resolvedMode = mode ?? (typeflag === '5' ? 0o755 : 0o644);
  writeAscii(header, name, 0, 100);
  writeOctal(header, resolvedMode, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, size > MAX_USTAR_OCTAL_SIZE ? 0 : size, 124, 12);
  writeOctal(header, mtime, 136, 12);
  header[156] = typeflag.charCodeAt(0);
  writeAscii(header, 'ustar', 257, 6);
  writeAscii(header, '00', 263, 2);
  finalizeTarHeaderChecksum(header);
  return header;
}

function formatPaxRecordLine(key, value) {
  const keyVal = ` ${key}=${value}\n`;
  const keyValBytes = Buffer.byteLength(keyVal, 'utf8');
  let totalLen = keyValBytes + 2;
  let recordStr = `${totalLen}${keyVal}`;
  while (Buffer.byteLength(recordStr, 'utf8') !== totalLen) {
    totalLen = Buffer.byteLength(recordStr, 'utf8');
    recordStr = `${totalLen}${keyVal}`;
  }
  return Buffer.from(recordStr, 'utf8');
}

function createPaxPayloadBuffer(attrs) {
  const parts = [];
  if (attrs.path) parts.push(formatPaxRecordLine('path', attrs.path));
  if (attrs.size !== undefined) parts.push(formatPaxRecordLine('size', String(attrs.size)));
  return Buffer.concat(parts);
}

function writeStreamChunk(stream, buf) {
  if (!buf || buf.length === 0) return Promise.resolve();
  if (stream.destroyed || stream.writableEnded) return Promise.resolve();
  if (stream.write(buf)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      stream.removeListener('drain', onDrain);
      stream.removeListener('close', onClose);
      stream.removeListener('error', onError);
    };
    stream.once('drain', onDrain);
    stream.once('close', onClose);
    stream.once('error', onError);
  });
}

function createAbortError(message = 'Operation aborted') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/**
 * Streams local files directly from disk into a temporary gzipped OCI layer (.tar.gz),
 * computing uncompressed diff_id and compressed SHA-256 digests with O(1) RAM usage.
 */
async function prepareTarSourceEntries(files, signal) {
  if (signal?.aborted) {
    throw createAbortError('Upload cancelled');
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('Cannot create an image with zero files.');
  }

  const statList = [];
  let totalFileBytes = 0;
  for (const f of files) {
    if (signal?.aborted) {
      throw createAbortError('Upload cancelled');
    }
    if (f.isDirectory) {
      let mtime =
        typeof f.mtime === 'number' && Number.isFinite(f.mtime)
          ? Math.floor(f.mtime)
          : Math.floor(Date.now() / 1000);
      if (f.fullPath && !(typeof f.mtime === 'number' && Number.isFinite(f.mtime))) {
        try {
          const st = await fs.stat(f.fullPath);
          mtime = Math.floor(st.mtimeMs / 1000);
        } catch {
          // Ignore stat error and keep default mtime
        }
      }
      statList.push({
        fullPath: f.fullPath || '',
        relativePath: f.relativePath,
        size: 0,
        mtime,
        isDirectory: true,
      });
      continue;
    }
    if (!f.fullPath) {
      throw new Error(`Missing disk path for "${f.relativePath}".`);
    }
    const st = await fs.stat(f.fullPath);
    if (!st.isFile()) {
      throw new Error(`Path is not a regular file: "${f.fullPath}".`);
    }
    const mtime =
      typeof f.mtime === 'number' && Number.isFinite(f.mtime)
        ? Math.floor(f.mtime)
        : Math.floor(st.mtimeMs / 1000);
    statList.push({
      fullPath: f.fullPath,
      relativePath: f.relativePath,
      size: st.size,
      mtime,
      isDirectory: false,
    });
    totalFileBytes += st.size;
  }

  return { statList, totalFileBytes };
}

function buildTarFileMetaList(statList) {
  return statList.map((f) => {
    const normalized = f.relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || '.';
    return f.isDirectory
      ? { path: normalized, size: 0, isDirectory: true }
      : { path: normalized, size: f.size };
  });
}

async function pumpTarArchiveIntoGzip({
  statList,
  gzip,
  uncompressedHash,
  signal,
  onActiveReadStream,
  getPipeFailure,
  onBytesRead,
}) {
  async function emitTarBytes(buf) {
    if (signal?.aborted) throw createAbortError('Upload cancelled');
    const pipeErr = getPipeFailure();
    if (pipeErr) throw pipeErr;
    if (!buf || buf.length === 0) return;
    uncompressedHash.update(buf);
    await writeStreamChunk(gzip, buf);
    const afterPipeErr = getPipeFailure();
    if (afterPipeErr) throw afterPipeErr;
  }

  const nowSec = Math.floor(Date.now() / 1000);

  for (const entry of statList) {
    if (signal?.aborted) throw createAbortError('Upload cancelled');
    const rawCleanPath = entry.relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const cleanPath = entry.isDirectory
      ? rawCleanPath === '' || rawCleanPath === '.'
        ? './'
        : `${rawCleanPath}/`
      : rawCleanPath;
    const pathBytes = Buffer.byteLength(cleanPath, 'utf8');
    const isAscii = /^[\x00-\x7F]*$/.test(cleanPath);
    const needsPaxPath = pathBytes > 99 || !isAscii;
    const needsPaxSize = !entry.isDirectory && entry.size > MAX_USTAR_OCTAL_SIZE;
    const mtime = entry.mtime ?? nowSec;

    if (needsPaxPath || needsPaxSize) {
      const paxPayload = createPaxPayloadBuffer({
        path: needsPaxPath ? cleanPath : undefined,
        size: needsPaxSize ? entry.size : undefined,
      });
      const paxHeader = createUstarHeaderNode(
        'PaxHeader/entry',
        paxPayload.length,
        mtime,
        'x'
      );
      await emitTarBytes(paxHeader);
      await emitTarBytes(paxPayload);
      const paxPad = (512 - (paxPayload.length % 512)) % 512;
      if (paxPad > 0) await emitTarBytes(Buffer.alloc(paxPad));
    }

    const shortAsciiName = cleanPath.replace(/[^\x20-\x7E]/g, '_').slice(-99);
    if (entry.isDirectory) {
      const dirHeader = createUstarHeaderNode(
        shortAsciiName || './',
        0,
        mtime,
        '5',
        0o755
      );
      await emitTarBytes(dirHeader);
      continue;
    }

    const fileHeader = createUstarHeaderNode(
      shortAsciiName || 'file',
      entry.size,
      mtime,
      '0'
    );
    await emitTarBytes(fileHeader);

    let actualRead = 0;
    const readStream = fsSync.createReadStream(entry.fullPath, {
      highWaterMark: READ_CHUNK_BYTES,
    });
    onActiveReadStream(readStream);
    for await (const chunk of readStream) {
      if (signal?.aborted) {
        readStream.destroy();
        throw createAbortError('Upload cancelled');
      }
      const pipeErr = getPipeFailure();
      if (pipeErr) {
        readStream.destroy();
        throw pipeErr;
      }
      actualRead += chunk.length;
      onBytesRead(chunk.length);
      await emitTarBytes(chunk);
    }
    onActiveReadStream(null);

    if (signal?.aborted) {
      throw createAbortError('Upload cancelled');
    }
    const postReadPipeErr = getPipeFailure();
    if (postReadPipeErr) {
      throw postReadPipeErr;
    }

    if (actualRead !== entry.size) {
      throw new Error(
        `File "${entry.relativePath}" changed size while reading (expected ${entry.size} B, read ${actualRead} B).`
      );
    }

    const padding = (512 - (entry.size % 512)) % 512;
    if (padding > 0) {
      await emitTarBytes(Buffer.alloc(padding));
    }
  }

  // Two 512-byte zero blocks mark end-of-archive
  await emitTarBytes(Buffer.alloc(1024));
  gzip.end();
}

/**
 * Streams local files directly from disk into a temporary gzipped OCI layer (.tar.gz),
 * computing uncompressed diff_id and compressed SHA-256 digests with O(1) RAM usage.
 */
async function buildOciLayerToFile({ files, outFilePath, onProgress, signal }) {
  const { statList, totalFileBytes } = await prepareTarSourceEntries(files, signal);

  const uncompressedHash = crypto.createHash('sha256');
  const compressedHash = crypto.createHash('sha256');
  const gzip = zlib.createGzip({ level: 6 });
  const outStream = fsSync.createWriteStream(outFilePath);
  let compressedSize = 0;
  let activeReadStream = null;

  gzip.on('data', (gzChunk) => {
    compressedSize += gzChunk.length;
    compressedHash.update(gzChunk);
  });

  // Node pipeline handles backpressure from disk outStream -> gzip -> emitTarBytes
  const pipeDone = pipeline(gzip, outStream);
  let pipeFailed = false;
  let pipeError = null;
  pipeDone.catch((e) => {
    pipeFailed = true;
    pipeError = e;
  });

  const onAbort = () => {
    pipeFailed = true;
    try {
      activeReadStream?.destroy();
    } catch {
      // ignore
    }
    try {
      gzip.destroy();
    } catch {
      // ignore
    }
    try {
      outStream.destroy();
    } catch {
      // ignore
    }
  };
  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  let processedBytes = 0;
  let lastPct = -1;
  function reportProgress(force = false) {
    if (!onProgress) return;
    const pct =
      totalFileBytes > 0
        ? Math.min(100, Math.round((processedBytes / totalFileBytes) * 100))
        : 100;
    if (force || pct !== lastPct) {
      lastPct = pct;
      onProgress({
        processedBytes,
        totalBytes: totalFileBytes,
        percent: pct,
      });
    }
  }

  try {
    reportProgress(true);
    await pumpTarArchiveIntoGzip({
      statList,
      gzip,
      uncompressedHash,
      signal,
      onActiveReadStream: (s) => {
        activeReadStream = s;
      },
      getPipeFailure: () => (pipeFailed ? pipeError || new Error('Archive stream failed') : null),
      onBytesRead: (delta) => {
        processedBytes += delta;
        reportProgress(false);
      },
    });
    await pipeDone;
    reportProgress(true);

    return {
      tempPath: outFilePath,
      uncompressedDigest: `sha256:${uncompressedHash.digest('hex')}`,
      compressedDigest: `sha256:${compressedHash.digest('hex')}`,
      compressedSize,
      totalFileBytes,
      fileCount: statList.filter((f) => !f.isDirectory).length,
      fileMetaList: buildTarFileMetaList(statList),
    };
  } catch (err) {
    try {
      activeReadStream?.destroy();
    } catch {
      // ignore
    }
    try {
      gzip.destroy();
    } catch {
      // ignore
    }
    try {
      outStream.destroy();
    } catch {
      // ignore
    }
    await pipeDone.catch((e) => {
      if (!pipeError) pipeError = e;
    });
    await fs.unlink(outFilePath).catch(() => {});
    if (signal?.aborted) {
      throw createAbortError('Upload cancelled');
    }
    throw pipeError || err;
  } finally {
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * Streams local files directly from disk through TAR + gzip into fixed-size chunks
 * (default 4 MiB) without writing any temporary archive file to disk.
 */
async function streamOciLayerInChunks({
  files,
  chunkBytes = DEFAULT_STREAM_CHUNK_BYTES,
  onChunk,
  onProgress,
  signal,
  gzipLevel,
}) {
  if (typeof onChunk !== 'function') {
    throw new Error('streamOciLayerInChunks requires an onChunk callback.');
  }
  const { statList, totalFileBytes } = await prepareTarSourceEntries(files, signal);
  const resolvedGzipLevel =
    typeof gzipLevel === 'number'
      ? gzipLevel
      : totalFileBytes >= ADAPTIVE_GZIP_FAST_THRESHOLD_BYTES
        ? 1
        : 6;

  const uncompressedHash = crypto.createHash('sha256');
  const compressedHash = crypto.createHash('sha256');
  const gzip = zlib.createGzip({ level: resolvedGzipLevel });
  const chunkBuf = Buffer.allocUnsafe(chunkBytes);
  let chunkFill = 0;
  let compressedSize = 0;
  let uploadedCompressedBytes = 0;
  let emittedChunkCount = 0;
  let committedDigest = null;
  let processedBytes = 0;
  let lastPct = -1;
  let activeReadStream = null;

  function reportProgress(force = false, chunkFlushed = false) {
    if (!onProgress) return;
    const pct =
      totalFileBytes > 0
        ? Math.min(100, Math.round((processedBytes / totalFileBytes) * 100))
        : 100;
    if (force || chunkFlushed || pct !== lastPct) {
      lastPct = pct;
      onProgress({
        processedBytes,
        totalBytes: totalFileBytes,
        uploadedBytes: uploadedCompressedBytes,
        percent: pct,
      });
    }
  }

  const chunkSink = new Writable({
    highWaterMark: 256 * 1024,
    write(gzChunk, _enc, cb) {
      (async () => {
        if (signal?.aborted) {
          throw createAbortError('Upload cancelled');
        }
        const buf = Buffer.isBuffer(gzChunk) ? gzChunk : Buffer.from(gzChunk);
        compressedSize += buf.length;
        compressedHash.update(buf);

        let srcOffset = 0;
        while (srcOffset < buf.length) {
          const take = Math.min(chunkBytes - chunkFill, buf.length - srcOffset);
          buf.copy(chunkBuf, chunkFill, srcOffset, srcOffset + take);
          chunkFill += take;
          srcOffset += take;

          if (chunkFill === chunkBytes) {
            await onChunk({
              chunk: chunkBuf,
              offset: uploadedCompressedBytes,
              isFinal: false,
              isMonolithic: false,
              compressedDigest: null,
            });
            uploadedCompressedBytes += chunkFill;
            emittedChunkCount += 1;
            chunkFill = 0;
            reportProgress(false, true);
          }
        }
      })().then(
        () => cb(),
        (err) => cb(err)
      );
    },
    final(cb) {
      (async () => {
        if (signal?.aborted) {
          throw createAbortError('Upload cancelled');
        }
        committedDigest = `sha256:${compressedHash.digest('hex')}`;
        const remaining = chunkFill > 0 ? chunkBuf.subarray(0, chunkFill) : Buffer.alloc(0);
        const isMonolithic = emittedChunkCount === 0;
        await onChunk({
          chunk: remaining,
          offset: uploadedCompressedBytes,
          isFinal: true,
          isMonolithic,
          compressedDigest: committedDigest,
        });
        uploadedCompressedBytes += remaining.length;
        chunkFill = 0;
        reportProgress(true, true);
      })().then(
        () => cb(),
        (err) => cb(err)
      );
    },
  });

  const pipeDone = pipeline(gzip, chunkSink);
  let pipeFailed = false;
  let pipeError = null;
  pipeDone.catch((e) => {
    pipeFailed = true;
    pipeError = e;
  });

  const onAbort = () => {
    pipeFailed = true;
    try {
      activeReadStream?.destroy();
    } catch {
      // ignore
    }
    try {
      gzip.destroy();
    } catch {
      // ignore
    }
    try {
      chunkSink.destroy();
    } catch {
      // ignore
    }
  };
  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    reportProgress(true, false);
    await pumpTarArchiveIntoGzip({
      statList,
      gzip,
      uncompressedHash,
      signal,
      onActiveReadStream: (s) => {
        activeReadStream = s;
      },
      getPipeFailure: () => (pipeFailed ? pipeError || new Error('Archive stream failed') : null),
      onBytesRead: (delta) => {
        processedBytes += delta;
        reportProgress(false, false);
      },
    });
    await pipeDone;
    reportProgress(true, false);

    return {
      uncompressedDigest: `sha256:${uncompressedHash.digest('hex')}`,
      compressedDigest: committedDigest || `sha256:${compressedHash.digest('hex')}`,
      compressedSize,
      totalFileBytes,
      fileCount: statList.filter((f) => !f.isDirectory).length,
      fileMetaList: buildTarFileMetaList(statList),
    };
  } catch (err) {
    try {
      activeReadStream?.destroy();
    } catch {
      // ignore
    }
    try {
      gzip.destroy();
    } catch {
      // ignore
    }
    try {
      chunkSink.destroy();
    } catch {
      // ignore
    }
    await pipeDone.catch((e) => {
      if (!pipeError) pipeError = e;
    });
    if (signal?.aborted) {
      throw createAbortError('Upload cancelled');
    }
    throw pipeError || err;
  } finally {
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * Streams local files directly from disk through TAR + gzip into a single continuous
 * stream (buffered up to `monolithicThresholdBytes` first so <= 4 MiB layers can commit
 * via one monolithic PUT). Writes zero temporary archive files to disk.
 */
async function streamOciLayerContinuous({
  files,
  monolithicThresholdBytes = DEFAULT_STREAM_CHUNK_BYTES,
  onStartStream,
  onMonolithic,
  onCommitStreamed,
  onProgress,
  signal,
  gzipLevel,
}) {
  if (
    typeof onStartStream !== 'function' ||
    typeof onMonolithic !== 'function' ||
    typeof onCommitStreamed !== 'function'
  ) {
    throw new Error(
      'streamOciLayerContinuous requires onStartStream, onMonolithic, and onCommitStreamed callbacks.'
    );
  }
  const { statList, totalFileBytes } = await prepareTarSourceEntries(files, signal);
  const resolvedGzipLevel =
    typeof gzipLevel === 'number'
      ? gzipLevel
      : totalFileBytes >= ADAPTIVE_GZIP_FAST_THRESHOLD_BYTES
        ? 1
        : 6;

  const uncompressedHash = crypto.createHash('sha256');
  const compressedHash = crypto.createHash('sha256');
  const gzip = zlib.createGzip({ level: resolvedGzipLevel });
  const initialBuf = Buffer.allocUnsafe(monolithicThresholdBytes);
  let initialFill = 0;
  let activeStream = null;
  let compressedSize = 0;
  let uploadedCompressedBytes = 0;
  let committedDigest = null;
  let processedBytes = 0;
  let lastPct = -1;
  let lastReportedUploaded = -1;
  let activeReadStream = null;
  let pipeFailed = false;
  let pipeError = null;

  function reportProgress(force = false, dataSent = false) {
    if (!onProgress) return;
    const pct =
      totalFileBytes > 0
        ? Math.min(100, Math.round((processedBytes / totalFileBytes) * 100))
        : 100;
    const uploadedDelta = uploadedCompressedBytes - lastReportedUploaded;
    if (
      force ||
      pct !== lastPct ||
      (dataSent && (lastReportedUploaded < 0 || uploadedDelta >= 1024 * 1024))
    ) {
      lastPct = pct;
      if (uploadedCompressedBytes > lastReportedUploaded) {
        lastReportedUploaded = uploadedCompressedBytes;
      }
      onProgress({
        processedBytes,
        totalBytes: totalFileBytes,
        uploadedBytes: uploadedCompressedBytes,
        percent: pct,
      });
    }
  }

  let sink;
  const abortPipelineWithError = (streamErr) => {
    if (!pipeError && streamErr) pipeError = streamErr;
    pipeFailed = true;
    try {
      activeReadStream?.destroy();
    } catch {
      // ignore
    }
    try {
      gzip.destroy();
    } catch {
      // ignore
    }
    try {
      sink?.destroy(streamErr);
    } catch {
      // ignore
    }
  };

  sink = new Writable({
    highWaterMark: 256 * 1024,
    write(gzChunk, _enc, cb) {
      (async () => {
        if (signal?.aborted) {
          throw createAbortError('Upload cancelled');
        }
        if (pipeFailed) {
          throw pipeError || new Error('Archive stream failed');
        }
        const buf = Buffer.isBuffer(gzChunk) ? gzChunk : Buffer.from(gzChunk);
        compressedSize += buf.length;
        compressedHash.update(buf);

        if (!activeStream) {
          if (initialFill + buf.length <= monolithicThresholdBytes) {
            buf.copy(initialBuf, initialFill);
            initialFill += buf.length;
            reportProgress(false, false);
            return;
          }
          activeStream = await onStartStream({
            abortPipeline: abortPipelineWithError,
          });
          if (initialFill > 0) {
            await activeStream.write(initialBuf.subarray(0, initialFill));
            uploadedCompressedBytes += initialFill;
            initialFill = 0;
          }
        }

        await activeStream.write(buf);
        uploadedCompressedBytes += buf.length;
        reportProgress(false, true);
      })().then(
        () => cb(),
        (err) => cb(err)
      );
    },
    final(cb) {
      (async () => {
        if (signal?.aborted) {
          throw createAbortError('Upload cancelled');
        }
        if (pipeFailed) {
          throw pipeError || new Error('Archive stream failed');
        }
        committedDigest = `sha256:${compressedHash.digest('hex')}`;
        if (!activeStream) {
          const body = initialFill > 0 ? initialBuf.subarray(0, initialFill) : Buffer.alloc(0);
          await onMonolithic({ body, compressedDigest: committedDigest });
          uploadedCompressedBytes = body.length;
          initialFill = 0;
          reportProgress(true, true);
          return;
        }
        await activeStream.finish();
        await onCommitStreamed({ compressedDigest: committedDigest });
        reportProgress(true, true);
      })().then(
        () => cb(),
        (err) => cb(err)
      );
    },
  });

  const pipeDone = pipeline(gzip, sink);
  pipeDone.catch((e) => {
    pipeFailed = true;
    if (!pipeError) pipeError = e;
  });

  const onAbort = () => {
    const cancelErr = createAbortError('Upload cancelled');
    pipeFailed = true;
    try {
      activeStream?.destroy?.(cancelErr);
    } catch {
      // ignore
    }
    try {
      activeReadStream?.destroy();
    } catch {
      // ignore
    }
    try {
      gzip.destroy();
    } catch {
      // ignore
    }
    try {
      sink.destroy();
    } catch {
      // ignore
    }
  };
  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    reportProgress(true, false);
    await pumpTarArchiveIntoGzip({
      statList,
      gzip,
      uncompressedHash,
      signal,
      onActiveReadStream: (s) => {
        activeReadStream = s;
      },
      getPipeFailure: () => (pipeFailed ? pipeError || new Error('Archive stream failed') : null),
      onBytesRead: (delta) => {
        processedBytes += delta;
        reportProgress(false, false);
      },
    });
    await pipeDone;
    reportProgress(true, false);

    return {
      uncompressedDigest: `sha256:${uncompressedHash.digest('hex')}`,
      compressedDigest: committedDigest || `sha256:${compressedHash.digest('hex')}`,
      compressedSize,
      totalFileBytes,
      fileCount: statList.filter((f) => !f.isDirectory).length,
      fileMetaList: buildTarFileMetaList(statList),
    };
  } catch (err) {
    try {
      activeStream?.destroy?.(err);
    } catch {
      // ignore
    }
    try {
      activeReadStream?.destroy();
    } catch {
      // ignore
    }
    try {
      gzip.destroy();
    } catch {
      // ignore
    }
    try {
      sink.destroy();
    } catch {
      // ignore
    }
    await pipeDone.catch((e) => {
      if (!pipeError) pipeError = e;
    });
    if (signal?.aborted) {
      throw createAbortError('Upload cancelled');
    }
    throw pipeError || err;
  } finally {
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * Shared streaming USTAR/PAX TAR state machine for both fast header indexing
 * and streaming zero-RAM extraction directly to disk.
 */
function createNodeTarStreamParser(handlers = {}) {
  const { onEntry, onDirectory, onFileStart, onFileData, onFileEnd } = handlers;
  const files = [];
  let pendingBuf = Buffer.alloc(4096);
  let pendingLen = 0;
  let dataRemaining = 0;
  let padRemaining = 0;
  let skipRemaining = 0;
  let metaNeededBlocks = 0;
  let metaExactSize = 0;
  let metaType = null;
  let pendingPaxPath = null;
  let pendingPaxSize = null;
  let done = false;

  function appendToPending(slice) {
    const needed = pendingLen + slice.length;
    if (needed > pendingBuf.length) {
      const next = Buffer.alloc(Math.max(pendingBuf.length * 2, needed));
      pendingBuf.copy(next, 0, 0, pendingLen);
      pendingBuf = next;
    }
    slice.copy(pendingBuf, pendingLen);
    pendingLen += slice.length;
  }

  function readNullStr(buf, offset, maxLen) {
    let end = offset;
    const limit = offset + maxLen;
    while (end < limit && buf[end] !== 0) end++;
    return buf.subarray(offset, end).toString('utf8');
  }

  function readOctal(buf, offset, maxLen) {
    const s = readNullStr(buf, offset, maxLen).trim();
    return s ? parseInt(s, 8) || 0 : 0;
  }

  async function feed(chunk) {
    if (done || !chunk || chunk.length === 0) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let pos = 0;

    while (pos < buf.length && !done) {
      if (dataRemaining > 0) {
        const take = Math.min(dataRemaining, buf.length - pos);
        if (onFileData) {
          await onFileData(buf.subarray(pos, pos + take));
        }
        pos += take;
        dataRemaining -= take;
        if (dataRemaining === 0 && onFileEnd) {
          await onFileEnd();
        }
        continue;
      }

      if (padRemaining > 0) {
        const take = Math.min(padRemaining, buf.length - pos);
        pos += take;
        padRemaining -= take;
        continue;
      }

      if (skipRemaining > 0) {
        const take = Math.min(skipRemaining, buf.length - pos);
        pos += take;
        skipRemaining -= take;
        continue;
      }

      if (metaNeededBlocks > 0) {
        const need = metaNeededBlocks - pendingLen;
        const take = Math.min(need, buf.length - pos);
        appendToPending(buf.subarray(pos, pos + take));
        pos += take;

        if (pendingLen === metaNeededBlocks) {
          const payload = pendingBuf.subarray(0, metaExactSize);
          if (metaType === 'x' || metaType === 'g') {
            const paxText = payload.toString('utf8');
            for (const line of paxText.split('\n')) {
              const spaceIdx = line.indexOf(' ');
              if (spaceIdx > 0) {
                const kv = line.slice(spaceIdx + 1);
                if (kv.startsWith('path=')) {
                  pendingPaxPath = kv.slice(5);
                } else if (kv.startsWith('size=')) {
                  const parsedSize = Number(kv.slice(5));
                  if (Number.isFinite(parsedSize) && parsedSize >= 0) {
                    pendingPaxSize = parsedSize;
                  }
                }
              }
            }
          } else if (metaType === 'L') {
            pendingPaxPath = readNullStr(payload, 0, payload.length);
          }
          pendingLen = 0;
          metaNeededBlocks = 0;
          metaExactSize = 0;
          metaType = null;
        }
        continue;
      }

      const need = 512 - pendingLen;
      const take = Math.min(need, buf.length - pos);
      appendToPending(buf.subarray(pos, pos + take));
      pos += take;

      if (pendingLen === 512) {
        const header = pendingBuf.subarray(0, 512);
        pendingLen = 0;

        let allZero = true;
        for (let i = 0; i < 512; i++) {
          if (header[i] !== 0) {
            allZero = false;
            break;
          }
        }
        if (allZero) {
          done = true;
          break;
        }

        const name = readNullStr(header, 0, 100);
        const prefix = readNullStr(header, 345, 155);
        const octalSize = readOctal(header, 124, 12);
        const typeflag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
        const size =
          (typeflag === '0' || typeflag === '\0') && pendingPaxSize !== null
            ? pendingPaxSize
            : octalSize;
        const blocks = Math.ceil(size / 512) * 512;
        const pad = blocks - size;

        if (typeflag === 'x' || typeflag === 'g' || typeflag === 'L') {
          if (blocks > 0) {
            metaType = typeflag;
            metaExactSize = octalSize;
            metaNeededBlocks = Math.ceil(octalSize / 512) * 512;
          }
        } else if (typeflag === '0' || typeflag === '\0') {
          const fullPath = (
            pendingPaxPath || (prefix ? `${prefix}/${name}` : name)
          ).replace(/^\/+/, '');
          pendingPaxPath = null;
          pendingPaxSize = null;

          if (fullPath) {
            const meta = { path: fullPath, size };
            files.push(meta);
            if (onEntry) await onEntry(meta);

            if (onFileStart) {
              await onFileStart(meta);
              if (size === 0) {
                if (onFileEnd) await onFileEnd();
              } else {
                dataRemaining = size;
                padRemaining = pad;
              }
            } else {
              skipRemaining = blocks;
            }
          } else {
            skipRemaining = blocks;
          }
        } else if (typeflag === '5') {
          const fullPath =
            (pendingPaxPath || (prefix ? `${prefix}/${name}` : name))
              .replace(/^\/+/, '')
              .replace(/\/+$/, '') || '.';
          pendingPaxPath = null;
          pendingPaxSize = null;

          const meta = { path: fullPath, size: 0, isDirectory: true };
          files.push(meta);
          if (onEntry) await onEntry(meta);
          if (onDirectory) await onDirectory(meta);
          skipRemaining = blocks;
        } else {
          pendingPaxPath = null;
          pendingPaxSize = null;
          skipRemaining = blocks;
        }
      }
    }
  }

  return {
    feed,
    getFiles: () => files,
    isDone: () => done,
  };
}

/**
 * Safely resolves an archive relative path under baseDest, preventing path traversal.
 */
function resolveSafeExtractPath(baseDest, relPath) {
  const cleanRel = String(relPath || '').replace(/^[/\\]+/, '');
  const resolvedBase = path.resolve(baseDest);
  const resolvedDest = path.resolve(resolvedBase, cleanRel);
  if (
    resolvedDest === resolvedBase ||
    !resolvedDest.startsWith(resolvedBase + path.sep)
  ) {
    throw new Error(`Unsafe archive entry path rejected: "${relPath}"`);
  }
  return resolvedDest;
}

/**
 * Sanitizes a package/image name into a safe cross-platform single folder name.
 */
function sanitizeFolderName(rawName) {
  const cleaned = String(rawName || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .trim()
    .replace(/[. ]+$/, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return 'package';
  }
  return cleaned;
}

/**
 * Checks whether "<parentDir>/<folderName>" already exists and returns a unique "(1)"/"(2)" suggestion.
 */
function resolveExtractDestinationInfo(parentDir, rawFolderName) {
  const folderName = sanitizeFolderName(rawFolderName);
  const targetPath = resolveSafeExtractPath(parentDir, folderName);
  const exists = fsSync.existsSync(targetPath);

  if (!exists) {
    return {
      parentDir,
      folderName,
      targetPath,
      exists: false,
      suggestedName: folderName,
      suggestedPath: targetPath,
    };
  }

  let counter = 1;
  while (counter < 10000) {
    const candidateName = `${folderName} (${counter})`;
    const candidatePath = resolveSafeExtractPath(parentDir, candidateName);
    if (!fsSync.existsSync(candidatePath)) {
      return {
        parentDir,
        folderName,
        targetPath,
        exists: true,
        suggestedName: candidateName,
        suggestedPath: candidatePath,
      };
    }
    counter += 1;
  }

  const fallbackName = `${folderName}-${Date.now()}`;
  return {
    parentDir,
    folderName,
    targetPath,
    exists: true,
    suggestedName: fallbackName,
    suggestedPath: resolveSafeExtractPath(parentDir, fallbackName),
  };
}

module.exports = {
  ADAPTIVE_GZIP_FAST_THRESHOLD_BYTES,
  DEFAULT_STREAM_CHUNK_BYTES,
  buildOciLayerToFile,
  createAbortError,
  createNodeTarStreamParser,
  resolveExtractDestinationInfo,
  resolveSafeExtractPath,
  sanitizeFolderName,
  streamOciLayerContinuous,
  streamOciLayerInChunks,
  writeStreamChunk,
};
