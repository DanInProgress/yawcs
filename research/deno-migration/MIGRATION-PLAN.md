# yawcs Deno Migration Plan

**Source codebase:** `src/cli.js` + `src/lib/{api,auth,cache,hash,log,pack,unpack,validate}.js` (~985 LOC, Node ESM)
**Target:** Fully Deno-native CLI — no `package.json`, no `node_modules`, no Makefile, distributable as single compiled binary.

---

## 1. Goal & End-State

### Target Architecture

| Artifact | Current | Target |
|---|---|---|
| Runtime | Node 18+ (ESM) | Deno 2.3+ |
| Entry point | `src/cli.js` (shebang: `#!/usr/bin/env node`) | `mod.ts` (shebang: `#!/usr/bin/env -S deno run ...`) |
| Dependency management | `package.json` + `node_modules` | `deno.json` import map; `jsr:` and `npm:` specifiers |
| Task runner | `Makefile` | `deno task` (tasks defined in `deno.json`) |
| Distribution | Node required on target machine | `deno compile` single-binary for linux-x64, macos-arm64, windows-x64 |
| Type checking | None (plain `.js` ESM) | Native TypeScript (`.ts`) — zero tsconfig needed |
| Formatter / linter | Not present | `deno fmt` + `deno lint` (built-in) |
| Test runner | Not present | `deno test` (built-in) |
| Dependency audit | `npm audit` | `deno audit` (Deno 2.6+) |
| API docs | None | `deno doc --html` from JSDoc/TS exports |

### Invariants That Must Not Change

1. The `.skill` ZIP format — should remain readable by claude.ai and ideally backward-compatible with existing local caches. yawcs is **not in wide deployment**, so a cache/skill-format breakage here is acceptable if unavoidable; review and **report** any such breakages rather than treating them as hard blockers (a `yawcs clean` / cache reset is a fine remedy).
2. The SHA-256 content hash algorithm and hex output format used for cache keying — any deviation invalidates all cached files.
3. The `SKILL.md` front-matter schema accepted by `validate.js` — downstream users rely on these validation rules.
4. Auth cookie/env-var names (`CLAUDE_SESSION_KEY`, `CF_CLEARANCE`, `CF_BM`, `USER_AGENT`) — changing these breaks existing `.env` files.

### What "Fully Deno-Native" Means

- Zero `require()` or CommonJS; zero `node_modules` directory.
- All imports use `jsr:`, `npm:`, or `node:` specifiers (the last only for `node:sqlite` and `node:crypto` bridging as explicitly noted).
- `package.json`, `package-lock.json`, and `Makefile` deleted.
- `deno.json` is the single project manifest.
- CI uses `denoland/setup-deno@v1`; release pipeline uses `deno compile` cross-compilation.

---

## 2. Dependency Mapping Table

### 2.1 npm Package Dependencies

| Current Dep | Version | Used In | Deno-Native Replacement | Rationale |
|---|---|---|---|---|
| `commander` | any | `cli.js:2,13–218` | `jsr:@std/cli/parse-args` + manual Record dispatch | `parseArgs` is JSR-native, zero deps, supports booleans/strings/aliases/negatable flags. Manual dispatch is ~30 lines of boilerplate. No subcommand framework needed for 5 commands. |
| `dotenv` | any | `auth.js:1-2` | Deleted; `--env-file` flag in `deno task` dev task | `deno run --env-file=.env` loads `.env` before process start with zero code. For compiled binary: use `jsr:@std/dotenv` with `load({ export: true })` at startup. |
| `gray-matter` | any | `validate.js:3,63` | `jsr:@std/front-matter/yaml` (`extract` + `test`) | JSR-native, same YAML parse semantics. API shape differs (`data`→`attrs`, `content`→`body`); `extract()` throws on missing front-matter, which improves validation strictness. |
| `adm-zip` | any | `pack.js:1`, `unpack.js:1`, `hash.js:4` | `npm:adm-zip` (bridge, permanent until `@std/archive` ZIP write is stable) | One-character specifier change; bundled into `deno compile` output as of Deno 2.3. `jsr:@std/archive` lacks `addLocalFolder`/`extractAllTo` convenience API; rewrite is a follow-up milestone, not day-one. |

### 2.2 Node Built-in APIs

