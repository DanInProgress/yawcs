# Migration Catalog: `src/lib/api.js` & `src/lib/auth.js`

**Focus areas:** fetch() calls & headers, dotenv → Deno native env, multipart/file uploads,
OTel fetch instrumentation slot, `readFileSync` usage, required permission flags.

---

## Summary Table

| # | File:Line(s) | Current Node API / Dep | Deno-Native Replacement | Effort | Behavior Risk |
|---|---|---|---|---|---|
| 1 | auth.js:1-2 | `import { config } from 'dotenv'; config()` | Delete both lines; use `Deno.env.get()` throughout | Trivial | `.env` loading must move to launch script or `deno task` |
| 2 | auth.js:9,21,22,33 | `process.env.CLAUDE_SESSION_KEY` etc. | `Deno.env.get("CLAUDE_SESSION_KEY")` | Trivial | Needs `--allow-env` flag |
| 3 | auth.js:16 | `process.exit(1)` | `Deno.exit(1)` | Trivial | None |
| 4 | api.js:1 | `import { readFileSync } from 'fs'` | `await Deno.readFile(skillPath)` (returns `Uint8Array`) | Trivial | Sync → async; callers are already async |
| 5 | api.js:2 | `import { basename } from 'path'` | `import { basename } from "jsr:@std/path"` | Trivial | None |
| 6 | api.js:26,81,104,139 | `fetch()` global (Node 18+ built-in) | `fetch()` global (Deno built-in, no import) | Trivial | Needs `--allow-net` for `claude.ai` |
| 7 | api.js:66-67 | `readFileSync(skillPath)` → `Buffer` → `new Blob([buffer])` | `await Deno.readFile(skillPath)` → `new Blob([uint8Array])` | Trivial | `Blob` ctor accepts `Uint8Array`; behavior identical |
| 8 | api.js:146 | `Buffer.from(await res.arrayBuffer())` | `new Uint8Array(await res.arrayBuffer())` | Trivial | Downstream `storeRemote()` in cache.js must accept `Uint8Array` instead of `Buffer` |
| 9 | api.js:185 | `new Date(s.updated_at).toLocaleString()` | `Temporal.Now` / `Intl.DateTimeFormat` or keep as-is | Trivial | `Date` works fine in Deno; Temporal upgrade is optional |
| 10 | auth.js (whole file) | `dotenv` npm package | Removed entirely | Trivial | See note §3 |
| 11 | api.js + auth.js | OTel: no instrumentation today | Zero-code: set `DENO_OTEL_EXPORTER_OTLP_ENDPOINT` env var | Zero | Automatic fetch span capture via Deno 2.4+ runtime |

**Required permission flags implied by these two files:**

```
--allow-env        # Deno.env.get() in auth.js
--allow-net=claude.ai  # all fetch() calls in api.js
--allow-read       # Deno.readFile() in api.js (skillPath)
```

---

## Detailed Notes

### 1. dotenv → Deno native env (`auth.js:1-2`)

**Current:**
```js
import { config } from 'dotenv';
config(); // silently no-ops if .env is absent
```

**Deno replacement:** Delete both lines entirely. Deno does not auto-load `.env` files — this is a behavioral change that needs a decision (see §Decision A below).

**Decision A — `.env` loading strategy:** Three options:
1. **`deno task` with `--env-file`** — `deno run --env-file=.env ...` auto-loads `.env` before the process starts. Zero code change, just update `deno.json` tasks. This is the recommended approach.
2. **`jsr:@std/dotenv`** — `import { load } from "jsr:@std/dotenv"; await load({ export: true });` — functionally equivalent to the current `dotenv` call. Use if the project must be runnable without `deno task` (e.g., direct `deno run` or `deno compile`d binary).
3. **Drop `.env` support** — require users to export env vars in their shell. Simpler but worse DX for a CLI tool.

**Recommendation:** Use `--env-file` in `deno.json` tasks for development; for the compiled binary, document that env vars must be exported in the shell. If the `.env` file must be auto-loaded at runtime inside the binary, use `jsr:@std/dotenv`.

---

### 2. `process.env.*` → `Deno.env.get()` (`auth.js:9,21,22,33`)

**Current:**
```js
const sessionKey = process.env.CLAUDE_SESSION_KEY;
if (process.env.CF_CLEARANCE) ...
if (process.env.CF_BM) ...
const userAgent = process.env.USER_AGENT;
```

**Deno replacement:**
```ts
const sessionKey = Deno.env.get("CLAUDE_SESSION_KEY");
if (Deno.env.get("CF_CLEARANCE")) ...
if (Deno.env.get("CF_BM")) ...
const userAgent = Deno.env.get("USER_AGENT");
```

