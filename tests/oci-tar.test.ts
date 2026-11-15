import assert from 'node:assert/strict';
import { toOciImageName, validateFilesSelectionName } from '../src/lib/naming.ts';
import {
  buildOciLayerFromFiles,
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

  console.log('All tests passed successfully!');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