| Current Node API | Used In (file:line) | Deno Replacement | Notes |
|---|---|---|---|
| `#!/usr/bin/env node` shebang | `cli.js:1` | `#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env` | `-S` splits arguments for `env`. |
| `process.exit(n)` | `cli.js:38,60,83,138,169,179,238,245`; `auth.js:16` | `Deno.exit(n)` | Identical semantics. |
| `process.env.VAR` | `auth.js:9,21,22,33` | `Deno.env.get("VAR")` | Requires `--allow-env`. |
| `fs.readdirSync(dir)` → `string[]` | `cli.js:3`, `hash.js:2`, `validate.js:1` | `[...Deno.readDirSync(dir)].map(e => e.name)` | Deno returns `Deno.DirEntry` objects; `.name` gives filename. |
| `fs.statSync(p).size` | `cli.js:97` | `Deno.statSync(p).size` | Same field name. |
| `fs.statSync(p).isDirectory()` | `cli.js:231–248` | `Deno.statSync(p).isDirectory` | Property not method — remove `()`. Prefer `Deno.readDirSync` entries which expose `.isDirectory` directly (eliminates per-entry stat call). |
| `fs.readFileSync(p)` → `Buffer` | `cli.js:107,133`; `hash.js:2` | `Deno.readFileSync(p)` → `Uint8Array` | All callers expecting `Buffer` must be migrated simultaneously. |
| `fs.readFileSync(p, 'utf8')` → `string` | `validate.js:61`; `cache.js:1` | `Deno.readTextFileSync(p)` | UTF-8 default; no encoding arg needed. |
| `fs.readFile(p)` async | `api.js:1,66-67` | `await Deno.readFile(p)` → `Uint8Array` | `Blob` constructor accepts `Uint8Array` directly; multipart upload behavior identical. |
| `fs.writeFileSync(p, data)` | `cache.js:1` | `Deno.writeFileSync(p, uint8array)` or `Deno.writeTextFileSync(p, str)` | Pick the variant matching the data type. |
| `fs.renameSync(src, dst)` | `cache.js:1` | `Deno.renameSync(src, dst)` | Identical. |
| `fs.unlinkSync(p)` | `cli.js:121,138` | `Deno.removeSync(p)` | Identical semantics. |
| `fs.existsSync(p)` | `cli.js:199`; `unpack.js:2`; `cache.js:1` | `import { existsSync } from "jsr:@std/fs"` | Drop-in; identical semantics. |
| `fs.mkdirSync(p, { recursive })` | `pack.js:2`; `cache.js:1` | `Deno.mkdirSync(p, { recursive: true })` (sync) or `await Deno.mkdir(p, { recursive: true })` (async, preferred) | Use async form for idiomatic Deno; update caller to `await`. |
| `path.join` | `cli.js:4`; `api.js:2`; `cache.js:2`; `hash.js:3`; `pack.js:3`; `unpack.js:3`; `validate.js:2` | `import { join } from "jsr:@std/path"` | Drop-in; identical API. |
| `path.basename` | `cli.js:4`; `api.js:2`; `pack.js:3`; `validate.js:2` | `import { basename } from "jsr:@std/path"` | Drop-in. |
| `path.resolve` | `pack.js:3` | `import { resolve } from "jsr:@std/path"` | Drop-in. |
| `path.relative` | `hash.js:3` | `import { relative } from "jsr:@std/path"` | Drop-in. |
| `crypto.createHash('sha256')` | `hash.js:1,43–51` | `node:crypto` (bridge, keep sync) → `jsr:@std/crypto` async (follow-up) | `createHash(...).update(...).digest('hex')` is synchronous. Web Crypto's `crypto.subtle.digest()` is async; propagating `await` through `canonicalHash` → `hashZipBuffer` → `storeRemote` touches multiple files. Use `import { createHash } from "node:crypto"` as bridge to preserve synchronous contract; plan async migration as Phase 4. |
| `Buffer.from(await res.arrayBuffer())` | `api.js:146` | `new Uint8Array(await res.arrayBuffer())` | Cross-file: `storeRemote` in `cache.js` must accept `Uint8Array` simultaneously. |
| Flat JSON cache (`cache/index.json`) | `cache.js:5–8,23–43,51–103` | Phase 1: keep flat JSON with Deno fs APIs. Phase 3: `node:sqlite` `DatabaseSync`. | SQLite migration is a separate pass; see section 3. |
| `process.on("SIGINT", ...)` | Absent | `Deno.addSignalListener("SIGINT", cleanup)` | Currently missing; add in Phase 1 to prevent partial `.skill` files and corrupt unpack dirs on Ctrl+C. |
| `program.parseAsync()` | `cli.js:218` | `await main()` with top-level `try/catch` | Deno supports top-level `await` natively. |

### 2.3 Resolved Open Questions from Research Guide

| Open Question | Decision | Rationale |
|---|---|---|
| §5.1 Arg parsing: `@std/cli/parse-args` vs `cliffy` | **`@std/cli/parse-args`** | yawcs has 5 subcommands with simple flat flags. Record-dispatch pattern (RESEARCH-GUIDE §3.2) is sufficient. Cliffy added only if CLI surface grows to 5+ subcommands with complex flag inheritance. |
| §5.2 Crypto: `jsr:@std/crypto` vs `node:crypto` vs Web Crypto | **`node:crypto` bridge first, async migration in Phase 4** | `canonicalHash` is synchronous and its output determines cache key correctness. Changing sync→async propagates through `hashZipBuffer`, `storeRemote`, and CLI callers. Bridge preserves correctness; async migration is a planned follow-up. |
| §5.3 Archive: `jsr:@std/archive` vs `npm:adm-zip` | **`npm:adm-zip` permanent unless `@std/archive` gains `addLocalFolder`/`extractAllTo`** | `jsr:@std/archive` currently lacks these convenience methods (pack-and-unpack findings, Note A). Evaluate again at Deno 2.x+1 minor. `npm:adm-zip` is bundled into `deno compile` since 2.3 — no distribution penalty. |
| §5.4 SQLite cache: `node:sqlite` vs `Deno.openKv` | **`node:sqlite` for cache data; `Deno.openKv` for user preferences if added** | `DatabaseSync` is synchronous (no async propagation), transactional, and handles concurrent writes. Flat-JSON stays through Phase 1–2; SQLite migration is Phase 3 with documented clean-break cache invalidation. |
| §5.5 Logging: manual `log` object vs `jsr:@std/log` | **Manual `log` object initially; optional `@std/log` in Phase 3** | `log.js` is already Deno-compatible (uses only Web Platform `console.*`). `@std/log` adds value only if CI log capture or file-based logging is required. Revisit after Phase 2. |
| §5.6 Prompts: `prompt()` vs raw `Deno.stdin.read()` | **`prompt()` for any one-off confirmations** | No interactive setup wizard exists in current yawcs. If added, build raw helpers then. |
| §5.7 Dependency management style | **`jsr:` specifiers directly in source; versions pinned in `deno.json` `imports` map** | Skip `deps.ts` pattern (predates `deno.json`). All `jsr:` and `npm:` specifiers in source files; `deno.json` `imports` section pins versions for deduplication. |
| `--no-verbose` vs `--verbose` | **Preserve `--no-verbose` opt-out semantic using `negatable: ["verbose"]` in `parseArgs`** | Current behavior is verbose-by-default, suppressed with `--no-verbose`. Changing to opt-in would silently suppress output for existing users. Preserve with: `parseArgs(Deno.args, { boolean: ["verbose"], negatable: ["verbose"], default: { verbose: true } })` |
| `.env` loading in compiled binary | **`jsr:@std/dotenv` `load({ export: true })` at startup in `auth.ts`** | `--env-file` flag works for `deno task` dev workflow. Compiled binary cannot use `deno run` flags; `@std/dotenv` load at runtime handles the binary distribution case cleanly. |
| `gray-matter` missing-frontmatter edge case | **Catch `extract()` throw + push to `errors[]`** | Consistent with existing error-accumulation pattern in `validate.js`. Treat missing frontmatter as a validation error, not a fatal exception. Use `import { test as hasFrontMatter } from "jsr:@std/front-matter"` as a guard before calling `extract()`. |

