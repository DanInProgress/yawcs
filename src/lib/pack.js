import AdmZip from 'adm-zip';
import { mkdirSync } from 'fs';
import { resolve as resolvePath, basename, join } from 'path';

const DIST_DIR = 'dist';

/**
 * Package a skill directory into a .skill archive (ZIP format).
 * The archive has the skill directory as its single root entry:
 *   my-skill/SKILL.md
 *   my-skill/scripts/helper.py
 *   ...
 *
 * @param {string} skillDir - path to the skill directory
 * @returns {string} - path to the created .skill file
 */
export function pack(skillDir) {
  const dirName = basename(skillDir);
  mkdirSync(DIST_DIR, { recursive: true });
  const outPath = join(DIST_DIR, `${dirName}.skill`);

  const zip = new AdmZip();
  // addLocalFolder(src, zipPrefix) adds all files under src with zipPrefix/ in the archive.
  // Using dirName produces: my-skill/SKILL.md (correct single-root structure).
  zip.addLocalFolder(resolvePath(skillDir), dirName);
  zip.writeZip(outPath);

  return outPath;
}
