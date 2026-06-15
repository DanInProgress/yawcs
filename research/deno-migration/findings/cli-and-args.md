# Migration Catalog: `src/cli.js` — CLI Entry Point & Arg Parsing

## Summary Table

| # | File:Line(s) | Current Node API / Dep | Deno-Native Replacement | Effort | Behavior Risk |
|---|---|---|---|---|---|
| 1 | cli.js:1 | `#!/usr/bin/env node` shebang | `#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env` | Trivial | Must list correct permission flags or runtime prompts break |
| 2 | cli.js:2 | `import { Command } from 'commander'` | `import { parseArgs } from "jsr:@std/cli/parse-args"` + manual dispatch | Involved | Loss of commander's `.hook()`, auto-help, `--no-*` negation; all must be hand-rolled |
| 3 | cli.js:3 | `import { readdirSync, statSync, readFileSync, unlinkSync, existsSync } from 'fs'` | `Deno.readDirSync` / `Deno.statSync` / `Deno.readFileSync` / `Deno.removeSync` / `Deno.statSync` (existence check) | Moderate | API shape differs; `existsSync` becomes a try/catch on `Deno.stat` |
| 4 | cli.js:4 | `import { join, basename } from 'path'` | `import { join, basename } from "jsr:@std/path"` | Trivial | Drop-in; same function signatures |
| 5 | cli.js:13–22 | `new Command()` / `.name()` / `.description()` / `.version()` | Manual `showHelp()` + `--version` flag in `parseArgs` | Moderate | Must write custom help text; version string hardcoded or read from `deno.json` |
| 6 | cli.js:19 | `.option('--no-verbose', ...)` Commander negation flag | `boolean: ["verbose"]`, `default: { verbose: true }` in `parseArgs`; `--no-verbose` maps to `{ verbose: false }` via `negatable` | Moderate | `parseArgs` does not auto-negate with `--no-*`; requires explicit `negatable` option or manual check of `Deno.args` |
| 7 | cli.js:20–22 | `.hook('preAction', ...)` to call `setVerbose()` | Call `setVerbose(args.verbose)` at top of `main()` before dispatch | Trivial | Functionally equivalent; executed once before any command |
| 8 | cli.js:38, 60, 83, 138, 169, 179, 238, 245 | `process.exit(1)` / `process.exit(0)` | `Deno.exit(1)` / `Deno.exit(0)` | Trivial | Identical semantics |
| 9 | cli.js:218 | `program.parseAsync()` top-level async | `await main()` wrapped in top-level `try/catch` with `Deno.exit(1)` | Trivial | Deno supports top-level await natively |
| 10 | cli.js:97 | `statSync(outPath).size` | `Deno.statSync(outPath).size` | Trivial | Same field name |
| 11 | cli.js:107, 133 | `readFileSync(outPath)` returning `Buffer` | `Deno.readFileSync(outPath)` returning `Uint8Array` | Moderate | Callers expecting Node `Buffer` (e.g., `hashZipBuffer`, `storeRemote`) must accept `Uint8Array`; cross-cuts into `lib/` |
| 12 | cli.js:121, 138 | `unlinkSync(outPath)` | `Deno.removeSync(outPath)` | Trivial | Same semantics |
| 13 | cli.js:199 | `existsSync(localDir)` | `try { Deno.statSync(localDir); } catch { /* not found */ }` or `await exists(localDir)` from `jsr:@std/fs/exists` | Trivial | `jsr:@std/fs/exists` is the cleanest drop-in |
| 14 | cli.js:231–248 | `readdirSync` + `statSync(...).isDirectory()` | `[...Deno.readDirSync(skillsRoot)]` with `.isDirectory` property | Trivial | `Deno.DirEntry` has `.isDirectory` (boolean), not `.isDirectory()` (method) — remove the call parens |
| 15 | (implicit) | No SIGINT handler | Add `Deno.addSignalListener("SIGINT", cleanup)` | Trivial | Currently leaves partial `.skill` zip files on disk on Ctrl+C during `pack`/`upload` |
| 16 | (implicit) | `--allow-net` needed | `upload`, `fetchSkills`, `fetchAndCacheRemoteSkill`, `listSkills` all call `fetch()` to claude.ai | N/A (permission declaration) | Must be listed in shebang and `deno compile` invocation |
| 17 | (implicit) | `--allow-read` needed | `readdirSync`, `statSync`, `readFileSync` on `skills/` and `dist/` | N/A | Must be declared |
| 18 | (implicit) | `--allow-write` needed | `pack` writes to `dist/`; `unpack` writes to `skills/`; `storeRemote` writes cache | N/A | Must be declared |
| 19 | (implicit) | `--allow-env` needed | `lib/api.js` reads auth token from env vars (inferred from API calls) | N/A | Must be declared |