---

## 3. Phased Work Plan

### Phase 0 — Scaffold (no behavior changes)

**Goal:** Establish the Deno project skeleton so all subsequent phases can run and be tested incrementally.

**Steps:**

**0.1 Create `deno.json`**

Files touched: `deno.json` (new)

```json
{
  "name": "@yourscope/yawcs",
  "version": "0.1.0",
  "exports": "./mod.ts",
  "imports": {
    "@std/cli": "jsr:@std/cli@^1.0",
    "@std/path": "jsr:@std/path@^1.0",
    "@std/fs": "jsr:@std/fs@^1.0",
    "@std/front-matter": "jsr:@std/front-matter@^1.0",
    "@std/fmt": "jsr:@std/fmt@^1.0",
    "@std/crypto": "jsr:@std/crypto@^1.0",
    "@std/dotenv": "jsr:@std/dotenv@^0.225",
    "adm-zip": "npm:adm-zip@^0.5"
  },
  "tasks": {
    "dev":   "deno run --allow-read --allow-write --allow-net --allow-env --watch mod.ts",
    "build": "deno run --allow-read --allow-write --allow-run build.ts",
    "test":  "deno test --allow-read --allow-write",
    "lint":  "deno lint",
    "fmt":   "deno fmt",
    "audit": "deno audit",
    "doc":   "deno doc --html --output=./docs src/lib/"
  },
  "lint": {
    "rules": { "tags": ["recommended"] }
  },
  "fmt": {
    "useTabs": false,
    "lineWidth": 100,
    "indentWidth": 2
  }
}
```

Acceptance criteria: `deno task --list` shows all tasks; `deno fmt --check` and `deno lint` exit 0 on an empty project.

**0.2 Create thin `mod.ts` entry point**

Files touched: `mod.ts` (new)

```ts
#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env
// Thin re-export; real logic stays in src/ during migration
export {};
```

Acceptance criteria: `deno run mod.ts` runs without error.

**0.3 Create `build.ts` (cross-platform compile script)**

Files touched: `build.ts` (new); mirrors Makefile release targets.

Acceptance criteria: `deno task build` exits 0 and produces binaries in `dist/`.

**0.4 Create `.github/workflows/release.yml`**

Files touched: `.github/workflows/release.yml` (new per RESEARCH-GUIDE §4.7)

Acceptance criteria: Workflow file lints cleanly; can be dry-run with `act` if available.

---

### Phase 1 — Port Leaf Modules (no external deps)

**Goal:** Migrate the modules with zero or trivial external dependencies first. No behavior changes; all hash outputs, zip contents, and log output must be identical.

**1.1 Migrate `src/lib/log.js` → `src/lib/log.ts`**

Files touched: `src/lib/log.js` → `src/lib/log.ts`

Changes:
- Rename file to `.ts`; add TypeScript type annotations.
- No Node API changes needed — `log.js` uses only `console.*` and Web Platform `Headers` API, both available in Deno natively (validate-and-log findings, row 7–9).
- Add `export type` declarations so callers can import `setVerbose`, `logRequest`, `logResponse`.

Acceptance criteria: `deno check src/lib/log.ts` exits 0; existing log output unchanged.

**1.2 Migrate `src/lib/validate.js` → `src/lib/validate.ts`**

Files touched: `src/lib/validate.js` → `src/lib/validate.ts`

