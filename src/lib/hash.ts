import { createHash } from "node:crypto";
import { join, relative } from "@std/path";
// @ts-types="npm:@types/adm-zip@^0.5.8"
import AdmZip from "adm-zip";
import type { Buffer } from "node:buffer";

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
function canonicalHash(files: { path: string; data: Uint8Array }[]): string {
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const outer = createHash("sha256");
  for (const { path, data } of files) {
    const innerHex = createHash("sha256").update(data).digest("hex");
    outer.update(path + "\0");
    outer.update(innerHex + "\n");
  }
  return outer.digest("hex");
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
export function hashSkillDir(dir: string): string {
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
export function hashZipBuffer(buf: Uint8Array): string {
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
