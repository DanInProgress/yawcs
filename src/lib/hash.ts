import { join, relative } from "@std/path";
// @ts-types="npm:@types/adm-zip@^0.5.8"
import AdmZip from "adm-zip";
import type { Buffer } from "node:buffer";

/**
 * SHA-256 of `data` as a lowercase hex string.
 *
 * Matches the output of `createHash("sha256").update(data).digest("hex")`.
 *
 * @param data
 * @returns hex SHA-256
 */
async function hexDigest(data: Uint8Array): Promise<string> {
  // crypto.subtle.digest wants a BufferSource backed by a plain ArrayBuffer;
  // Deno's file/zip byte arrays are typed Uint8Array<ArrayBufferLike>, so cast
  // at this boundary. The bytes are identical either way.
  const buf = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Recursively collect all regular file paths under a directory.
 * Returns absolute paths sorted lexicographically.
 *
 * @param dir
 * @returns absolute file paths
 */
function walkDir(dir: string): string[] {
  const results: string[] = [];
  for (const entry of [...Deno.readDirSync(dir)]) {
    const full = join(dir, entry.name);
    if (entry.isDirectory) {
      results.push(...walkDir(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

/**
 * Canonical content hash over a set of (relativePath, fileData) pairs.
 *
 * Algorithm:
 *   sort entries by path ascending
 *   outer = sha256()
 *   for each {path, data}:
 *     outer.update(path + "\0")
 *     outer.update(sha256(data).hex + "\n")
 *   return outer.hex
 *
 * Same algorithm used by both hashSkillDir and hashZipBuffer so they produce
 * identical hashes for identical content regardless of how the files are stored.
 *
 * @param files
 * @returns hex SHA-256
 */
async function canonicalHash(
  files: { path: string; data: Uint8Array }[],
): Promise<string> {
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // Web Crypto has no streaming update(); accumulate the same byte sequence the
  // streaming algorithm would feed the outer hash, then digest once. SHA-256
  // update() concatenates inputs, so this is byte-identical to the streaming
  // node:crypto version.
  const parts: string[] = [];
  for (const { path, data } of files) {
    const innerHex = await hexDigest(data);
    parts.push(path + "\0");
    parts.push(innerHex + "\n");
  }
  const outerBuf = new TextEncoder().encode(parts.join(""));
  return hexDigest(outerBuf);
}

/**
 * Compute a deterministic content hash for all files in a skill directory.
 *
 * Walks the directory with Deno.readDirSync (includes uncommitted/untracked files).
 * Paths in the hash are relative to `dir`.
 *
 * @param dir - path to skill directory (e.g. 'skills/my-skill')
 * @returns hex SHA-256
 */
export function hashSkillDir(dir: string): Promise<string> {
  const absFiles = walkDir(dir).sort();
  const files = absFiles.map((abs) => ({
    path: relative(dir, abs),
    data: Deno.readFileSync(abs),
  }));
  return canonicalHash(files);
}

/**
 * Compute a deterministic content hash for the files inside a .skill ZIP buffer.
 *
 * Strips the top-level directory prefix from ZIP entry names so that the
 * resulting paths match what hashSkillDir produces for the same content:
 *   ZIP entry "my-skill/SKILL.md" → path "SKILL.md"
 *
 * @param buf - raw .skill ZIP bytes
 * @returns hex SHA-256
 */
export function hashZipBuffer(buf: Uint8Array): Promise<string> {
  // adm-zip's bundled type declarations predate Buffer being a Uint8Array
  // subclass and only list `string | Buffer`. The constructor accepts a
  // Uint8Array at runtime, so cast at this boundary only.
  const zip = new AdmZip(buf as unknown as Buffer);
  const files: { path: string; data: Uint8Array }[] = [];
  for (const entry of zip.getEntries()) {
    // Skip directory entries
    if (entry.isDirectory) continue;
    // Strip top-level dir prefix: "my-skill/SKILL.md" → "SKILL.md"
    const parts = entry.entryName.split("/");
    const relPath = parts.slice(1).join("/");
    if (!relPath) continue; // skip entries that were just the root dir itself
    files.push({ path: relPath, data: entry.getData() });
  }
  return canonicalHash(files);
}