Changes (validate-and-log findings, rows 1–6):
- `import { readdirSync } from 'fs'` → `Deno.readDirSync(skillDir)` with `.map(e => e.name)` adapter (validate.js:39,46 — Note A).
- `import { readFileSync } from 'fs'` → `Deno.readTextFileSync` (validate.js:61).
- `import { join, basename } from 'path'` → `import { join, basename } from "@std/path"`.
- `import matter from 'gray-matter'` → `import { extract } from "@std/front-matter/yaml"` + `import { test as hasFrontMatter } from "@std/front-matter"` (validate.js:3,63 — Note B).
- Update destructuring: `parsed.data` → `parsed.attrs`; `parsed.content` → `parsed.body` (validate.js:63–70).
- Add no-frontmatter guard before `extract()` (currently missing; would throw on SKILL.md without `---` delimiters).
- The existing `try/catch` around `matter(raw)` was dead code with gray-matter; it is now live and meaningful — keep it, wrapping the new `extract()` call.

Acceptance criteria:
- `deno check src/lib/validate.ts` exits 0.
- `deno test` validation tests pass (write a test fixture with valid and invalid SKILL.md files — no-frontmatter case must produce an error entry, not a thrown exception).
- Output of `validate` command identical to Node version on the same inputs.

**1.3 Migrate `src/lib/auth.js` → `src/lib/auth.ts`**

Files touched: `src/lib/auth.js` → `src/lib/auth.ts`

Changes (api-and-auth findings, rows 1–3, 10):
- Delete `import { config } from 'dotenv'; config()` (auth.js:1-2).
- Add `import { load } from "@std/dotenv"; await load({ export: true });` at module init — handles `.env` for both `deno task` dev and compiled binary.
- Replace all `process.env.VAR` with `Deno.env.get("VAR")` (auth.js:9,21,22,33).
- Replace `process.exit(1)` with `Deno.exit(1)` (auth.js:16).
- Add TypeScript types for the returned headers object.

Acceptance criteria:
- `deno check src/lib/auth.ts` exits 0.
- `CLAUDE_SESSION_KEY=test deno run --allow-env src/lib/auth.ts` produces correct headers object.
- Missing env var still exits with code 1 and a useful error message.

---

### Phase 2 — Port Core I/O Modules (Buffer/Uint8Array coordinated change)

**Goal:** Migrate the remaining lib modules. The `Buffer`→`Uint8Array` transition in `api.js`, `cache.js`, and `hash.js` must be done as a coordinated atomic change to prevent a broken intermediate state.

**2.1 Migrate `src/lib/hash.js` → `src/lib/hash.ts`**

Files touched: `src/lib/hash.js` → `src/lib/hash.ts`

Changes (cache-and-hash findings, rows 9–12):
- `import { createHash } from 'crypto'` → `import { createHash } from "node:crypto"` (bridge; hash.js:1). Preserve synchronous API contract to avoid async propagation. This is an explicit bridge — not idiomatic Deno — documented for Phase 4 follow-up.
- `import { readdirSync, readFileSync, statSync } from 'fs'` → Deno built-ins:
  - `readdirSync(dir)` → `[...Deno.readDirSync(dir)]` with `.name`/`.isDirectory` access; eliminates per-entry `statSync` call (hash.js:2, `walkDir` lines 13–24).
  - `readFileSync(abs)` → `Deno.readFileSync(abs)` returning `Uint8Array` (compatible with `createHash().update()` which accepts `BinaryLike`).
- `import { join, relative } from 'path'` → `import { join, relative } from "@std/path"` (hash.js:3).
- `import AdmZip from 'adm-zip'` → `import AdmZip from "adm-zip"` (resolves to `npm:adm-zip` via `deno.json` import map; hash.js:4,83–92). No other changes needed — `npm:adm-zip` accepts `Uint8Array` as well as `Buffer`.
- Update TypeScript type annotation on `hashZipBuffer` parameter from `Buffer` to `Uint8Array`.

Acceptance criteria:
- `deno check src/lib/hash.ts` exits 0.
- Hash output for a fixed test fixture `.skill` file is byte-for-byte identical to Node output (critical — run the parity test in §5).

**2.2 Migrate `src/lib/cache.js` → `src/lib/cache.ts` (flat-JSON phase)**

Files touched: `src/lib/cache.js` → `src/lib/cache.ts`

Changes (cache-and-hash findings, rows 1–8, 13):
- `import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs'` → Deno equivalents:
  - `existsSync` → `import { existsSync } from "@std/fs"`.
  - `mkdirSync(p, { recursive: true })` → `Deno.mkdirSync(p, { recursive: true })`.
  - `readFileSync(p, 'utf8')` → `Deno.readTextFileSync(p)`.
  - `readFileSync(p)` (binary read for `readCachedSkill`) → `Deno.readFileSync(p)` → `Uint8Array`.
  - `writeFileSync(p, str)` → `Deno.writeTextFileSync(p, str)` (for JSON index) / `Deno.writeFileSync(p, uint8array)` (for binary `.skill` files).
  - `renameSync(src, dst)` → `Deno.renameSync(src, dst)`.
- `import { join } from 'path'` → `import { join } from "@std/path"`.
- Update `storeRemote` signature: `buf: Buffer` → `buf: Uint8Array` (coordinated with `api.js` change 2.3 below).
- Update `readCachedSkill` return type: `Buffer | null` → `Uint8Array | null`.
- Flat-JSON index structure preserved; SQLite migration is Phase 3.

Acceptance criteria:
- `deno check src/lib/cache.ts` exits 0.
- Cache read/write round-trip test: write a known `.skill` file via `storeRemote`, read it back via `readCachedSkill`, hash matches original.
- Existing `cache/index.json` files from Node version are readable (same JSON format).

