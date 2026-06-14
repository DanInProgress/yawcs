#!/usr/bin/env node
import { Command } from 'commander';
import { readdirSync, statSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { validate } from './lib/validate.js';
import { pack } from './lib/pack.js';
import { upload, fetchSkills, fetchAndCacheRemoteSkill, listSkills } from './lib/api.js';
import { unpack } from './lib/unpack.js';
import { setVerbose } from './lib/log.js';
import { hashSkillDir, hashZipBuffer } from './lib/hash.js';
import { ensureCache, readCachedSkill, storeRemote } from './lib/cache.js';

const program = new Command();

program
  .name('yawcs')
  .description('Manage claude.ai skills')
  .version('0.1.0')
  .option('--no-verbose', 'suppress verbose API logging')
  .hook('preAction', (thisCommand) => {
    setVerbose(thisCommand.opts().verbose);
  });

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------
program
  .command('validate [skill-dir]')
  .description('Validate skill(s) locally. No network. Defaults to all skills/ subdirectories.')
  .action(async (skillDir) => {
    const targets = resolveTargets(skillDir);
    let hasErrors = false;
    for (const dir of targets) {
      const result = validate(dir);
      printResult(dir, result);
      if (result.errors.length > 0) hasErrors = true;
    }
    if (hasErrors) process.exit(1);
  });

// ---------------------------------------------------------------------------
// pack
// ---------------------------------------------------------------------------
program
  .command('pack [skill-dir]')
  .description('Validate + create dist/{name}.skill archive. Defaults to all skills/ subdirectories.')
  .action(async (skillDir) => {
    const targets = resolveTargets(skillDir);
    let hasErrors = false;
    for (const dir of targets) {
      const result = validate(dir);
      printResult(dir, result);
      if (result.errors.length > 0) {
        hasErrors = true;
        continue;
      }
      const outPath = pack(dir);
      console.log(`  packed → ${outPath}`);
    }
    if (hasErrors) process.exit(1);
  });

// ---------------------------------------------------------------------------
// upload
// ---------------------------------------------------------------------------
program
  .command('upload [skill-dir]')
  .description(
    'Validate + pack + upload skill(s) to claude.ai (always overwrites). ' +
      'Defaults to all skills/ subdirectories.'
  )
  .option('--dry-run', 'validate and pack but skip the actual upload', false)
  .action(async (skillDir, options) => {
    const targets = resolveTargets(skillDir);

    // Fetch remote skills once for comparison (also validates auth).
    let remoteMap = new Map();
    try {
      const remoteSkills = await fetchSkills();
      remoteMap = new Map(remoteSkills.map((s) => [s.name, s]));
    } catch (err) {
      console.error(`  error fetching remote skills: ${err.message}`);
      process.exit(1);
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

      const outPath = pack(dir);
      const sizeKb = (statSync(outPath).size / 1024).toFixed(1);

      // Determine action by comparing local content hash to remote
      const name = basename(dir);
      const remote = remoteMap.get(name);
      let action;

      if (!remote) {
        action = 'new';
      } else {
        const localHash = hashZipBuffer(readFileSync(outPath));
        const { contentHash: remoteHash } = await fetchAndCacheRemoteSkill(
          remote.id, remote.name, remote.updated_at
        );
        action = localHash === remoteHash ? 'skip' : 'update';
      }

      if (options.dryRun) {
        if (action === 'skip') {
          console.log(`  [dry-run] ${name} (${sizeKb} KB) → SKIP (up to date)`);
        } else {
          const tag = action === 'new' ? 'NEW' : 'UPDATE';
          console.log(`  [dry-run] ${name} (${sizeKb} KB) → ${tag}`);
        }
        unlinkSync(outPath);
      } else if (action === 'skip') {
        console.log(`  skipped ${name} (up to date)`);
        unlinkSync(outPath);
      } else {
        await upload(outPath);
        const tag = action === 'new' ? 'NEW' : 'UPDATE';
        console.log(`  uploaded ${name} ✓ [${tag}]`);
        // Re-fetch to get the new updated_at, then cache the uploaded artifact
        const refreshed = await fetchSkills();
        const uploaded = refreshed.find((s) => s.name === name);
        if (uploaded) {
          const buf = readFileSync(outPath);
          storeRemote(name, uploaded.updated_at, buf);
        }
      }
    }
    if (hasErrors) process.exit(1);
  });

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------
program
  .command('list')
  .description('List skills currently installed on claude.ai.')
  .option('--include-wiggle', 'include Anthropic built-in skills', false)
  .action(async (options) => {
    await listSkills({ includeWiggleSkills: options.includeWiggle });
  });

// ---------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------
program
  .command('download [skill-name]')
  .description(
    'Download user skills from claude.ai and unpack to skills/. ' +
      'Defaults to all user-created skills. Skips existing local dirs unless --overwrite.'
  )
  .option('--overwrite', 'overwrite existing local skill directories', false)
  .option('--include-wiggle', 'include Anthropic built-in skills', false)
  .action(async (skillName, options) => {
    // Fetch the full list to get IDs and filter
    let allSkills;
    try {
      allSkills = await fetchSkills({ includeWiggleSkills: options.includeWiggle });
    } catch (err) {
      console.error(`  error fetching skills: ${err.message}`);
      process.exit(1);
    }

    const candidates = skillName
      ? allSkills.filter((s) => s.name === skillName)
      : allSkills;

    if (candidates.length === 0) {
      if (skillName) {
        console.error(`skill not found: "${skillName}"`);
      } else {
        console.log('No user-created skills found on claude.ai.');
      }
      process.exit(1);
    }

    ensureCache();
    for (const s of candidates) {
      console.log(`\n[${s.name}]`);
      let remoteHash;
      try {
        const result = await fetchAndCacheRemoteSkill(s.id, s.name, s.updated_at);
        remoteHash = result.contentHash;
      } catch (err) {
        console.error(`  error fetching "${s.name}": ${err.message}`);
        continue;
      }

      const localDir = join('skills', s.name);
      if (existsSync(localDir)) {
        const localHash = hashSkillDir(localDir);
        if (localHash === remoteHash) {
          console.log(`  skipped (local matches remote)`);
          continue;
        }
        if (!options.overwrite) {
          console.log(`  skipped (differs from remote — use --overwrite to replace)`);
          continue;
        }
      }

      const buf = readCachedSkill(remoteHash);
      const result = unpack(buf, s.name, { overwrite: options.overwrite });
      console.log(result === 'overwritten' ? `  downloaded ✓ (overwritten)` : `  downloaded ✓`);
    }
  });


program.parseAsync().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * If a specific skill directory is given, return it as a single-element array.
 * Otherwise, return all subdirectories of skills/.
 */
function resolveTargets(skillDir) {
  if (skillDir) return [skillDir];
  const skillsRoot = 'skills';
  let entries;
  try {
    entries = readdirSync(skillsRoot);
  } catch {
    console.error(`Error: cannot read skills directory "${skillsRoot}". Run from the repo root.`);
    process.exit(1);
  }
  const targets = entries
    .map((name) => join(skillsRoot, name))
    .filter((p) => statSync(p).isDirectory());
  if (targets.length === 0) {
    console.error(`No skill directories found in "${skillsRoot}".`);
    process.exit(1);
  }
  return targets;
}

/**
 * Print validate() results to stdout/stderr with a dir header.
 */
function printResult(dir, result) {
  console.log(`\n[${dir}]`);
  for (const e of result.errors) console.error(`  ERROR: ${e}`);
  for (const w of result.warnings) console.warn(`  WARN:  ${w}`);
  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.log('  OK');
  }
}
