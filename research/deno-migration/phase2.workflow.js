export const meta = {
  name: "yawcs-deno-phase2",
  description:
    "Phase 2 of the yawcs Deno migration: port the core I/O modules (hash, cache, api, pack, unpack) and the CLI, coordinating the Buffer->Uint8Array change as one atomic unit, then gate on a hash-parity test and a full deno fmt/lint/check/test sweep.",
  phases: [
    { title: "Port core I/O", detail: "A1 opus: hash+cache+api (atomic Buffer->Uint8Array). A2 sonnet: pack+unpack." },
    { title: "Wire CLI", detail: "B1 opus: cli.ts + mod.ts (commander->parseArgs). B2 sonnet: hash-parity test." },
    { title: "Verify", detail: "C1: deno fmt --check, lint, check mod.ts, test — report green/red." },
  ],
};

// ---------------------------------------------------------------------------
// Shared context injected into every agent. These are the coordination facts
// the dependency analysis surfaced — every agent operates against the same
// import map, the same already-ported signatures, and the same conventions.
// ---------------------------------------------------------------------------
const SHARED = `
You are porting part of the \`yawcs\` CLI from Node ESM (.js) to Deno-native TypeScript (.ts).
Repo root: /Users/dfallon/code/personal/yawcs   Branch: deno-migration
The authoritative spec is research/deno-migration/MIGRATION-PLAN.md — read the Phase 2 section
(lines ~224-392) for the exact per-file change list. The findings in
research/deno-migration/findings/ have file:line references.

SHARED RULES (apply to every file you touch):
- deno.json already maps these names — import by bare name, never with jsr:/npm: prefixes in source:
    @std/path, @std/fs, @std/fmt, @std/crypto, @std/assert, @std/front-matter, @std/dotenv, @std/cli, adm-zip
  e.g. import { join, basename } from "@std/path";  import AdmZip from "adm-zip";
- INTERNAL imports between our modules use the ".ts" extension now (import { x } from "./hash.ts").
- When you finish porting FOO.js -> FOO.ts, DELETE the old FOO.js with \`git rm\` (Phase 1 did the same;
  leaving dead .js files would break \`deno lint\`/\`deno fmt --check\` over the repo).
- Add real TypeScript type annotations to every exported function signature. Keep the existing JSDoc,
  updating @param/@returns types to match.
- createHash stays the SYNCHRONOUS node:crypto bridge — \`import { createHash } from "node:crypto";\`.
  Do NOT switch to async @std/crypto (that is deferred to Phase 4).
- Buffer -> Uint8Array EVERYWHERE binary data flows. node:crypto and adm-zip both accept Uint8Array.
- PRESERVE BEHAVIOR. yawcs is not widely deployed, so if you discover an unavoidable behavior or
  format breakage, REPORT it in your "breakages" field rather than blocking — do not invent
  workarounds that change semantics.
- fmt config: 2-space indent, lineWidth 100, no tabs. Run \`deno fmt <yourfiles>\` before returning.
- Already-ported modules you may import and rely on (do NOT modify them):
    ./auth.ts     -> export function getBaseHeaders(): Record<string, string>
    ./log.ts      -> setVerbose(value: boolean): void;
                     logRequest(method, url, headers, bodyDesc?): void;
                     logResponse(status: number, headers: Headers, rawBody: string | null): void
    ./validate.ts -> export interface ValidationResult; export function validate(skillDir): ValidationResult
- Before returning, run \`deno check\` on each file you created and capture the result.
`;

// Reusable structured-report schema so the orchestrator can aggregate verdicts.
const REPORT = {
  type: "object",
  additionalProperties: false,
  required: ["files", "checkPassed", "summary", "breakages"],
  properties: {
    files: {
      type: "array",
      items: { type: "string" },
      description: "Paths created, modified, or deleted (use 'deleted: path' for removals).",
    },
    checkPassed: {
      type: "boolean",
      description: "Did `deno check` pass on every .ts file you authored?",
    },
    summary: { type: "string", description: "2-5 sentences on what changed and any deviations from the plan, with rationale." },
    breakages: {
      type: "string",
      description: "Any behavior/format breakage or parity concern discovered, or 'none'.",
    },
  },
};

// ===========================================================================
// STAGE A — port core I/O. A1 (atomic triangle) and A2 (leaves) run in
// parallel: disjoint files, no import edge between them.
// ===========================================================================
phase("Port core I/O");