---

## Detailed Notes

### 1. Shebang (`cli.js:1`)

Current: `#!/usr/bin/env node`

Replace with:
```
#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env
```

The `-S` flag is required for `env` to split multiple arguments. This line is also the canonical place to declare runtime permissions for direct execution. For `deno compile` distribution the same set of flags is passed at compile time and embedded in the binary.

---

### 2. Commander Replacement — DECISION REQUIRED (`cli.js:2`, `cli.js:13–218`)

This is the single largest change in `cli.js`. Commander provides:
- Subcommand registration (`.command(...)`)
- Automatic `--help` generation
- `--no-verbose` boolean negation (commander special-cases `--no-*` flags)
- `.hook('preAction', ...)` for cross-cutting setup
- `program.parseAsync()` as the entry point

The recommended Deno replacement is `jsr:@std/cli/parse-args` with a manual Record-based dispatch (see RESEARCH-GUIDE §3.2). This requires:

1. Writing a `showHelp()` function that replicates the current auto-generated help text.
2. Implementing the `--no-verbose` flag explicitly. `parseArgs` supports a `negatable` config but the ergonomics differ from commander's automatic `--no-*` handling. Concretely: `parseArgs(Deno.args, { boolean: ["verbose"], default: { verbose: true } })` will treat `--no-verbose` as setting `verbose: false` **only if** `negatable: ["verbose"]` is also passed (Deno std `parseArgs` inherits this from the `minimist`-compatible API).
3. Replacing `.hook('preAction', ...)` with a single `setVerbose(args.verbose)` call at the top of `main()` before the command dispatch switch.

**Alternative worth considering:** `npm:commander` via the `npm:` specifier (zero code changes to `cli.js`). This avoids a full rewrite but adds an npm dep and doesn't benefit from Deno-native types. Acceptable as a migration bridge; not recommended long-term.

---

### 3. `--no-verbose` Flag Wiring (`cli.js:19–22`)

Commander silently converts `--no-verbose` into `verbose: false` in `opts()`. This is commander-specific behavior. In `parseArgs`:

```typescript
const args = parseArgs(Deno.args, {
  boolean: ["verbose"],
  negatable: ["verbose"],   // enables --no-verbose → verbose: false
  default: { verbose: true },
});
```

The current default is effectively "verbose = on unless suppressed", which matches the `--no-verbose` framing. Confirm with the team whether to flip this to `--verbose` opt-in (more conventional) or preserve the current opt-out semantic.

---

### 4. SIGINT / Cleanup Opportunity (`cli.js` — missing)

There is currently no signal handler. During `upload` or `pack`, a Ctrl+C can leave a `.skill` zip under `dist/`. Adding a SIGINT handler is low-effort and high-value:

```typescript
let activePackPath: string | null = null;

Deno.addSignalListener("SIGINT", () => {
  if (activePackPath) {
    try { Deno.removeSync(activePackPath); } catch { /* ignore */ }
  }
  console.error("\nInterrupted.");
  Deno.exit(130);
});
```

Track the in-progress output path in a module-level variable; clear it on success. Requires `--allow-read` (already needed).

---

