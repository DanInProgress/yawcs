import AdmZip from 'adm-zip';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Extract a .skill ZIP buffer into the skills/ directory.
 *
 * @param {Buffer} buffer - raw ZIP bytes from downloadSkillFile()
 * @param {string} skillName - skill name (used to check for existing dir)
 * @param {{ overwrite?: boolean }} options
 * @returns {'written' | 'overwritten' | 'skipped'}
 */
export function unpack(buffer, skillName, { overwrite = false, outDir = 'skills' } = {}) {
  const dir = join(outDir, skillName);

  if (existsSync(dir) && !overwrite) return 'skipped';

  const wasExisting = existsSync(dir);
  const zip = new AdmZip(buffer);
  // extractAllTo(outDir, overwrite) places skill-name/SKILL.md → outDir/skill-name/SKILL.md
  zip.extractAllTo(outDir, overwrite);

  return wasExisting ? 'overwritten' : 'written';
}