**2.3 Migrate `src/lib/api.js` → `src/lib/api.ts`**

Files touched: `src/lib/api.js` → `src/lib/api.ts`

Changes (api-and-auth findings, rows 4–9):
- `import { readFileSync } from 'fs'` → deleted; use `await Deno.readFile(skillPath)` at call site (api.js:1,66-67).
- `import { basename } from 'path'` → `import { basename } from "@std/path"` (api.js:2).
- `Buffer.from(await res.arrayBuffer())` → `new Uint8Array(await res.arrayBuffer())` (api.js:146). Coordinated with cache.js change above — `storeRemote` now accepts `Uint8Array`.
- All `fetch()` calls (api.js:26,81,104,139) — no change; global in Deno.
- `new Date(s.updated_at).toLocaleString()` (api.js:185) — no change; `Date` works in Deno.
- Header manipulation pattern `delete headers['content-type']` (api.js:77,135) — no change.
- Add TypeScript types for all function signatures.

Acceptance criteria:
- `deno check src/lib/api.ts` exits 0.
- `upload()` can be called with `--allow-net=claude.ai --allow-read --allow-env` and produces correct multipart body (manual test with `--dry-run` flag or mock fetch).

**2.4 Migrate `src/lib/pack.js` → `src/lib/pack.ts`**

Files touched: `src/lib/pack.js` → `src/lib/pack.ts`

Changes (pack-and-unpack findings, rows 1–9):
- `import AdmZip from 'adm-zip'` → `import AdmZip from "adm-zip"` (resolves via import map; pack.js:1).
- `import { mkdirSync } from 'fs'` → `await Deno.mkdir(DIST_DIR, { recursive: true })` inline; convert `pack()` to `async` (pack.js:2).
- `import { resolve, basename, join } from 'path'` → `import { resolve, basename, join } from "@std/path"` (pack.js:3).
- Convert exported `pack()` function to `async function pack()` to accommodate `await Deno.mkdir`.
- Add SIGINT handler via module-level variable tracking `outPath`; remove partial file on interrupt (pack-and-unpack Note C). Register in the CLI entry point (Phase 2.6) rather than per-module to avoid duplicate signal listeners.

Acceptance criteria:
- `deno check src/lib/pack.ts` exits 0.
- `deno task dev pack my-skill` produces identical `.skill` zip byte-for-byte compared to Node version (verify with `sha256sum`).

**2.5 Migrate `src/lib/unpack.js` → `src/lib/unpack.ts`**

Files touched: `src/lib/unpack.js` → `src/lib/unpack.ts`

Changes (pack-and-unpack findings, rows 1–5, 10):
- `import AdmZip from 'adm-zip'` → `import AdmZip from "adm-zip"` (resolves via import map; unpack.js:1).
- `import { existsSync } from 'fs'` → `import { existsSync } from "@std/fs"` (unpack.js:2).
- `import { join } from 'path'` → `import { join } from "@std/path"` (unpack.js:3).
- Convert to `async function unpack()` for consistency (no blocking sync calls once adm-zip handles extraction synchronously internally — keep sync zip ops, add async mkdir/write if ever refactoring to native).
- SIGINT cleanup tracked in CLI entry (Phase 2.6).

Acceptance criteria:
- `deno check src/lib/unpack.ts` exits 0.
- `unpack()` on a `.skill` produced by the Deno `pack()` produces byte-for-byte identical directory tree.
- Interrupted unpack (simulated) leaves no partial directory.

**2.6 Migrate `src/cli.js` → `src/cli.ts` (and wire `mod.ts`)**

Files touched: `src/cli.js` → `src/cli.ts`; `mod.ts` updated to import and run CLI.

Changes (cli-and-args findings, rows 1–19):

*Shebang:*
```ts
#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env
```

*Arg parsing (replaces commander):*
```ts
import { parseArgs } from "@std/cli/parse-args";

const args = parseArgs(Deno.args, {
  boolean: ["verbose", "dry-run", "overwrite", "include-wiggle", "help", "version"],
  string: ["output"],
  negatable: ["verbose"],
  alias: { h: "help", V: "version" },
  default: { verbose: true },
  stopEarly: true,   // first non-flag becomes the subcommand
});
```

*Subcommand dispatch (replaces `.command()` chain):*
```ts
const COMMANDS: Record<string, (rest: string[], args: ParsedArgs) => Promise<void>> = {
  validate: runValidate,
  pack: runPack,
  upload: runUpload,
  list: runList,
  download: runDownload,
};
```

*Help text:* Write `showHelp()` function reproducing the commander auto-generated output exactly (preserves existing user documentation).

*Node API swaps:*
- All `process.exit(n)` → `Deno.exit(n)` (cli.js:38,60,83,138,169,179,238,245).
- `statSync(outPath).size` → `Deno.statSync(outPath).size` (cli.js:97).
- `readFileSync(outPath)` → `Deno.readFileSync(outPath)` → `Uint8Array` (cli.js:107,133) — type flows into `hash.ts` and `cache.ts` which now accept `Uint8Array`.
- `unlinkSync(outPath)` → `Deno.removeSync(outPath)` (cli.js:121,138).
- `existsSync(localDir)` → `import { existsSync } from "@std/fs"` (cli.js:199).
- `readdirSync` + `statSync(...).isDirectory()` → `[...Deno.readDirSync(skillsRoot)]` with `.isDirectory` property access (cli.js:231–248).
- `import { join, basename } from 'path'` → `import { join, basename } from "@std/path"` (cli.js:4).

