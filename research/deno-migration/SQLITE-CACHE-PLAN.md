# yawcs Cache: SQLite Migration Design Doc

**Status:** Proposal / decision aid (no code written)
**Scope:** Evaluates replacing the flat-JSON cache in `src/lib/cache.ts` with a
`node:sqlite` (`DatabaseSync`) implementation. Supersedes the "just do it"
sketch in `MIGRATION-PLAN.md` §3.3 and Risk 4 with a careful written analysis.
**Audience:** the maintainer, deciding whether to proceed.
**Verified against:** Deno 2.7 behavior. Confidence levels are stated inline
where the answer is not certain.

---

## A. Goal & Scope

### What the cache does today

`src/lib/cache.ts` is a content-addressed cache for remote claude.ai skills,
backed entirely by the filesystem:

| Path | Role |
|---|---|
| `cache/` | cache root |
| `cache/remote/{contentHash}.skill` | content-addressed ZIP blobs (one per unique content) |
| `cache/index.json` | metadata index, `Record<skillName, CacheEntry>` |
| `cache/index.json.tmp` | scratch file for the atomic tmp-write+rename |

The index entry shape is:

```ts
interface CacheEntry {
  updated_at: string;   // remote freshness key (ISO string)
  content_hash: string; // points at cache/remote/{hash}.skill
  cached_at: string;    // when we cached it (ISO string)
}
type CacheIndex = Record<string /* skillName */, CacheEntry>;
```

The blob layer is **content-addressed**: `storeRemote` hashes the ZIP via
`hashZipBuffer` (`src/lib/hash.ts`), names the file `{hash}.skill`, and skips the
write if a file with that hash already exists. Two skills (or two versions of one
skill) with byte-identical content share a single blob. The index is the only
mutable, per-skill-name layer on top.

**Every exported function is synchronous.** This is not incidental — it is a
contract that callers depend on. See the API table in §C for each signature.

### Access pattern (measured from callers)

Grepping `src/` for the cache API (`src/cli.ts`, `src/lib/api.ts`):

- `src/lib/api.ts:6` calls `ensureCache()` at module load.
- `src/lib/api.ts:166-170` (`fetchAndCacheRemoteSkill`): `isRemoteCached()` →
  on hit `getEntry()`, on miss `storeRemote()`. This is the hot path.
- `src/cli.ts:102,195` call `ensureCache()`; `:154` calls `storeRemote()`;
  `:224` calls `readCachedSkill()`.

Characterization:

- **Single-user, single-process CLI.** One invocation per command. No daemon.
- **Read-mostly.** The common case is a cache hit (`isRemoteCached` →
  `getEntry`), which touches only the index plus one `existsSync`. Writes happen
  only on a cache miss (a genuine remote change).
- **No real concurrent writers.** Two `yawcs` processes writing the same cache
  at the same instant is possible but not a workflow anyone runs.
- **Tiny scale.** yawcs caches *a user's own* remote skills — tens of entries,
  not thousands, never millions.

### What a SQLite version would change

Replace `cache/index.json` (and optionally the blob files) with a single SQLite
database opened via `node:sqlite`'s `DatabaseSync`. The exported function
signatures and their **synchronous** behavior stay identical; only the storage
engine behind them changes.

### The sync-API invariant (why `node:sqlite`, not an async store)

`node:sqlite`'s `DatabaseSync` is a **synchronous** API:
`db.prepare(sql).get(...)`, `.run(...)`, and `.all(...)` all return directly, no
promises. This is precisely why it is the right SQLite binding here. The cache
API is synchronous end to end, and `storeRemote` sits on the upload/download hot
path inside `fetchAndCacheRemoteSkill`. Switching to an async store (e.g.
`Deno.openKv`, or any `await db.execute(...)` driver) would force `await` to
propagate up through `storeRemote` → `fetchAndCacheRemoteSkill` → both CLI
handlers, and would also drag `hashZipBuffer` (currently sync via
`node:crypto`) into the same refactor. `DatabaseSync` lets us swap the engine
**without touching a single caller signature.** Preserving sync is the whole
point.

---

## B. Proposed Schema

### The BLOB question (decide this first)

The central design decision is *where the `.skill` ZIP bytes live*.

#### Option 1 — SQLite holds metadata only; blob files stay on disk

Mirrors today exactly: `cache/remote/{hash}.skill` files are untouched; SQLite
replaces only `index.json`.

