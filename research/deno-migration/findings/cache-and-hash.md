# Deno Migration Findings: `src/lib/cache.js` + `src/lib/hash.js`

## Summary Table

| # | File:Line(s) | Current Node API / Dep | Deno-Native Replacement | Effort | Behavior Risk |
|---|---|---|---|---|---|
| 1 | cache.js:1 | `import { existsSync } from 'fs'` | `Deno.statSync` / `jsr:@std/fs/exists` | trivial | none |
| 2 | cache.js:1 | `import { mkdirSync } from 'fs'` | `Deno.mkdirSync` / `Deno.mkdir` | trivial | none |
| 3 | cache.js:1 | `import { readFileSync } from 'fs'` | `Deno.readFileSync` / `Deno.readTextFile` | trivial | encoding param differs |
| 4 | cache.js:1 | `import { writeFileSync } from 'fs'` | `Deno.writeFileSync` / `Deno.writeTextFile` | trivial | none |
| 5 | cache.js:1 | `import { renameSync } from 'fs'` | `Deno.renameSync` | trivial | none |
| 6 | cache.js:2 | `import { join } from 'path'` | `import { join } from "jsr:@std/path"` | trivial | none |
| 7 | cache.js (all) | Flat JSON file index (INDEX_PATH) | `node:sqlite` `DatabaseSync` (DECISION REQUIRED) | involved | schema design choice |
| 8 | cache.js:40–42 | Atomic write via tmp+rename | `Deno.writeTextFile` + `Deno.renameSync` (or SQLite transaction) | trivial/moderate | N/A if SQLite chosen |
| 9 | hash.js:1 | `import { createHash } from 'crypto'` | `jsr:@std/crypto` `crypto.subtle` (Web Crypto) | moderate | API async vs sync (see note) |
| 10 | hash.js:2 | `import { readdirSync, readFileSync, statSync } from 'fs'` | `Deno.readdirSync` / `Deno.readFileSync` / `Deno.statSync` | trivial | none |
| 11 | hash.js:3 | `import { join, relative } from 'path'` | `import { join, relative } from "jsr:@std/path"` | trivial | none |
| 12 | hash.js:4 | `import AdmZip from 'adm-zip'` | `import AdmZip from "npm:adm-zip"` (bridge) or `jsr:@std/archive` (goal) | moderate/involved | API differs if @std/archive |

---

## Required Permission Flags

| Flag | Reason |
|---|---|
| `--allow-read` | `readFileSync`, `existsSync`, directory walking (`readdirSync`, `statSync`) |
| `--allow-write` | `writeFileSync`, `renameSync`, `mkdirSync` |

No network, subprocess, or env access in these two files.

---

## Detailed Notes

### 1–6. `fs` and `path` imports (cache.js:1–2, hash.js:2–3)

All `fs`/`path` Node built-ins have direct Deno equivalents:

- `existsSync(p)` → `Deno.statSync(p)` wrapped in try/catch (returns `false` on `NotFound`), or import `{ exists } from "jsr:@std/fs/exists"` for the ergonomic async form, or `existsSync` from `"jsr:@std/fs"`.
- `mkdirSync(p, { recursive: true })` → `Deno.mkdirSync(p, { recursive: true })` (identical signature).
- `readFileSync(p, 'utf8')` → `Deno.readTextFileSync(p)` (UTF-8 by default; no encoding param needed). For binary reads (the `.skill` buffer read in `readCachedSkill`): `Deno.readFileSync(p)` returns `Uint8Array`, not `Buffer` — see item 13 below.
- `writeFileSync(p, data)` → `Deno.writeFileSync(p, data)` for `Uint8Array`; `Deno.writeTextFileSync(p, str)` for strings.
- `renameSync(src, dst)` → `Deno.renameSync(src, dst)` (identical).
- `join` / `relative` → `import { join, relative } from "jsr:@std/path"` (identical API).

These are all **trivial mechanical swaps**.

---

### 7. Flat-JSON cache index → `node:sqlite` (DECISION REQUIRED)

**Current design (cache.js:5–8, 23–43, 51–103):**

The entire cache state lives in a single flat JSON file (`cache/index.json`) structured as:

```json
{
  "skill-name": {
    "updated_at": "...",
    "content_hash": "abc123",
    "cached_at": "..."
  }
}
```

