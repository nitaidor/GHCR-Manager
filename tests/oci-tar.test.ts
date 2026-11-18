import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import {
  formatTimestampTag,
  toOciImageName,
  validateFilesSelectionName,
  validateOciTag,
} from '../src/lib/naming.ts';
import {
  buildOciLayerFromFiles,
  createZipFromExtractedFiles,
  extractFileMetaListStreaming,
  extractFilesFromOciLayer,
  normalizeMemoryLimitError,
  summarizeArchiveEntries,
  type TarInputFile,
} from '../src/lib/tar.ts';
import { unzipSync } from 'fflate';

const require = createRequire(import.meta.url);
const {
  buildOciLayerToFile,
  createNodeTarStreamParser,
  resolveExtractDestinationInfo,
  resolveSafeExtractPath,
  sanitizeFolderName,
} = require('../electron/streaming-tar.cjs');

async function runTests() {
  console.log('1. Testing single-file and multi-file naming rules...');

  // Single file: keeps default file name when custom name is empty
  const singleDefault = validateFilesSelectionName(1, '', 'My_Report 2026.pdf');
  assert.equal(singleDefault.valid, true);
  assert.equal(singleDefault.effectiveRawName, 'My_Report 2026.pdf');
  assert.equal(singleDefault.ociPackageName, 'my_report-2026.pdf');

  // Single file: user can enter another name for the image
  const singleCustom = validateFilesSelectionName(1, 'CustomImage', 'My_Report 2026.pdf');
  assert.equal(singleCustom.valid, true);
  assert.equal(singleCustom.effectiveRawName, 'CustomImage');
  assert.equal(singleCustom.ociPackageName, 'customimage');

  // Multiple files: MUST enter a name for the image
  const multiEmpty = validateFilesSelectionName(3, '');
  assert.equal(multiEmpty.valid, false);
  assert.match(multiEmpty.error || '', /must enter a name/i);

  const multiValid = validateFilesSelectionName(3, 'My Multi File Bundle');
  assert.equal(multiValid.valid, true);
  assert.equal(multiValid.ociPackageName, 'my-multi-file-bundle');

  console.log('2. Testing root folder sync naming rules...');
  // Root file -> image name is the file name
  assert.equal(toOciImageName('archive.tar.gz'), 'archive.tar.gz');
  // Sub-folder -> image name is the sub-folder name
  assert.equal(toOciImageName('Frontend Assets'), 'frontend-assets');

  console.log('3. Testing OCI .tar.gz layer builder & extractor roundtrip...');
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const sampleFiles: TarInputFile[] = [
    {
      relativePath: 'readme.txt',
      data: encoder.encode('Hello from GitHub Package Manager!'),
      mtime: 1700000000,
    },
    {
      relativePath: 'nested/subfolder/config.json',
      data: encoder.encode(JSON.stringify({ version: 1, ok: true })),
      mtime: 1700000100,
    },
  ];

  const builtLayer = await buildOciLayerFromFiles(sampleFiles);
  assert.ok(builtLayer.uncompressedDigest.startsWith('sha256:'));
  assert.ok(builtLayer.compressedDigest.startsWith('sha256:'));
  assert.ok(builtLayer.compressedSize > 0);

  const extracted = extractFilesFromOciLayer(builtLayer.targzBytes);
  assert.equal(extracted.length, 2);
  assert.equal(extracted[0].relativePath, 'readme.txt');
  assert.equal(decoder.decode(extracted[0].data), 'Hello from GitHub Package Manager!');
  assert.equal(extracted[1].relativePath, 'nested/subfolder/config.json');
  assert.deepEqual(JSON.parse(decoder.decode(extracted[1].data)), {
    version: 1,
    ok: true,
  });

  console.log('4. Testing streaming .tar.gz header meta extractor (multi-file + PAX long path + large payload skip)...');
  const longSubPath =
    'very/deeply/nested/folder/structure/that/exceeds/standard/ustar/ninety-nine/byte/filename/limit/payload.bin';
  const largePayload = new Uint8Array(150 * 1024); // > 2x 64KB chunk size to span multiple chunks
  largePayload.fill(0x41);
  const multiFiles: TarInputFile[] = [
    { relativePath: 'alpha.txt', data: encoder.encode('Alpha content'), mtime: 1700000000 },
    { relativePath: longSubPath, data: largePayload, mtime: 1700000010 },
    { relativePath: 'omega/final.json', data: encoder.encode('{"ok":true}'), mtime: 1700000020 },
  ];
  const multiLayer = await buildOciLayerFromFiles(multiFiles);
  const progressValues: number[] = [];
  const streamedMeta = await extractFileMetaListStreaming(multiLayer.targzBytes, {
    onProgress: (pct) => progressValues.push(pct),
  });
  assert.equal(streamedMeta.length, 3);
  assert.deepEqual(streamedMeta, [
    { path: 'alpha.txt', size: 13 },
    { path: longSubPath, size: largePayload.byteLength },
    { path: 'omega/final.json', size: 11 },
  ]);
  assert.ok(progressValues.length > 0);
  assert.equal(progressValues[progressValues.length - 1], 100);

  console.log('5. Testing timestamp tag formatting and OCI tag validation...');
  const sampleDate = new Date(2026, 10, 16, 13, 5, 9); // 2026-11-16 13:05:09 local
  assert.equal(formatTimestampTag(sampleDate, '24h', 'YYYY-MM-DD'), '2026-11-16_13.05.09');
  assert.equal(formatTimestampTag(sampleDate, '24h', 'YY-MM-DD'), '26-11-16_13.05.09');
  assert.equal(formatTimestampTag(sampleDate, '24h', 'DD-MM-YYYY'), '16-11-2026_13.05.09');
  assert.equal(formatTimestampTag(sampleDate, '24h', 'DD-MM-YY'), '16-11-26_13.05.09');
  assert.equal(formatTimestampTag(sampleDate, '12h', 'YYYY-MM-DD'), '2026-11-16_01.05.09pm');
  assert.equal(
    formatTimestampTag(new Date(2026, 0, 5, 0, 4, 2), '12h', 'DD-MM-YYYY'),
    '05-01-2026_12.04.02am'
  );

  assert.equal(validateOciTag('2026-11-16_13.05.09').valid, true);
  assert.equal(validateOciTag('v1.0-rc_2').valid, true);
  assert.equal(validateOciTag('').valid, false);
  assert.equal(validateOciTag('.hidden').valid, false);
  assert.equal(validateOciTag('-dash').valid, false);
  assert.equal(validateOciTag('12:30:00').valid, false);
  assert.equal(validateOciTag('2026/11/16').valid, false);
  assert.equal(validateOciTag('a b').valid, false);
  assert.equal(validateOciTag('a'.repeat(129)).valid, false);

  console.log('6. Testing Desktop Node streaming TAR builder, extractor & PAX >8GiB header support...');
  const tmpWorkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ghcr-mgr-test-'));
  try {
    const srcFile1 = path.join(tmpWorkDir, 'alpha.txt');
    const srcEmpty = path.join(tmpWorkDir, 'empty.txt');
    const srcBigChunked = path.join(tmpWorkDir, 'chunked.bin');
    const srcLong = path.join(tmpWorkDir, 'long.txt');
    const outTargz = path.join(tmpWorkDir, 'layer.tar.gz');
    const extractDir = path.join(tmpWorkDir, 'extracted');

    const chunkPayload = crypto.randomBytes(2.5 * 1024 * 1024); // Spans > 2x 1 MiB READ_CHUNK_BYTES
    await fs.writeFile(srcFile1, 'Hello streaming world!');
    await fs.writeFile(srcEmpty, '');
    await fs.writeFile(srcBigChunked, chunkPayload);
    await fs.writeFile(srcLong, 'PAX path payload');

    const desktopInputs = [
      { fullPath: srcFile1, relativePath: 'alpha.txt', mtime: 1700000000 },
      { fullPath: srcEmpty, relativePath: 'empty.txt', mtime: 1700000001 },
      { fullPath: srcBigChunked, relativePath: 'nested/chunked.bin', mtime: 1700000002 },
      { fullPath: srcLong, relativePath: longSubPath, mtime: 1700000003 },
    ];

    const streamedLayer = await buildOciLayerToFile({
      files: desktopInputs,
      outFilePath: outTargz,
    });

    // Must match in-memory tar.ts digests byte-for-byte for identical content + mtime
    const inMemoryInputs: TarInputFile[] = [
      { relativePath: 'alpha.txt', data: await fs.readFile(srcFile1), mtime: 1700000000 },
      { relativePath: 'empty.txt', data: await fs.readFile(srcEmpty), mtime: 1700000001 },
      { relativePath: 'nested/chunked.bin', data: chunkPayload, mtime: 1700000002 },
      { relativePath: longSubPath, data: await fs.readFile(srcLong), mtime: 1700000003 },
    ];
    const inMemLayer = await buildOciLayerFromFiles(inMemoryInputs);
    assert.equal(streamedLayer.uncompressedDigest, inMemLayer.uncompressedDigest);
    assert.equal(streamedLayer.totalFileBytes, inMemLayer.totalFileBytes);
    assert.equal(streamedLayer.fileCount, 4);

    // Extract streamed layer back via Node streaming parser in awkward tiny 313-byte slices
    const rawTargz = await fs.readFile(outTargz);
    const rawTar = zlib.gunzipSync(rawTargz);
    const extractedMap = new Map<string, Buffer[]>();
    let currentKey = '';
    const nodeParser = createNodeTarStreamParser({
      onFileStart: async (meta: { path: string; size: number }) => {
        currentKey = meta.path;
        extractedMap.set(currentKey, []);
      },
      onFileData: async (chunk: Buffer) => {
        extractedMap.get(currentKey)?.push(Buffer.from(chunk));
      },
    });
    for (let i = 0; i < rawTar.length; i += 313) {
      await nodeParser.feed(rawTar.subarray(i, Math.min(rawTar.length, i + 313)));
    }
    assert.equal(nodeParser.isDone(), true);
    assert.equal(Buffer.concat(extractedMap.get('alpha.txt') || []).toString('utf8'), 'Hello streaming world!');
    assert.equal(Buffer.concat(extractedMap.get('empty.txt') || []).length, 0);
    assert.equal(Buffer.concat(extractedMap.get('nested/chunked.bin') || []).equals(chunkPayload), true);
    assert.equal(Buffer.concat(extractedMap.get(longSubPath) || []).toString('utf8'), 'PAX path payload');

    // Verify extraction path safety against zip-slip
    assert.throws(
      () => resolveSafeExtractPath(extractDir, '../../outside.txt'),
      /Unsafe archive entry path rejected/
    );
    const safeNested = resolveSafeExtractPath(extractDir, 'sub/ok.txt');
    assert.ok(safeNested.startsWith(path.resolve(extractDir) + path.sep));

    // Verify PAX >8 GiB size header parsing without allocating 9 GB
    const largeSizeStr = '9000000000';
    const paxLineBody = ` size=${largeSizeStr}\n`;
    const paxLineLen = Buffer.byteLength(paxLineBody, 'utf8') + 2;
    const paxLine = Buffer.from(`${paxLineLen}${paxLineBody}`, 'utf8');
    const paxHdr = Buffer.alloc(512);
    Buffer.from('PaxHeader/big.bin').copy(paxHdr, 0);
    Buffer.from('0000644\0').copy(paxHdr, 100);
    Buffer.from(paxLine.length.toString(8).padStart(11, '0') + '\0').copy(paxHdr, 124);
    paxHdr[156] = 'x'.charCodeAt(0);
    const paxDataPad = Buffer.alloc((512 - (paxLine.length % 512)) % 512);
    const regHdr = Buffer.alloc(512);
    Buffer.from('big.bin').copy(regHdr, 0);
    Buffer.from('00000000000\0').copy(regHdr, 124);
    regHdr[156] = '0'.charCodeAt(0);
    const metaOnlyParser = createNodeTarStreamParser();
    await metaOnlyParser.feed(Buffer.concat([paxHdr, paxLine, paxDataPad, regHdr]));
    assert.deepEqual(metaOnlyParser.getFiles(), [{ path: 'big.bin', size: 9000000000 }]);

    // Verify friendly OOM message normalization for Web/Mobile
    const oomErr = normalizeMemoryLimitError(new RangeError('Array buffer allocation failed'), 'upload');
    assert.match(oomErr.message, /browser\/mobile memory limits/i);

    console.log('7. Testing package-folder naming, conflict numbering, and aborted TAR cleanup...');
    assert.equal(sanitizeFolderName('report.pdf'), 'report.pdf');
    assert.equal(sanitizeFolderName('  bad:folder/name*  '), 'bad_folder_name_');
    assert.equal(sanitizeFolderName('..'), 'package');
    assert.equal(sanitizeFolderName(''), 'package');

    const conflictParent = path.join(tmpWorkDir, 'extract-parent');
    await fs.mkdir(conflictParent, { recursive: true });
    const cleanDest = resolveExtractDestinationInfo(conflictParent, 'temp');
    assert.equal(cleanDest.folderName, 'temp');
    assert.equal(cleanDest.exists, false);
    assert.equal(cleanDest.targetPath, path.join(conflictParent, 'temp'));
    assert.equal(cleanDest.suggestedName, 'temp');
    assert.equal(cleanDest.suggestedPath, path.join(conflictParent, 'temp'));

    await fs.mkdir(path.join(conflictParent, 'temp'));
    const firstConflict = resolveExtractDestinationInfo(conflictParent, 'temp');
    assert.equal(firstConflict.exists, true);
    assert.equal(firstConflict.suggestedName, 'temp (1)');
    assert.equal(firstConflict.suggestedPath, path.join(conflictParent, 'temp (1)'));

    await fs.mkdir(path.join(conflictParent, 'temp (1)'));
    const secondConflict = resolveExtractDestinationInfo(conflictParent, 'temp');
    assert.equal(secondConflict.exists, true);
    assert.equal(secondConflict.suggestedName, 'temp (2)');
    assert.equal(secondConflict.suggestedPath, path.join(conflictParent, 'temp (2)'));

    const abortCtrl = new AbortController();
    const abortedTargz = path.join(tmpWorkDir, 'aborted-layer.tar.gz');
    await assert.rejects(
      () =>
        buildOciLayerToFile({
          files: desktopInputs,
          outFilePath: abortedTargz,
          signal: abortCtrl.signal,
          onProgress: () => {
            abortCtrl.abort();
          },
        }),
      (err: unknown) => err instanceof Error && err.name === 'AbortError'
    );
    await assert.rejects(() => fs.stat(abortedTargz), /ENOENT/);

    console.log('8. Testing empty folders (TAR typeflag 5, PAX long dir paths, streaming parser, ZIP & summary)...');
    const emptyLongDir = `empty_parent/${'deep_segment_'.repeat(8)}empty_leaf`;
    const mixedEmptyDir = path.join(tmpWorkDir, 'empty-real-dir');
    await fs.mkdir(mixedEmptyDir, { recursive: true });
    const mixedTargz = path.join(tmpWorkDir, 'mixed-empty.tar.gz');

    const mixedStreamed = await buildOciLayerToFile({
      files: [
        { fullPath: srcFile1, relativePath: 'FolderA/alpha.txt', mtime: 1700000010 },
        { fullPath: mixedEmptyDir, relativePath: 'FolderA/empty-sub', size: 0, mtime: 1700000011, isDirectory: true },
        { fullPath: '', relativePath: emptyLongDir, size: 0, mtime: 1700000012, isDirectory: true },
        { fullPath: '', relativePath: '.', size: 0, mtime: 1700000013, isDirectory: true },
      ],
      outFilePath: mixedTargz,
    });
    assert.equal(mixedStreamed.fileCount, 1);

    const mixedInMem = await buildOciLayerFromFiles([
      { relativePath: 'FolderA/alpha.txt', data: await fs.readFile(srcFile1), mtime: 1700000010 },
      { relativePath: 'FolderA/empty-sub', data: new Uint8Array(0), mtime: 1700000011, isDirectory: true },
      { relativePath: emptyLongDir, data: new Uint8Array(0), mtime: 1700000012, isDirectory: true },
      { relativePath: '.', data: new Uint8Array(0), mtime: 1700000013, isDirectory: true },
    ]);
    assert.equal(mixedStreamed.uncompressedDigest, mixedInMem.uncompressedDigest);

    const parsedMeta = await extractFileMetaListStreaming(mixedInMem.targzBytes);
    assert.deepEqual(parsedMeta, [
      { path: 'FolderA/alpha.txt', size: 22 },
      { path: 'FolderA/empty-sub', size: 0, isDirectory: true },
      { path: emptyLongDir, size: 0, isDirectory: true },
      { path: '.', size: 0, isDirectory: true },
    ]);

    const summary = summarizeArchiveEntries(parsedMeta);
    assert.deepEqual(summary, { regularFileCount: 1, emptyFolderCount: 2 });

    const extractedMixed = extractFilesFromOciLayer(mixedInMem.targzBytes);
    assert.equal(extractedMixed.length, 4);
    assert.equal(extractedMixed[1].relativePath, 'FolderA/empty-sub');
    assert.equal(extractedMixed[1].isDirectory, true);
    assert.equal(extractedMixed[2].relativePath, emptyLongDir);
    assert.equal(extractedMixed[2].isDirectory, true);
    assert.equal(extractedMixed[3].relativePath, '.');
    assert.equal(extractedMixed[3].isDirectory, true);

    const createdDirs: string[] = [];
    const mixedNodeParser = createNodeTarStreamParser({
      onDirectory: async (meta: { path: string }) => {
        createdDirs.push(meta.path);
      },
    });
    const mixedTarRaw = zlib.gunzipSync(await fs.readFile(mixedTargz));
    await mixedNodeParser.feed(mixedTarRaw);
    assert.deepEqual(createdDirs, ['FolderA/empty-sub', emptyLongDir, '.']);

    const zipBytes = createZipFromExtractedFiles(extractedMixed);
    const unzippedKeys = Object.keys(unzipSync(zipBytes));
    assert.ok(unzippedKeys.includes('FolderA/alpha.txt'));
    assert.ok(unzippedKeys.includes('FolderA/empty-sub/'));
    assert.ok(unzippedKeys.includes(`${emptyLongDir}/`));
    assert.equal(unzippedKeys.includes('./'), false);
  } finally {
    await fs.rm(tmpWorkDir, { recursive: true, force: true });
  }

  console.log('All tests passed successfully!');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
