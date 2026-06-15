# Deno Migration Findings: `validate.js` and `log.js`

**Files analyzed:** `src/lib/validate.js`, `src/lib/log.js`
**Focus areas:** gray-matter → @std/front-matter, custom logging → @std/log, byte/duration output → @std/fmt

---

## Summary Table

| # | File:Line | Current API / Dep | Deno-Native Replacement | Effort | Behavior Risk |
|---|-----------|-------------------|------------------------|--------|---------------|
| 1 | `validate.js:1` | `import { readdirSync } from 'fs'` | `Deno.readDirSync(path)` (returns `Deno.DirEntry[]`) | trivial | API shape change: Node returns `string[]`; Deno returns iterator of `{name, isFile, isDirectory}` — entry extraction differs (see Note A) |
| 2 | `validate.js:1` | `import { readFileSync } from 'fs'` | `Deno.readTextFileSync(path)` | trivial | None — same synchronous string result |
| 3 | `validate.js:2` | `import { join, basename } from 'path'` | `import { join, basename } from "jsr:@std/path"` | trivial | None — identical API |
| 4 | `validate.js:3` | `import matter from 'gray-matter'` | `import { extract } from "jsr:@std/front-matter/yaml"` | moderate | API shape change — see Note B (decision required) |
| 5 | `validate.js:61` | `readFileSync(skillMdPath, 'utf8')` | `Deno.readTextFileSync(skillMdPath)` | trivial | None |
| 6 | `validate.js:63` | `matter(raw)` → `{ data, content }` | `extract(raw)` → `{ attrs, body }` | moderate | Field rename: `data` → `attrs`, `content` → `body` — see Note B |
| 7 | `log.js:1–5` | Module-level `let verbose = true` with `setVerbose()` | No change needed (pure JS logic) | trivial | None — no Node-specific API used |
| 8 | `log.js:60` | `console.log(...)` for request logging | Optionally `jsr:@std/log` `logger.debug()`/`logger.info()` | moderate | Decision required — see Note C |
| 9 | `log.js:75` | `headers.entries()` on Fetch `Headers` object | No change — `Headers` is Web Platform API available in Deno | trivial | None |
| 10 | `log.js:46` | `rawBody.length` for byte-count display | `jsr:@std/fmt/bytes` `format(bytes)` if human-readable output desired | trivial | Enhancement only — current code shows raw char count, not formatted bytes |

---

## Permission Flags Required

| File | Flags | Reason |
|------|-------|--------|
| `validate.js` | `--allow-read` | `Deno.readDirSync` + `Deno.readTextFileSync` for skill directory scanning |
| `log.js` | none | Pure console I/O; `Headers` API is Web Platform — no Deno permission needed |

---

## Detailed Notes

### Note A — `readdirSync` vs `Deno.readDirSync` (validate.js:39, validate.js:46)

**Current code (Node):**
```js
entries = readdirSync(skillDir);          // returns string[]
entries.includes('SKILL.md')              // works directly
entries.find((e) => e.toLowerCase() === 'skill.md')
```

**Deno equivalent:**
```ts
const entries = [...Deno.readDirSync(skillDir)].map((e) => e.name);
// rest of logic is unchanged
```

`Deno.readDirSync` returns a synchronous iterator of `Deno.DirEntry` objects (`{name, isFile, isDirectory, isSymlink}`). The one-liner above converts it to `string[]` matching the current contract so no other validation logic changes. This is a **mechanical swap**, not a behavior risk, but must not be forgotten — the raw iterator is not a string array.

---

### Note B — `gray-matter` vs `@std/front-matter` (validate.js:3, 63–70) — DECISION REQUIRED

**Current gray-matter API:**
```js
const parsed = matter(raw);
const fm = parsed.data;    // frontmatter fields as object
const body = parsed.content; // markdown body after frontmatter
```

**`@std/front-matter` API:**
```ts
import { extract } from "jsr:@std/front-matter/yaml";
const parsed = extract(raw);
const fm = parsed.attrs;   // renamed: data → attrs
const body = parsed.body;  // renamed: content → body
```

Key differences to evaluate:

1. **Field rename is mechanical** (`data`→`attrs`, `content`→`body`) — low risk once noted.

2. **Error behavior differs.** `gray-matter` never throws on malformed YAML — it silently returns an empty `data` object. `@std/front-matter` throws `TypeError` if the front-matter block is malformed. The current `try/catch` around `matter(raw)` at line 63 is therefore **dead code** with gray-matter but will become live and meaningful with `@std/front-matter`. This is actually a correctness improvement — the error path was always unreachable before.