This is read-in-full on every operation (`readIndex()`) and written-in-full on every mutation (`writeIndex()`). The atomic write is implemented manually via a `tmp` file + `renameSync`.

**Recommended replacement:** `node:sqlite` (`DatabaseSync`) per the research guide §2.8 and §3.8:

```typescript
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(join(CACHE_ROOT, "cache.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS skill_cache (
    skill_name   TEXT PRIMARY KEY,
    updated_at   TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    cached_at    TEXT NOT NULL
  )
`);
```

Benefits:
- Transactions replace the manual tmp+rename pattern (atomicity handled by SQLite WAL).
- Queries replace full-JSON-parse on every read.
- `DatabaseSync` is synchronous — no async/await plumbing changes needed in callers.
- Available in Deno 2.2+ via `node:sqlite` compat layer.

**Decision required:** This is not a mechanical swap — it requires choosing a schema, migrating any existing `cache/index.json` files on first run (or documenting a clean-break), and rewriting `readIndex`, `writeIndex`, `getEntry`, `isRemoteCached`, and `storeRemote` in terms of SQL statements rather than object mutation. The public API surface of these functions can remain identical; the internals change substantially.

**Alternative:** Keep the flat-JSON approach during initial migration (use `Deno.readTextFileSync`/`Deno.writeTextFileSync` + `Deno.renameSync`). This is lower risk and preserves existing cache files. Migrate to SQLite in a follow-up.

---

### 8. Atomic write (cache.js:39–42)

```js
writeFileSync(INDEX_TMP, JSON.stringify(index, null, 2));
renameSync(INDEX_TMP, INDEX_PATH);
```

If keeping flat JSON: swap to `Deno.writeTextFileSync` + `Deno.renameSync` — **trivial**.

If migrating to SQLite: this pattern is entirely replaced by a single `INSERT OR REPLACE` inside an implicit SQLite transaction — the tmp file and rename disappear entirely.

---

### 9. `createHash` from `node:crypto` (hash.js:1, 43–51)

**Current use in `canonicalHash`:**

```js
const outer = createHash('sha256');
// ...
const innerHex = createHash('sha256').update(data).digest('hex');
outer.update(path + '\0');
outer.update(innerHex + '\n');
return outer.digest('hex');
```

This is a **streaming, synchronous** SHA-256 use: multiple `.update()` calls followed by `.digest('hex')`.

**Deno-native replacement options:**

**Option A — `jsr:@std/crypto` `crypto` helper (recommended):**

```typescript
import { crypto } from "jsr:@std/crypto";

// @std/crypto wraps Web Crypto with sync-friendly utilities
// but digest() returns Promise<ArrayBuffer> — see caveat below
const hashBuf = await crypto.subtle.digest("SHA-256", data);
const hex = Array.from(new Uint8Array(hashBuf))
  .map(b => b.toString(16).padStart(2, "0")).join("");