const stageA = await parallel([
  // ---- A1 (opus): the Buffer->Uint8Array atomic triangle ----
  () =>
    agent(
      `${SHARED}

YOUR TASK (atomic unit — port all THREE files together so the Buffer->Uint8Array type
contract stays consistent and \`deno check\` is green across them):

1) src/lib/hash.js -> src/lib/hash.ts  (MIGRATION-PLAN 2.1)
   - createHash from "node:crypto" (sync bridge).
   - readdirSync/statSync(...).isDirectory()/readFileSync (in walkDir + hashSkillDir):
       use [...Deno.readDirSync(dir)] entries (each has .name and .isDirectory PROPERTY, no ()),
       and Deno.readFileSync(abs) -> Uint8Array. This eliminates the per-entry statSync call.
   - join, relative from "@std/path".
   - import AdmZip from "adm-zip".
   - canonicalHash's files param: { path: string; data: Uint8Array }[]; hashZipBuffer(buf: Uint8Array).
   - CRITICAL: hash output must stay byte-identical. The sort in canonicalHash and the
     walkDir ordering determine the hash — keep walkDir's traversal producing the same set of
     relative paths, and keep \`files.sort()\` exactly as-is. If Deno.readDirSync ordering could
     differ, that's fine: the explicit .sort() makes it deterministic regardless. Do not change
     the algorithm.

2) src/lib/cache.js -> src/lib/cache.ts  (MIGRATION-PLAN 2.2, flat-JSON phase — do NOT do SQLite)
   - import { hashZipBuffer } from "./hash.ts".
   - existsSync from "@std/fs"; mkdirSync/readTextFileSync/writeTextFileSync/writeFileSync/renameSync
     via Deno.* (Deno.readTextFileSync for the JSON index, Deno.readFileSync for binary .skill reads).
   - join from "@std/path".
   - storeRemote(skillName: string, updatedAt: string, buf: Uint8Array): string.
   - readCachedSkill(contentHash: string): Uint8Array | null.
   - Keep the atomic tmp-file + renameSync index write and the content-addressed dedup exactly.
   - The existing cache/index.json JSON shape MUST stay readable (same structure).

3) src/lib/api.js -> src/lib/api.ts  (MIGRATION-PLAN 2.3)
   - Delete readFileSync import; in upload(), read via \`const buffer = await Deno.readFile(skillPath)\`
     (Uint8Array) — make sure upload stays async (it already is).
   - basename from "@std/path".
   - imports: { getBaseHeaders } from "./auth.ts"; { logRequest, logResponse } from "./log.ts";
     { isRemoteCached, storeRemote, getEntry, ensureCache } from "./cache.ts".
   - downloadSkillFile: \`const buf = new Uint8Array(await res.arrayBuffer());\` (was Buffer.from).
     Return type Promise<Uint8Array>. storeRemote now accepts Uint8Array — consistent.
   - fetch / FormData / Blob / Date are global in Deno — no change. \`delete headers["content-type"]\`
     stays. The module-level \`ensureCache()\` call at top stays.
   - Type all exported function signatures (upload, fetchSkills, fetchAndCacheRemoteSkill, listSkills).

After porting: git rm the three old .js files. Run \`deno check src/lib/hash.ts src/lib/cache.ts
src/lib/api.ts\` and \`deno fmt\` on them. Report via the schema. Note: a dangling import of these
from src/cli.js (still Node) is EXPECTED at this stage — do not touch cli.js.`,
      { label: "A1 hash+cache+api (opus)", phase: "Port core I/O", model: "opus", schema: REPORT },
    ),

  // ---- A2 (sonnet): independent leaf modules ----
  () =>
    agent(
      `${SHARED}

YOUR TASK — port two INDEPENDENT leaf modules (no internal imports):

1) src/lib/pack.js -> src/lib/pack.ts  (MIGRATION-PLAN 2.4)
   - import AdmZip from "adm-zip".
   - resolve, basename, join from "@std/path" (note: source aliases resolve as resolvePath — keep a
     local alias or rename usage, your choice, but keep behavior identical).
   - Replace mkdirSync(DIST_DIR,{recursive:true}) with \`await Deno.mkdir(DIST_DIR,{recursive:true})\`
     wrapped to ignore Deno.errors.AlreadyExists, and make \`pack\` an \`async function\` returning
     Promise<string>. (build.ts has the exact ignore-AlreadyExists pattern if you want to mirror it.)
   - adm-zip's addLocalFolder/writeZip stay synchronous — keep them. Only the mkdir becomes async.

2) src/lib/unpack.js -> src/lib/unpack.ts  (MIGRATION-PLAN 2.5)
   - import AdmZip from "adm-zip".
   - existsSync from "@std/fs"; join from "@std/path".
   - buffer param type: Uint8Array (was Buffer). adm-zip accepts it.
   - KEEP unpack SYNCHRONOUS: it has no async filesystem calls (adm-zip extractAllTo is sync,
     existsSync is sync). The plan mentions "async for consistency" but there is no async op here,
     so a gratuitous async would force an needless await in cli — keep it sync and note this
     deviation + rationale in your summary. Return type stays 'written' | 'overwritten' | 'skipped'.
   - Do NOT add a SIGINT handler here; cleanup is centralized in cli.ts (Phase 2.6).

After porting: git rm the two old .js files. Run \`deno check src/lib/pack.ts src/lib/unpack.ts\`
and \`deno fmt\` on them. Report via the schema.`,
      { label: "A2 pack+unpack (sonnet)", phase: "Port core I/O", model: "sonnet", schema: REPORT },
    ),
]);

