// @ts-types="npm:@types/adm-zip@^0.5.8"
import AdmZip from "adm-zip";
import { existsSync } from "@std/fs";
import { join } from "@std/path";
import type { Buffer } from "node:buffer";

/**
 * Extract a .skill ZIP buffer into the skills/ directory.
 *
 * @param {Uint8Array} buffer - raw ZIP bytes from downloadSkillFile()
 * @param {string} skillName - skill name (used to check for existing dir)
 * @param {{ overwrite?: boolean, outDir?: string }} options
 * @returns {'written' | 'overwritten' | 'skipped'}
 */
export function unpack(
  buffer: Uint8Array,
  skillName: string,
  { overwrite = false, outDir = "skills" }: { overwrite?: boolean; outDir?: string } = {},
): "written" | "overwritten" | "skipped" {
  const dir = join(outDir, skillName);

  if (existsSync(dir) && !overwrite) return "skipped";

  const wasExisting = existsSync(dir);
  // adm-zip's bundled type declarations predate Buffer being a Uint8Array
  // subclass and only list `string | Buffer`. The constructor accepts a
  // Uint8Array at runtime, so cast at this boundary only.
  const zip = new AdmZip(buffer as unknown as Buffer);
  // extractAllTo(outDir, overwrite) places skill-name/SKILL.md → outDir/skill-name/SKILL.md
  zip.extractAllTo(outDir, overwrite);

  return wasExisting ? "overwritten" : "written";
}
