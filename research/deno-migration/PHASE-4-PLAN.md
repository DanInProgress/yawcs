# yawcs Deno Migration — Phase 4 (Remaining Work)

**Status at time of writing:** Phases 0–3 are complete and committed on branch `deno-migration`.
The codebase is fully Deno-native: no `package.json`, no `node_modules`, no `Makefile`; the CLI
runs from `mod.ts` → `src/cli.ts`, type-checks (`deno check mod.ts`), lints, formats, passes
`deno test` (6/6), and cross-compiles to standalone binaries for linux-x64 / macos-arm64 /
windows-x64 via `deno task build`.

This document is a **self-contained handoff** for the remaining Phase 4 items. None of these block a
working release — they are quality/cleanup follow-ups. Each item below is independently shippable and
can be done in any order unless a dependency is noted. See `MIGRATION-PLAN.md` §3 (Phase 4) and §5
(Risks) for the original sketches; this doc supersedes and expands them for execution.

---

## Orientation for a fresh agent

- **Run from the repo root.** Branch: `deno-migration`.
- **Verification commands** (the bar every change must clear):
  ```bash
  deno fmt --check
  deno lint
  deno check mod.ts
  deno test --allow-read --allow-write
  deno task build            # optional but recommended for items touching imports/deps
  ```
- **Conventions already in force** (do not regress these):
  - Internal imports use the `.ts` extension (`import { x } from "./hash.ts"`).
  - `jsr:`/`npm:` deps are pinned in `deno.json`'s `imports` map and locked in `deno.lock`.
  - `adm-zip` types are pinned at each import site with `// @ts-types="npm:@types/adm-zip@^0.5.8"`
    (NOT in a `package.json` — there is none). There is a types-only boundary cast
    `buf as unknown as Buffer` wherever a `Uint8Array` is handed to the `AdmZip` constructor.
  - `fmt`/`lint` in `deno.json` **exclude** `research/`, `test/fixtures/`, `dist/`, `cache/`,
    `docs/`, and `README.md`. **`test/fixtures/` must never be formatted** — the fixture bytes are
    the input to the pinned hash in `test/hash-parity.test.ts`.
  - Scoped runtime permissions (in `mod.ts` shebang and baked into `build.ts`):
    `--allow-read --allow-write --allow-net=claude.ai --allow-env=CLAUDE_SESSION_KEY,CF_CLEARANCE,CF_BM,USER_AGENT`.
  - Env-var names `CLAUDE_SESSION_KEY`, `CF_CLEARANCE`, `CF_BM`, `USER_AGENT` are load-bearing
    (existing `.env` files depend on them) — never rename.
- **Commit hygiene:** the repo has pre-commit hooks (trailing-whitespace auto-fix can abort a commit;
  re-stage and retry). Keep each item below as its own commit.

---

## Item 4.1 — Async crypto: `node:crypto` bridge → `@std/crypto`

**Why:** `src/lib/hash.ts` currently uses `import { createHash } from "node:crypto"` as a deliberate
**synchronous bridge**. The idiomatic Deno path is Web Crypto / `@std/crypto`, but `crypto.subtle.digest`
is **async**, which propagates `await` outward. This is the one item with real blast radius.

**Files:** `src/lib/hash.ts`, `src/lib/cache.ts`, `src/lib/api.ts`, `src/cli.ts`.

