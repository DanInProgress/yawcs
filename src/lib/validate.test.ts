import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { validate } from "./validate.ts";

/**
 * Build a temporary skill directory with the given SKILL.md content.
 * The directory base name defaults to a valid skill name.
 */
async function makeSkill(
  skillMd: string,
  dirName = "my-skill",
): Promise<string> {
  const tmp = await Deno.makeTempDir();
  const skillDir = join(tmp, dirName);
  await Deno.mkdir(skillDir);
  await Deno.writeTextFile(join(skillDir, "SKILL.md"), skillMd);
  return skillDir;
}

/** Remove the temp directory created for a skill dir (its parent). */
async function cleanup(skillDir: string): Promise<void> {
  await Deno.remove(join(skillDir, ".."), { recursive: true });
}

Deno.test("valid front-matter produces no errors", async () => {
  const skillDir = await makeSkill(
    `---
name: my-skill
description: A perfectly valid skill description.
---
# My Skill

Some body content.
`,
  );
  try {
    const { errors, warnings } = validate(skillDir);
    assertEquals(errors, []);
    assertEquals(warnings, []);
  } finally {
    await cleanup(skillDir);
  }
});

Deno.test("malformed YAML front-matter yields an error, not a throw", async () => {
  // Invalid YAML inside a well-delimited front-matter block.
  const skillDir = await makeSkill(
    `---
name: my-skill
description: "unterminated
  : : nonsense
---
body
`,
  );
  try {
    const { errors } = validate(skillDir);
    assertEquals(errors.length >= 1, true);
    assertStringIncludes(errors[0], "frontmatter parse error");
  } finally {
    await cleanup(skillDir);
  }
});

Deno.test("no front-matter delimiters yields a no-front-matter error", async () => {
  const skillDir = await makeSkill(
    `# My Skill

This file has no YAML front-matter block at all.
`,
  );
  try {
    const { errors } = validate(skillDir);
    assertEquals(errors, ["SKILL.md has no YAML front-matter block."]);
  } finally {
    await cleanup(skillDir);
  }
});

Deno.test("empty front-matter yields errors for required fields", async () => {
  const skillDir = await makeSkill(
    `---
---
body
`,
  );
  try {
    const { errors } = validate(skillDir);
    assertStringIncludes(
      errors.join("\n"),
      "Missing required frontmatter field: name",
    );
    assertStringIncludes(
      errors.join("\n"),
      "Missing required frontmatter field: description",
    );
  } finally {
    await cleanup(skillDir);
  }
});
