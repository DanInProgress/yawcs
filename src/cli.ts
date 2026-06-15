#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net=claude.ai --allow-env=CLAUDE_SESSION_KEY,CF_CLEARANCE,CF_BM,USER_AGENT
import { parseArgs } from "@std/cli/parse-args";
import { existsSync } from "@std/fs";
import { basename, join } from "@std/path";
import { validate } from "./lib/validate.ts";
import type { ValidationResult } from "./lib/validate.ts";
import { pack } from "./lib/pack.ts";
import { fetchAndCacheRemoteSkill, fetchSkills, listSkills, upload } from "./lib/api.ts";
import { unpack } from "./lib/unpack.ts";
import { setVerbose } from "./lib/log.ts";
import { hashSkillDir, hashZipBuffer } from "./lib/hash.ts";
import { ensureCache, readCachedSkill, storeRemote } from "./lib/cache.ts";

type ParsedArgs = ReturnType<typeof parse>;

function parse(argv: string[]) {
  return parseArgs(argv, {
    boolean: ["verbose", "dry-run", "overwrite", "include-wiggle", "help", "version"],
    string: ["output"],
    negatable: ["verbose"],
    alias: { h: "help", V: "version" },
    default: { verbose: true },
    stopEarly: true, // first non-flag is the subcommand
  });
}

// ---------------------------------------------------------------------------
// SIGINT cleanup tracking
// ---------------------------------------------------------------------------
let activePackPath: string | null = null;
let activeUnpackDir: string | null = null;
let unpackWasExisting = false;