**Approach:**
1. Convert `canonicalHash`, `hashSkillDir`, and `hashZipBuffer` in `hash.ts` to `async` using
   `crypto.subtle.digest("SHA-256", data)` (or `@std/crypto`'s `crypto.subtle`). Note the inner
   per-file hash and the outer rolling hash both become async — you cannot call `.update()` on a
   streaming digest with Web Crypto, so accumulate bytes and digest once, OR keep a small helper that
   concatenates `path + "\0" + innerHex + "\n"` segments into one buffer and digests at the end.
   **The output hex string MUST stay byte-identical** to the current algorithm.
2. Propagate `await`: `cache.ts` `storeRemote` (calls `hashZipBuffer`) becomes async;
   `api.ts` `fetchAndCacheRemoteSkill` already async (just `await`); `cli.ts` call sites that compute
   `hashZipBuffer(readFileSync(...))` and `hashSkillDir(...)` must `await`.
3. Remove the `node:crypto` import and the `// node:crypto bridge` comments.

**Guard / acceptance:**
- `test/hash-parity.test.ts` pins the golden vector `87347e458e72c6d217bce5435a605c88697b3983218cbc3c3f27f35d7a0f1231`
  (verified against the original Node algorithm). **This test must still pass unchanged** — it is the
  regression lock for this exact migration. Update the test only to `await` the now-async functions;
  do NOT change `PINNED_HASH`. If the hash changes, the implementation is wrong, not the constant.
- All standard verification commands pass.

**Gotcha:** Web Crypto `subtle.digest` returns an `ArrayBuffer` — convert to lowercase hex exactly as
the current code does (`createHash(...).digest("hex")` produces lowercase). Write the hex conversion
carefully (per-byte `padStart(2,"0")`).

---

## Item 4.2 — Replace `npm:adm-zip` with `jsr:@std/archive` (drop the npm bridge)

**Why:** `npm:adm-zip` is the only remaining npm runtime dependency. Moving to the pure-Deno
`@std/archive` removes the npm bridge and the `@ts-types` directives entirely.

**Precondition:** Verify the installed `@std/archive` actually has ergonomic ZIP read/write with a
directory-add and bulk-extract path. The migration plan deferred this *because* `@std/archive`
historically lacked `addLocalFolder`/`extractAllTo` equivalents. **Check the current `@std/archive`
API first**; if it still lacks these, STOP and report — do not hand-roll a ZIP writer.

**Files:** `src/lib/pack.ts`, `src/lib/unpack.ts`, `src/lib/hash.ts` (`hashZipBuffer` reads entries),
`test/hash-parity.test.ts` (in-memory pack), `deno.json` (drop `adm-zip` from imports), and remove all
four `// @ts-types="npm:@types/adm-zip@^0.5.8"` directives + the `buf as unknown as Buffer` casts.

**Critical acceptance — ZIP byte-compatibility:**
- The `.skill` archives produced by `@std/archive` must remain readable by claude.ai and ideally
  match the adm-zip output. yawcs is **not widely deployed**, so a cache/format break is *acceptable
  if unavoidable* — but it must be **detected and reported**, not silently shipped.
- `test/hash-parity.test.ts` packs the fixture in-memory and asserts `hashZipBuffer === hashSkillDir`
  and both equal `PINNED_HASH`. After switching to `@std/archive`, the entry naming and the set of
  entries (`sample-skill/SKILL.md`, `sample-skill/scripts/hello.txt`, top-level dir prefix stripping)
  must produce the **same content hash**. If `@std/archive` orders entries or normalizes paths
  differently, adjust the packing code (not the hash algorithm) to match, or report the divergence.
- Round-trip: a `.skill` packed by the new code must `unpack` to a byte-identical directory tree.

**Recommendation:** Do this AFTER 4.1, and treat it as its own PR with the parity + round-trip tests
as the gate. If `@std/archive` isn't ready, leaving the `npm:adm-zip` bridge is explicitly fine.

---

## Item 4.3 — `deno doc` HTML API reference

**Why:** Publishable API docs from the JSDoc/TS already on the exported functions.

**Files:** none in `src/` (docs are generated). The `doc` task already exists in `deno.json`:
`deno doc --html --output=./docs src/lib/`.

**Approach:**
1. Run `deno task doc`; confirm it generates `docs/` without errors.
2. Ensure every exported function in `src/lib/*.ts` has a JSDoc summary (most do from the ports; fill
   any gaps — do not change behavior).
3. `docs/` is already `fmt`/`lint`-excluded and should be git-ignored OR published to GitHub Pages —
   decide and wire accordingly. If publishing: add a `pages` workflow; if not: add `docs/` to
   `.gitignore`. **Default recommendation:** gitignore `docs/` and generate on demand; only add a
   Pages workflow if the maintainer wants hosted docs.

**Acceptance:** `deno task doc` exits 0 and produces browsable HTML.

---

## Item 4.4 — `deno audit` as a CI step

**Why:** Supply-chain check on every PR. The `audit` task already exists in `deno.json`.

**Files:** `.github/workflows/release.yml` (currently tag-triggered only) and/or a new
`.github/workflows/ci.yml` for PRs.

**Approach:**
1. Add a PR-triggered CI workflow (`on: pull_request`) running the full verification bar:
   `deno fmt --check`, `deno lint`, `deno check mod.ts`, `deno test`, and `deno audit`.
   The release workflow already runs fmt/lint/check on tags; PR CI is currently absent.
2. `deno audit` may need network access in CI; confirm it runs against `deno.lock`.

**Acceptance:** A PR triggers the workflow; all steps pass on the current `deno-migration` tree.

**Note:** Until this lands, the release workflow runs `deno fmt --check`/`deno lint`/`deno check`
repo-wide on tags only — they pass today because of the `deno.json` excludes.

---

## Item 4.5 — README docs follow-up (`.env` for the compiled binary)

**Why:** Phase 3.1 updated README commands but flagged a prose gap. The README's Setup section
explains the `.env` cookie fields but does not explain runtime `.env` loading for the **compiled
binary** (Risk 3 in `MIGRATION-PLAN.md`).

**Files:** `README.md` (note: `README.md` is `fmt`-excluded, so write clean markdown by hand).

**Approach:** Add a short note that `src/lib/auth.ts` calls `@std/dotenv` `load({ export: true })` at
startup, so the binary reads `.env` **from the current working directory** — or the user can export
the env vars directly in the shell. Document the four env-var names and that the binary must be run
from a directory containing `.env` (or with the vars exported).

**Acceptance:** README accurately describes credential loading for both `deno run` and the compiled
binary. No code change.

---

## Item 4.6 — (Optional) SQLite cache — see separate plan

A full design analysis lives in **`SQLITE-CACHE-PLAN.md`**. Its recommendation is to **DEFER**:
the flat-JSON cache is the better fit for a single-user, read-mostly CLI. Do NOT implement SQLite
unless the maintainer explicitly decides to, in which case follow that doc. If implementing, first
smoke-test that `node:sqlite` is stable on the pinned Deno version and bundles into `deno compile`
without extra flags (the doc marks these as high-confidence-but-unverified).

---

## Suggested order

1. **4.5** (README) and **4.3** (docs) — trivial, no code risk, do first or anytime.
2. **4.4** (CI audit) — independent, low risk.
3. **4.1** (async crypto) — guarded by the parity test; do before 4.2.
4. **4.2** (`@std/archive`) — highest risk; gate on parity + round-trip; only if the library is ready.
5. **4.6** (SQLite) — only on explicit maintainer decision.

Each is its own commit/PR. The parity test (`test/hash-parity.test.ts`) is the safety net for 4.1
and 4.2 — keep it green and do not edit `PINNED_HASH`.