log(
  `Stage A complete. A1 check=${stageA[0]?.checkPassed} A2 check=${stageA[1]?.checkPassed}. ` +
    `Breakages: A1="${stageA[0]?.breakages}" A2="${stageA[1]?.breakages}"`,
);

// ===========================================================================
// STAGE B — wire the CLI and write the parity test. Both gated behind A's
// barrier: B1 imports every ported lib module; B2 imports hash.ts.
// ===========================================================================
phase("Wire CLI");

const stageB = await parallel([
  // ---- B1 (opus): cli.ts + mod.ts ----
  () =>
    agent(
      `${SHARED}

Stage A is DONE — these now exist as typed Deno modules with .ts extensions:
src/lib/{hash,cache,api,pack,unpack,validate,log,auth}.ts
Note: pack() is now \`async\` (returns Promise<string>) — you MUST await it. unpack() stayed sync.
cache.readCachedSkill() and api.downloadSkillFile() now return Uint8Array.

YOUR TASK — port the CLI and wire the entry point (MIGRATION-PLAN 2.6, findings cli-and-args):

1) src/cli.js -> src/cli.ts
   - Shebang: #!/usr/bin/env -S deno run --allow-read --allow-write --allow-net=claude.ai --allow-env=CLAUDE_SESSION_KEY,CF_CLEARANCE,CF_BM,USER_AGENT
   - Replace commander entirely with parseArgs from "@std/cli/parse-args":
       parseArgs(Deno.args, {
         boolean: ["verbose","dry-run","overwrite","include-wiggle","help","version"],
         string: ["output"],
         negatable: ["verbose"],
         alias: { h: "help", V: "version" },
         default: { verbose: true },
         stopEarly: true,   // first non-flag is the subcommand
       })
     stopEarly:true means args._ = [subcommand, ...positionals]. Dispatch on args._[0].
   - Build a Record<string,(positionals,args)=>Promise<void>> dispatch for the 5 commands:
       validate, pack, upload, list, download — preserving EACH command's current behavior exactly
       (read src/cli.js for the precise logic, dry-run handling, hash comparison, cache writes, etc.).
   - Write a showHelp() that reproduces commander's help output (top-level + the per-command options:
       --no-verbose, upload --dry-run, list --include-wiggle, download --overwrite/--include-wiggle).
       --help / -h prints it and exits 0; --version / -V prints "0.1.0"; unknown/no subcommand prints
       help to stderr and exits 1.
   - Call setVerbose(args.verbose) once at startup before any command runs (replaces the preAction hook).
   - Node API swaps: process.exit(n)->Deno.exit(n); statSync(p).size->Deno.statSync(p).size;
     readFileSync(outPath)->Deno.readFileSync(outPath) (Uint8Array, flows into hashZipBuffer/storeRemote);
     unlinkSync(p)->Deno.removeSync(p); existsSync from "@std/fs";
     resolveTargets(): replace readdirSync+statSync(...).isDirectory() with
       [...Deno.readDirSync("skills")] filtering on entry.isDirectory (property), mapping join("skills",name).
   - join, basename from "@std/path". await pack(dir) everywhere it is called.
   - SIGINT handler (centralized — currently absent in Node version): track activePackPath (the path
     pack is about to write) and the active unpack dir + whether it pre-existed; on SIGINT remove the
     partial .skill file and (only if it did not pre-exist) the unpack dir recursively, print
     "\\nInterrupted." and Deno.exit(130). Use Deno.addSignalListener("SIGINT", ...).
     Set/clear the tracking vars around the pack and unpack calls in the upload/download handlers.
   - Entry: export an \`async function main()\`; end with
       if (import.meta.main) { await main().catch((err) => { console.error(err.message); Deno.exit(1); }); }

2) mod.ts — replace the \`export {}\` placeholder so the compiled binary runs the CLI:
   import { main } from "./src/cli.ts";  (keep the same scoped-permission shebang already in mod.ts)
   if (import.meta.main) { await main().catch((err) => { console.error(err?.message ?? err); Deno.exit(1); }); }
   Re-export main if useful. The goal: \`deno run mod.ts <args>\` and \`deno run src/cli.ts <args>\` both work.

After porting: git rm src/cli.js. Run \`deno check src/cli.ts mod.ts\` and \`deno check mod.ts\`
(whole-graph type check) and \`deno fmt src/cli.ts mod.ts\`. Smoke-test \`deno run mod.ts --help\` and
\`deno run mod.ts --version\`. Report via the schema; put any --help wording you could not match
exactly in breakages.`,
      { label: "B1 cli.ts + mod.ts (opus)", phase: "Wire CLI", model: "opus", schema: REPORT },
    ),

  // ---- B2 (sonnet): hash-parity golden-vector test ----
  () =>
    agent(
      `${SHARED}

Stage A is DONE: src/lib/hash.ts exports hashSkillDir(dir: string): string and
hashZipBuffer(buf: Uint8Array): string (SHA-256 hex, sync, node:crypto bridge).

YOUR TASK — write a hash-parity / golden-vector test that locks the hash output so any future
change (especially the Phase 4 async-crypto swap) that alters the hex string fails CI.
(MIGRATION-PLAN Risk 2, section 5.)

1) Create a small deterministic fixture under test/fixtures/sample-skill/ with at least:
   - SKILL.md containing a minimal valid front-matter block + body
   - one nested file, e.g. scripts/hello.txt
   Keep contents fixed and committed so the hash is reproducible.

2) Create test/hash-parity.test.ts using Deno.test + @std/assert:
   - Compute hashSkillDir("test/fixtures/sample-skill") and assert it equals a PINNED hex constant.
   - Pack that fixture into a Uint8Array in-memory with adm-zip (mirror pack.ts: addLocalFolder with
     the dir's basename as prefix, then \`zip.toBuffer()\`), compute hashZipBuffer on it, and assert
     hashSkillDir === hashZipBuffer (the two must agree by design) AND equals the same pinned constant.

3) Establishing the PINNED value (ground truth):
   - FIRST try to capture Node ground truth: check if node + node_modules/adm-zip are available
     (\`ls node_modules/adm-zip\` ; \`node -v\`). If yes, run the LEGACY algorithm against the fixture
     via a throwaway node script replicating src/lib/hash.js's algorithm (or temporarily \`node\` the
     old file from git history) and use that hex as the pinned constant — this proves Deno parity
     with Node. Document in a comment that the value came from the Node reference.
   - If node/adm-zip are NOT available, pin the value produced by the Deno hash.ts instead and add a
     comment: "// Golden vector pinned from Deno hash.ts (Node reference unavailable at port time).
     Content-addressed hashing only requires a stable algorithm; this locks regressions." This is
     acceptable per the migration plan (yawcs not widely deployed; report-don't-block).
   - Report in "breakages" which path you took (Node-verified vs Deno-pinned).

Run \`deno test --allow-read test/hash-parity.test.ts\` and confirm it passes. Run \`deno fmt\` on the
test file. Report via the schema.`,
      { label: "B2 hash-parity test (sonnet)", phase: "Wire CLI", model: "sonnet", schema: REPORT },
    ),
]);

