import { gzipSync, gunzipSync, Gunzip, zipSync } from 'fflate';

export interface TarInputFile {
  /** Path inside the image layer (e.g. "report.pdf" or "subfolder/nested/file.txt") */
  relativePath: string;
  /** Raw file content */
  data: Uint8Array;
  /** Optional modification unix timestamp in seconds */
  mtime?: number;
}

export interface BuiltOciLayer {
  /** Uncompressed tar bytes */
  tarBytes: Uint8Array;
  /** Gzip-compressed tar.gz bytes */
  targzBytes: Uint8Array;
  /** sha256:<hex> of uncompressed tar (OCI diff_id) */
  uncompressedDigest: string;
  /** sha256:<hex> of compressed tar.gz (OCI layer digest) */
  compressedDigest: string;
  /** Byte length of compressed tar.gz */
  compressedSize: number;
  /** Total uncompressed file payload bytes */
  totalFileBytes: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function sha256Hex(data: Uint8Array): Promise<string> {
  // Copy into a guaranteed ArrayBuffer slice for Web Crypto compatibility
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', copy.buffer);
  const hashArray = new Uint8Array(hashBuffer);
  let hex = '';
  for (let i = 0; i < hashArray.length; i++) {
    hex += hashArray[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function writeAscii(buf: Uint8Array, str: string, offset: number, length: number) {
  const bytes = encoder.encode(str);
  const len = Math.min(bytes.length, length);
  for (let i = 0; i < len; i++) {
    buf[offset + i] = bytes[i];
  }
}

function writeOctal(buf: Uint8Array, value: number, offset: number, length: number) {
  const oct = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, '0');
  writeAscii(buf, oct, offset, length - 1);
  buf[offset + length - 1] = 0;
}

function finalizeTarHeaderChecksum(header: Uint8Array) {
  // Fill checksum field (148..155) with spaces (0x20)
  for (let i = 148; i < 156; i++) {
    header[i] = 0x20;
  }
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    sum += header[i];
  }
  const oct = sum.toString(8).padStart(6, '0');
  writeAscii(header, oct, 148, 6);
  header[154] = 0;
  header[155] = 0x20;
}

function createUstarHeader(
  name: string,
  size: number,
  mtime: number,
  typeflag: string = '0'
): Uint8Array {
  const header = new Uint8Array(512);
  writeAscii(header, name, 0, 100);
  writeOctal(header, 0o644, 100, 8); // mode
  writeOctal(header, 0, 108, 8); // uid
  writeOctal(header, 0, 116, 8); // gid
  writeOctal(header, size, 124, 12); // size
  writeOctal(header, mtime, 136, 12); // mtime
  header[156] = typeflag.charCodeAt(0);
  writeAscii(header, 'ustar', 257, 6);
  writeAscii(header, '00', 263, 2);
  finalizeTarHeaderChecksum(header);
  return header;
}

function createPaxPathRecord(fullPath: string): Uint8Array {
  // Format: "<length> path=<fullPath>\n"
  const keyVal = ` path=${fullPath}\n`;
  const keyValBytes = encoder.encode(keyVal);
  let totalLen = keyValBytes.length + 2;
  let recordStr = `${totalLen}${keyVal}`;
  while (encoder.encode(recordStr).length !== totalLen) {
    totalLen = encoder.encode(recordStr).length;
    recordStr = `${totalLen}${keyVal}`;
  }
  return encoder.encode(recordStr);
}

/**
 * Creates a standard POSIX USTAR/PAX .tar archive from a list of files.
 */
export function createTarArchive(files: TarInputFile[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const nowSec = Math.floor(Date.now() / 1000);

  for (const file of files) {
    const cleanPath = file.relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const pathBytes = encoder.encode(cleanPath);
    const isAscii = cleanPath.split('').every((ch) => ch.charCodeAt(0) < 128);
    const mtime = file.mtime ?? nowSec;

    // If path > 99 bytes or contains non-ASCII UTF-8 characters, emit a PAX extended header ('x')
    if (pathBytes.length > 99 || !isAscii) {
      const paxPayload = createPaxPathRecord(cleanPath);
      const paxHeader = createUstarHeader('PaxHeader/entry', paxPayload.byteLength, mtime, 'x');
      chunks.push(paxHeader);
      chunks.push(paxPayload);
      const paxPad = (512 - (paxPayload.byteLength % 512)) % 512;
      if (paxPad > 0) chunks.push(new Uint8Array(paxPad));
    }

    const shortAsciiName = cleanPath.replace(/[^\x20-\x7E]/g, '_').slice(-99);
    const fileHeader = createUstarHeader(
      shortAsciiName || 'file',
      file.data.byteLength,
      mtime,
      '0'
    );
    chunks.push(fileHeader);
    chunks.push(file.data);

    const padding = (512 - (file.data.byteLength % 512)) % 512;
    if (padding > 0) {
      chunks.push(new Uint8Array(padding));
    }
  }

  // Two 512-byte zero blocks mark end-of-archive
  chunks.push(new Uint8Array(1024));

  const totalByteLength = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const tarBytes = new Uint8Array(totalByteLength);
  let offset = 0;
  for (const chunk of chunks) {
    tarBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return tarBytes;
}

/**
 * Builds a complete OCI .tar.gz layer and computes its uncompressed & compressed SHA-256 digests.
 */
export async function buildOciLayerFromFiles(files: TarInputFile[]): Promise<BuiltOciLayer> {
  const tarBytes = createTarArchive(files);
  const uncompressedHex = await sha256Hex(tarBytes);
  const targzBytes = gzipSync(tarBytes, { level: 6 });
  const compressedHex = await sha256Hex(targzBytes);
  const totalFileBytes = files.reduce((acc, f) => acc + f.data.byteLength, 0);

  return {
    tarBytes,
    targzBytes,
    uncompressedDigest: `sha256:${uncompressedHex}`,
    compressedDigest: `sha256:${compressedHex}`,
    compressedSize: targzBytes.byteLength,
    totalFileBytes,
  };
}

function readNullTerminatedString(buf: Uint8Array, offset: number, maxLen: number): string {
  let end = offset;
  const limit = offset + maxLen;
  while (end < limit && buf[end] !== 0) {
    end++;
  }
  return decoder.decode(buf.subarray(offset, end));
}

function readOctalField(buf: Uint8Array, offset: number, maxLen: number): number {
  const str = readNullTerminatedString(buf, offset, maxLen).trim();
  if (!str) return 0;
  return parseInt(str, 8) || 0;
}

/**
 * Extracts all files from a .tar or .tar.gz OCI layer archive.
 */
export function extractFilesFromOciLayer(layerBytes: Uint8Array): TarInputFile[] {
  // Detect gzip magic bytes (0x1f 0x8b)
  const isGzip =
    layerBytes.byteLength >= 2 && layerBytes[0] === 0x1f && layerBytes[1] === 0x8b;
  const tarBytes = isGzip ? gunzipSync(layerBytes) : layerBytes;

  const extracted: TarInputFile[] = [];
  let offset = 0;
  let pendingPaxPath: string | null = null;

  while (offset + 512 <= tarBytes.byteLength) {
    const header = tarBytes.subarray(offset, offset + 512);
    // Check if entire block is zeros
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;

    const name = readNullTerminatedString(header, 0, 100);
    const prefix = readNullTerminatedString(header, 345, 155);
    const size = readOctalField(header, 124, 12);
    const mtime = readOctalField(header, 136, 12);
    const typeflag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);

    offset += 512;
    const payload = tarBytes.subarray(offset, offset + size);
    const blocks = Math.ceil(size / 512) * 512;
    offset += blocks;

    if (typeflag === 'x' || typeflag === 'g') {
      // Parse PAX extended header for path=...
      const paxText = decoder.decode(payload);
      const lines = paxText.split('\n');
      for (const line of lines) {
        const spaceIdx = line.indexOf(' ');
        if (spaceIdx > 0) {
          const kv = line.slice(spaceIdx + 1);
          if (kv.startsWith('path=')) {
            pendingPaxPath = kv.slice(5);
          }
        }
      }
      continue;
    }

    if (typeflag === 'L') {
      // GNU LongLink path
      pendingPaxPath = readNullTerminatedString(payload, 0, payload.byteLength);
      continue;
    }

    if (typeflag === '0' || typeflag === '\0') {
      const fullPath =
        pendingPaxPath || (prefix ? `${prefix}/${name}` : name);
      pendingPaxPath = null;
      const copy = new Uint8Array(payload.byteLength);
      copy.set(payload);
      extracted.push({
        relativePath: fullPath.replace(/^\/+/, ''),
        data: copy,
        mtime,
      });
    } else {
      pendingPaxPath = null;
    }
  }

  return extracted;
}

/**
 * Creates a streaming .tar metadata parser that extracts only file paths and sizes
 * from 512-byte USTAR/PAX/GNU headers while discarding all file content bytes as chunks arrive.
 */
export function createStreamingTarMetaParser(): {
  feed: (chunk: Uint8Array) => void;
  getFiles: () => Array<{ path: string; size: number }>;
  isDone: () => boolean;
} {
  const files: Array<{ path: string; size: number }> = [];
  let pendingBuf = new Uint8Array(4096);
  let pendingLen = 0;
  let skipRemaining = 0;
  let metaNeededBlocks = 0;
  let metaExactSize = 0;
  let metaType: 'x' | 'g' | 'L' | null = null;
  let pendingPaxPath: string | null = null;
  let done = false;

  function appendToPending(slice: Uint8Array) {
    const needed = pendingLen + slice.byteLength;
    if (needed > pendingBuf.byteLength) {
      const next = new Uint8Array(Math.max(pendingBuf.byteLength * 2, needed));
      next.set(pendingBuf.subarray(0, pendingLen));
      pendingBuf = next;
    }
    pendingBuf.set(slice, pendingLen);
    pendingLen += slice.byteLength;
  }

  function feed(chunk: Uint8Array) {
    if (done || chunk.byteLength === 0) return;
    let pos = 0;

    while (pos < chunk.byteLength && !done) {
      if (skipRemaining > 0) {
        const avail = chunk.byteLength - pos;
        const toSkip = Math.min(avail, skipRemaining);
        pos += toSkip;
        skipRemaining -= toSkip;
        continue;
      }

      if (metaNeededBlocks > 0) {
        const need = metaNeededBlocks - pendingLen;
        const take = Math.min(need, chunk.byteLength - pos);
        appendToPending(chunk.subarray(pos, pos + take));
        pos += take;

        if (pendingLen === metaNeededBlocks) {
          const payload = pendingBuf.subarray(0, metaExactSize);
          if (metaType === 'x' || metaType === 'g') {
            const paxText = decoder.decode(payload);
            const lines = paxText.split('\n');
            for (const line of lines) {
              const spaceIdx = line.indexOf(' ');
              if (spaceIdx > 0) {
                const kv = line.slice(spaceIdx + 1);
                if (kv.startsWith('path=')) {
                  pendingPaxPath = kv.slice(5);
                }
              }
            }
          } else if (metaType === 'L') {
            pendingPaxPath = readNullTerminatedString(payload, 0, payload.byteLength);
          }
          pendingLen = 0;
          metaNeededBlocks = 0;
          metaExactSize = 0;
          metaType = null;
        }
        continue;
      }

      // Reading a 512-byte tar header
      const need = 512 - pendingLen;
      const take = Math.min(need, chunk.byteLength - pos);
      appendToPending(chunk.subarray(pos, pos + take));
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

        const name = readNullTerminatedString(header, 0, 100);
        const prefix = readNullTerminatedString(header, 345, 155);
        const size = readOctalField(header, 124, 12);
        const typeflag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
        const blocks = Math.ceil(size / 512) * 512;

        if (typeflag === 'x' || typeflag === 'g' || typeflag === 'L') {
          if (blocks > 0) {
            metaType = typeflag;
            metaExactSize = size;
            metaNeededBlocks = blocks;
          }
        } else if (typeflag === '0' || typeflag === '\0') {
          const fullPath = (
            pendingPaxPath || (prefix ? `${prefix}/${name}` : name)
          ).replace(/^\/+/, '');
          pendingPaxPath = null;
          if (fullPath) {
            files.push({ path: fullPath, size });
          }
          skipRemaining = blocks;
        } else {
          pendingPaxPath = null;
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
 * Streams a .tar or .tar.gz OCI layer in 64 KB chunks through fflate's Gunzip state machine,
 * yielding periodically to keep UI responsive on Android, iOS, and Web while holding only
 * 512-byte headers in memory and discarding file body bytes immediately.
 */
export async function extractFileMetaListStreaming(
  layerBytes: Uint8Array,
  opts?: {
    onProgress?: (percent: number) => void;
    signal?: AbortSignal;
  }
): Promise<Array<{ path: string; size: number }>> {
  const parser = createStreamingTarMetaParser();
  const total = layerBytes.byteLength;
  if (total === 0) return [];

  const isGzip = total >= 2 && layerBytes[0] === 0x1f && layerBytes[1] === 0x8b;
  const CHUNK_SIZE = 65536;
  const gunzip = isGzip
    ? new Gunzip((decompressed) => {
        parser.feed(decompressed);
      })
    : null;

  let chunkIdx = 0;
  for (let offset = 0; offset < total; offset += CHUNK_SIZE) {
    if (opts?.signal?.aborted) {
      throw new DOMException('Layer scan aborted', 'AbortError');
    }

    const end = Math.min(offset + CHUNK_SIZE, total);
    const slice = layerBytes.subarray(offset, end);
    const isFinal = end >= total;

    if (gunzip) {
      gunzip.push(slice, isFinal);
    } else {
      parser.feed(slice);
    }

    if (opts?.onProgress) {
      const pct = Math.min(100, Math.round((end / total) * 100));
      opts.onProgress(pct);
    }

    if (parser.isDone()) break;

    chunkIdx++;
    if (chunkIdx % 4 === 0 && !isFinal) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  return parser.getFiles();
}

/**
 * Bundles multiple extracted files into a single .zip archive for convenient browser/mobile download.
 */
export function createZipFromExtractedFiles(files: TarInputFile[]): Uint8Array {
  const zipMap: Record<string, Uint8Array> = {};
  for (const file of files) {
    zipMap[file.relativePath] = file.data;
  }
  return zipSync(zipMap, { level: 6 });
}