### 5. `fs` → Deno Built-ins (`cli.js:3`)

| Node (`fs`) | Deno built-in | Notes |
|---|---|---|
| `readdirSync(dir)` | `[...Deno.readDirSync(dir)]` | Returns `Deno.DirEntry[]` not strings; `.name` field for filename |
| `statSync(p).size` | `Deno.statSync(p).size` | Same field |
| `statSync(p).isDirectory()` | `Deno.statSync(p).isDirectory` | Property, not method — remove `()` |
| `readFileSync(p)` | `Deno.readFileSync(p)` | Returns `Uint8Array` not `Buffer` |
| `unlinkSync(p)` | `Deno.removeSync(p)` | Same semantics |
| `existsSync(p)` | `import { existsSync } from "jsr:@std/fs/exists"` | Or `try { Deno.statSync(p) } catch {}` |

The `readFileSync` → `Uint8Array` change cross-cuts into `lib/hash.js` (`hashZipBuffer`) and `lib/cache.js` (`storeRemote`), which must be checked for `Buffer`-specific method usage (`.toString()`, `.slice()`, etc.).

---

### 6. `path` → `@std/path` (`cli.js:4`)

```typescript
import { join, basename } from "jsr:@std/path";
```

Both `join` and `basename` are drop-in compatible. No behavior change.

---

### 7. Subcommand Dispatch (`cli.js:27–215`)

Current structure: five commander `.command()` registrations (`validate`, `pack`, `upload`, `list`, `download`), each with inline `.action()` handlers.

Deno equivalent using Record-dispatch pattern (from RESEARCH-GUIDE §3.2):

```typescript
const commands: Record<string, (args: ParsedArgs) => Promise<void>> = {
  validate: runValidate,
  pack:     runPack,
  upload:   runUpload,
  list:     runList,
  download: runDownload,
};

async function main() {
  const [command, ...rest] = Deno.args;
  // parse flags from `rest` per-command...
  const handler = commands[command];
  if (!handler) { showHelp(); Deno.exit(command ? 1 : 0); }
  await handler(parsedArgs);
}
```

Per-command options (`--dry-run`, `--overwrite`, `--include-wiggle`) need to be parsed inside each handler or by passing the raw `rest` array to a second `parseArgs` call within each function. This is more boilerplate than commander but fully equivalent.

---

## Required Deno Permission Flags

All permissions must appear in both the shebang (for direct execution) and the `deno compile` invocation:

| Flag | Reason |
|---|---|
| `--allow-read` | Read `skills/` dirs, `dist/` zips, cache files |
| `--allow-write` | Write `dist/` zips, `skills/` unpacked dirs, cache |
| `--allow-net` | `fetch()` calls to claude.ai API (`upload`, `fetchSkills`, etc.) |
| `--allow-env` | Read auth token env var in `lib/api.js` |

`--allow-run` is not needed by `cli.js` itself (no child processes spawned here). If `lib/` modules shell out for git, add `--allow-run=git` scoped to the specific command.

---

## Items Requiring a Team Decision

1. **`--no-verbose` vs `--verbose` default:** Preserve the current opt-out (`--no-verbose`) semantic, or flip to conventional opt-in (`--verbose`, default false)? Affects `parseArgs` `default` config and all downstream `log.js` callers.

2. **Commander bridge vs full rewrite:** Use `npm:commander` (zero CLI code changes, npm dep retained) as a migration bridge, or do the full `parseArgs` + manual dispatch rewrite upfront? The bridge works correctly under Deno 2.x but delays cleanup.

3. **`readFileSync` return type (`Buffer` vs `Uint8Array`):** Once `fs.readFileSync` is replaced, all call sites in `lib/hash.js` and `lib/cache.js` that accept the return value must be audited. This is the most likely source of subtle runtime bugs if not handled deliberately.

4. **Help text ownership:** Commander auto-generates help strings from `.description()` and option definitions. After migration, help text must be maintained manually in a `showHelp()` function. Decide on format before rewriting.