Effort: trivial search-and-replace. Requires `--allow-env` (or `--allow-env=CLAUDE_SESSION_KEY,CF_CLEARANCE,CF_BM,USER_AGENT` for least-privilege).

---

### 3. `process.exit()` → `Deno.exit()` (`auth.js:16`)

Mechanical swap. No behavior difference. Part of the broader `process.*` removal sweep.

---

### 4. `readFileSync` → `Deno.readFile` (`api.js:1,66-67`)

**Current:**
```js
import { readFileSync } from 'fs';
// ...
const buffer = readFileSync(skillPath);          // returns Buffer
const blob = new Blob([buffer], { type: 'application/zip' });
```

**Deno replacement:**
```ts
const bytes = await Deno.readFile(skillPath);   // returns Uint8Array
const blob = new Blob([bytes], { type: 'application/zip' });
```

`Blob` accepts `Uint8Array` directly — the multipart upload behavior is identical. The switch from sync to async is safe because `upload()` is already `async`. Requires `--allow-read`.

---

### 5. `basename` from `path` → `jsr:@std/path` (`api.js:2`)

**Current:**
```js
import { basename } from 'path';
```

**Deno replacement:**
```ts
import { basename } from "jsr:@std/path";
```

One-line swap; API is identical.

---

### 6. `fetch()` calls (`api.js:26,81,104,139`)

`fetch()` is a global in both Node 18+ and Deno — the call sites in `api.js` require zero code changes. The only migration action is adding `--allow-net=claude.ai` to the permission set.

**Header management pattern** (api.js:77, api.js:135) — the current code does:
```js
const headers = getBaseHeaders();
delete headers['content-type'];
```

This works identically in Deno. No change needed. The comment at api.js:73-76 correctly explains why `content-type` must not be set for `FormData` bodies — Deno's native `fetch` respects the same Web Platform spec behavior.

---

### 7. `Buffer.from(await res.arrayBuffer())` → `Uint8Array` (`api.js:146`)

**Current:**
```js
const buf = Buffer.from(await res.arrayBuffer());
```

**Deno replacement:**
```ts
const buf = new Uint8Array(await res.arrayBuffer());
```

**Behavior risk (moderate):** `Buffer` is a Node-specific subclass of `Uint8Array` with extra methods (`.toString('hex')`, `.toString('base64')`, etc.). The returned `buf` is passed to `storeRemote()` in `cache.js`. Before making this change, confirm that `cache.js` does not call any `Buffer`-specific methods on it. If it does, those must be migrated simultaneously (use `jsr:@std/encoding` for hex/base64, or the Web Crypto API). This is a **cross-file dependency** that must be resolved as a coordinated change.

---

### 8. OTel fetch instrumentation slot (`api.js` — all `fetch()` calls)

There is no OTel instrumentation today. In Deno 2.4+, `fetch()` calls are **automatically captured as spans** when the OTLP endpoint env var is set — no code changes are required:

```bash
DENO_OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317 deno run --allow-net mod.ts
```

The existing `logRequest` / `logResponse` calls (api.js:24,28,79,83,103,107,141,147) serve a similar observability purpose. After the Deno migration, these can be kept as-is for human-readable debug output, or replaced/supplemented by `jsr:@std/log` structured logging which integrates cleanly with OTel log records.

**Decision B — OTel adoption:** The OTel integration requires zero code change; the only action is deciding whether to expose `DENO_OTEL_EXPORTER_OTLP_ENDPOINT` as a documented env var in `.env.example`. The existing verbose logging can coexist with OTel spans.

---

### 9. `new Date(s.updated_at).toLocaleString()` (`api.js:185`)

This works identically in Deno. No migration required. Optional upgrade to `Temporal` if relative-time display ("3 days ago") is wanted in the future.

---

## Files Completely Free of Node APIs After This Group's Changes

After applying items 1–9 above:
- `auth.js` — fully Deno-native (no `process`, no `dotenv`, no Node imports)
- `api.js` — fully Deno-native except for the `Buffer` in `downloadSkillFile`, which requires a coordinated fix with `cache.js`

## Cross-File Dependency: `cache.js`

The `Buffer` returned by `downloadSkillFile` (api.js:146) is passed directly to `storeRemote()` (cache.js). Migrating api.js:146 to `Uint8Array` is blocked on — or must be coordinated with — the cache.js migration group. Flag this as a **hard dependency**.

---

## Permission Flag Summary

| Flag | Why needed |
|---|---|
| `--allow-env` | `Deno.env.get()` in auth.js for all session/cookie env vars |
| `--allow-net=claude.ai` | All `fetch()` calls in api.js target `https://claude.ai/api` |
| `--allow-read` | `Deno.readFile(skillPath)` in api.js `upload()` function |

No `--allow-write` or `--allow-run` is implied by these two files alone.
