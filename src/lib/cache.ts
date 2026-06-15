import { existsSync } from "@std/fs";
import { join } from "@std/path";
import { yellow } from "@std/fmt/colors";
import { hashZipBuffer } from "./hash.ts";

const CACHE_ROOT = "cache";
const CACHE_REMOTE = join(CACHE_ROOT, "remote");
const INDEX_PATH = join(CACHE_ROOT, "index.json");
const INDEX_TMP = join(CACHE_ROOT, "index.json.tmp");

/** A single cache index entry. */
export interface CacheEntry {
  updated_at: string;
  content_hash: string;
  cached_at: string;
}

/** The full cache index keyed by skill name. */
export type CacheIndex = Record<string, CacheEntry>;

/**
 * Create cache/ and cache/remote/ if they don't exist.
 * Safe to call on every CLI invocation.
 */
export function ensureCache(): void {
  Deno.mkdirSync(CACHE_REMOTE, { recursive: true });
}

/**
 * Read cache/index.json. Returns {} on first run or if the file is absent/malformed.
 *
 * @returns the parsed cache index
 */
export function readIndex(): CacheIndex {
  if (!existsSync(INDEX_PATH)) return {};
  try {
    return JSON.parse(Deno.readTextFileSync(INDEX_PATH));
  } catch {
    console.warn(yellow("⚠") + "  warn: cache index is malformed, treating as empty");
    return {};
  }
}

/**
 * Write the index atomically using a tmp file + rename.
 * Prevents a corrupt index if the process is killed mid-write.
 *
 * @param index
 */
export function writeIndex(index: CacheIndex): void {
  ensureCache();
  Deno.writeTextFileSync(INDEX_TMP, JSON.stringify(index, null, 2));
  Deno.renameSync(INDEX_TMP, INDEX_PATH);
}

/**
 * Return the cached entry for a skill, or null if not present.
 *
 * @param skillName
 * @returns the cache entry, or null
 */
export function getEntry(skillName: string): CacheEntry | null {
  return readIndex()[skillName] ?? null;
}

/**
 * Return true if the remote version identified by updatedAt is already cached.
 * Fast path: only reads the index, no file I/O on the cached .skill file.
 *
 * @param skillName
 * @param updatedAt - remote updated_at ISO string
 * @returns whether the remote version is cached
 */
export function isRemoteCached(skillName: string, updatedAt: string): boolean {
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
 * @param skillName
 * @param updatedAt - remote updated_at ISO string
 * @param buf - raw .skill ZIP bytes
 * @returns contentHash
 */
export async function storeRemote(
  skillName: string,
  updatedAt: string,
  buf: Uint8Array,
): Promise<string> {
  const contentHash = await hashZipBuffer(buf);
  const skillPath = join(CACHE_REMOTE, `${contentHash}.skill`);

  // Content-addressed: if file already exists, it's identical — skip write
  if (!existsSync(skillPath)) {
    Deno.writeFileSync(skillPath, buf);
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
 * @param contentHash
 * @returns the cache file path
 */
export function cachePath(contentHash: string): string {
  return join(CACHE_REMOTE, `${contentHash}.skill`);
}

/**
 * Read a cached .skill file by content hash. Returns null if not found.
 *
 * @param contentHash
 * @returns the file bytes, or null
 */
export function readCachedSkill(contentHash: string): Uint8Array | null {
  const p = cachePath(contentHash);
  if (!existsSync(p)) return null;
  return Deno.readFileSync(p);
}