*SIGINT handler* (new — currently absent):
```ts
let activePackPath: string | null = null;
let activeUnpackDir: string | null = null;
let unpackWasExisting = false;

Deno.addSignalListener("SIGINT", () => {
  if (activePackPath) try { Deno.removeSync(activePackPath); } catch { /**/ }
  if (activeUnpackDir && !unpackWasExisting) {
    try { Deno.removeSync(activeUnpackDir, { recursive: true }); } catch { /**/ }
  }
  console.error("\nInterrupted.");
  Deno.exit(130);
});
```

*Entry:*
```ts
if (import.meta.main) {
  await main().catch(err => { console.error(err.message); Deno.exit(1); });
}
```

Acceptance criteria:
- `deno check src/cli.ts` exits 0.
- All 5 subcommands (`validate`, `pack`, `upload`, `list`, `download`) exercise correctly against a local test skills directory.
- `--help` output matches current commander output.
- `--no-verbose` suppresses verbose output.
- Exit code 0/1 behavior matches existing behavior on all error paths.
- Ctrl+C during `pack` leaves no partial `.skill` file.

---

### Phase 3 — Replace Build Tooling & Cleanup

**Goal:** Remove `package.json`, `Makefile`, and `node_modules`. Verify binary compilation. Optionally migrate cache to SQLite.

**3.1 Delete Node artifacts**

Files touched: `package.json` (delete), `package-lock.json` (delete), `node_modules/` (delete), `Makefile` (delete).

Acceptance criteria: `ls node_modules` → not found. `deno task --list` covers all former Makefile targets. `deno audit` exits 0.

**3.2 Verify `deno compile` single-binary**

Files touched: `build.ts` (finalized); `.github/workflows/release.yml` (finalized).

Run:
```bash
deno compile --allow-read --allow-write --allow-net --allow-env \
  --output ./dist/yawcs mod.ts
./dist/yawcs validate my-skill/
```

Acceptance criteria:
- Binary runs without Deno installed.
- `npm:adm-zip` is bundled (verify with `file ./dist/yawcs` — single executable, no external deps).
- Cross-compilation for all three targets succeeds via `build.ts`.

**3.3 Optional: Migrate cache to `node:sqlite`**

Files touched: `src/lib/cache.ts`

This is a deliberate scope break — it can ship after Phase 3.1/3.2 without blocking binary distribution.

Schema:
```sql
CREATE TABLE IF NOT EXISTS skill_cache (
  skill_name   TEXT PRIMARY KEY,
  updated_at   TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  cached_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS remote_skills (
  skill_name   TEXT PRIMARY KEY,
  file_path    TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  cached_at    TEXT NOT NULL
);
```

Migration strategy: On first run with the new binary, if `cache/index.json` exists, read it and `INSERT OR REPLACE` all entries into the SQLite DB, then rename the JSON file to `cache/index.json.migrated`. Document in release notes that `yawcs clean` resets the cache if migration is unwanted.

Acceptance criteria:
- `deno check src/lib/cache.ts` exits 0.
- Cache operations survive a process restart (persistence test).
- Concurrent `yawcs upload` and `yawcs download` do not corrupt the cache (SQLite WAL handles this).
- Hash correctness: migrated entries from JSON produce the same content hashes.

**3.4 Optional: Migrate to `jsr:@std/log`**

Files touched: `src/lib/log.ts`, `src/cli.ts`

Wire `--verbose` → `DEBUG` log level:
```ts
import * as log from "@std/log";
log.setup({
  handlers: { console: new log.ConsoleHandler(args.verbose ? "DEBUG" : "INFO") },
  loggers: { default: { level: args.verbose ? "DEBUG" : "INFO", handlers: ["console"] } },
});
```

Replace `if (!verbose) return` guards in `log.ts` with `logger.debug(...)`.

Acceptance criteria: Verbose output unchanged. `--no-verbose` suppresses all debug-level output. CI `deno test` captures structured log output.

---

### Phase 4 — Follow-Up Improvements (post-release)

These items are explicitly deferred and documented here for tracking. They are not blockers for a working Deno release.

**4.1 Async crypto: `node:crypto` bridge → `jsr:@std/crypto`**

Replace `import { createHash } from "node:crypto"` in `hash.ts` with `crypto.subtle.digest` or `jsr:@std/crypto`. Requires converting `canonicalHash` and `hashZipBuffer` to async, which propagates `await` through `storeRemote` and CLI upload/download handlers.

Risk: The hash output format (`sha256`, lowercase hex) must remain byte-identical. Write a parity test before switching that asserts the hex string produced by both implementations matches for a fixed binary input.

**4.2 `jsr:@std/archive` ZIP rewrite**

Replace `npm:adm-zip` with pure-Deno `jsr:@std/archive` once that library gains stable ZIP read/write with directory add and bulk extract APIs. Gate on verifying `@std/archive` produces bit-identical archives for the yawcs skill structure.

**4.3 `deno doc` API reference**

Run `deno doc --html --output=./docs src/lib/` and publish to GitHub Pages. Requires JSDoc comments on all exported functions (add during Phase 1–2 ports).

**4.4 `deno audit` in CI**

Add `deno audit` as a required CI step on every PR. Already in `deno.json` tasks.

---

## 4. Permissions Model