```sql
CREATE TABLE IF NOT EXISTS skill_cache (
  skill_name   TEXT PRIMARY KEY,
  updated_at   TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  cached_at    TEXT NOT NULL
);

-- Optional, only if reverse lookups (hash -> skills) are ever needed.
-- Not required by any current caller; omit until there is a use.
CREATE INDEX IF NOT EXISTS idx_skill_cache_hash ON skill_cache (content_hash);
```

`skill_name` is the natural primary key — it is exactly the JSON object key
today, and `getEntry`/`isRemoteCached`/`storeRemote` all key on it. The optional
index on `content_hash` is speculative; at tens of rows a full scan is free, so
**omit it** until a feature needs hash→name lookups.

**Tradeoffs:**

- (+) Content-addressed dedup is unchanged — the existing `existsSync({hash}.skill)`
  / "skip write if present" logic carries over verbatim.
- (+) `.skill` files remain loose on disk: trivially inspectable
  (`unzip cache/remote/<hash>.skill`), copyable, and servable without going
  through SQLite.
- (+) Blobs never bloat the DB; the DB stays a few KB regardless of skill sizes.
- (+) `readCachedSkill` stays a plain `Deno.readFileSync` — no BLOB
  materialization, no row-size limits to worry about.
- (−) Two storage locations to keep consistent (DB row + file). But this is the
  *same* split that exists today (index + blob dir), so it is not a regression.
- (−) Atomicity spans two artifacts: a row insert and a file write. Today's code
  already lives with this (it writes the file, then the index) and it is
  benign — an orphan blob with no index row is harmless dead space, and
  `isRemoteCached` re-checks `existsSync` so a stale row pointing at a missing
  blob simply misses.

#### Option 2 — Blobs stored as SQLite `BLOB` columns (single-file cache)

```sql
CREATE TABLE IF NOT EXISTS blobs (
  content_hash TEXT PRIMARY KEY,
  data         BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS skill_cache (
  skill_name   TEXT PRIMARY KEY,
  updated_at   TEXT NOT NULL,
  content_hash TEXT NOT NULL REFERENCES blobs (content_hash),
  cached_at    TEXT NOT NULL
);
```

**Tradeoffs:**

- (+) True single-file cache — one `cache/cache.db`, no loose-file directory.
  Easy to delete, back up, or move atomically.
- (+) Row insert + blob write are in one transaction → genuine all-or-nothing
  atomicity for a store.
- (+) Content-addressed dedup becomes `INSERT OR IGNORE INTO blobs` keyed on the
  hash — clean semantics, same dedup guarantee.
- (−) DB bloat: skill ZIPs (KB–low MB) live in the DB file. Deleting/replacing
  rows leaves free pages that are not returned to the OS without `VACUUM`; a
  long-lived cache that churns versions slowly grows. Mitigable with
  `PRAGMA auto_vacuum=INCREMENTAL` (must be set *before* first table creation)
  or a periodic `VACUUM` on `yawcs clean`.
- (−) Default SQLite page size is 4 KB; large BLOBs spill across overflow pages.
  Fine for KB-MB skills, but it is strictly more I/O than a flat file read.
- (−) You lose direct inspectability: `unzip` no longer works on the cache; you
  need a SQL query + extract step to look at or serve a `.skill`.
- (−) `readCachedSkill` must materialize the BLOB into a `Uint8Array` from the
  row (`row.data` comes back as a `Uint8Array` under `node:sqlite` — confidence:
  high), which is fine functionally but couples reads to the DB handle.

### Recommendation: **Option 1 (metadata-only)**

For yawcs's scale and access pattern, Option 1 wins clearly:

1. It preserves the content-addressed blob layer *exactly*, so `hashZipBuffer`,
   the dedup write, and `readCachedSkill` need near-zero change.
2. Inspectability matters for a developer tool whose whole job is producing and
   shipping `.skill` ZIPs. Keeping them as loose, `unzip`-able files is a
   feature, not an accident.
3. The single-file portability win of Option 2 is the *only* thing it buys here,
   and yawcs does not need it — nobody is shipping the cache around, and `cache/`
   is already a single deletable directory.
4. It sidesteps VACUUM/bloat/page-size concerns entirely.

Option 2 would only become attractive if yawcs grew a need for atomic
backup/restore of the whole cache or had thousands of tiny blobs where per-file
filesystem overhead dominated. Neither is true.

---

## C. API Mapping (`node:sqlite` / `DatabaseSync`)

The exported signatures and synchronous behavior are **unchanged**. Only bodies
change. Under Option 1 the `.skill` files and `hashZipBuffer` call are untouched.

### DB handle lifecycle

