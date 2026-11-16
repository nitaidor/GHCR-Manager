import assert from 'node:assert/strict';
import {
  formatTimestampTag,
  toOciImageName,
  validateFilesSelectionName,
  validateOciTag,
} from '../src/lib/naming.ts';
import {
  buildOciLayerFromFiles,
  extractFileMetaListStreaming,
  extractFilesFromOciLayer,
  type TarInputFile,
} from '../src/lib/tar.ts';

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

  console.log('All tests passed successfully!');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
