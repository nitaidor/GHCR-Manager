const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');

const MAX_USTAR_OCTAL_SIZE = 0o77777777777; // 8,589,934,591 bytes (~8 GiB)
const READ_CHUNK_BYTES = 1024 * 1024; // 1 MiB read chunks

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

function createUstarHeaderNode(name, size, mtime, typeflag = '0') {
  const header = Buffer.alloc(512);
  writeAscii(header, name, 0, 100);
  writeOctal(header, 0o644, 100, 8);
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

/**
 * Streams local files directly from disk into a temporary gzipped OCI layer (.tar.gz),
 * computing uncompressed diff_id and compressed SHA-256 digests with O(1) RAM usage.
 */
async function buildOciLayerToFile({ files, outFilePath, onProgress }) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('Cannot create an image with zero files.');
  }

  const statList = [];
  let totalFileBytes = 0;
  for (const f of files) {
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
    });
    totalFileBytes += st.size;
  }

  const uncompressedHash = crypto.createHash('sha256');
  const compressedHash = crypto.createHash('sha256');
  const gzip = zlib.createGzip({ level: 6 });
  const outStream = fsSync.createWriteStream(outFilePath);
  let compressedSize = 0;

  gzip.on('data', (gzChunk) => {
    compressedSize += gzChunk.length;
    compressedHash.update(gzChunk);
  });

  // Node pipeline handles backpressure from disk outStream -> gzip -> emitTarBytes
  const pipeDone = pipeline(gzip, outStream);
  let pipeFailed = false;
  pipeDone.catch(() => {
    pipeFailed = true;
  });

  async function emitTarBytes(buf) {
    if (!buf || buf.length === 0) return;
    uncompressedHash.update(buf);
    await writeStreamChunk(gzip, buf);
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
    const nowSec = Math.floor(Date.now() / 1000);

    for (const entry of statList) {
      const cleanPath = entry.relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
      const pathBytes = Buffer.byteLength(cleanPath, 'utf8');
      const isAscii = /^[\x00-\x7F]*$/.test(cleanPath);
      const needsPaxPath = pathBytes > 99 || !isAscii;
      const needsPaxSize = entry.size > MAX_USTAR_OCTAL_SIZE;
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
      for await (const chunk of readStream) {
        if (pipeFailed) {
          readStream.destroy();
          break;
        }
        actualRead += chunk.length;
        processedBytes += chunk.length;
        await emitTarBytes(chunk);
        reportProgress(false);
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
    await pipeDone;
    reportProgress(true);

    const fileMetaList = statList.slice(0, 150).map((f) => ({
      path: f.relativePath,
      size: f.size,
    }));

    return {
      tempPath: outFilePath,
      uncompressedDigest: `sha256:${uncompressedHash.digest('hex')}`,
      compressedDigest: `sha256:${compressedHash.digest('hex')}`,
      compressedSize,
      totalFileBytes,
      fileCount: statList.length,
      fileMetaList,
    };
  } catch (err) {
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
    await pipeDone.catch(() => {});
    await fs.unlink(outFilePath).catch(() => {});
    throw err;
  }
}

/**
 * Shared streaming USTAR/PAX TAR state machine for both fast header indexing
 * and streaming zero-RAM extraction directly to disk.
 */
function createNodeTarStreamParser(handlers = {}) {
  const { onEntry, onFileStart, onFileData, onFileEnd } = handlers;
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

module.exports = {
  buildOciLayerToFile,
  createNodeTarStreamParser,
  resolveSafeExtractPath,
  writeStreamChunk,
};
