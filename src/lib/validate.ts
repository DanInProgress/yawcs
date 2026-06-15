import { basename, join } from "@std/path";
import { extract } from "@std/front-matter/yaml";
import { test as hasFrontMatter } from "@std/front-matter";

// No consecutive, leading, or trailing hyphens; lowercase letters, numbers, hyphens only.
// Regex: one or more [a-z0-9] groups separated by single hyphens.
const DIR_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RESERVED_WORDS = ["claude", "anthropic"];

/** Result of validating a skill directory. */
export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

/**
 * Validate a skill directory against the rules required for claude.ai upload.
 *
 * @param skillDir path to the skill directory
 * @returns the accumulated errors and warnings
 */
export function validate(skillDir: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const dirName = basename(skillDir);

  // Rule 1: Directory name format
  if (!DIR_NAME_RE.test(dirName)) {
    errors.push(
      `Directory name "${dirName}" must use only lowercase letters, numbers, and hyphens ` +
        `with no consecutive, leading, or trailing hyphens.`,
    );
  }
  if (dirName.length > 64) {
    errors.push(`Directory name "${dirName}" exceeds 64 characters (${dirName.length}).`);
  }
  for (const word of RESERVED_WORDS) {
    if (dirName.includes(word)) {
      errors.push(`Directory name "${dirName}" contains reserved word "${word}".`);
    }
  }

  // Rule 2: SKILL.md exists — use readDirSync for case-sensitive check on macOS
  let entries: string[];
  try {
    entries = [...Deno.readDirSync(skillDir)].map((e) => e.name);
  } catch {
    errors.push(`Cannot read directory "${skillDir}".`);
    return { errors, warnings };
  }

  if (!entries.includes("SKILL.md")) {
    const wrongCase = entries.find((e) => e.toLowerCase() === "skill.md");
    if (wrongCase) {
      errors.push(
        `Found "${wrongCase}" — the file must be named "SKILL.md" (exact case).`,
      );
    } else {
      errors.push(`Missing SKILL.md in "${skillDir}".`);
    }
    // Can't validate frontmatter without the file
    return { errors, warnings };
  }

  // Parse frontmatter
  const skillMdPath = join(skillDir, "SKILL.md");
  const raw = Deno.readTextFileSync(skillMdPath);

  // @std/front-matter's extract() throws when no front-matter block is present
  // (gray-matter used to return empty data). Guard with test() first so a missing
  // block becomes a validation error rather than a thrown exception.
  if (!hasFrontMatter(raw)) {
    errors.push(`SKILL.md has no YAML front-matter block.`);
    return { errors, warnings };
  }

  // extract() also throws on malformed YAML — catch and convert to an error entry.
  let fm: Record<string, unknown>;
  let body: string;
  try {
    const parsed = extract<Record<string, unknown>>(raw);
    fm = parsed.attrs;
    body = parsed.body;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    errors.push(`SKILL.md frontmatter parse error: ${message}`);
    return { errors, warnings };
  }

  // Rule 3: name field present and matches directory name
  if (!fm.name) {
    errors.push(`Missing required frontmatter field: name`);
  } else if (fm.name !== dirName) {
    errors.push(
      `Frontmatter name "${fm.name}" does not match directory name "${dirName}". ` +
        `They must be identical.`,
    );
  }

  // Rule 4: description field present and within length limits
  if (!fm.description) {
    errors.push(`Missing required frontmatter field: description`);
  } else if (typeof fm.description !== "string") {
    errors.push(`Frontmatter description must be a string.`);
  } else {
    if (fm.description.length > 1024) {
      errors.push(
        `description exceeds 1024 character limit (${fm.description.length} chars).`,
      );
    } else if (fm.description.length > 200) {
      warnings.push(
        `description is ${fm.description.length} chars; claude.ai listing UI truncates at 200 chars.`,
      );
    }
  }

  // Rule 5: No < or > in any frontmatter string values (prompt injection guard)
  checkAngles(fm, "", errors);

  // Rule 6: Body line count (warn only — soft limit)
  const bodyLines = body.split("\n").length;
  if (bodyLines > 500) {
    warnings.push(
      `SKILL.md body is ${bodyLines} lines; keeping under 500 is recommended to avoid context bloat.`,
    );
  }

  return { errors, warnings };
}

/**
 * Recursively check all string values in an object for < or > characters.
 */
function checkAngles(value: unknown, path: string, errors: string[]): void {
  if (typeof value === "string") {
    if (value.includes("<") || value.includes(">")) {
      errors.push(
        `Frontmatter field "${path}" contains forbidden characters < or > (prompt injection guard).`,
      );
    }
  } else if (value !== null && typeof value === "object") {
    for (const [key, val] of Object.entries(value)) {
      checkAngles(val, path ? `${path}.${key}` : key, errors);
    }
  }
}
