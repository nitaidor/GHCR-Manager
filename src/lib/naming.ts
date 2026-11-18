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
export type ClockFormat = '24h' | '12h';
export type DateFormat = 'YYYY-MM-DD' | 'YY-MM-DD' | 'DD-MM-YYYY' | 'DD-MM-YY';

const OCI_TAG_REGEX = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;

/**
 * Formats a Date in local time into a valid OCI tag using the user's preferred date and clock formats.
 * Dots separate HH.MM.SS (since ':' and '/' are invalid in OCI tags), e.g. "2026-11-16_13.05.09".
 */
export function formatTimestampTag(
  date: Date,
  clockFormat: ClockFormat = '24h',
  dateFormat: DateFormat = 'YYYY-MM-DD'
): string {
  const fullYear = String(date.getFullYear());
  const shortYear = fullYear.slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  let datePart: string;
  switch (dateFormat) {
    case 'YY-MM-DD':
      datePart = `${shortYear}-${month}-${day}`;
      break;
    case 'DD-MM-YYYY':
      datePart = `${day}-${month}-${fullYear}`;
      break;
    case 'DD-MM-YY':
      datePart = `${day}-${month}-${shortYear}`;
      break;
    case 'YYYY-MM-DD':
    default:
      datePart = `${fullYear}-${month}-${day}`;
      break;
  }

  const h24 = date.getHours();
  const min = String(date.getMinutes()).padStart(2, '0');
  const sec = String(date.getSeconds()).padStart(2, '0');

  let timePart: string;
  if (clockFormat === '12h') {
    const suffix = h24 >= 12 ? 'pm' : 'am';
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    timePart = `${String(h12).padStart(2, '0')}.${min}.${sec}${suffix}`;
  } else {
    timePart = `${String(h24).padStart(2, '0')}.${min}.${sec}`;
  }

  return `${datePart}_${timePart}`;
}

/**
 * Validates an OCI image tag according to the OCI Distribution Specification / ghcr.io rules:
 * `[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}`.
 */
export function validateOciTag(rawTag: string): {
  valid: boolean;
  tag: string;
  error?: string;
} {
  const trimmed = rawTag.trim();
  if (!trimmed) {
    return {
      valid: false,
      tag: '',
      error: 'Please enter a tag for the image.',
    };
  }
  if (trimmed.length > 128) {
    return {
      valid: false,
      tag: trimmed,
      error: 'Tag must be 128 characters or fewer.',
    };
  }
  if (trimmed.startsWith('.') || trimmed.startsWith('-')) {
    return {
      valid: false,
      tag: trimmed,
      error: 'Tag cannot start with "." or "-".',
    };
  }
  if (!OCI_TAG_REGEX.test(trimmed)) {
    return {
      valid: false,
      tag: trimmed,
      error:
        'Tag may only contain letters, numbers, "_", ".", and "-" (no spaces, ":", or "/").',
    };
  }
  return { valid: true, tag: trimmed };
}

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

export const REPO_INDEX_PACKAGE_PREFIX = 'ghcr-manager-index_';
export const REPO_INDEX_MODE = 'repo-index';
export const REPO_INDEX_KEEP_VERSIONS = 5;

export function getRepoIndexPackageName(repoName: string): string {
  const slug = toOciImageName(repoName) || 'repo';
  const raw = `${REPO_INDEX_PACKAGE_PREFIX}${slug}`.slice(0, 128).replace(/[._-]+$/, '');
  return raw || `${REPO_INDEX_PACKAGE_PREFIX}repo`;
}

export function getRepoIndexDisplayTitle(repoName: string): string {
  return `GHCR Manager Index - ${repoName}`;
}

export function isRepoIndexPackageName(pkgName: string): boolean {
  return pkgName.toLowerCase().startsWith(REPO_INDEX_PACKAGE_PREFIX);
}