The CLI needs exactly four permission flags. They must appear in both the shebang line and the `deno compile` invocation.

### Declared Permissions

| Flag | Scope | Reason | Source |
|---|---|---|---|
| `--allow-read` | Unscoped (skills/, dist/, cache/) | Read skill directories (`readDirSync`), read `.skill` zip files (`readFileSync`), read cache index (`readTextFileSync`), read env file (dotenv). Scoping to specific paths is possible but complicates portable binaries. | cli-and-args findings rows 17; cache-and-hash rows 1,3; pack-and-unpack rows 2,4 |
| `--allow-write` | Unscoped (dist/, skills/, cache/) | Write packed `.skill` archives (`writeFile`), extract to `skills/`, write cache index (`writeTextFile`), write SQLite db (Phase 3). | cli-and-args findings row 18; pack-and-unpack row 2,7,8 |
| `--allow-net` | `--allow-net=claude.ai` | All `fetch()` calls in `api.ts` target `https://claude.ai/api`. Scoped to the single hostname — never broader than needed. | api-and-auth findings rows 6–8 |
| `--allow-env` | `--allow-env=CLAUDE_SESSION_KEY,CF_CLEARANCE,CF_BM,USER_AGENT` | Auth cookie/token env vars read in `auth.ts` (auth.js:9,21,22,33). Scoped to exact var names for least privilege. | api-and-auth findings rows 1–2 |

### Shebang Line

```
#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net=claude.ai --allow-env=CLAUDE_SESSION_KEY,CF_CLEARANCE,CF_BM,USER_AGENT
```

### `deno compile` Invocation

```bash
deno compile \
  --allow-read \
  --allow-write \
  --allow-net=claude.ai \
  --allow-env=CLAUDE_SESSION_KEY,CF_CLEARANCE,CF_BM,USER_AGENT \
  --output ./dist/yawcs \
  mod.ts
```

### What Is NOT Needed

- `--allow-run`: yawcs does not shell out to any subprocess. If git operations are added in future, use `--allow-run=git` scoped to the `git` binary only.
- `--allow-hrtime`: not needed.
- `--allow-ffi`: not needed.
- `--unstable-*`: not needed for any API in this plan. `node:sqlite` is stable in Deno 2.2+; `Deno.openKv` is stable; `Temporal` is stable in Deno 2.7+.

---

## 5. Risks & Validation

### Risk 1 — ZIP Byte Compatibility

**What could break:** `npm:adm-zip` running under Deno might produce a zip with different compression parameters, entry ordering, or metadata than `adm-zip` under Node. Existing `.skill` files in local caches could become unreadable. **Severity is low** — yawcs is not in wide deployment, so the goal here is to *detect and report* any divergence, not to block on byte-identity. A cache reset is an acceptable remedy.

**Validation:**
1. Take a known test skill directory (e.g., `test-fixtures/sample-skill/`).
2. Pack it with the Node version: `node src/cli.js pack sample-skill` → `dist/sample-skill.skill`.
3. Pack it with the Deno version: `deno task dev pack sample-skill` → `dist/sample-skill-deno.skill`.
4. Compare with `sha256sum` — they should match byte-for-byte since the same `adm-zip` code runs underneath.
5. Unpack the Node-produced `.skill` with the Deno unpack, and vice versa — both must succeed.
6. Run this as an automated `deno test` fixture that is re-run on every PR.

**Fallback:** If byte-level mismatch occurs, it is most likely in zip metadata (timestamps). Add `zip.setEntryDate(entry, new Date(0))` to normalize timestamps before the assertion, and accept that the binary format may differ while the content is functionally equivalent.

### Risk 2 — Hash Parity

**What could break:** The `canonicalHash` function in `hash.ts` uses SHA-256 to fingerprint skill directories and zip contents. If the hash output changes (even by one character), all cached entries are invalidated and users must re-download all remote skills.

**Root causes of potential mismatch:**
- `Deno.readDirSync` returning entries in a different order than Node `fs.readdirSync` (both return OS-ordered results, but order may differ on case-insensitive filesystems).
- `Deno.readFileSync` returning `Uint8Array` vs Node `Buffer` — content is identical; this is safe.
- Future Phase 4 crypto migration producing a different hex string (only if the implementation is buggy).

**Validation:**
1. Compute `canonicalHash` for a fixed test skill directory under both Node and Deno.
2. Assert the hex strings are equal in a `deno test` fixture.
3. Compute `hashZipBuffer` for a fixed `.skill` file under both runtimes; assert equal.
4. Pin these hash values as golden test vectors in `test/hash-parity.test.ts`.
5. Run the parity test in CI against both the Node and Deno outputs before deleting the Node entry point.

**Mitigation:** If sort order differs, add an explicit `entries.sort()` to `walkDir` — the hash is content-addressed and any stable ordering is fine as long as it is consistent.

### Risk 3 — Auth Cookies & Env Var Loading

**What could break:**
- `dotenv` is removed; if users run the compiled binary without exporting env vars, auth will silently fail.
- `jsr:@std/dotenv` `load()` looks for `.env` in the current working directory; if the user runs the binary from a different directory, `.env` is not found.

**Validation:**
1. Test `auth.ts` with `CLAUDE_SESSION_KEY` set via env export (not `.env`) — must succeed.
2. Test with a `.env` file in the current directory — must succeed.
3. Test with no `.env` and no env export — must exit 1 with a clear "CLAUDE_SESSION_KEY not set" message (not a silent JSON parse error).
4. Document in `README.md` that the binary requires env vars exported in the shell or a `.env` file in the working directory.