3. **No-frontmatter documents.** `gray-matter` returns `{ data: {}, content: rawText }` if no `---` delimiters are found. `@std/front-matter/extract` throws if no front-matter block is present. The validate function currently has no guard for SKILL.md files without frontmatter — this edge case needs a decision: wrap `extract()` in try/catch and treat missing frontmatter as a validation error (recommended), or use `@std/front-matter/test` first to detect presence.

   **Recommended pattern:**
   ```ts
   import { extract } from "jsr:@std/front-matter/yaml";
   import { test as hasFrontMatter } from "jsr:@std/front-matter";

   if (!hasFrontMatter(raw)) {
     errors.push("SKILL.md has no YAML front-matter block.");
     return { errors, warnings };
   }
   const parsed = extract(raw);
   const fm = parsed.attrs;
   const body = parsed.body;
   ```

4. **gray-matter extras not used here.** gray-matter supports `excerpt`, `engines`, `delimiters` options — none are used in yawcs, so no loss.

**Effort: moderate** — the API difference is small but requires understanding the error-throwing behavior change and adding a presence guard.

---

### Note C — `console.log` vs `@std/log` in `log.js` — DECISION REQUIRED

`log.js` uses raw `console.log` / `console.error` throughout. This works identically in Deno — **no migration is required for correctness**.

However, the research guide (§5.5) flags a decision point: migrate to `jsr:@std/log` for CI-friendly structured output and file handler support.

**Assessment for this file specifically:** `log.js` is a *request/response inspector* for debugging undocumented API endpoints, not a general-purpose logger. Its output is intentionally human-readable and terminal-oriented. The `verbose` guard already provides the primary filtering mechanism.

**Options:**

| Option | When to choose |
|--------|---------------|
| Keep raw `console.log` | Sufficient for interactive terminal use; zero migration cost |
| Adopt `jsr:@std/log` with `ConsoleHandler` | If yawcs ever needs CI log capture, log level filtering beyond boolean verbose, or log file output |
| Adopt `jsr:@std/log` with `--verbose` → `DEBUG` level mapping | Best practice if `--verbose` flag is plumbed through `@std/log` globally |

**Recommendation:** Keep `console.log` for now; if yawcs adopts `@std/log` globally (driven by the main entry point), this file should switch `console.log(...)` → `logger.debug(...)` and remove the manual `if (!verbose) return` guards (log level filtering handles it). That refactor is straightforward but depends on a project-wide logging decision made elsewhere.

---

### Note D — Byte/Duration formatting in `log.js:47`

Line 47 truncates body output with a raw character count:
```js
return text.slice(0, BODY_LIMIT) + `\n… [truncated, ${text.length} total chars]`;
```

The `BODY_LIMIT` constant (2048) is in characters, not bytes. If the codebase ever adds file-size reporting or build-duration output (more relevant to other files than this logger), use:

```ts
import { format as formatBytes } from "jsr:@std/fmt/bytes";
import { format as formatDuration } from "jsr:@std/fmt/duration";
```

For `log.js` itself, no change is needed — char-count truncation is the correct behavior for this use case. The `@std/fmt` imports are flagged here for awareness, not as a required change in this file.

---

## Migration Checklist

### `src/lib/validate.js`

- [ ] Replace `import { readdirSync } from 'fs'` with `Deno.readDirSync` and add `.map(e => e.name)` adapter
- [ ] Replace `import { readFileSync } from 'fs'` with `Deno.readTextFileSync`
- [ ] Replace `import { join, basename } from 'path'` with `import { join, basename } from "jsr:@std/path"`
- [ ] Replace `import matter from 'gray-matter'` with `import { extract } from "jsr:@std/front-matter/yaml"` and `import { test as hasFrontMatter } from "jsr:@std/front-matter"`
- [ ] Update destructuring: `parsed.data` → `parsed.attrs`, `parsed.content` → `parsed.body`
- [ ] Add no-frontmatter guard before `extract()` call (currently unguarded — would throw in Deno)
- [ ] Remove `gray-matter` from `package.json` / `node_modules` (no longer needed)
- [ ] Add `--allow-read` permission to shebang / `deno.json` tasks

### `src/lib/log.js`

- [ ] No required changes for Deno compatibility — file is already Deno-compatible as written
- [ ] Optional: integrate with project-wide `@std/log` if that decision is made elsewhere
- [ ] Optional: use `jsr:@std/fmt/bytes` for human-readable byte counts if truncation display is ever redesigned

---

## Open Decisions

| ID | Question | Impact | Recommendation |
|----|----------|--------|----------------|
| D1 | Should `@std/front-matter` throw on missing frontmatter be caught, or should missing frontmatter be a hard validation error? | validate.js error handling | Catch + push to `errors[]` — consistent with existing error-accumulation pattern |
| D2 | Should the project adopt `@std/log` globally (affecting log.js)? | Depends on CLI's CI/logging story | Defer until main entry point migration; revisit then |

---

*Analyzed files: `src/lib/validate.js` (130 lines), `src/lib/log.js` (85 lines). All Node built-in imports confined to validate.js; log.js uses only Web Platform APIs already available in Deno.*
