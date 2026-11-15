/**
 * Rules for GitHub Package Manager image & package naming:
 * 1. Single file picked: defaults to the file's name; user can keep it or enter a custom name.
 * 2. Multiple files picked: user MUST enter a name for the image.
 * 3. Root Folder Sync (Windows / Linux / macOS):
 *    - Direct file in the root folder -> 1 image per file; image/package name = file name.
 *    - Immediate sub-folder in the root folder -> 1 image containing all files in that sub-folder;
 *      image/package name = sub-folder name.
 * 4. Package name === Image name.
 */

export type UploadMode = 'files' | 'folder-sync';

/**
 * Normalizes any raw file name, folder name, or custom image name into a valid
 * OCI / GitHub Container Registry (ghcr.io) package/image name.
 *
 * OCI spec regex for repository component: [a-z0-9]+(?:[._-][a-z0-9]+)*
 * - Keeps lowercase letters, digits, '.', '_', '-'
 * - Converts spaces & invalid separators into '-'
 * - Collapses consecutive separators and trims leading/trailing separators
 */
export function toOciImageName(rawName: string): string {
  const trimmed = rawName.trim();
  if (!trimmed) return '';

  // Lowercase and replace whitespace or unsupported characters with '-'
  let normalized = trimmed
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '-')
    // Collapse multiple consecutive punctuation chars (e.g. "--" or ".-") into the first one
    .replace(/([._-])[._-]+/g, '$1')
    // Strip leading or trailing '.', '_', '-'
    .replace(/^[._-]+|[._-]+$/g, '');

  // If the original name was purely non-ASCII (e.g. Hebrew/Arabic/CJK), produce a deterministic hex slug
  if (!normalized) {
    const bytes = new TextEncoder().encode(trimmed);
    let hex = '';
    for (let i = 0; i < Math.min(bytes.length, 12); i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    normalized = `pkg-${hex}`;
  }

  return normalized;
}

/**
 * Validates whether a user-entered image name is valid for the current file selection.
 */
export function validateFilesSelectionName(
  fileCount: number,
  enteredName: string,
  defaultSingleFileName?: string
): {
  valid: boolean;
  effectiveRawName: string;
  ociPackageName: string;
  error?: string;
} {
  if (fileCount === 0) {
    return {
      valid: false,
      effectiveRawName: '',
      ociPackageName: '',
      error: 'Select at least one file to upload.',
    };
  }

  if (fileCount === 1) {
    const raw = enteredName.trim() || (defaultSingleFileName ?? '').trim();
    const oci = toOciImageName(raw);
    if (!oci) {
      return {
        valid: false,
        effectiveRawName: raw,
        ociPackageName: '',
        error: 'Please enter a valid image name.',
      };
    }
    return {
      valid: true,
      effectiveRawName: raw,
      ociPackageName: oci,
    };
  }

  // Multiple files (2+): User MUST enter a name for the image
  const raw = enteredName.trim();
  if (!raw) {
    return {
      valid: false,
      effectiveRawName: '',
      ociPackageName: '',
      error: 'When uploading multiple files, you must enter a name for the image.',
    };
  }

  const oci = toOciImageName(raw);
  if (!oci) {
    return {
      valid: false,
      effectiveRawName: raw,
      ociPackageName: '',
      error: 'Image name must contain at least one letter or number.',
    };
  }

  return {
    valid: true,
    effectiveRawName: raw,
    ociPackageName: oci,
  };
}
