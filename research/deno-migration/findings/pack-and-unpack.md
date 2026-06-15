# Migration Catalog: `src/lib/pack.js` and `src/lib/unpack.js`

## Files Analyzed

- `src/lib/pack.js` (29 lines)
- `src/lib/unpack.js` (24 lines)

Both files are small and focused: `pack.js` creates a ZIP archive from a skill directory; `unpack.js` extracts a ZIP buffer into the skills directory. Together they account for the entire archive I/O surface of yawcs.

---

## Summary Table

| # | File:Line | Current API / Dep | Deno-Native Replacement | Effort | Behavior Risk |
|---|-----------|-------------------|------------------------|--------|---------------|
| 1 | `pack.js:1`, `unpack.js:1` | `import AdmZip from 'adm-zip'` | `import AdmZip from 'npm:adm-zip'` (bridge) OR rewrite with `jsr:@std/archive` (goal) | Trivial (bridge) / Involved (rewrite) | See note A |
| 2 | `pack.js:2` | `import { mkdirSync } from 'fs'` | `Deno.mkdirSync(path, { recursive: true })` or `await Deno.mkdir(path, { recursive: true })` | Trivial | `mkdirSync` is sync; Deno has both sync (`Deno.mkdirSync`) and async variants — pick async for consistency |
| 3 | `pack.js:3` | `import { resolve, basename, join } from 'path'` | `import { resolve, basename, join } from 'jsr:@std/path'` | Trivial | API is identical; cross-platform behavior is preserved |
| 4 | `unpack.js:2` | `import { existsSync } from 'fs'` | `import { existsSync } from 'jsr:@std/fs'` | Trivial | Drop-in; same semantics |
| 5 | `unpack.js:3` | `import { join } from 'path'` | `import { join } from 'jsr:@std/path'` | Trivial | API is identical |
| 6 | `pack.js:22–25` | `zip.addLocalFolder(src, zipPrefix)` | No direct equivalent in `jsr:@std/archive`; requires manual directory walk + entry-by-entry add | Involved | See note A |
| 7 | `pack.js:26` | `zip.writeZip(outPath)` — synchronous disk write | `await Deno.writeFile(outPath, zipBytes)` after producing bytes | Trivial (bridge) / Moderate (rewrite) | Must ensure `dist/` exists before write; already handled by `mkdirSync` above |
| 8 | `unpack.js:19–21` | `zip.extractAllTo(outDir, overwrite)` — synchronous extract to disk | No single-call equivalent in `jsr:@std/archive`; requires iterating entries and writing each | Involved | See note A |
| 9 | `pack.js` (whole file) | No SIGINT / cleanup handler | Add `Deno.addSignalListener("SIGINT", ...)` to delete partial `outPath` on interrupt | Moderate | Without this, a Ctrl+C mid-`writeZip` leaves a corrupt `.skill` file on disk |
| 10 | `unpack.js` (whole file) | No SIGINT / cleanup handler | Add `Deno.addSignalListener("SIGINT", ...)` to remove partially-extracted `dir` | Moderate | Without this, a Ctrl+C mid-extract leaves a partial skill directory that passes the `existsSync` guard as if it were already installed |

---

## Required Permission Flags

| Flag | Why Required |
|------|-------------|
| `--allow-read` | `existsSync` check on output dir/file; `addLocalFolder` reads the entire skill directory tree |
| `--allow-write` | `mkdirSync` creates `dist/`; `writeZip` writes the `.skill` archive; `extractAllTo` writes extracted files into `skills/` |

No network access (`--allow-net`) or environment variables (`--allow-env`) are needed by these two files in isolation. When compiled with `deno compile`, these two flags must be listed explicitly.

---

## Detailed Notes

### Note A — `adm-zip` API Surface vs `jsr:@std/archive`

This is the single largest migration decision for this file group.

**`npm:adm-zip` bridge (recommended first step)**

The simplest migration is to change the import specifier from `'adm-zip'` to `'npm:adm-zip'`. No other code changes are required. As of Deno 2.3, `deno compile` bundles `npm:` dependencies into the single binary. This is a one-line change per file and carries zero behavior risk.

```ts
// pack.js — line 1 becomes:
import AdmZip from 'npm:adm-zip';

// unpack.js — line 1 becomes:
import AdmZip from 'npm:adm-zip';
```

**`jsr:@std/archive` rewrite (goal, not day-one)**

`jsr:@std/archive` provides lower-level entry-based access; there is no `addLocalFolder` or `extractAllTo` convenience method equivalent. A full rewrite requires:

1. `pack`: walk the skill directory with `for await (const entry of Deno.readDir(...))` recursively, then use the `@std/archive` zip writer to add each file with the correct `zipPrefix/relative-path` archive path.
2. `unpack`: iterate zip entries, reconstruct output paths, call `Deno.writeFile` for each file entry and `Deno.mkdir` for each directory entry.

This work is **involved** because:
- `adm-zip`'s `addLocalFolder` recursively descends into subdirectories; a replacement needs an explicit recursive walk helper.
- `adm-zip`'s `extractAllTo(outDir, overwrite)` handles both file and directory entries in a single pass; a replacement must handle them separately.
- The single-root structure guarantee (`my-skill/SKILL.md`) must be tested explicitly after rewrite.

**Decision needed:** Whether to accept `npm:adm-zip` as a permanent dependency or commit to a full `jsr:@std/archive` rewrite. The research guide (§5.3) recommends using `npm:adm-zip` as a bridge during initial migration.

---

### Note B — Synchronous vs Asynchronous APIs

All current code in both files is fully synchronous (`mkdirSync`, `writeZip`, `extractAllTo`, `existsSync`). Deno's primary filesystem API is async. Options:

- Use the `Sync` variants Deno exposes (`Deno.mkdirSync`, `Deno.writeFileSync`) to keep the sync calling convention — but these block the event loop and are discouraged.
- Convert both exported functions to `async` and use `await Deno.mkdir(...)`, `await Deno.writeFile(...)` — this is the idiomatic Deno approach. Callers in the CLI layer will need to `await` these calls, but the CLI already uses top-level `await`.

**Decision needed:** Whether to keep the sync signature (simplest migration, not idiomatic) or go async (right approach, requires updating callers).

---

### Note C — Partial-Archive Cleanup on Interrupt

Neither file currently registers a SIGINT handler. In Node the process exits cleanly and the OS reclaims the file descriptor, but a partial `.skill` file or a partially-extracted skill directory is left on disk.

In Deno the same behavior occurs by default. The fix is to register a signal listener in the CLI entry point (or in each function) before the archive operation begins:

```ts
// pack.js pattern
let outPath: string | null = null;

Deno.addSignalListener("SIGINT", () => {
  if (outPath) {
    try { Deno.removeSync(outPath); } catch { /* ignore */ }
  }
  Deno.exit(130);
});
```

```ts
// unpack.js pattern — partial directory removal
Deno.addSignalListener("SIGINT", () => {
  if (partialDir && !wasExisting) {
    try { Deno.removeSync(partialDir, { recursive: true }); } catch { /* ignore */ }
  }
  Deno.exit(130);
});
```

**Behavior risk:** For `unpack`, if the directory `existsSync` check returned `false` (new install) and extraction is interrupted, subsequent calls will see a partial directory and return `'overwritten'` instead of `'written'`, masking the corruption. The cleanup handler prevents this. For `pack`, a partial `.skill` file may be treated as a valid archive by later steps.

This is the **highest behavior-risk item** in the group — it exists in Node too but is worth fixing during the Deno migration.

---

### Note D — `fs.existsSync` → `jsr:@std/fs`

`jsr:@std/fs` exports `existsSync` with identical semantics. Import path:

```ts
import { existsSync } from 'jsr:@std/fs';
```

This is a trivial swap with no behavior risk.

---

## Full Replacement Import Blocks

### `pack.js` — Deno-native imports (bridge phase)

```ts
import AdmZip from 'npm:adm-zip';                          // unchanged behavior; npm bridge
import { join, basename, resolve } from 'jsr:@std/path';   // replaces 'path'
// mkdirSync replaced inline: await Deno.mkdir(DIST_DIR, { recursive: true })
```

### `unpack.js` — Deno-native imports (bridge phase)

```ts
import AdmZip from 'npm:adm-zip';            // unchanged behavior; npm bridge
import { existsSync } from 'jsr:@std/fs';    // replaces 'fs' existsSync
import { join } from 'jsr:@std/path';        // replaces 'path'
```

---

## Effort Summary

| Phase | Changes | Total Effort |
|-------|---------|-------------|
| Bridge (day-one) | `adm-zip` → `npm:adm-zip`; `path` → `@std/path`; `fs` → `@std/fs` | ~1 hour |
| Async conversion | `mkdirSync` → `await Deno.mkdir`; callers updated to `await` | ~2 hours |
| SIGINT cleanup | Add signal handlers in pack + unpack (or CLI entry point) | ~2 hours |
| Full `jsr:@std/archive` rewrite | Replace all adm-zip calls with manual walk + entry-based API | ~1–2 days |
