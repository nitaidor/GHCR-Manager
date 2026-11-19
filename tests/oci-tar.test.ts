import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import {
  formatTimestampTag,
  formatUniqueRepoIndexTag,
  getPackageLockKey,
  getRepoIndexDisplayTitle,
  getRepoIndexPackageName,
  isRepoIndexPackageName,
  toGitRefSafeLockSegment,
  toOciImageName,
  validateFilesSelectionName,
  validateOciTag,
} from '../src/lib/naming.ts';
import {
  acquireRepoIndexLock,
  acquireRepoLock,
  acquireRepoPackageLocks,
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

    // (b) Crashed lease expiry + server-clock immunity + late stale release rejection
    const pc1CrashLock = await acquireRepoIndexLock({
      repo: demoRepo,
      githubToken: 'tok',
      ownerLogin: 'alice',
      pollIntervalMs: 25,
      heartbeatIntervalMs: 60_000,
      leaseTtlMs: 5_000,
      httpRequest: mockGitHubHttp,
    });
    // Advance GitHub server clock past the 5s lease TTL
    mockServerNowMs += 6_500;
    let leaseLostFired = false;
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
        leaseLostFired = true;
      },
      httpRequest: mockGitHubHttp,
    });
    assert.equal(leaseLostFired, false);
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
  } finally {
    await fs.rm(tmpWorkDir, { recursive: true, force: true });
  }

  console.log('All tests passed successfully!');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
