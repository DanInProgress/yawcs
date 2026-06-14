import { createHash } from 'crypto';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import AdmZip from 'adm-zip';

/**
 * Recursively collect all regular file paths under a directory.
 * Returns absolute paths sorted lexicographically.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function walkDir(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
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
 * @param {{ path: string, data: Buffer }[]} files
 * @returns {string} hex SHA-256
 */
function canonicalHash(files) {
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const outer = createHash('sha256');
  for (const { path, data } of files) {
    const innerHex = createHash('sha256').update(data).digest('hex');
    outer.update(path + '\0');
    outer.update(innerHex + '\n');
  }
  return outer.digest('hex');
}

/**
 * Compute a deterministic content hash for all files in a skill directory.
 *
 * Walks the directory with readdirSync (includes uncommitted/untracked files).
 * Paths in the hash are relative to `dir`.
 *
 * @param {string} dir - path to skill directory (e.g. 'skills/my-skill')
 * @returns {string} hex SHA-256
 */
export function hashSkillDir(dir) {
  const absFiles = walkDir(dir).sort();
  const files = absFiles.map((abs) => ({
    path: relative(dir, abs),
    data: readFileSync(abs),
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
 * @param {Buffer} buf - raw .skill ZIP bytes
 * @returns {string} hex SHA-256
 */
export function hashZipBuffer(buf) {
  const zip = new AdmZip(buf);
  const files = [];
  for (const entry of zip.getEntries()) {
    // Skip directory entries
    if (entry.isDirectory) continue;
    // Strip top-level dir prefix: "my-skill/SKILL.md" → "SKILL.md"
    const parts = entry.entryName.split('/');
    const relPath = parts.slice(1).join('/');
    if (!relPath) continue; // skip entries that were just the root dir itself
    files.push({ path: relPath, data: entry.getData() });
  }
  return canonicalHash(files);
}