```

**Caveat — async vs sync:** Web Crypto's `crypto.subtle.digest()` is **async** (`Promise<ArrayBuffer>`), unlike Node's synchronous `createHash(...).update(...).digest('hex')`. The `canonicalHash` function is currently synchronous and called from synchronous callers (`hashSkillDir`, `hashZipBuffer`). Making it async propagates `await` through `storeRemote` in `cache.js` and potentially into the CLI command layer. This is **moderate** effort — the logic is simple, but the async propagation touches callers.

**Option B — `node:crypto` compat shim:** Deno 2.x ships `node:crypto` as a compatibility layer. Changing only the import specifier from `'crypto'` to `'node:crypto'` would work with zero logic changes. This is **trivial** but not idiomatic Deno.

**Option C — `jsr:@std/crypto` `toHashString` + synchronous approach:** `@std/crypto` v1.x provides `toHashString(hash, "hex")` as a convenience, but `digest` remains async.

**Recommendation:** Use `node:crypto` as a bridge import (`'node:crypto'` specifier) to keep the synchronous contract intact during initial migration. Plan a follow-up to convert `canonicalHash` to async and adopt `jsr:@std/crypto` or `crypto.subtle` directly.

**Behavior risk:** The hash algorithm and output format must remain identical (`sha256`, lowercase hex) because existing cached `.skill` files are named by their content hash. Any change to the hashing logic invalidates all cached files.

---

### 10–11. `fs` directory-walk APIs (hash.js:2, `walkDir` function, lines 13–24)

```js
readdirSync(dir)       // lists dir entries as strings
statSync(full).isDirectory()
readFileSync(abs)      // returns Buffer
```

Deno equivalents:

- `Deno.readdirSync(dir)` returns `Iterable<Deno.DirEntry>` objects (with `.name`, `.isDirectory`, `.isFile` properties) — **not plain strings**. The `walkDir` inner loop must change from `for (const entry of readdirSync(dir))` (string) to `for (const entry of Deno.readdirSync(dir))` using `entry.name` and `entry.isDirectory` directly, eliminating the `statSync` call entirely. **Trivial** but requires the loop rewrite.
- `Deno.readFileSync(abs)` returns `Uint8Array` (not Node `Buffer`). The `data` values passed into `canonicalHash` will be `Uint8Array` — this is compatible with `crypto.subtle.digest` which accepts `BufferSource`. **No behavior change.**
- `Deno.statSync` is still available if needed, but `Deno.readdirSync` entries already expose `isDirectory` — removes the need for a stat call per entry.

---

### 12. `adm-zip` dependency (hash.js:4, 83–92)

**Current use in `hashZipBuffer`:**

```js
const zip = new AdmZip(buf);
for (const entry of zip.getEntries()) {
  if (entry.isDirectory) continue;
  const parts = entry.entryName.split('/');
  const relPath = parts.slice(1).join('/');
  files.push({ path: relPath, data: entry.getData() });
}
```

**Bridge option:** Change `import AdmZip from 'adm-zip'` to `import AdmZip from "npm:adm-zip"`. The API is identical. Works immediately, bundled into `deno compile` output as of Deno 2.3. **Trivial.**

**Migration-goal option:** Replace with `jsr:@std/archive`. However, `@std/archive` currently supports tar natively; ZIP support is in progress / limited. **Decision required** — verify current `@std/archive` ZIP read capability before committing. If ZIP read is not yet stable in `@std/archive`, keep `npm:adm-zip` as the long-term choice rather than a temporary bridge.

**Behavior risk (hash correctness):** `entry.getData()` on `adm-zip` decompresses and returns the raw file bytes. Any replacement must return the same bytes — the content hash depends on exact file content. If `@std/archive` decompresses identically, hashes match; if there are any differences (e.g., line-ending normalization), all cached hashes would be invalidated. This must be verified with a test fixture before switching.

---

### 13. `Buffer` vs `Uint8Array` (cache.js:118–125, hash.js throughout)

Node's `Buffer` is a subclass of `Uint8Array` and is used implicitly in several places:

- `readCachedSkill` returns `Buffer | null` (cache.js:121).
- `storeRemote` accepts `buf: Buffer` and passes it to `writeFileSync` and `hashZipBuffer` (cache.js:85).
- `hashZipBuffer` receives a `Buffer`, passes it to `AdmZip(buf)`, and uses `entry.getData()` which returns `Buffer`.

In Deno, `Deno.readFileSync` returns `Uint8Array`. `npm:adm-zip` accepts `Buffer` or `Uint8Array` interchangeably. `Deno.writeFileSync` requires `Uint8Array`. The types align in practice, but any TypeScript type annotations referencing `Buffer` must change to `Uint8Array`. **Trivial** once the `node:crypto` / `fs` imports are resolved.

---

## Items Requiring a Decision (not mechanical swaps)

| Decision | Options | Recommendation |
|---|---|---|
| **Cache storage backend** | Keep flat-JSON (low risk, bridge) vs migrate to `node:sqlite` (correct long-term) | SQLite in a dedicated pass; flat-JSON for initial migration |
| **Crypto API sync vs async** | `node:crypto` shim (sync, trivial) vs `jsr:@std/crypto` / `crypto.subtle` (async, requires caller refactor) | `node:crypto` bridge first; async migration as follow-up |
| **adm-zip bridge vs @std/archive** | `npm:adm-zip` specifier (trivial, works now) vs `jsr:@std/archive` (idiomatic, ZIP support unclear) | Use `npm:adm-zip` bridge; evaluate `@std/archive` ZIP status before committing |
| **Cache file migration** | SQLite migration must either import existing `index.json` on first run or document a clean-break invalidation | Clean-break is simpler; document that users should run `yawcs clean` once |
