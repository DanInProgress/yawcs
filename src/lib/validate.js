import { readdirSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import matter from 'gray-matter';

// No consecutive, leading, or trailing hyphens; lowercase letters, numbers, hyphens only.
// Regex: one or more [a-z0-9] groups separated by single hyphens.
const DIR_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RESERVED_WORDS = ['claude', 'anthropic'];

/**
 * Validate a skill directory against the rules required for claude.ai upload.
 *
 * @param {string} skillDir - path to the skill directory
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validate(skillDir) {
  const errors = [];
  const warnings = [];
  const dirName = basename(skillDir);

  // Rule 1: Directory name format
  if (!DIR_NAME_RE.test(dirName)) {
    errors.push(
      `Directory name "${dirName}" must use only lowercase letters, numbers, and hyphens ` +
        `with no consecutive, leading, or trailing hyphens.`
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

  // Rule 2: SKILL.md exists — use readdirSync for case-sensitive check on macOS
  let entries;
  try {
    entries = readdirSync(skillDir);
  } catch {
    errors.push(`Cannot read directory "${skillDir}".`);
    return { errors, warnings };
  }

  if (!entries.includes('SKILL.md')) {
    const wrongCase = entries.find((e) => e.toLowerCase() === 'skill.md');
    if (wrongCase) {
      errors.push(
        `Found "${wrongCase}" — the file must be named "SKILL.md" (exact case).`
      );
    } else {
      errors.push(`Missing SKILL.md in "${skillDir}".`);
    }
    // Can't validate frontmatter without the file
    return { errors, warnings };
  }

  // Parse frontmatter
  const skillMdPath = join(skillDir, 'SKILL.md');
  const raw = readFileSync(skillMdPath, 'utf8');
  let parsed;
  try {
    parsed = matter(raw);
  } catch (e) {
    errors.push(`SKILL.md frontmatter parse error: ${e.message}`);
    return { errors, warnings };
  }

  const fm = parsed.data;
  const body = parsed.content;

  // Rule 3: name field present and matches directory name
  if (!fm.name) {
    errors.push(`Missing required frontmatter field: name`);
  } else if (fm.name !== dirName) {
    errors.push(
      `Frontmatter name "${fm.name}" does not match directory name "${dirName}". ` +
        `They must be identical.`
    );
  }

  // Rule 4: description field present and within length limits
  if (!fm.description) {
    errors.push(`Missing required frontmatter field: description`);
  } else if (typeof fm.description !== 'string') {
    errors.push(`Frontmatter description must be a string.`);
  } else {
    if (fm.description.length > 1024) {
      errors.push(
        `description exceeds 1024 character limit (${fm.description.length} chars).`
      );
    } else if (fm.description.length > 200) {
      warnings.push(
        `description is ${fm.description.length} chars; claude.ai listing UI truncates at 200 chars.`
      );
    }
  }

  // Rule 5: No < or > in any frontmatter string values (prompt injection guard)
  checkAngles(fm, '', errors);

  // Rule 6: Body line count (warn only — soft limit)
  const bodyLines = body.split('\n').length;
  if (bodyLines > 500) {
    warnings.push(
      `SKILL.md body is ${bodyLines} lines; keeping under 500 is recommended to avoid context bloat.`
    );
  }

  return { errors, warnings };
}

/**
 * Recursively check all string values in an object for < or > characters.
 */
function checkAngles(value, path, errors) {
  if (typeof value === 'string') {
    if (value.includes('<') || value.includes('>')) {
      errors.push(
        `Frontmatter field "${path}" contains forbidden characters < or > (prompt injection guard).`
      );
    }
  } else if (value !== null && typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      checkAngles(val, path ? `${path}.${key}` : key, errors);
    }
  }
}
