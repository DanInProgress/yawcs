import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { hashZipBuffer } from './hash.js';

const CACHE_ROOT = 'cache';
const CACHE_REMOTE = join(CACHE_ROOT, 'remote');
const INDEX_PATH = join(CACHE_ROOT, 'index.json');
const INDEX_TMP = join(CACHE_ROOT, 'index.json.tmp');

/**
 * Create cache/ and cache/remote/ if they don't exist.
 * Safe to call on every CLI invocation.
 */
export function ensureCache() {
  mkdirSync(CACHE_REMOTE, { recursive: true });
}

/**
 * Read cache/index.json. Returns {} on first run or if the file is absent/malformed.
 *
 * @returns {Record<string, { updated_at: string, content_hash: string, cached_at: string }>}
 */
export function readIndex() {
  if (!existsSync(INDEX_PATH)) return {};
  try {
    return JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
  } catch {
    console.warn('  warn: cache index is malformed, treating as empty');
    return {};
  }
}

/**
 * Write the index atomically using a tmp file + rename.
 * Prevents a corrupt index if the process is killed mid-write.
 *
 * @param {Record<string, object>} index
 */
export function writeIndex(index) {
  ensureCache();
  writeFileSync(INDEX_TMP, JSON.stringify(index, null, 2));
  renameSync(INDEX_TMP, INDEX_PATH);
}

/**
 * Return the cached entry for a skill, or null if not present.
 *
 * @param {string} skillName
 * @returns {{ updated_at: string, content_hash: string, cached_at: string } | null}
 */
export function getEntry(skillName) {
  return readIndex()[skillName] ?? null;
}

/**
 * Return true if the remote version identified by updatedAt is already cached.
 * Fast path: only reads the index, no file I/O on the cached .skill file.
 *
 * @param {string} skillName
 * @param {string} updatedAt - remote updated_at ISO string
 * @returns {boolean}
 */
export function isRemoteCached(skillName, updatedAt) {
  const entry = getEntry(skillName);
  if (!entry) return false;
  if (entry.updated_at !== updatedAt) return false;
  // Verify the actual file is still on disk
  return existsSync(join(CACHE_REMOTE, `${entry.content_hash}.skill`));
}

/**
 * Store a downloaded .skill buffer in the content-addressed cache and update the index.
 *
 * Steps:
 *   1. Compute content hash of the ZIP's extracted content (deterministic)
 *   2. Write cache/remote/{contentHash}.skill if not already present
 *   3. Update index[skillName] with { updated_at, content_hash, cached_at }
 *   4. Write index atomically
 *
 * @param {string} skillName
 * @param {string} updatedAt - remote updated_at ISO string
 * @param {Buffer} buf - raw .skill ZIP bytes
 * @returns {string} contentHash
 */
export function storeRemote(skillName, updatedAt, buf) {
  const contentHash = hashZipBuffer(buf);
  const skillPath = join(CACHE_REMOTE, `${contentHash}.skill`);

  // Content-addressed: if file already exists, it's identical — skip write
  if (!existsSync(skillPath)) {
    writeFileSync(skillPath, buf);
  }

  const index = readIndex();
  index[skillName] = {
    updated_at: updatedAt,
    content_hash: contentHash,
    cached_at: new Date().toISOString(),
  };
  writeIndex(index);

  return contentHash;
}

/**
 * Return the absolute path for a cached .skill file given its content hash.
 *
 * @param {string} contentHash
 * @returns {string}
 */
export function cachePath(contentHash) {
  return join(CACHE_REMOTE, `${contentHash}.skill`);
}

/**
 * Read a cached .skill file by content hash. Returns null if not found.
 *
 * @param {string} contentHash
 * @returns {Buffer | null}
 */
export function readCachedSkill(contentHash) {
  const p = cachePath(contentHash);
  if (!existsSync(p)) return null;
  return readFileSync(p);
}