log(
  `Stage B complete. B1 cli check=${stageB[0]?.checkPassed} B2 parity check=${stageB[1]?.checkPassed}. ` +
    `B2 ground-truth: "${stageB[1]?.breakages}"`,
);

// ===========================================================================
// STAGE C — full verification gate. Needs the whole tree. Reports green/red
// with raw output; does NOT commit (the orchestrator reviews + commits).
// ===========================================================================
phase("Verify");

const verify = await agent(
  `${SHARED}

All Phase 2 ports are landed. Run the FULL Deno verification sweep from the repo root and report the
raw outcome of each. Do NOT commit. Do NOT modify source logic. You MAY run \`deno fmt\` (no --check)
once to auto-fix formatting, but if it changes anything, say which files in your summary.

Run, in order, capturing pass/fail and the tail of any failure output:
  1. deno fmt --check
  2. deno lint
  3. deno check mod.ts        (whole import graph)
  4. deno test --allow-read --allow-write
Also confirm there are no remaining Node leftovers among the ported set:
  5. ls src/lib/*.js src/cli.js 2>/dev/null   (should be empty — all should be .ts now)

In "summary" give a one-line PASS/FAIL for each of the 5 checks. In "breakages" put the failure
details (file:line + message tails) for anything red, or 'none' if all green. Set checkPassed=true
only if checks 1-4 all pass and check 5 finds no leftover .js.`,
  { label: "C1 full verification (sonnet)", phase: "Verify", model: "sonnet", schema: REPORT },
);

return {
  stageA: stageA,
  stageB: stageB,
  verify: verify,
};