Keep a module-level lazily-opened singleton, opened inside `ensureCache()` (the
one function every entry point already calls — `api.ts:6`, `cli.ts:102,195`):

```ts
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";

const CACHE_ROOT = "cache";
const CACHE_REMOTE = join(CACHE_ROOT, "remote");
const DB_PATH = join(CACHE_ROOT, "cache.db");

let db: DatabaseSync | null = null;

export function ensureCache(): void {
  Deno.mkdirSync(CACHE_REMOTE, { recursive: true });
  if (db) return;
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode=WAL");      // see note below
  db.exec("PRAGMA foreign_keys=ON");        // harmless under Option 1
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_cache (
      skill_name   TEXT PRIMARY KEY,
      updated_at   TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      cached_at    TEXT NOT NULL
    )
  `);
}

function getDb(): DatabaseSync {
  if (!db) ensureCache();
  return db!;
}
```

**WAL mode** (`PRAGMA journal_mode=WAL`): set once at open. It improves
concurrent read/write behavior and crash durability versus the default rollback
journal. For yawcs's single-writer reality it is mostly insurance, but it is
cheap and the right default. Note WAL creates sidecar files (`cache.db-wal`,
`cache.db-shm`) next to the DB — `yawcs clean` and any `.gitignore` must account
for all three.

### Function-by-function mapping

| Current function | Sync? | SQLite implementation |
|---|---|---|
| `ensureCache()` | yes | `mkdirSync` remote dir + lazy-open DB + `PRAGMA` + `CREATE TABLE IF NOT EXISTS` (above). |
| `readIndex(): CacheIndex` | yes | `SELECT *` → rebuild the `Record`. Kept for API/back-compat; see snippet. |
| `writeIndex(index)` | yes | Replace whole table in a transaction (`DELETE` + bulk `INSERT OR REPLACE`). Rarely needed once `storeRemote` writes a single row directly. |
| `getEntry(name): CacheEntry \| null` | yes | `SELECT ... WHERE skill_name = ?`.get(name) → row or null. |
| `isRemoteCached(name, updatedAt): boolean` | yes | `getEntry` + `updated_at === updatedAt` + `existsSync({hash}.skill)` (unchanged blob check under Option 1). |
| `storeRemote(name, updatedAt, buf): string` | yes | `hashZipBuffer(buf)` (unchanged) → dedup write `{hash}.skill` (unchanged) → single `INSERT OR REPLACE` row. |
| `cachePath(hash): string` | yes | Unchanged — `join(CACHE_REMOTE, ${hash}.skill)`. |
| `readCachedSkill(hash): Uint8Array \| null` | yes | Unchanged — `existsSync` + `Deno.readFileSync`. |

### Representative prepared-statement snippets

```ts
export function getEntry(skillName: string): CacheEntry | null {
  const row = getDb()
    .prepare(
      "SELECT updated_at, content_hash, cached_at FROM skill_cache WHERE skill_name = ?",
    )
    .get(skillName) as CacheEntry | undefined;
  return row ?? null;
}

export function storeRemote(
  skillName: string,
  updatedAt: string,
  buf: Uint8Array,
): string {
  const contentHash = hashZipBuffer(buf);                 // unchanged
  const skillPath = join(CACHE_REMOTE, `${contentHash}.skill`);
  if (!existsSync(skillPath)) Deno.writeFileSync(skillPath, buf); // unchanged dedup

  getDb()
    .prepare(`
      INSERT INTO skill_cache (skill_name, updated_at, content_hash, cached_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(skill_name) DO UPDATE SET
        updated_at   = excluded.updated_at,
        content_hash = excluded.content_hash,
        cached_at    = excluded.cached_at
    `)
    .run(skillName, updatedAt, contentHash, new Date().toISOString());

  return contentHash;
}

