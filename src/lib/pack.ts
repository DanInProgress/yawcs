// @ts-types="npm:@types/adm-zip@^0.5.8"
import AdmZip from "adm-zip";
import { basename, join, resolve as resolvePath } from "@std/path";

const DIST_DIR = "dist";

/**
 * Package a skill directory into a .skill archive (ZIP format).
 * The archive has the skill directory as its single root entry:
 *   my-skill/SKILL.md
 *   my-skill/scripts/helper.py
 *   ...
 *
 * @param {string} skillDir - path to the skill directory
 * @returns {Promise<string>} - path to the created .skill file
 */
export async function pack(skillDir: string): Promise<string> {
  const dirName = basename(skillDir);
  try {
    await Deno.mkdir(DIST_DIR, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
  }
  const outPath = join(DIST_DIR, `${dirName}.skill`);

  const zip = new AdmZip();
  // addLocalFolder(src, zipPrefix) adds all files under src with zipPrefix/ in the archive.
  // Using dirName produces: my-skill/SKILL.md (correct single-root structure).
  zip.addLocalFolder(resolvePath(skillDir), dirName);
  zip.writeZip(outPath);

  return outPath;
}
