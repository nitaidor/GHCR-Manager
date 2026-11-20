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

function formatDatePart(date: Date, dateFormat: DateFormat, sep = '-'): string {
  const fullYear = String(date.getFullYear());
  const shortYear = fullYear.slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  switch (dateFormat) {
    case 'YY-MM-DD':
      return `${shortYear}${sep}${month}${sep}${day}`;
    case 'DD-MM-YYYY':
      return `${day}${sep}${month}${sep}${fullYear}`;
    case 'DD-MM-YY':
      return `${day}${sep}${month}${sep}${shortYear}`;
    case 'YYYY-MM-DD':
    default:
      return `${fullYear}${sep}${month}${sep}${day}`;
  }
}

/**
 * Formats a Date in local time into a valid OCI tag using the user's preferred date and clock formats.
 * Dots separate HH.MM.SS (since ':' and '/' are invalid in OCI tags), e.g. "2026-11-16_13.05.09".
 */
export function formatTimestampTag(
  date: Date,
  clockFormat: ClockFormat = '24h',
  dateFormat: DateFormat = 'YYYY-MM-DD'
): string {
  const datePart = formatDatePart(date, dateFormat, '-');
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
 * Formats a Date or ISO timestamp for human-readable UI display using the user's
 * configured DateFormat and ClockFormat settings (using '/' date separators).
 */
export function formatDisplayDateTime(
  dateInput: Date | string | number,
  clockFormat: ClockFormat = '24h',
  dateFormat: DateFormat = 'YYYY-MM-DD'
): string {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(date.getTime())) return '';

  const datePart = formatDatePart(date, dateFormat, '/');
  const h24 = date.getHours();
  const min = String(date.getMinutes()).padStart(2, '0');
  const sec = String(date.getSeconds()).padStart(2, '0');

  let timePart: string;
  if (clockFormat === '12h') {
    const suffix = h24 >= 12 ? 'PM' : 'AM';
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    timePart = `${String(h12).padStart(2, '0')}:${min}:${sec} ${suffix}`;
  } else {
    timePart = `${String(h24).padStart(2, '0')}:${min}:${sec}`;
  }

  return `${datePart}, ${timePart}`;
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
export const REPO_INDEX_LOCK_KEY = 'index';

/**
 * Generates an OCI tag for `ghcr-manager-index_<repo>` using `formatTimestampTag`,
 * appending milliseconds (or sequence number) only if `existingTags` already contains
 * that exact same-second tag.
 */
export function formatUniqueRepoIndexTag(
  date: Date,
  clockFormat: ClockFormat = '24h',
  dateFormat: DateFormat = 'YYYY-MM-DD',
  existingTags?: Iterable<string>
): string {
  const base = formatTimestampTag(date, clockFormat, dateFormat);
  const taken = new Set<string>();
  if (existingTags) {
    for (const tag of existingTags) {
      if (tag) taken.add(tag.trim());
    }
  }
  if (!taken.has(base)) {
    return base;
  }

  const ms = String(date.getMilliseconds()).padStart(3, '0');
  const withMs = `${base}.${ms}`.slice(0, 128);
  if (!taken.has(withMs)) {
    return withMs;
  }

  for (let seq = 2; seq < 1000; seq++) {
    const candidate = `${base}.${ms}-${seq}`.slice(0, 128);
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  return `${base}.${ms}-${Date.now()}`.slice(0, 128);
}

/**
 * Bijectively encodes an arbitrary string into a single Git-ref-safe path segment
 * containing only `[a-z0-9_-]` (no dots, slashes, `..`, or `.lock` suffix).
 */
export function toGitRefSafeLockSegment(rawName: string): string {
  const normalized = rawName.trim().toLowerCase() || 'default';
  const bytes = new TextEncoder().encode(normalized);
  let encoded = '';
  for (const byte of bytes) {
    const isAlphaNumOrHyphen =
      (byte >= 97 && byte <= 122) || (byte >= 48 && byte <= 57) || byte === 45;
    if (isAlphaNumOrHyphen) {
      encoded += String.fromCharCode(byte);
    } else {
      encoded += `_${byte.toString(16).padStart(2, '0')}_`;
    }
  }
  if (encoded.length <= 160) {
    return encoded;
  }
  // Keep deterministic fixed-length FNV-1a suffix if unusually long
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${encoded.slice(0, 140)}-${hash.toString(16).padStart(8, '0')}`;
}

export function getPackageLockKey(pkgName: string): string {
  return `pkg-${toGitRefSafeLockSegment(pkgName)}`;
}

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

export const MAX_DISPLAY_TAG_CHARS = 22;

export function truncateTagForDisplay(
  text: string,
  maxChars = MAX_DISPLAY_TAG_CHARS
): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

export function getVersionReferenceInfo(version: {
  name?: string;
  metadata?: {
    container?: {
      tags?: string[];
    };
  };
}): {
  tags: string[];
  primaryTag: string;
  shortTagsLabel: string;
  isUntagged: boolean;
  shortDigest: string;
  inspectRef: string;
  pullSuffix: string;
  displayPullSuffix: string;
} {
  const tags = (version.metadata?.container?.tags || []).filter(Boolean);
  const primaryTag = tags[0] || '';
  const fullTagsLabel = tags.join(', ');
  const shortTagsLabel = truncateTagForDisplay(fullTagsLabel);
  const isUntagged = tags.length === 0;
  const digest = version.name || '';
  const shortDigest = digest.startsWith('sha256:')
    ? `${digest.slice(0, 19)}…`
    : digest.length > 16
    ? `${digest.slice(0, 16)}…`
    : digest;
  const inspectRef = digest.startsWith('sha256:') ? digest : primaryTag || digest;
  const pullSuffix = primaryTag ? `:${primaryTag}` : `@${digest}`;
  const displayPullSuffix = primaryTag
    ? `:${truncateTagForDisplay(primaryTag)}`
    : `@${shortDigest}`;
  return {
    tags,
    primaryTag,
    shortTagsLabel,
    isUntagged,
    shortDigest,
    inspectRef,
    pullSuffix,
    displayPullSuffix,
  };
}