### Risk 4 — Cache Format Compatibility (Phase 3 SQLite migration)

**What could break:** Existing `cache/index.json` is flat JSON. After Phase 3.3, it is replaced by SQLite. Users upgrading from Node version have a populated JSON cache; if the migration script is wrong, they lose their cache state.

**Validation:**
1. Write a migration test: populate a `cache/index.json` with known entries, run the new binary, assert all entries appear in SQLite.
2. Run the migration twice — idempotent (`INSERT OR REPLACE` handles re-runs).
3. After migration, assert `readCachedSkill("known-skill")` returns the correct `Uint8Array`.
4. Provide `yawcs clean` command that deletes both the JSON file and the SQLite db for users who prefer a fresh start.

### Risk 5 — `gray-matter` → `@std/front-matter` Behavior Differences

**What could break:** `gray-matter` never throws; `extract()` throws on missing front-matter. Any SKILL.md without a `---` block that previously produced `{ errors: [] }` will now throw unless the `hasFrontMatter` guard is in place.

**Validation:**
1. Test fixture: SKILL.md with valid front-matter → expect no errors.
2. Test fixture: SKILL.md with malformed YAML in front-matter → expect an error entry (not a thrown exception).
3. Test fixture: SKILL.md with no `---` delimiters → expect a "no YAML front-matter block" error entry.
4. Test fixture: SKILL.md with empty front-matter (`--- ---`) → expect errors for all required fields.
5. Run all fixtures as `deno test` assertions.

### Risk 6 — `--no-verbose` Flag Behavior

**What could break:** `parseArgs` with `negatable: ["verbose"]` must produce `{ verbose: false }` when `--no-verbose` is passed. If `negatable` is not supported in the pinned version of `@std/cli`, verbose output cannot be suppressed.

**Validation:**
1. `parseArgs(["--no-verbose"], { boolean: ["verbose"], negatable: ["verbose"], default: { verbose: true } })` → assert `args.verbose === false`.
2. `parseArgs([], ...)` → assert `args.verbose === true`.
3. Add this as a unit test in `test/cli-args.test.ts`.

---

## 6. Effort Estimate & Sequencing Recommendation

### Effort by Phase

| Phase | Work | Estimate |
|---|---|---|
| Phase 0: Scaffold | `deno.json`, `mod.ts`, `build.ts`, GitHub Actions | 2–4 hours |
| Phase 1: Leaf modules (`log`, `validate`, `auth`) | Mostly mechanical; `gray-matter` swap is the only involved change | 4–6 hours |
| Phase 2: Core I/O (`hash`, `cache`, `api`, `pack`, `unpack`, `cli`) | `Buffer`→`Uint8Array` coordination + commander removal; hash parity test | 1.5–2.5 days |
| Phase 3: Tooling cleanup + compile verify | Delete Node artifacts; verify binary; optional SQLite | 4–8 hours (add 1 day if SQLite migration) |
| Phase 4: Follow-up (async crypto, `@std/archive`, docs) | Optional; post-release | 2–5 days |
| **Total (Phases 0–3)** | | **3–5 days** |

### Sequencing Recommendations

1. **Do Phase 0 first on a feature branch.** Having `deno.json` and `mod.ts` lets you run `deno check` against any file immediately, catching type errors as you work through each module.

2. **Port leaf modules before core I/O (Phase 1 before Phase 2).** `log.ts` has zero changes; `validate.ts` and `auth.ts` are self-contained. Getting them green builds confidence and produces a working `validate` subcommand before touching the complex `hash`/`cache`/`api` triangle.

3. **Treat the `Buffer`→`Uint8Array` transition as a single atomic commit.** The three files `hash.ts`, `cache.ts`, and `api.ts` form a dependency triangle. Migrating them separately risks a broken intermediate state. Do them in one PR.

4. **Write the hash parity test before deleting the Node entry point.** Keep `package.json` (but add it to `.gitignore` changes) until the golden vector test is green. Delete it in Phase 3.1 only after the parity test has passed in CI.

5. **Ship Phase 3.3 (SQLite) as a separate PR.** It is an opt-in improvement with a clean data migration path. It does not block binary distribution. Separating it keeps Phase 3.1/3.2 lean and reviewable.

6. **CI gating:** Add `deno fmt --check`, `deno lint`, `deno check mod.ts`, `deno test`, and `deno audit` to the CI matrix before merging Phase 2. These are all zero-configuration with `deno.json` in place.

### Critical Path

```
Phase 0 (scaffold)
  └─ Phase 1.1 log.ts       [trivial]
  └─ Phase 1.2 validate.ts  [gray-matter swap]
  └─ Phase 1.3 auth.ts      [dotenv removal]
       └─ Phase 2 (coordinated: hash.ts + cache.ts + api.ts + pack.ts + unpack.ts + cli.ts)
            └─ Phase 3.1 delete Node artifacts
            └─ Phase 3.2 verify deno compile binary
                 └─ Phase 3.3 SQLite (optional, parallel)
                 └─ Phase 4 (post-release)
```

The only hard dependency chain is: Phase 0 → Phase 1 (any order) → Phase 2 (must be atomic for `Buffer`→`Uint8Array`) → Phase 3.

Phase 1 modules are independent of each other and can be worked in parallel if multiple contributors are available.
