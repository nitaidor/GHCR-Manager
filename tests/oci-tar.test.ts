import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import {
  filterUnlinkedContainerPackages,
  formatDisplayDateTime,
  formatTimestampTag,
  formatUniqueRepoIndexTag,
  getPackageLockKey,
  getPackageSettingsUrl,
  getRepoIndexDisplayTitle,
  getRepoIndexPackageName,
  getVersionReferenceInfo,
  isRepoIndexPackageName,
  isUnlinkedPackagesRepo,
  MAX_DISPLAY_TAG_CHARS,
  packageMatchesRepo,
  summarizeAccountPackageCounts,
  toGitRefSafeLockSegment,
  toOciImageName,
  UNLINKED_PACKAGES_REPO_ID,
  validateFilesSelectionName,
  validateOciTag,
} from '../src/lib/naming.ts';
import {
  cleanVersion,
  compareVersions,
  resolveUpdateCheckFromReleases,
} from '../src/lib/updater.ts';
import {
  acquireRepoIndexLock,
  acquireRepoLock,
  acquireRepoPackageLocks,
  resolveCanonicalOwnerLockRepo,
  type HttpRequestFn,
} from '../src/lib/repo-lock.ts';
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
  writeStreamChunk,
} = require('../electron/streaming-tar.cjs');
const {
  BLOB_UPLOAD_CHUNK_BYTES,
  streamAndUploadOciLayer,
  streamAndUploadOciLayerChunked,
} = require('../electron/oci-upload.cjs');

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

    console.log('9. Testing Repo Index naming, >150 entries without slicing, and O(N) summary scale...');
    assert.equal(getRepoIndexPackageName('My Cool Repo'), 'ghcr-manager-index_my-cool-repo');
    assert.equal(getRepoIndexDisplayTitle('My Cool Repo'), 'GHCR Manager Index - My Cool Repo');
    assert.equal(isRepoIndexPackageName('ghcr-manager-index_my-cool-repo'), true);
    assert.equal(isRepoIndexPackageName('my-normal-pkg'), false);

    const manyInputs = Array.from({ length: 250 }, (_, idx) => ({
      fullPath: srcFile1,
      relativePath: `batch/file-${idx}.txt`,
      mtime: 1700000100,
    }));
    const manyTargz = path.join(tmpWorkDir, 'many-250.tar.gz');
    const manyStreamed = await buildOciLayerToFile({
      files: manyInputs,
      outFilePath: manyTargz,
    });
    assert.equal(manyStreamed.fileCount, 250);
    assert.equal(manyStreamed.fileMetaList.length, 250);

    const scaleEntries = [
      ...Array.from({ length: 5000 }, (_, i) => ({
        path: `src/mod-${i % 20}/file-${i}.ts`,
      })),
      { path: 'src/mod-0', isDirectory: true },
      { path: 'empty-root-child/nested-empty', isDirectory: true },
      { path: 'empty-root-child', isDirectory: true },
    ];
    const scaleSummary = summarizeArchiveEntries(scaleEntries);
    assert.deepEqual(scaleSummary, { regularFileCount: 5000, emptyFolderCount: 1 });

    console.log('10. Testing collision-free index tags, bijective Git ref keys & atomic Repo Lock CAS...');
    const sameSecDate = new Date(2026, 10, 19, 22, 30, 5, 412);
    const baseSecTag = formatTimestampTag(sameSecDate, '24h', 'YYYY-MM-DD');
    assert.equal(baseSecTag, '2026-11-19_22.30.05');
    assert.equal(
      formatUniqueRepoIndexTag(sameSecDate, '24h', 'YYYY-MM-DD', []),
      '2026-11-19_22.30.05'
    );
    const secondSameSecTag = formatUniqueRepoIndexTag(sameSecDate, '24h', 'YYYY-MM-DD', [
      baseSecTag,
    ]);
    assert.equal(secondSameSecTag, '2026-11-19_22.30.05.412');
    assert.equal(validateOciTag(secondSameSecTag).valid, true);
    const thirdSameSecTag = formatUniqueRepoIndexTag(sameSecDate, '24h', 'YYYY-MM-DD', [
      baseSecTag,
      secondSameSecTag,
    ]);
    assert.equal(thirdSameSecTag, '2026-11-19_22.30.05.412-2');

    // Bijective Git ref key encoding: no collisions and no `.lock` / `..` / `/`
    assert.notEqual(getPackageLockKey('foo.bar'), getPackageLockKey('foo_2e_bar'));
    assert.equal(getPackageLockKey('foo.lock').endsWith('.lock'), false);
    assert.equal(getPackageLockKey('a..b').includes('..'), false);
    assert.match(toGitRefSafeLockSegment('Hello.World_2026'), /^[a-z0-9_-]+$/);

    // Stateful in-memory GitHub Git Refs server simulating CAS fast-forward & server clock
    let mockServerNowMs = 1_795_000_000_000;
    let objSeq = 0;
    const commits = new Map<
      string,
      { sha: string; message: string; treeSha: string; parents: string[]; committerDate: string }
    >();
    const refs = new Map<string, string>();

    const isAncestorCommit = (ancestorSha: string, descendantSha: string): boolean => {
      let cur: string | undefined = descendantSha;
      const visited = new Set<string>();
      while (cur && !visited.has(cur)) {
        if (cur === ancestorSha) return true;
        visited.add(cur);
        cur = commits.get(cur)?.parents[0];
      }
      return false;
    };

    const jsonRes = (status: number, data: unknown): { status: number; headers: Record<string, string>; body: Uint8Array } => ({
      status,
      headers: {
        'content-type': 'application/json',
        date: new Date(mockServerNowMs).toUTCString(),
      },
      body: new TextEncoder().encode(JSON.stringify(data)),
    });

    const mockGitHubHttp: HttpRequestFn = async (req) => {
      const url = new URL(req.url);
      const method = req.method || 'GET';
      const pathName = url.pathname;
      const parsedBody = req.body
        ? JSON.parse(typeof req.body === 'string' ? req.body : new TextDecoder().decode(req.body))
        : null;

      if (pathName === '/repos/alice/empty-repo/git/trees' || pathName.startsWith('/repos/alice/empty-repo/git/ref')) {
        return jsonRes(409, { message: 'Git Repository is empty.' });
      }
      if (method === 'POST' && pathName === '/repos/alice/demo/git/trees') {
        return jsonRes(201, { sha: `tree-${++objSeq}` });
      }
      if (method === 'POST' && pathName === '/repos/alice/demo/git/commits') {
        const sha = `commit-${++objSeq}`;
        commits.set(sha, {
          sha,
          message: parsedBody.message,
          treeSha: parsedBody.tree,
          parents: parsedBody.parents || [],
          committerDate: new Date(mockServerNowMs).toISOString(),
        });
        return jsonRes(201, { sha });
      }
      if (method === 'GET' && pathName.startsWith('/repos/alice/demo/git/commits/')) {
        const sha = decodeURIComponent(pathName.split('/').pop() || '');
        const c = commits.get(sha);
        if (!c) return jsonRes(404, { message: 'Not Found' });
        return jsonRes(200, {
          sha: c.sha,
          message: c.message,
          tree: { sha: c.treeSha },
          committer: { date: c.committerDate },
        });
      }
      if (method === 'GET' && pathName.startsWith('/repos/alice/demo/git/ref/')) {
        const refName = `refs/${pathName.slice('/repos/alice/demo/git/ref/'.length)}`;
        const sha = refs.get(refName);
        if (!sha) return jsonRes(404, { message: 'Not Found' });
        return jsonRes(200, { ref: refName, object: { sha, type: 'commit' } });
      }
      if (method === 'POST' && pathName === '/repos/alice/demo/git/refs') {
        if (refs.has(parsedBody.ref)) {
          return jsonRes(422, { message: 'Reference already exists' });
        }
        refs.set(parsedBody.ref, parsedBody.sha);
        return jsonRes(201, { ref: parsedBody.ref, object: { sha: parsedBody.sha } });
      }
      if (method === 'PATCH' && pathName.startsWith('/repos/alice/demo/git/refs/')) {
        const refName = `refs/${pathName.slice('/repos/alice/demo/git/refs/'.length)}`;
        const currentSha = refs.get(refName);
        if (!currentSha) return jsonRes(404, { message: 'Not Found' });
        const nextSha = parsedBody.sha as string;
        if (!parsedBody.force && !isAncestorCommit(currentSha, nextSha)) {
          return jsonRes(422, { message: 'Update is not a fast forward' });
        }
        refs.set(refName, nextSha);
        return jsonRes(200, { ref: refName, object: { sha: nextSha } });
      }
      return jsonRes(404, { message: 'Unhandled mock route' });
    };

    const demoRepo = {
      id: 42,
      name: 'demo',
      full_name: 'alice/demo',
      owner: { login: 'alice' },
    };

    // (a) Simultaneous race between PC1 and PC2 on same package
    let activeHolders = 0;
    let maxConcurrentHolders = 0;
    let pc2WaitCalls = 0;
    const p1 = acquireRepoLock({
      repo: demoRepo,
      githubToken: 'tok',
      ownerLogin: 'alice',
      lockKey: getPackageLockKey('shared-pkg'),
      packageName: 'shared-pkg',
      operation: 'upload',
      sessionId: 'pc-1',
      pollIntervalMs: 30,
      heartbeatIntervalMs: 5_000,
      leaseTtlMs: 10_000,
      httpRequest: mockGitHubHttp,
    }).then(async (lock) => {
      activeHolders += 1;
      maxConcurrentHolders = Math.max(maxConcurrentHolders, activeHolders);
      await new Promise((r) => setTimeout(r, 200));
      activeHolders -= 1;
      await lock.release();
      return lock;
    });

    const p2 = acquireRepoLock({
      repo: demoRepo,
      githubToken: 'tok',
      ownerLogin: 'alice',
      lockKey: getPackageLockKey('shared-pkg'),
      packageName: 'shared-pkg',
      operation: 'upload',
      sessionId: 'pc-2',
      pollIntervalMs: 30,
      heartbeatIntervalMs: 5_000,
      leaseTtlMs: 10_000,
      onWaiting: () => {
        pc2WaitCalls += 1;
      },
      httpRequest: mockGitHubHttp,
    }).then(async (lock) => {
      activeHolders += 1;
      maxConcurrentHolders = Math.max(maxConcurrentHolders, activeHolders);
      await new Promise((r) => setTimeout(r, 120));
      activeHolders -= 1;
      await lock.release();
      return lock;
    });

    const [lock1Res, lock2Res] = await Promise.all([p1, p2]);
    assert.equal(maxConcurrentHolders, 1);
    assert.equal(lock1Res.hadToWait || lock2Res.hadToWait, true);
    assert.ok(pc2WaitCalls >= 1 || lock1Res.hadToWait);

    // (b) Crashed/offline lease expiry + verifyHeld blocks late manifest push + late release rejection
    let pc1LeaseLostFired = false;
    const pc1CrashLock = await acquireRepoIndexLock({
      repo: demoRepo,
      githubToken: 'tok',
      ownerLogin: 'alice',
      pollIntervalMs: 25,
      heartbeatIntervalMs: 60_000,
      leaseTtlMs: 5_000,
      onLeaseLost: () => {
        pc1LeaseLostFired = true;
      },
      httpRequest: mockGitHubHttp,
    });
    // Advance GitHub server clock past the 5s lease TTL
    mockServerNowMs += 6_500;
    let pc2LeaseLostFired = false;
    const pc2Takeover = await acquireRepoLock({
      repo: demoRepo,
      githubToken: 'tok',
      ownerLogin: 'alice',
      lockKey: 'index',
      operation: 'index',
      sessionId: 'pc-2-takeover',
      pollIntervalMs: 25,
      heartbeatIntervalMs: 60_000,
      leaseTtlMs: 5_000,
      onLeaseLost: () => {
        pc2LeaseLostFired = true;
      },
      httpRequest: mockGitHubHttp,
    });
    assert.equal(pc2LeaseLostFired, false);
    await pc2Takeover.verifyHeld();
    // Old disconnected PC reconnects right before publishing manifest: verifyHeld must reject
    await assert.rejects(() => pc1CrashLock.verifyHeld(), /Lock lease lost/);
    assert.equal(pc1LeaseLostFired, true);
    assert.equal(pc1CrashLock.isLeaseLost(), true);
    // Old crashed PC wakes up late and tries to release; CAS 422 must reject it
    const activeTakeoverSha = refs.get('refs/ghcr-manager/locks/index');
    await pc1CrashLock.release();
    assert.equal(refs.get('refs/ghcr-manager/locks/index'), activeTakeoverSha);
    await pc2Takeover.release();

    // (c) Multi-package canonical lock ordering ([zeta, alpha] vs [alpha, zeta]) without deadlock
    const [bundleA, bundleB] = await Promise.all([
      acquireRepoPackageLocks({
        repo: demoRepo,
        githubToken: 'tok',
        ownerLogin: 'alice',
        packageNames: ['zeta-pkg', 'alpha-pkg'],
        operation: 'sync',
        sessionId: 'sync-a',
        pollIntervalMs: 25,
        httpRequest: mockGitHubHttp,
      }).then(async (b) => {
        assert.equal(b.locks[0].packageName, 'alpha-pkg');
        assert.equal(b.locks[1].packageName, 'zeta-pkg');
        await new Promise((r) => setTimeout(r, 40));
        await b.releaseAll();
        return b;
      }),
      acquireRepoPackageLocks({
        repo: demoRepo,
        githubToken: 'tok',
        ownerLogin: 'alice',
        packageNames: ['alpha-pkg', 'zeta-pkg'],
        operation: 'sync',
        sessionId: 'sync-b',
        pollIntervalMs: 25,
        httpRequest: mockGitHubHttp,
      }).then(async (b) => {
        await b.releaseAll();
        return b;
      }),
    ]);
    assert.equal(bundleA.locks.length, 2);
    assert.equal(bundleB.locks.length, 2);

    // (d) Empty 0-commit repo fails fast with explicit message
    await assert.rejects(
      () =>
        acquireRepoLock({
          repo: {
            id: 99,
            name: 'empty-repo',
            full_name: 'alice/empty-repo',
            owner: { login: 'alice' },
          },
          githubToken: 'tok',
          ownerLogin: 'alice',
          lockKey: getPackageLockKey('test'),
          operation: 'upload',
          httpRequest: mockGitHubHttp,
        }),
      /empty \(0-commit\) repositories/i
    );

    console.log('11. Testing formatDisplayDateTime across all DateFormat and ClockFormat settings...');
    const sampleDisplayDate = new Date(2026, 10, 20, 0, 26, 18); // 2026-11-20 00:26:18 local
    assert.equal(formatDisplayDateTime(sampleDisplayDate, '24h', 'YYYY-MM-DD'), '2026/11/20, 00:26:18');
    assert.equal(formatDisplayDateTime(sampleDisplayDate, '12h', 'YYYY-MM-DD'), '2026/11/20, 12:26:18 AM');
    assert.equal(formatDisplayDateTime(sampleDisplayDate, '24h', 'YY-MM-DD'), '26/11/20, 00:26:18');
    assert.equal(formatDisplayDateTime(sampleDisplayDate, '12h', 'DD-MM-YYYY'), '20/11/2026, 12:26:18 AM');
    assert.equal(formatDisplayDateTime(sampleDisplayDate, '24h', 'DD-MM-YY'), '20/11/26, 00:26:18');
    const sampleAfternoon = new Date(2026, 10, 20, 15, 4, 9);
    assert.equal(formatDisplayDateTime(sampleAfternoon, '12h', 'DD-MM-YY'), '20/11/26, 03:04:09 PM');
    assert.equal(formatDisplayDateTime('not-a-date', '24h', 'YYYY-MM-DD'), '');

    console.log('12. Testing cancel + immediate re-upload lock race & 2-phase fencing...');
    // Simulate a permissive GitHub PATCH endpoint that allows two concurrent fast-forwards
    // from the same unlocked ancestor (no old_oid check), proving cache-busting + 2-phase
    // confirmLockOwnership strictly enforces mutual exclusion across PC1 and PC2.
    const racyRefs = new Map<string, string>();
    const racyCommits = new Map<
      string,
      { sha: string; message: string; treeSha: string; parents: string[]; committerDate: string }
    >();
    let racySeq = 0;
    let sawCacheBust = false;
    let sawNoCacheHeader = false;
    const racyHttp: HttpRequestFn = async (req) => {
      const u = new URL(req.url);
      const method = req.method || 'GET';
      const pathName = u.pathname;
      const body = req.body
        ? JSON.parse(typeof req.body === 'string' ? req.body : new TextDecoder().decode(req.body))
        : null;

      if (method === 'GET' && (pathName.includes('/git/ref/') || pathName.includes('/git/commits/'))) {
        if (u.searchParams.has('_cb')) sawCacheBust = true;
        if ((req.headers?.['Cache-Control'] || '').includes('no-store')) sawNoCacheHeader = true;
      }

      if (method === 'POST' && pathName === '/repos/alice/demo/git/trees') {
        return jsonRes(201, { sha: `rtree-${++racySeq}` });
      }
      if (method === 'POST' && pathName === '/repos/alice/demo/git/commits') {
        const sha = `rcommit-${++racySeq}`;
        racyCommits.set(sha, {
          sha,
          message: body.message,
          treeSha: body.tree,
          parents: body.parents || [],
          committerDate: new Date(mockServerNowMs).toISOString(),
        });
        return jsonRes(201, { sha });
      }
      if (method === 'GET' && pathName.startsWith('/repos/alice/demo/git/commits/')) {
        const sha = decodeURIComponent(pathName.split('/').pop() || '');
        const c = racyCommits.get(sha);
        if (!c) return jsonRes(404, { message: 'Not Found' });
        return jsonRes(200, { sha: c.sha, message: c.message, tree: { sha: c.treeSha }, committer: { date: c.committerDate } });
      }
      if (method === 'GET' && pathName.startsWith('/repos/alice/demo/git/ref/')) {
        const refName = `refs/${pathName.slice('/repos/alice/demo/git/ref/'.length)}`;
        const sha = racyRefs.get(refName);
        if (!sha) return jsonRes(404, { message: 'Not Found' });
        return jsonRes(200, { ref: refName, object: { sha, type: 'commit' } });
      }
      if (method === 'POST' && pathName === '/repos/alice/demo/git/refs') {
        if (racyRefs.has(body.ref)) return jsonRes(422, { message: 'Reference already exists' });
        racyRefs.set(body.ref, body.sha);
        return jsonRes(201, { ref: body.ref, object: { sha: body.sha } });
      }
      if (method === 'PATCH' && pathName.startsWith('/repos/alice/demo/git/refs/')) {
        const refName = `refs/${pathName.slice('/repos/alice/demo/git/refs/'.length)}`;
        if (!racyRefs.has(refName)) return jsonRes(404, { message: 'Not Found' });
        // Intentionally allow fast-forward from shared parent without strict CAS serialization
        // when the commit's direct parent isn't behind a confirm barrier, testing last-writer-wins
        racyRefs.set(refName, body.sha);
        return jsonRes(200, { ref: refName, object: { sha: body.sha } });
      }
      return jsonRes(404, { message: 'Unhandled racy mock route' });
    };

    const pc1Initial = await acquireRepoLock({
      repo: demoRepo,
      githubToken: 'tok',
      ownerLogin: 'alice',
      lockKey: getPackageLockKey('cancel-race-pkg'),
      packageName: 'cancel-race-pkg',
      operation: 'upload',
      sessionId: 'pc-1',
      confirmSettleMs: 30,
      pollIntervalMs: 25,
      httpRequest: racyHttp,
    });
    assert.equal(sawCacheBust, true);
    assert.equal(sawNoCacheHeader, true);

    let racyActive = 0;
    let racyMaxConcurrent = 0;
    // Start PC2 waiting while PC1 holds the lock, then PC1 cancels (releases) and immediately re-acquires
    const pc2WaiterPromise = acquireRepoLock({
      repo: demoRepo,
      githubToken: 'tok',
      ownerLogin: 'alice',
      lockKey: getPackageLockKey('cancel-race-pkg'),
      packageName: 'cancel-race-pkg',
      operation: 'upload',
      sessionId: 'pc-2',
      confirmSettleMs: 30,
      pollIntervalMs: 25,
      httpRequest: racyHttp,
    }).then(async (lock) => {
      racyActive += 1;
      racyMaxConcurrent = Math.max(racyMaxConcurrent, racyActive);
      await new Promise((r) => setTimeout(r, 60));
      racyActive -= 1;
      await lock.release();
    });

    await new Promise((r) => setTimeout(r, 35));
    await pc1Initial.release(); // User cancels upload #1 on PC1

    const pc1ImmediateReupload = acquireRepoLock({
      repo: demoRepo,
      githubToken: 'tok',
      ownerLogin: 'alice',
      lockKey: getPackageLockKey('cancel-race-pkg'),
      packageName: 'cancel-race-pkg',
      operation: 'upload',
      sessionId: 'pc-1',
      confirmSettleMs: 30,
      pollIntervalMs: 25,
      httpRequest: racyHttp,
    }).then(async (lock) => {
      racyActive += 1;
      racyMaxConcurrent = Math.max(racyMaxConcurrent, racyActive);
      await new Promise((r) => setTimeout(r, 60));
      racyActive -= 1;
      await lock.release();
    });

    await Promise.all([pc2WaiterPromise, pc1ImmediateReupload]);
    assert.equal(racyMaxConcurrent, 1);

    // Abort mid-confirmation rolls back ownership cleanly instead of leaking the lock
    const abortMidAcquire = new AbortController();
    setTimeout(() => abortMidAcquire.abort(), 15);
    await assert.rejects(
      () =>
        acquireRepoLock({
          repo: demoRepo,
          githubToken: 'tok',
          ownerLogin: 'alice',
          lockKey: getPackageLockKey('abort-rollback-pkg'),
          packageName: 'abort-rollback-pkg',
          operation: 'upload',
          sessionId: 'pc-abort',
          confirmSettleMs: 120,
          signal: abortMidAcquire.signal,
          httpRequest: racyHttp,
        }),
      (err: unknown) => (err as { name?: string })?.name === 'AbortError'
    );
    // Another PC must be able to immediately acquire without waiting on a leaked TTL
    const afterAbortLock = await acquireRepoLock({
      repo: demoRepo,
      githubToken: 'tok',
      ownerLogin: 'alice',
      lockKey: getPackageLockKey('abort-rollback-pkg'),
      packageName: 'abort-rollback-pkg',
      operation: 'upload',
      sessionId: 'pc-next',
      confirmSettleMs: 20,
      pollIntervalMs: 500,
      httpRequest: racyHttp,
    });
    assert.equal(afterAbortLock.hadToWait, false);
    await afterAbortLock.release();

    console.log('13. Testing streaming HTTP extraction with high gzip expansion & file/folder collision...');
    const colSrcA = path.join(tmpWorkDir, 'col_file.bin');
    const colSrcB = path.join(tmpWorkDir, 'col_folder_file.bin');
    const colArchive = path.join(tmpWorkDir, 'collision_layer.tar.gz');
    const colExtractDir = path.join(tmpWorkDir, 'col_extracted');
    // Highly compressible 12 MB total payload (>1000:1 gzip ratio so HTTP body finishes well before gunzip)
    await fs.writeFile(colSrcA, Buffer.alloc(6 * 1024 * 1024, 0x41));
    await fs.writeFile(colSrcB, Buffer.alloc(6 * 1024 * 1024, 0x42));
    await buildOciLayerToFile({
      outFilePath: colArchive,
      files: [
        { fullPath: colSrcB, relativePath: 'test/subfile.bin', size: 6 * 1024 * 1024 },
        { fullPath: colSrcA, relativePath: 'test', size: 6 * 1024 * 1024 },
      ],
    });
    await fs.mkdir(colExtractDir, { recursive: true });
    const compressedArchive = await fs.readFile(colArchive);
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Length': String(compressedArchive.length) });
      res.end(compressedArchive);
    });
    await new Promise<void>((resolve) => srv.listen(0, resolve));
    try {
      const port = (srv.address() as { port: number }).port;
      const upstreamRes = await fetch(`http://127.0.0.1:${port}`);
      assert.ok(upstreamRes.body);
      let activeOut: fsSync.WriteStream | null = null;
      const closeOut = () =>
        new Promise<void>((resolve, reject) => {
          if (!activeOut) return resolve();
          const ref = activeOut;
          activeOut = null;
          ref.once('error', reject);
          ref.end(resolve);
        });
      const ensureDirSafe = async (rootDir: string, targetDir: string) => {
        const rel = path.relative(rootDir, targetDir);
        if (!rel || rel === '.' || rel.startsWith('..')) return;
        let curr = rootDir;
        for (const part of rel.split(path.sep).filter(Boolean)) {
          curr = path.join(curr, part);
          try {
            const st = await fs.lstat(curr);
            if (!st.isDirectory()) {
              const alt = resolveExtractDestinationInfo(path.dirname(curr), path.basename(curr)).suggestedPath;
              await fs.rename(curr, alt);
            }
          } catch {
            // missing segment
          }
        }
        await fs.mkdir(targetDir, { recursive: true });
      };

      const streamParser = createNodeTarStreamParser({
        onFileStart: async (meta: { path: string }) => {
          await closeOut();
          let destPath = resolveSafeExtractPath(colExtractDir, meta.path);
          await ensureDirSafe(colExtractDir, path.dirname(destPath));
          if (fsSync.existsSync(destPath)) {
            destPath = resolveExtractDestinationInfo(path.dirname(destPath), path.basename(destPath)).suggestedPath;
          }
          activeOut = fsSync.createWriteStream(destPath, { highWaterMark: 1024 * 1024 });
        },
        onFileData: async (chunk: Buffer) => {
          if (activeOut) await writeStreamChunk(activeOut, chunk);
        },
        onFileEnd: async () => {
          await closeOut();
        },
      });

      const reader = upstreamRes.body.getReader();
      const gunzip = zlib.createGunzip({ chunkSize: 1024 * 1024 });
      let consumeErr: unknown = null;
      const consumePromise = (async () => {
        try {
          for await (const dec of gunzip) {
            await streamParser.feed(dec);
            if (streamParser.isDone()) {
              await reader.cancel().catch(() => {});
              gunzip.destroy();
              break;
            }
          }
        } catch (e) {
          consumeErr = e;
          gunzip.destroy();
          await reader.cancel().catch(() => {});
        }
      })();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writeStreamChunk(gunzip, Buffer.from(value));
      }
      if (!gunzip.destroyed) gunzip.end();
      await consumePromise;
      if (consumeErr) throw consumeErr;
      await closeOut();

      const names = (await fs.readdir(colExtractDir)).sort();
      assert.deepEqual(names, ['test', 'test (1)']);
      const nestedStat = await fs.stat(path.join(colExtractDir, 'test', 'subfile.bin'));
      const renamedFileStat = await fs.stat(path.join(colExtractDir, 'test (1)'));
      assert.equal(nestedStat.size, 6 * 1024 * 1024);
      assert.equal(renamedFileStat.size, 6 * 1024 * 1024);
    } finally {
      srv.close();
    }

    console.log('14. Testing getVersionReferenceInfo display truncation vs full pull command...');
    const fullDigest = 'sha256:37f5d6a6c659264e400da52d8888362c6cdf288235f9e0aa8b063c6310e982c9';
    const untaggedRef = getVersionReferenceInfo({
      name: fullDigest,
      metadata: { container: { tags: [] } },
    });
    assert.equal(untaggedRef.isUntagged, true);
    assert.equal(untaggedRef.pullSuffix, `@${fullDigest}`);
    assert.equal(untaggedRef.shortDigest, 'sha256:37f5d6a6c659…');
    assert.equal(untaggedRef.displayPullSuffix, '@sha256:37f5d6a6c659…');

    const longTag = 'very-long-custom-tag-name-that-definitely-exceeds-twenty-eight-characters';
    const taggedRef = getVersionReferenceInfo({
      name: fullDigest,
      metadata: { container: { tags: [longTag] } },
    });
    assert.equal(taggedRef.isUntagged, false);
    assert.equal(taggedRef.pullSuffix, `:${longTag}`);
    assert.equal(taggedRef.shortTagsLabel, `${longTag.slice(0, MAX_DISPLAY_TAG_CHARS)}…`);
    assert.equal(taggedRef.displayPullSuffix, `:${longTag.slice(0, MAX_DISPLAY_TAG_CHARS)}…`);

    console.log('15. Testing resolveCanonicalOwnerLockRepo across different selected repositories...');
    const repoOldestEmpty = {
      id: 10,
      name: 'empty-oldest',
      full_name: 'alice/empty-oldest',
      hasCommits: false,
      permissions: { push: true },
      owner: { login: 'alice' },
    };
    const repoOtherOwnerOldest = {
      id: 20,
      name: 'org-repo',
      full_name: 'acme/org-repo',
      hasCommits: true,
      permissions: { push: true },
      owner: { login: 'acme' },
    };
    const repoReadOnlyOlder = {
      id: 30,
      name: 'readonly-repo',
      full_name: 'alice/readonly-repo',
      hasCommits: true,
      permissions: { push: false },
      owner: { login: 'alice' },
    };
    const repoCanonical = {
      id: 42,
      name: 'demo',
      full_name: 'alice/demo',
      hasCommits: true,
      permissions: { push: true },
      owner: { login: 'alice' },
    };
    const repoB = {
      id: 105,
      name: 'repo-b',
      full_name: 'alice/repo-b',
      hasCommits: true,
      permissions: { push: true },
      owner: { login: 'alice' },
    };
    const repoC = {
      id: 200,
      name: 'repo-c',
      full_name: 'alice/repo-c',
      hasCommits: true,
      permissions: { push: true },
      owner: { login: 'alice' },
    };
    const allRepos = [repoC, repoReadOnlyOlder, repoCanonical, repoOtherOwnerOldest, repoOldestEmpty, repoB];
    // PC1 selects Repo B while PC2 selects Repo C -> both resolve to repoCanonical (`alice/demo`)
    const lockRepoPc1 = resolveCanonicalOwnerLockRepo(allRepos, repoB, 'alice');
    const lockRepoPc2 = resolveCanonicalOwnerLockRepo(allRepos, repoC, 'alice');
    assert.equal(lockRepoPc1.id, 42);
    assert.equal(lockRepoPc2.id, 42);

    // Verify PC1 (Repo B selected) and PC2 (Repo C selected) contend on the exact same lock ref
    let crossRepoActive = 0;
    let crossRepoMax = 0;
    await Promise.all([
      acquireRepoLock({
        repo: lockRepoPc1,
        githubToken: 'tok',
        ownerLogin: 'alice',
        lockKey: getPackageLockKey('shared-cross-repo'),
        packageName: 'shared-cross-repo',
        operation: 'upload',
        sessionId: 'pc1-repoB',
        confirmSettleMs: 25,
        pollIntervalMs: 25,
        httpRequest: racyHttp,
      }).then(async (lock) => {
        crossRepoActive += 1;
        crossRepoMax = Math.max(crossRepoMax, crossRepoActive);
        await new Promise((r) => setTimeout(r, 60));
        crossRepoActive -= 1;
        await lock.release();
      }),
      acquireRepoLock({
        repo: lockRepoPc2,
        githubToken: 'tok',
        ownerLogin: 'alice',
        lockKey: getPackageLockKey('shared-cross-repo'),
        packageName: 'shared-cross-repo',
        operation: 'upload',
        sessionId: 'pc2-repoC',
        confirmSettleMs: 25,
        pollIntervalMs: 25,
        httpRequest: racyHttp,
      }).then(async (lock) => {
        crossRepoActive += 1;
        crossRepoMax = Math.max(crossRepoMax, crossRepoActive);
        await new Promise((r) => setTimeout(r, 60));
        crossRepoActive -= 1;
        await lock.release();
      }),
    ]);
    assert.equal(crossRepoMax, 1);

    console.log('16. Testing zero-temp-file 4 MiB streaming OCI upload (chunking, adaptive cap, 401 refresh, abort)...');
    const createMockRegistry = (opts: {
      maxPatchBytes?: number;
      expectedLimitLabel?: string;
      failChunk2With401Once?: boolean;
      delaySecondPatchMs?: number;
      onSecondPatchStart?: () => void;
    }) => {
      const state = {
        maxPatchBytes: opts.maxPatchBytes ?? BLOB_UPLOAD_CHUNK_BYTES,
        expectedLimitLabel: opts.expectedLimitLabel ?? '4.00MiB',
        expectedToken: 'tok-initial',
        failed401Once: false,
        sessions: new Map<
          string,
          {
            chunks: Buffer[];
            offset: number;
            patchSizes: number[];
            monolithicPutSize: number | null;
            committedDigest: string | null;
            deleted: boolean;
          }
        >(),
        deletedCount: 0,
        lastSessionId: '',
      };

      const srv = http.createServer(async (req, res) => {
        const reqChunks: Buffer[] = [];
        for await (const c of req) {
          reqChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        }
        const body = Buffer.concat(reqChunks);
        const urlObj = new URL(req.url || '/', 'http://127.0.0.1');

        if (req.method === 'POST' && urlObj.pathname === '/v2/alice/pkg/blobs/uploads/') {
          if (req.headers.authorization !== `Bearer ${state.expectedToken}`) {
            res.statusCode = 401;
            res.end('unauthorized');
            return;
          }
          const sid = `sess-${state.sessions.size + 1}`;
          state.lastSessionId = sid;
          state.sessions.set(sid, {
            chunks: [],
            offset: 0,
            patchSizes: [],
            monolithicPutSize: null,
            committedDigest: null,
            deleted: false,
          });
          res.statusCode = 202;
          res.setHeader('Location', `/v2/alice/pkg/blobs/uploads/${sid}`);
          res.end();
          return;
        }

        const sessMatch = urlObj.pathname.match(/^\/v2\/alice\/pkg\/blobs\/uploads\/(sess-\d+)$/);
        if (!sessMatch) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        const sess = state.sessions.get(sessMatch[1]);
        if (!sess || sess.deleted) {
          res.statusCode = 404;
          res.end('session not found');
          return;
        }

        if (req.method === 'DELETE') {
          sess.deleted = true;
          state.deletedCount += 1;
          res.statusCode = 204;
          res.end();
          return;
        }

        if (req.headers.authorization !== `Bearer ${state.expectedToken}`) {
          res.statusCode = 401;
          res.end('unauthorized');
          return;
        }

        if (req.method === 'GET') {
          res.statusCode = 204;
          res.setHeader('Range', sess.offset > 0 ? `0-${sess.offset - 1}` : '0-0');
          res.end();
          return;
        }

        if (req.method === 'PATCH') {
          if (
            opts.failChunk2With401Once &&
            !state.failed401Once &&
            sess.patchSizes.length === 1
          ) {
            state.failed401Once = true;
            state.expectedToken = 'tok-refreshed';
            res.statusCode = 401;
            res.end('token expired');
            return;
          }

          if (sess.patchSizes.length === 1 && opts.onSecondPatchStart) {
            opts.onSecondPatchStart();
          }
          if (sess.patchSizes.length === 1 && opts.delaySecondPatchMs) {
            await new Promise((r) => setTimeout(r, opts.delaySecondPatchMs));
          }

          if (body.length > state.maxPatchBytes) {
            res.statusCode = 416;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                errors: [
                  {
                    code: 'REQUESTED_RANGE_NOT_SATISFIABLE',
                    message: `the request body is too large and exceeds the maximum permissible limit of ${state.expectedLimitLabel}`,
                  },
                ],
              })
            );
            return;
          }

          const contentRange = String(req.headers['content-range'] || '');
          const m = contentRange.match(/^(\d+)-(\d+)$/);
          if (!m) {
            res.statusCode = 400;
            res.end('missing content-range');
            return;
          }
          const rStart = Number(m[1]);
          const rEnd = Number(m[2]);
          if (rStart !== sess.offset || rEnd - rStart + 1 !== body.length) {
            res.statusCode = 416;
            res.setHeader('Range', sess.offset > 0 ? `0-${sess.offset - 1}` : '0-0');
            res.end('range mismatch');
            return;
          }

          sess.chunks.push(body);
          sess.offset += body.length;
          sess.patchSizes.push(body.length);
          res.statusCode = 202;
          res.setHeader('Location', `/v2/alice/pkg/blobs/uploads/${sessMatch[1]}`);
          res.setHeader('Range', `0-${sess.offset - 1}`);
          res.end();
          return;
        }

        if (req.method === 'PUT') {
          const digest = urlObj.searchParams.get('digest');
          if (body.length > 0) {
            if (body.length > state.maxPatchBytes) {
              res.statusCode = 416;
              res.end(
                JSON.stringify({
                  errors: [
                    {
                      code: 'REQUESTED_RANGE_NOT_SATISFIABLE',
                      message: `the request body is too large and exceeds the maximum permissible limit of ${state.expectedLimitLabel}`,
                    },
                  ],
                })
              );
              return;
            }
            sess.chunks.push(body);
            sess.offset += body.length;
            sess.monolithicPutSize = body.length;
          }
          const assembled = Buffer.concat(sess.chunks);
          const actualDigest = `sha256:${crypto.createHash('sha256').update(assembled).digest('hex')}`;
          if (digest !== actualDigest) {
            res.statusCode = 400;
            res.end(`digest mismatch: expected ${digest}, got ${actualDigest}`);
            return;
          }
          sess.committedDigest = actualDigest;
          res.statusCode = 201;
          res.end();
          return;
        }

        res.statusCode = 405;
        res.end('method not allowed');
      });

      return new Promise<{
        baseUrl: string;
        state: typeof state;
        close: () => Promise<void>;
      }>((resolve) => {
        srv.listen(0, '127.0.0.1', () => {
          const addr = srv.address();
          assert.ok(addr && typeof addr === 'object');
          resolve({
            baseUrl: `http://127.0.0.1:${addr.port}`,
            state,
            close: () => new Promise<void>((done) => srv.close(() => done())),
          });
        });
      });
    };

    const parseTarFromTargzBuffer = async (targzBuf: Buffer) => {
      const extractedFiles = new Map<string, Buffer>();
      let curPath = '';
      let curChunks: Buffer[] = [];
      const parser = createNodeTarStreamParser({
        onFileStart: ({ path: p }: { path: string }) => {
          curPath = p;
          curChunks = [];
        },
        onFileData: (chunk: Buffer) => {
          curChunks.push(Buffer.from(chunk));
        },
        onFileEnd: () => {
          extractedFiles.set(curPath, Buffer.concat(curChunks));
        },
      });
      await parser.feed(zlib.gunzipSync(targzBuf));
      assert.equal(parser.isDone(), true);
      return extractedFiles;
    };

    // Case A: > 9 MiB incompressible random bytes with strict 4.00 MiB PATCH cap & zero temp files
    const srcStreamDir = path.join(tmpWorkDir, 'stream-src');
    await fs.mkdir(srcStreamDir, { recursive: true });
    const random95Path = path.join(srcStreamDir, 'random-9.5mb.bin');
    const random95Bytes = crypto.randomBytes(9 * 1024 * 1024 + 512 * 1024);
    await fs.writeFile(random95Path, random95Bytes);

    const mockA = await createMockRegistry({});
    try {
      const tempBefore = (await fs.readdir(os.tmpdir())).filter((n) =>
        n.startsWith('ghcr-manager-layer-')
      );
      const resA = await streamAndUploadOciLayerChunked({
        files: [
          {
            fullPath: random95Path,
            relativePath: 'random-9.5mb.bin',
            size: random95Bytes.length,
          },
        ],
        uploadInitUrl: `${mockA.baseUrl}/v2/alice/pkg/blobs/uploads/`,
        registryToken: 'tok-initial',
      });
      const tempAfter = (await fs.readdir(os.tmpdir())).filter((n) =>
        n.startsWith('ghcr-manager-layer-')
      );
      assert.equal(tempAfter.length, tempBefore.length);
      const sessA = mockA.state.sessions.get(mockA.state.lastSessionId)!;
      assert.ok(sessA.patchSizes.length >= 3);
      assert.ok(sessA.patchSizes.every((s) => s > 0 && s <= 4 * 1024 * 1024));
      assert.equal(sessA.monolithicPutSize, null);
      assert.equal(sessA.committedDigest, resA.compressedDigest);
      const assembledA = Buffer.concat(sessA.chunks);
      assert.equal(assembledA.length, resA.compressedSize);
      const extractedA = await parseTarFromTargzBuffer(assembledA);
      assert.equal(extractedA.get('random-9.5mb.bin')?.equals(random95Bytes), true);
    } finally {
      await mockA.close();
    }

    // Case B: Small file (< 4 MiB) uses monolithic PUT with 0 PATCH requests
    const smallPath = path.join(srcStreamDir, 'small.bin');
    const smallBytes = crypto.randomBytes(128 * 1024);
    await fs.writeFile(smallPath, smallBytes);
    const mockB = await createMockRegistry({});
    try {
      const resB = await streamAndUploadOciLayerChunked({
        files: [{ fullPath: smallPath, relativePath: 'small.bin', size: smallBytes.length }],
        uploadInitUrl: `${mockB.baseUrl}/v2/alice/pkg/blobs/uploads/`,
        registryToken: 'tok-initial',
      });
      const sessB = mockB.state.sessions.get(mockB.state.lastSessionId)!;
      assert.equal(sessB.patchSizes.length, 0);
      assert.ok(sessB.monolithicPutSize !== null && sessB.monolithicPutSize < 4 * 1024 * 1024);
      assert.equal(sessB.committedDigest, resB.compressedDigest);
      const extractedB = await parseTarFromTargzBuffer(Buffer.concat(sessB.chunks));
      assert.equal(extractedB.get('small.bin')?.equals(smallBytes), true);
    } finally {
      await mockB.close();
    }

    // Case C: Adaptive chunk halving when server enforces stricter 1.00 MiB PATCH cap
    const random45Path = path.join(srcStreamDir, 'random-4.5mb.bin');
    const random45Bytes = crypto.randomBytes(4 * 1024 * 1024 + 512 * 1024);
    await fs.writeFile(random45Path, random45Bytes);
    const mockC = await createMockRegistry({
      maxPatchBytes: 1024 * 1024,
      expectedLimitLabel: '1.00MiB',
    });
    try {
      const resC = await streamAndUploadOciLayerChunked({
        files: [
          {
            fullPath: random45Path,
            relativePath: 'random-4.5mb.bin',
            size: random45Bytes.length,
          },
        ],
        uploadInitUrl: `${mockC.baseUrl}/v2/alice/pkg/blobs/uploads/`,
        registryToken: 'tok-initial',
      });
      const sessC = mockC.state.sessions.get(mockC.state.lastSessionId)!;
      assert.ok(sessC.patchSizes.length >= 5);
      assert.ok(sessC.patchSizes.every((s) => s > 0 && s <= 1024 * 1024));
      assert.equal(sessC.committedDigest, resC.compressedDigest);
      const extractedC = await parseTarFromTargzBuffer(Buffer.concat(sessC.chunks));
      assert.equal(extractedC.get('random-4.5mb.bin')?.equals(random45Bytes), true);
    } finally {
      await mockC.close();
    }

    // Case D: Mid-upload HTTP 401 triggers token refresh and completes upload
    const mockD = await createMockRegistry({ failChunk2With401Once: true });
    let refreshCount = 0;
    try {
      const resD = await streamAndUploadOciLayerChunked({
        files: [
          {
            fullPath: random45Path,
            relativePath: 'random-4.5mb.bin',
            size: random45Bytes.length,
          },
        ],
        uploadInitUrl: `${mockD.baseUrl}/v2/alice/pkg/blobs/uploads/`,
        registryToken: 'tok-initial',
        refreshToken: async () => {
          refreshCount += 1;
          return 'tok-refreshed';
        },
      });
      assert.equal(refreshCount, 1);
      assert.equal(resD.registryToken, 'tok-refreshed');
      const sessD = mockD.state.sessions.get(mockD.state.lastSessionId)!;
      assert.equal(sessD.committedDigest, resD.compressedDigest);
    } finally {
      await mockD.close();
    }

    // Case E: Mid-upload abort cancels cleanly and sends DELETE for upload session cleanup
    const abortUploadCtrl = new AbortController();
    const mockE = await createMockRegistry({
      delaySecondPatchMs: 250,
      onSecondPatchStart: () => abortUploadCtrl.abort(),
    });
    try {
      await assert.rejects(
        streamAndUploadOciLayerChunked({
          files: [
            {
              fullPath: random95Path,
              relativePath: 'random-9.5mb.bin',
              size: random95Bytes.length,
            },
          ],
          uploadInitUrl: `${mockE.baseUrl}/v2/alice/pkg/blobs/uploads/`,
          registryToken: 'tok-initial',
          signal: abortUploadCtrl.signal,
        }),
        (err: unknown) => Boolean(err && typeof err === 'object' && (err as Error).name === 'AbortError')
      );
      assert.equal(mockE.state.deletedCount, 1);
    } finally {
      await mockE.close();
    }

    console.log('17. Testing continuous streaming PATCH upload (retry once, proxy/401/double-drop 4 MiB fallback, abort)...');
    const createStreamingMockRegistry = (opts: {
      rejectStreamingStatus?: number;
      dropSocketOnAttempt?: Set<number>;
      failStreaming401AfterBytes?: number;
      onContinuousBytes?: () => void;
    }) => {
      const state = {
        expectedToken: 'tok-initial',
        streamingAttempts: 0,
        chunkedPatchCalls: 0,
        monolithicPutCalls: 0,
        failedStreaming401: false,
        deletedCount: 0,
        lastCommittedSessionId: '',
        sessions: new Map<
          string,
          {
            chunks: Buffer[];
            offset: number;
            streamingBytes: number;
            patchSizes: number[];
            committedDigest: string | null;
            deleted: boolean;
          }
        >(),
      };

      const srv = http.createServer((req, res) => {
        const urlObj = new URL(req.url || '/', 'http://127.0.0.1');

        if (req.method === 'POST' && urlObj.pathname === '/v2/alice/pkg/blobs/uploads/') {
          if (req.headers.authorization !== `Bearer ${state.expectedToken}`) {
            res.statusCode = 401;
            res.end('unauthorized');
            return;
          }
          const sid = `stream-sess-${state.sessions.size + 1}`;
          state.sessions.set(sid, {
            chunks: [],
            offset: 0,
            streamingBytes: 0,
            patchSizes: [],
            committedDigest: null,
            deleted: false,
          });
          res.statusCode = 202;
          res.setHeader('Location', `/v2/alice/pkg/blobs/uploads/${sid}`);
          res.end();
          return;
        }

        const sessMatch = urlObj.pathname.match(/^\/v2\/alice\/pkg\/blobs\/uploads\/(stream-sess-\d+)$/);
        if (!sessMatch) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        const sess = state.sessions.get(sessMatch[1]);
        if (!sess || sess.deleted) {
          res.statusCode = 404;
          res.end('session not found');
          return;
        }

        if (req.method === 'DELETE') {
          sess.deleted = true;
          state.deletedCount += 1;
          res.statusCode = 204;
          res.end();
          return;
        }

        if (req.headers.authorization !== `Bearer ${state.expectedToken}`) {
          res.statusCode = 401;
          res.end('unauthorized');
          return;
        }

        if (req.method === 'GET') {
          res.statusCode = 204;
          res.setHeader('Range', sess.offset > 0 ? `0-${sess.offset - 1}` : '0-0');
          res.end();
          return;
        }

        if (req.method === 'PATCH') {
          const contentRange = req.headers['content-range'];
          if (!contentRange) {
            state.streamingAttempts += 1;
            if (opts.rejectStreamingStatus) {
              res.statusCode = opts.rejectStreamingStatus;
              res.end('streaming not supported');
              return;
            }
            const attemptIdx = state.streamingAttempts;
            const localChunks: Buffer[] = [];
            let received = 0;
            let endedEarly = false;

            req.on('data', (chunk: Buffer) => {
              if (endedEarly) return;
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              received += buf.length;
              localChunks.push(buf);

              if (
                opts.failStreaming401AfterBytes &&
                received >= opts.failStreaming401AfterBytes &&
                !state.failedStreaming401
              ) {
                endedEarly = true;
                state.failedStreaming401 = true;
                state.expectedToken = 'tok-refreshed';
                res.statusCode = 401;
                res.end('token expired mid-stream');
                return;
              }

              if (
                opts.dropSocketOnAttempt &&
                opts.dropSocketOnAttempt.has(attemptIdx) &&
                received >= 1024 * 1024
              ) {
                endedEarly = true;
                req.socket.destroy();
                return;
              }

              if (opts.onContinuousBytes && received >= 1024 * 1024) {
                endedEarly = true;
                opts.onContinuousBytes();
              }
            });

            req.on('end', () => {
              if (endedEarly) return;
              sess.chunks.push(...localChunks);
              sess.offset += received;
              sess.streamingBytes += received;
              res.statusCode = 202;
              res.setHeader('Location', `/v2/alice/pkg/blobs/uploads/${sessMatch[1]}`);
              res.setHeader('Range', `0-${sess.offset - 1}`);
              res.end();
            });
            return;
          }

          // Ranged 4 MiB chunked fallback PATCH
          state.chunkedPatchCalls += 1;
          const patchChunks: Buffer[] = [];
          req.on('data', (c: Buffer) => patchChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          req.on('end', () => {
            const body = Buffer.concat(patchChunks);
            if (body.length > BLOB_UPLOAD_CHUNK_BYTES) {
              res.statusCode = 416;
              res.end(
                JSON.stringify({
                  errors: [
                    {
                      code: 'REQUESTED_RANGE_NOT_SATISFIABLE',
                      message: 'the request body is too large and exceeds the maximum permissible limit of 4.00MiB',
                    },
                  ],
                })
              );
              return;
            }
            const m = String(contentRange).match(/^(\d+)-(\d+)$/);
            if (!m || Number(m[1]) !== sess.offset || Number(m[2]) - Number(m[1]) + 1 !== body.length) {
              res.statusCode = 416;
              res.setHeader('Range', sess.offset > 0 ? `0-${sess.offset - 1}` : '0-0');
              res.end('range mismatch');
              return;
            }
            sess.chunks.push(body);
            sess.offset += body.length;
            sess.patchSizes.push(body.length);
            res.statusCode = 202;
            res.setHeader('Location', `/v2/alice/pkg/blobs/uploads/${sessMatch[1]}`);
            res.setHeader('Range', `0-${sess.offset - 1}`);
            res.end();
          });
          return;
        }

        if (req.method === 'PUT') {
          const putChunks: Buffer[] = [];
          req.on('data', (c: Buffer) => putChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          req.on('end', () => {
            const body = Buffer.concat(putChunks);
            const digest = urlObj.searchParams.get('digest');
            if (body.length > 0) {
              state.monolithicPutCalls += 1;
              sess.chunks.push(body);
              sess.offset += body.length;
            }
            const assembled = Buffer.concat(sess.chunks);
            const actualDigest = `sha256:${crypto.createHash('sha256').update(assembled).digest('hex')}`;
            if (digest !== actualDigest) {
              res.statusCode = 400;
              res.end(`digest mismatch: expected ${digest}, got ${actualDigest}`);
              return;
            }
            sess.committedDigest = actualDigest;
            state.lastCommittedSessionId = sessMatch[1];
            res.statusCode = 201;
            res.end();
          });
          return;
        }

        res.statusCode = 405;
        res.end('method not allowed');
      });

      return new Promise<{
        baseUrl: string;
        state: typeof state;
        close: () => Promise<void>;
      }>((resolve) => {
        srv.listen(0, '127.0.0.1', () => {
          const addr = srv.address();
          assert.ok(addr && typeof addr === 'object');
          resolve({
            baseUrl: `http://127.0.0.1:${addr.port}`,
            state,
            close: () =>
              new Promise<void>((done) => {
                if (typeof srv.closeAllConnections === 'function') {
                  srv.closeAllConnections();
                }
                srv.close(() => done());
              }),
          });
        });
      });
    };

    // Case A (Continuous): > 9 MiB incompressible bytes via single continuous Transfer-Encoding: chunked PATCH
    const streamMockA = await createStreamingMockRegistry({});
    try {
      const tempBefore = (await fs.readdir(os.tmpdir())).filter((n) =>
        n.startsWith('ghcr-manager-layer-')
      );
      const resA = await streamAndUploadOciLayer({
        files: [
          {
            fullPath: random95Path,
            relativePath: 'random-9.5mb.bin',
            size: random95Bytes.length,
          },
        ],
        uploadInitUrl: `${streamMockA.baseUrl}/v2/alice/pkg/blobs/uploads/`,
        registryToken: 'tok-initial',
        retryDelayMs: 50,
        fallbackDelayMs: 25,
      });
      const tempAfter = (await fs.readdir(os.tmpdir())).filter((n) =>
        n.startsWith('ghcr-manager-layer-')
      );
      assert.equal(tempAfter.length, tempBefore.length);
      assert.equal(resA.uploadMode, 'continuous');
      assert.equal(streamMockA.state.streamingAttempts, 1);
      assert.equal(streamMockA.state.chunkedPatchCalls, 0);
      const sessA = streamMockA.state.sessions.get(streamMockA.state.lastCommittedSessionId)!;
      assert.equal(sessA.streamingBytes, resA.compressedSize);
      assert.equal(sessA.committedDigest, resA.compressedDigest);
      const extractedA = await parseTarFromTargzBuffer(Buffer.concat(sessA.chunks));
      assert.equal(extractedA.get('random-9.5mb.bin')?.equals(random95Bytes), true);
    } finally {
      await streamMockA.close();
    }

    // Case B (Continuous): Small file (< 4 MiB) uses monolithic PUT with 0 PATCH requests
    const streamMockB = await createStreamingMockRegistry({});
    try {
      const resB = await streamAndUploadOciLayer({
        files: [{ fullPath: smallPath, relativePath: 'small.bin', size: smallBytes.length }],
        uploadInitUrl: `${streamMockB.baseUrl}/v2/alice/pkg/blobs/uploads/`,
        registryToken: 'tok-initial',
        retryDelayMs: 50,
        fallbackDelayMs: 25,
      });
      assert.equal(resB.uploadMode, 'continuous');
      assert.equal(streamMockB.state.streamingAttempts, 0);
      assert.equal(streamMockB.state.chunkedPatchCalls, 0);
      assert.equal(streamMockB.state.monolithicPutCalls, 1);
      const sessB = streamMockB.state.sessions.get(streamMockB.state.lastCommittedSessionId)!;
      const extractedB = await parseTarFromTargzBuffer(Buffer.concat(sessB.chunks));
      assert.equal(extractedB.get('small.bin')?.equals(smallBytes), true);
    } finally {
      await streamMockB.close();
    }

    // Case C (Continuous): Proxy rejects streaming with 411 -> immediate 4 MiB fallback after 1 streaming attempt
    const streamMockC = await createStreamingMockRegistry({ rejectStreamingStatus: 411 });
    const statusMsgsC: string[] = [];
    try {
      const resC = await streamAndUploadOciLayer({
        files: [
          {
            fullPath: random95Path,
            relativePath: 'random-9.5mb.bin',
            size: random95Bytes.length,
          },
        ],
        uploadInitUrl: `${streamMockC.baseUrl}/v2/alice/pkg/blobs/uploads/`,
        registryToken: 'tok-initial',
        retryDelayMs: 50,
        fallbackDelayMs: 25,
        onStatusMessage: (m: string) => statusMsgsC.push(m),
      });
      assert.equal(resC.uploadMode, 'chunked');
      assert.equal(streamMockC.state.streamingAttempts, 1);
      assert.ok(streamMockC.state.chunkedPatchCalls >= 3);
      assert.ok(statusMsgsC.some((m) => m.includes('4 MiB chunked')));
      const sessC = streamMockC.state.sessions.get(streamMockC.state.lastCommittedSessionId)!;
      const extractedC = await parseTarFromTargzBuffer(Buffer.concat(sessC.chunks));
      assert.equal(extractedC.get('random-9.5mb.bin')?.equals(random95Bytes), true);
    } finally {
      await streamMockC.close();
    }

    // Case D (Continuous): One-off socket reset on Attempt 1 retries continuous stream cleanly (Attempt 2 succeeds)
    const streamMockD = await createStreamingMockRegistry({
      dropSocketOnAttempt: new Set([1]),
    });
    const statusMsgsD: string[] = [];
    try {
      const resD = await streamAndUploadOciLayer({
        files: [
          {
            fullPath: random95Path,
            relativePath: 'random-9.5mb.bin',
            size: random95Bytes.length,
          },
        ],
        uploadInitUrl: `${streamMockD.baseUrl}/v2/alice/pkg/blobs/uploads/`,
        registryToken: 'tok-initial',
        retryDelayMs: 50,
        fallbackDelayMs: 25,
        onStatusMessage: (m: string) => statusMsgsD.push(m),
      });
      assert.equal(resD.uploadMode, 'continuous');
      assert.equal(streamMockD.state.streamingAttempts, 2);
      assert.equal(streamMockD.state.chunkedPatchCalls, 0);
      assert.ok(statusMsgsD.some((m) => m.includes('retrying continuous stream')));
      const sessD = streamMockD.state.sessions.get(streamMockD.state.lastCommittedSessionId)!;
      const extractedD = await parseTarFromTargzBuffer(Buffer.concat(sessD.chunks));
      assert.equal(extractedD.get('random-9.5mb.bin')?.equals(random95Bytes), true);
    } finally {
      await streamMockD.close();
    }

    // Case E (Continuous): Two consecutive socket resets fall back automatically to 4 MiB chunks
    const streamMockE = await createStreamingMockRegistry({
      dropSocketOnAttempt: new Set([1, 2]),
    });
    try {
      const resE = await streamAndUploadOciLayer({
        files: [
          {
            fullPath: random95Path,
            relativePath: 'random-9.5mb.bin',
            size: random95Bytes.length,
          },
        ],
        uploadInitUrl: `${streamMockE.baseUrl}/v2/alice/pkg/blobs/uploads/`,
        registryToken: 'tok-initial',
        retryDelayMs: 50,
        fallbackDelayMs: 25,
      });
      assert.equal(resE.uploadMode, 'chunked');
      assert.equal(streamMockE.state.streamingAttempts, 2);
      assert.ok(streamMockE.state.chunkedPatchCalls >= 3);
      const sessE = streamMockE.state.sessions.get(streamMockE.state.lastCommittedSessionId)!;
      const extractedE = await parseTarFromTargzBuffer(Buffer.concat(sessE.chunks));
      assert.equal(extractedE.get('random-9.5mb.bin')?.equals(random95Bytes), true);
    } finally {
      await streamMockE.close();
    }

    // Case F (Continuous): Mid-stream 401 refreshes token and falls back immediately to 4 MiB chunks
    const streamMockF = await createStreamingMockRegistry({
      failStreaming401AfterBytes: 1024 * 1024,
    });
    let streamRefreshCount = 0;
    try {
      const resF = await streamAndUploadOciLayer({
        files: [
          {
            fullPath: random95Path,
            relativePath: 'random-9.5mb.bin',
            size: random95Bytes.length,
          },
        ],
        uploadInitUrl: `${streamMockF.baseUrl}/v2/alice/pkg/blobs/uploads/`,
        registryToken: 'tok-initial',
        retryDelayMs: 50,
        fallbackDelayMs: 25,
        refreshToken: async () => {
          streamRefreshCount += 1;
          return 'tok-refreshed';
        },
      });
      assert.equal(resF.uploadMode, 'chunked');
      assert.equal(streamMockF.state.streamingAttempts, 1);
      assert.equal(streamRefreshCount, 1);
      assert.equal(resF.registryToken, 'tok-refreshed');
      assert.ok(streamMockF.state.chunkedPatchCalls >= 3);
      const sessF = streamMockF.state.sessions.get(streamMockF.state.lastCommittedSessionId)!;
      const extractedF = await parseTarFromTargzBuffer(Buffer.concat(sessF.chunks));
      assert.equal(extractedF.get('random-9.5mb.bin')?.equals(random95Bytes), true);
    } finally {
      await streamMockF.close();
    }

    // Case G (Continuous): User abort cancels immediately with 0 retries, 0 fallback, and DELETE cleanup
    const continuousAbortCtrl = new AbortController();
    const streamMockG = await createStreamingMockRegistry({
      onContinuousBytes: () => continuousAbortCtrl.abort(),
    });
    try {
      await assert.rejects(
        streamAndUploadOciLayer({
          files: [
            {
              fullPath: random95Path,
              relativePath: 'random-9.5mb.bin',
              size: random95Bytes.length,
            },
          ],
          uploadInitUrl: `${streamMockG.baseUrl}/v2/alice/pkg/blobs/uploads/`,
          registryToken: 'tok-initial',
          retryDelayMs: 50,
          fallbackDelayMs: 25,
          signal: continuousAbortCtrl.signal,
        }),
        (err: unknown) => Boolean(err && typeof err === 'object' && (err as Error).name === 'AbortError')
      );
      assert.equal(streamMockG.state.streamingAttempts, 1);
      assert.equal(streamMockG.state.chunkedPatchCalls, 0);
      assert.equal(streamMockG.state.deletedCount, 1);
    } finally {
      await streamMockG.close();
    }

    // Case H: uploadMode='chunked' goes straight to 4 MiB chunked PATCH with 0 continuous attempts
    const streamMockH = await createStreamingMockRegistry({});
    try {
      const resH = await streamAndUploadOciLayer({
        files: [
          {
            fullPath: random95Path,
            relativePath: 'random-9.5mb.bin',
            size: random95Bytes.length,
          },
        ],
        uploadInitUrl: `${streamMockH.baseUrl}/v2/alice/pkg/blobs/uploads/`,
        registryToken: 'tok-initial',
        uploadMode: 'chunked',
      });
      assert.equal(resH.uploadMode, 'chunked');
      assert.equal(streamMockH.state.streamingAttempts, 0);
      assert.ok(streamMockH.state.chunkedPatchCalls >= 3);
      const sessH = streamMockH.state.sessions.get(streamMockH.state.lastCommittedSessionId)!;
      const extractedH = await parseTarFromTargzBuffer(Buffer.concat(sessH.chunks));
      assert.equal(extractedH.get('random-9.5mb.bin')?.equals(random95Bytes), true);
    } finally {
      await streamMockH.close();
    }
  } finally {
    await fs.rm(tmpWorkDir, { recursive: true, force: true });
  }

  console.log('18. Testing Unlinked Packages helpers and canonical lock guard...');
  assert.equal(isUnlinkedPackagesRepo(null), false);
  assert.equal(isUnlinkedPackagesRepo(undefined), false);
  assert.equal(isUnlinkedPackagesRepo({ id: UNLINKED_PACKAGES_REPO_ID }), true);
  assert.equal(isUnlinkedPackagesRepo({ id: 12345 }), false);

  const sampleRepoA = { id: 100, full_name: 'Alice/RepoA' };
  const sampleUnlinkedRepo = { id: UNLINKED_PACKAGES_REPO_ID, full_name: 'Unlinked Packages' };
  assert.equal(
    packageMatchesRepo({ repository: { id: 100, full_name: 'other/name' } }, sampleRepoA),
    true
  );
  assert.equal(
    packageMatchesRepo({ repository: { id: 999, full_name: 'alice/repoa' } }, sampleRepoA),
    true
  );
  assert.equal(
    packageMatchesRepo({ repository: { id: 200, full_name: 'Alice/RepoB' } }, sampleRepoA),
    false
  );
  assert.equal(packageMatchesRepo({ repository: null }, sampleRepoA), false);
  assert.equal(packageMatchesRepo({ repository: undefined }, sampleRepoA), false);
  assert.equal(
    packageMatchesRepo({ repository: { id: -1, full_name: 'Unlinked Packages' } }, sampleUnlinkedRepo),
    false
  );

  const mixedPkgs = [
    { id: 1, name: 'unlinked-one', owner: { login: 'Alice' }, repository: null },
    { id: 1, name: 'unlinked-one', owner: { login: 'Alice' }, repository: null },
    { id: 2, name: 'linked-pkg', owner: { login: 'Alice' }, repository: { id: 100, full_name: 'Alice/RepoA' } },
    { id: 3, name: 'ghcr-manager-index_repoa', owner: { login: 'Alice' }, repository: null },
    { id: 4, name: 'unlinked-org', owner: { login: 'MyOrg' }, repository: undefined },
  ];
  const filteredUnlinked = filterUnlinkedContainerPackages(mixedPkgs);
  assert.deepEqual(
    filteredUnlinked.map((p) => p.name),
    ['unlinked-one', 'unlinked-org']
  );

  const lockPickedReal = resolveCanonicalOwnerLockRepo(
    [
      {
        id: UNLINKED_PACKAGES_REPO_ID,
        name: 'Unlinked Packages',
        full_name: 'Unlinked Packages',
        hasCommits: true,
        permissions: { push: true },
        owner: { login: 'Alice' },
      },
      {
        id: 42,
        name: 'real-repo',
        full_name: 'Alice/real-repo',
        hasCommits: true,
        permissions: { push: true },
        owner: { login: 'Alice' },
      },
    ],
    {
      id: UNLINKED_PACKAGES_REPO_ID,
      name: 'Unlinked Packages',
      full_name: 'Unlinked Packages',
      hasCommits: true,
      permissions: { push: true },
      owner: { login: 'Alice' },
    },
    'Alice'
  );
  assert.equal(lockPickedReal.id, 42);

  console.log('19. Testing account package counts summary and package settings URL normalization...');
  const pkgCountsSummary = summarizeAccountPackageCounts([
    { id: 1, name: 'u1', owner: { login: 'Alice' }, repository: null },
    { id: 2, name: 'u2', owner: { login: 'MyOrg' }, repository: undefined },
    { id: 2, name: 'u2', owner: { login: 'MyOrg' }, repository: undefined },
    { id: 3, name: 'p1', owner: { login: 'Alice' }, repository: { id: 100, full_name: 'Alice/RepoA' } },
    { id: 4, name: 'p2', owner: { login: 'Alice' }, repository: { id: 100, full_name: 'Alice/RepoA' } },
    { id: 5, name: 'p3', owner: { login: 'Alice' }, repository: { id: 200, full_name: 'Alice/RepoB' } },
    { id: 6, name: 'ghcr-manager-index_repoa', owner: { login: 'Alice' }, repository: { id: 100, full_name: 'Alice/RepoA' } },
    { id: 7, name: 'ghcr-manager-index_orphan', owner: { login: 'Alice' }, repository: null },
  ]);
  assert.equal(pkgCountsSummary.unlinkedCount, 2);
  assert.equal(pkgCountsSummary.byRepoId[100], 2);
  assert.equal(pkgCountsSummary.byRepoId[200], 1);
  assert.equal(pkgCountsSummary.byRepoFullName['alice/repoa'], 2);
  assert.equal(pkgCountsSummary.byRepoFullName['alice/repob'], 1);

  assert.equal(
    getPackageSettingsUrl({
      name: '12',
      html_url: 'https://github.com/users/nityanandos/packages/container/package/12',
      owner: { login: 'nityanandos', type: 'User' },
    }),
    'https://github.com/users/nityanandos/packages/container/12/settings'
  );
  assert.equal(
    getPackageSettingsUrl({
      name: 'my/app',
      html_url: 'https://github.com/orgs/acme/packages/container/package/my%2Fapp/',
      owner: { login: 'acme', type: 'Organization' },
    }),
    'https://github.com/orgs/acme/packages/container/my%2Fapp/settings'
  );
  assert.equal(
    getPackageSettingsUrl({
      name: 'test',
      html_url: 'https://github.com/nityanandos/Test/pkgs/container/test',
      owner: { login: 'nityanandos', type: 'User' },
    }),
    'https://github.com/nityanandos/Test/pkgs/container/test/settings'
  );
  assert.equal(
    getPackageSettingsUrl({
      name: 'fallback-pkg',
      html_url: '',
      owner: { login: 'Alice', type: 'User' },
    }),
    'https://github.com/users/Alice/packages/container/fallback-pkg/settings'
  );
  assert.equal(
    getPackageSettingsUrl({
      name: 'org-pkg',
      html_url: null,
      owner: { login: 'MyOrg', type: 'Organization' },
    }),
    'https://github.com/orgs/MyOrg/packages/container/org-pkg/settings'
  );

  console.log('20. Testing SemVer update comparison and GitHub release resolution...');
  assert.equal(cleanVersion('v1.2.3'), '1.2.3');
  assert.equal(cleanVersion(' V1.10.0 '), '1.10.0');
  assert.equal(compareVersions('v1.2.10', 'v1.2.3'), 1);
  assert.equal(compareVersions('v1.2.3', 'v1.2.10'), -1);
  assert.equal(compareVersions('v1.4.0', 'v1.2.10'), 1);
  assert.equal(compareVersions('v1.1.3', '1.1.3'), 0);
  assert.equal(compareVersions('v2.0.0', 'v1.99.99'), 1);
  assert.equal(compareVersions('v1.2.0', 'v1.2'), 0);

  const emptyRes = resolveUpdateCheckFromReleases('1.1.3', []);
  assert.equal(emptyRes.status, 'up-to-date');
  assert.equal(emptyRes.latestVersion, '1.1.3');

  const releaseCheckNewer = resolveUpdateCheckFromReleases('1.1.3', [
    {
      tag_name: 'nightly',
      draft: false,
      html_url: 'https://github.com/nitaidor/GHCR-Manager/releases/tag/nightly',
    },
    {
      tag_name: 'v9.9.9',
      draft: true,
      html_url: 'https://github.com/nitaidor/GHCR-Manager/releases/tag/v9.9.9',
    },
    {
      tag_name: 'v1.2.2',
      draft: false,
      name: 'Release v1.2.2',
      html_url: 'https://github.com/nitaidor/GHCR-Manager/releases/tag/v1.2.2',
      published_at: '2026-11-18T10:00:00Z',
    },
    {
      tag_name: 'v1.2.10',
      draft: false,
      name: 'GHCR Manager v1.2.10',
      html_url: 'https://github.com/nitaidor/GHCR-Manager/releases/tag/v1.2.10',
      published_at: '2026-11-20T12:00:00Z',
    },
  ]);
  assert.equal(releaseCheckNewer.status, 'update-available');
  assert.equal(releaseCheckNewer.currentVersion, '1.1.3');
  assert.equal(releaseCheckNewer.latestVersion, '1.2.10');
  assert.equal(releaseCheckNewer.releaseName, 'GHCR Manager v1.2.10');
  assert.equal(
    releaseCheckNewer.releaseUrl,
    'https://github.com/nitaidor/GHCR-Manager/releases/tag/v1.2.10'
  );
  assert.equal(releaseCheckNewer.publishedAt, '2026-11-20T12:00:00Z');

  const releaseCheckUpToDate = resolveUpdateCheckFromReleases('1.2.10', [
    {
      tag_name: 'v1.2.10',
      draft: false,
      html_url: 'https://github.com/nitaidor/GHCR-Manager/releases/tag/v1.2.10',
    },
    {
      tag_name: 'v1.2.3',
      draft: false,
      html_url: 'https://github.com/nitaidor/GHCR-Manager/releases/tag/v1.2.3',
    },
  ]);
  assert.equal(releaseCheckUpToDate.status, 'up-to-date');
  assert.equal(releaseCheckUpToDate.latestVersion, '1.2.10');

  console.log('All tests passed successfully!');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