Deno.addSignalListener("SIGINT", () => {
  if (activePackPath) {
    try {
      Deno.removeSync(activePackPath);
    } catch { /* ignore */ }
  }
  if (activeUnpackDir && !unpackWasExisting) {
    try {
      Deno.removeSync(activeUnpackDir, { recursive: true });
    } catch { /* ignore */ }
  }
  console.error("\nInterrupted.");
  Deno.exit(130);
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------
function runValidate(positionals: string[], _args: ParsedArgs): Promise<void> {
  const targets = resolveTargets(positionals[0]);
  let hasErrors = false;
  for (const dir of targets) {
    const result = validate(dir);
    printResult(dir, result);
    if (result.errors.length > 0) hasErrors = true;
  }
  if (hasErrors) Deno.exit(1);
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// pack
// ---------------------------------------------------------------------------
async function runPack(positionals: string[], _args: ParsedArgs): Promise<void> {
  const targets = resolveTargets(positionals[0]);
  let hasErrors = false;
  for (const dir of targets) {
    const result = validate(dir);
    printResult(dir, result);
    if (result.errors.length > 0) {
      hasErrors = true;
      continue;
    }
    activePackPath = join("dist", `${basename(dir)}.skill`);
    const outPath = await pack(dir);
    activePackPath = null;
    console.log(`  packed → ${outPath}`);
  }
  if (hasErrors) Deno.exit(1);
}

// ---------------------------------------------------------------------------
// upload
// ---------------------------------------------------------------------------
async function runUpload(positionals: string[], args: ParsedArgs): Promise<void> {
  const targets = resolveTargets(positionals[0]);
  const dryRun = args["dry-run"];

  // Fetch remote skills once for comparison (also validates auth).
  let remoteMap = new Map<string, Record<string, unknown>>();
  try {
    const remoteSkills = await fetchSkills();
    remoteMap = new Map(remoteSkills.map((s) => [s.name as string, s]));
  } catch (err) {
    console.error(`  error fetching remote skills: ${(err as Error).message}`);
    Deno.exit(1);
  }

  ensureCache();
  let hasErrors = false;
  for (const dir of targets) {
    const result = validate(dir);
    printResult(dir, result);
    if (result.errors.length > 0) {
      hasErrors = true;
      continue;
    }

    activePackPath = join("dist", `${basename(dir)}.skill`);
    const outPath = await pack(dir);
    activePackPath = null;
    const sizeKb = (Deno.statSync(outPath).size / 1024).toFixed(1);

    // Determine action by comparing local content hash to remote
    const name = basename(dir);
    const remote = remoteMap.get(name);
    let action: "new" | "skip" | "update";

    if (!remote) {
      action = "new";
    } else {
      const localHash = await hashZipBuffer(Deno.readFileSync(outPath));
      const { contentHash: remoteHash } = await fetchAndCacheRemoteSkill(
        remote.id as string,
        remote.name as string,
        remote.updated_at as string,
      );
      action = localHash === remoteHash ? "skip" : "update";
    }

    if (dryRun) {
      if (action === "skip") {
        console.log(`  [dry-run] ${name} (${sizeKb} KB) → SKIP (up to date)`);
      } else {
        const tag = action === "new" ? "NEW" : "UPDATE";
        console.log(`  [dry-run] ${name} (${sizeKb} KB) → ${tag}`);
      }
      Deno.removeSync(outPath);
    } else if (action === "skip") {
      console.log(`  skipped ${name} (up to date)`);
      Deno.removeSync(outPath);
    } else {
      await upload(outPath);
      const tag = action === "new" ? "NEW" : "UPDATE";
      console.log(`  uploaded ${name} ✓ [${tag}]`);
      // Re-fetch to get the new updated_at, then cache the uploaded artifact
      const refreshed = await fetchSkills();
      const uploaded = refreshed.find((s) => s.name === name);
      if (uploaded) {
        const buf = Deno.readFileSync(outPath);
        await storeRemote(name, uploaded.updated_at as string, buf);
      }
    }
  }
  if (hasErrors) Deno.exit(1);
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------
async function runList(_positionals: string[], args: ParsedArgs): Promise<void> {
  await listSkills({ includeWiggleSkills: args["include-wiggle"] });
}

// ---------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------
async function runDownload(positionals: string[], args: ParsedArgs): Promise<void> {
  const skillName = positionals[0];
  const overwrite = args.overwrite;

  // Fetch the full list to get IDs and filter
  let allSkills: Record<string, unknown>[];
  try {
    allSkills = await fetchSkills({ includeWiggleSkills: args["include-wiggle"] });
  } catch (err) {
    console.error(`  error fetching skills: ${(err as Error).message}`);
    Deno.exit(1);
  }

  const candidates = skillName ? allSkills.filter((s) => s.name === skillName) : allSkills;

  if (candidates.length === 0) {
    if (skillName) {
      console.error(`skill not found: "${skillName}"`);
    } else {
      console.log("No user-created skills found on claude.ai.");
    }
    Deno.exit(1);
  }

  ensureCache();
  for (const s of candidates) {
    console.log(`\n[${s.name}]`);
    let remoteHash: string;
    try {
      const result = await fetchAndCacheRemoteSkill(
        s.id as string,
        s.name as string,
        s.updated_at as string,
      );
      remoteHash = result.contentHash;
    } catch (err) {
      console.error(`  error fetching "${s.name}": ${(err as Error).message}`);
      continue;
    }

    const localDir = join("skills", s.name as string);
    if (existsSync(localDir)) {
      const localHash = await hashSkillDir(localDir);
      if (localHash === remoteHash) {
        console.log(`  skipped (local matches remote)`);
        continue;
      }
      if (!overwrite) {
        console.log(`  skipped (differs from remote — use --overwrite to replace)`);
        continue;
      }
    }

    const buf = readCachedSkill(remoteHash);
    if (!buf) {
      console.error(`  error: cached skill file missing for "${s.name}"`);
      continue;
    }
    activeUnpackDir = localDir;
    unpackWasExisting = existsSync(localDir);
    const result = unpack(buf, s.name as string, { overwrite });
    activeUnpackDir = null;
    console.log(result === "overwritten" ? `  downloaded ✓ (overwritten)` : `  downloaded ✓`);
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
const COMMANDS: Record<string, (rest: string[], args: ParsedArgs) => Promise<void>> = {
  validate: runValidate,
  pack: runPack,
  upload: runUpload,
  list: runList,
  download: runDownload,
};

/**
 * Parse argv, set verbosity, and dispatch to the matching subcommand handler.
 */
export async function main(): Promise<void> {
  const args = parse(Deno.args);

  if (args.version) {
    console.log("0.1.0");
    Deno.exit(0);
  }

  if (args.help) {
    console.log(showHelp());
    Deno.exit(0);
  }

  setVerbose(args.verbose);

  const subcommand = String(args._[0] ?? "");
  const handler = COMMANDS[subcommand];
  if (!handler) {
    console.error(showHelp());
    Deno.exit(1);
  }

  const positionals = args._.slice(1).map(String);
  await handler(positionals, args);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reproduce commander's auto-generated help output.
 */
function showHelp(): string {
  return `Usage: yawcs [options] [command]

Manage claude.ai skills

Options:
  -V, --version              output the version number
  --no-verbose               suppress verbose API logging
  -h, --help                 display help for command

Commands:
  validate [skill-dir]       Validate skill(s) locally. No network. Defaults to all skills/ subdirectories.
  pack [skill-dir]           Validate + create dist/{name}.skill archive. Defaults to all skills/ subdirectories.
  upload [options] [skill-dir]  Validate + pack + upload skill(s) to claude.ai (always overwrites). Defaults to all skills/ subdirectories.
  list [options]             List skills currently installed on claude.ai.
  download [options] [skill-name]  Download user skills from claude.ai and unpack to skills/. Defaults to all user-created skills. Skips existing local dirs unless --overwrite.
  help [command]             display help for command

Command Options:
  upload --dry-run           validate and pack but skip the actual upload
  list --include-wiggle      include Anthropic built-in skills
  download --overwrite       overwrite existing local skill directories
  download --include-wiggle  include Anthropic built-in skills`;
}

/**
 * If a specific skill directory is given, return it as a single-element array.
 * Otherwise, return all subdirectories of skills/.
 */
function resolveTargets(skillDir?: string): string[] {
  if (skillDir) return [skillDir];
  const skillsRoot = "skills";
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(skillsRoot)];
  } catch {
    console.error(`Error: cannot read skills directory "${skillsRoot}". Run from the repo root.`);
    Deno.exit(1);
  }
  const targets = entries
    .filter((entry) => entry.isDirectory)
    .map((entry) => join(skillsRoot, entry.name));
  if (targets.length === 0) {
    console.error(`No skill directories found in "${skillsRoot}".`);
    Deno.exit(1);
  }
  return targets;
}

/**
 * Print validate() results to stdout/stderr with a dir header.
 */
function printResult(dir: string, result: ValidationResult): void {
  console.log(`\n[${dir}]`);
  for (const e of result.errors) console.error(`  ERROR: ${e}`);
  for (const w of result.warnings) console.warn(`  WARN:  ${w}`);
  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.log("  OK");
  }
}

if (import.meta.main) {
  await main().catch((err) => {
    console.error(err.message);
    Deno.exit(1);
  });
}