export function readIndex(): CacheIndex {
  const rows = getDb()
    .prepare("SELECT skill_name, updated_at, content_hash, cached_at FROM skill_cache")
    .all() as Array<CacheEntry & { skill_name: string }>;
  const out: CacheIndex = {};
  for (const r of rows) {
    out[r.skill_name] = {
      updated_at: r.updated_at,
      content_hash: r.content_hash,
      cached_at: r.cached_at,
    };
  }
  return out;
}
```

Statements can be prepared once and cached at module scope rather than per call;
at this volume it does not matter, so prepare-on-use is fine and keeps the code
simple.

---

## D. Migration Strategy

Two acceptable paths. Pick based on how much existing-cache continuity is worth.

### Path 1 — One-time import (preserve existing caches)

On first run under the SQLite build, inside `ensureCache()` after the table is
created:

1. If `cache/index.json` exists, read and `JSON.parse` it.
2. For each `[skillName, entry]`, run an idempotent
   `INSERT INTO skill_cache (...) ... ON CONFLICT(skill_name) DO UPDATE SET ...`
   (i.e. `INSERT OR REPLACE` semantics) inside a single transaction.
3. `Deno.renameSync("cache/index.json", "cache/index.json.migrated")` so the
   import runs exactly once and the old file is preserved as a manual fallback.

```ts
function migrateJsonIndexIfPresent(): void {
  if (!existsSync(INDEX_PATH)) return;
  let parsed: CacheIndex;
  try {
    parsed = JSON.parse(Deno.readTextFileSync(INDEX_PATH));
  } catch {
    return; // malformed -> treat as no prior cache, same as today's readIndex
  }
  const stmt = getDb().prepare(`
    INSERT INTO skill_cache (skill_name, updated_at, content_hash, cached_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(skill_name) DO UPDATE SET
      updated_at = excluded.updated_at,
      content_hash = excluded.content_hash,
      cached_at = excluded.cached_at
  `);
  getDb().exec("BEGIN");
  for (const [name, e] of Object.entries(parsed)) {
    stmt.run(name, e.updated_at, e.content_hash, e.cached_at);
  }
  getDb().exec("COMMIT");
  Deno.renameSync(INDEX_PATH, INDEX_PATH + ".migrated");
}
```

**Blob files need no migration.** Under Option 1 the content-addressed
`cache/remote/{hash}.skill` files are exactly where the new code expects them.
The imported rows' `content_hash` values already point at them. This is the key
simplification of choosing Option 1 — the expensive-to-move artifacts (the
blobs) do not move.

Idempotent and safe to re-run: the conflict clause makes re-import a no-op, and
the rename guarantees it runs once anyway.

### Path 2 — Clean break (cheaper, acceptable here)

yawcs is **not in wide deployment** (stated in `MIGRATION-PLAN.md` §1 invariants
and Risk 1). So a clean break is legitimate: on first SQLite run, ignore
`index.json` entirely; the cache simply starts empty and re-populates on the
next `download`. Re-downloading a handful of skills costs seconds. This deletes
the entire `migrateJsonIndexIfPresent` code path and its tests.

### `yawcs clean` escape hatch

There is **no `clean` command today** (grep of `src/cli.ts` finds only a SIGINT
comment). Either path should ship alongside a new `yawcs clean` subcommand that
removes the whole `cache/` tree (DB + WAL sidecars + `remote/` blobs +
`index.json.migrated`), giving users a one-command reset if migration or the new
format misbehaves. This is cheap to add and is the documented remedy referenced
throughout the migration plan.

### Recommendation

Given the no-wide-deployment reality, **Path 2 (clean break) + a `yawcs clean`
command** is the better cost/benefit: it removes import code, removes Risk 4's
migration-correctness test surface, and the only user-visible cost is one extra
re-download. Offer Path 1 only if a maintainer specifically values cache
continuity for early users.

---

## E. Pros & Cons vs the Current JSON Cache

Balanced, not a pitch. Several columns favor JSON for yawcs specifically.

| Dimension | JSON (today) | SQLite (`node:sqlite`) |
|---|---|---|
| **Concurrency safety** | tmp-file + `renameSync` makes the index write atomic *per write*; two concurrent writers can still last-writer-wins clobber each other's index. | WAL gives real multi-reader/single-writer safety + row-level `INSERT OR REPLACE` avoids whole-file clobber. **But** the CLI is single-process — this advantage is largely theoretical here. |
| **Transactional multi-row update** | none — whole index is one JSON blob, rewritten wholesale. | native `BEGIN/COMMIT`; partial failures roll back. Marginal value: the only multi-row op is the one-time import. |
| **Query / filter flexibility** | must `JSON.parse` everything then filter in JS. | `WHERE`/`ORDER BY`/aggregates in SQL. Nice if features grow (e.g. "list skills cached before date X"), unused today. |
| **Corruption resistance** | a half-written index is prevented by rename; a fully-written-but-bad JSON is handled (`readIndex` warns + returns `{}`). | WAL + transactions resist torn writes; a corrupt DB is harder to hand-repair than re-saving a JSON file. |
| **Storage shape** | index.json + `remote/` blob dir (two artifacts). | Option 1: cache.db + `remote/` (still two). Option 2: one file. No net simplification under the recommended Option 1. |
| **Human-readability / git-diffability** | `index.json` is plain text — readable, greppable, diffable, hand-editable. | binary `.db` — opaque without `sqlite3`. A real regression for debuggability. (`cache/` is git-ignored regardless, so diffability matters only for local inspection.) |
| **Dependency surface** | `@std/fs` + `Deno.*` only. | adds `node:sqlite`. No npm dep, no `node_modules`. |
| **Deno permissions** | `--allow-read`/`--allow-write` (already required). | **same** — `node:sqlite` needs only read/write on the DB path; no extra flag. Confidence: high. |
| **Unstable flag** | n/a | `node:sqlite` is **stable in Deno 2.7** (it left `--unstable-node-sqlite` earlier in the 2.x line). No `--unstable-*` needed. Confidence: high; verify with `deno eval 'import {DatabaseSync} from "node:sqlite"; new DatabaseSync(":memory:")'` on the pinned Deno before committing. |
| **`deno compile` bundling** | trivially bundles. | `node:sqlite` is built into the Deno runtime (native), so it is present in any `deno compile` binary without a separate native addon. Confidence: high; the §3.2 compile-verify step should add a smoke test that opens an in-memory DB in the compiled binary. |
| **Binary-size impact** | none. | none meaningful — the SQLite engine is already compiled into the Deno binary; using it adds no measurable size. Confidence: medium-high. |
| **Code complexity** | ~140 lines, no schema, no DDL. | adds schema/DDL, handle lifecycle, PRAGMAs, WAL sidecar cleanup, prepared statements. Net more code and more concepts. |
| **Testability** | trivial — write JSON fixtures, assert files. | `:memory:` DBs make unit tests clean and fast; but you also must test WAL sidecar cleanup and (if Path 1) import correctness. |

### Where the JSON cache is genuinely the better choice

- **Simplicity.** ~140 lines, zero schema, zero DDL, one file format everyone
  already understands. For a tool this size that is real value.
- **Tiny scale.** At tens of read-mostly entries, every SQLite advantage
  (indexing, query planning, transactional throughput) is below the noise floor.
  A `JSON.parse` of a few-KB file is instant.
- **Transparency / debuggability.** `cat cache/index.json` and
  `unzip cache/remote/<hash>.skill` are the entire debugging story today. SQLite
  replaces `cat` with "open a DB tool," a strict downgrade for a dev tool.
- **No concurrent writers in practice.** The headline SQLite win (concurrency)
  addresses a problem yawcs does not have.

---

## F. Recommendation

**Defer it. Do not migrate the cache to SQLite as part of this Deno migration.**

Reasoning:

1. **The migration's stated value props do not apply at yawcs's scale.** SQLite
   earns its keep with concurrent writers, large/queried datasets, and
   transactional multi-row workloads. yawcs is a single-user, single-process,
   read-mostly CLI caching *tens* of entries with no real concurrency. The
   tmp-file+rename JSON index already gives per-write atomicity and graceful
   handling of a malformed index. There is no problem here that SQLite uniquely
   solves.

2. **It adds permanent complexity for a theoretical benefit.** Schema, DDL, WAL
   sidecar management, handle lifecycle, and prepared statements are ongoing
   surface area. The recommended Option 1 does not even consolidate storage —
   it is still "metadata store + `remote/` blob dir," same as today — so the
   single-file simplification never materializes.

3. **It costs debuggability,** trading a `cat`-able text index for an opaque
   binary file, which is a net negative for a developer tool.

4. **It is correctly already marked optional and non-blocking** in
   `MIGRATION-PLAN.md` §3.3 ("a deliberate scope break ... can ship after Phase
   3.1/3.2"). Nothing about the Deno port or single-binary distribution depends
   on it.

**Concrete guidance for the maintainer:**

- Ship the Deno migration with the flat-JSON cache (Phase 2.2 as planned).
- Add the `yawcs clean` subcommand now anyway — it is independently useful and
  cheap.
- Revisit SQLite **only** if a future feature actually needs it: a daemon/watch
  mode with concurrent writers, multi-machine/shared caches, rich cache queries,
  or entry counts in the thousands. If that day comes, this doc's Option 1 +
  clean-break (Path 2) + `node:sqlite` `DatabaseSync` is the path — preserving
  the synchronous API contract is the design constraint that makes it a
  drop-in.

**The key tradeoff that drove this:** SQLite's one real advantage for yawcs —
concurrency/transaction safety — addresses a problem a single-user single-process
CLI does not have, while its costs (added complexity, lost text-file
transparency, no storage consolidation under the recommended metadata-only
option) are paid every day. At this scale the flat-JSON cache is not a stopgap;
it is the better-fitting design.
