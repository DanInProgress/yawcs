# Deno Migration Research Guide — yawcs

## 1. Overview

### Why Deno for CLIs?

Across all sources, four themes recur consistently:

**Zero-configuration TypeScript.** Deno runs `.ts` files natively — no `tsconfig.json`, no `ts-node`, no separate compile step. For a Node ESM CLI like yawcs that already uses TypeScript, this eliminates an entire layer of build tooling.

**Explicit security model.** Permissions (`--allow-read`, `--allow-write`, `--allow-net`, `--allow-run`, `--allow-env`) must be declared at runtime or baked in at `deno compile` time. This is a behavioral change from Node but also serves as self-documenting security policy for a CLI that touches developer machines.

**Batteries-included stdlib and built-in tooling.** Deno ships a formatter, linter, test runner, task runner, doc generator, and audit tool with the runtime. The `@std/*` library on JSR covers colors, path manipulation, logging, formatting, and more — replacing a dozen `node_modules` packages.

**Single-binary distribution.** `deno compile` produces a self-contained executable (bundling npm deps like `adm-zip` as of Deno 2.3) for all major targets. No Node runtime required on end-user machines — a significant improvement over yawcs's current distribution story.

---

## 2. Library & API Catalog

### 2.1 Argument Parsing

| Specifier | What it does | Replaces (Node) | Source |
|---|---|---|---|
| `jsr:@std/cli/parse-args` | Typed flag parsing: booleans, strings, aliases, defaults, stopEarly, `--` passthrough. Returns `args._` for positionals. | yargs / commander / minimist | oneuptime.com, deno.com/blog/build-cross-platform-cli, kennyheard.dev |
| `Deno.args` | Built-in array of raw CLI arguments (already `.slice(2)`'d) | `process.argv.slice(2)` | All sources |

**Older URL form** (avoid in new code): `https://deno.land/std@0.200.0/flags/mod.ts` — prefer `jsr:@std/cli/parse-args`.

### 2.2 Environment & Secrets

| Specifier | What it does | Replaces (Node) | Source |
|---|---|---|---|
| `Deno.env.get("VAR")` | Read environment variable | `process.env.VAR` | (Deno built-in, standard API) |
| Permission flag `--allow-env` | Required to access env vars | implicit in Node | Deno docs |

### 2.3 HTTP / Fetch

| Specifier | What it does | Replaces (Node) | Source |
|---|---|---|---|
| `fetch()` (global) | Built-in Web Platform API; no import needed | `node:http` / `node-fetch` / `axios` | deno.com/learn/scripts-clis |

OpenTelemetry (Deno 2.4, stabilized) auto-instruments `fetch()` via env var `DENO_OTEL_EXPORTER_OTLP_ENDPOINT` — no code changes required for basic tracing (user notes).

### 2.4 Filesystem & Paths

| Specifier | What it does | Replaces (Node) | Source |
|---|---|---|---|
| `jsr:@std/path` | `join`, `resolve`, `extname`, `basename` — cross-platform | `node:path` | user notes |
| `Deno.readTextFile(path)` | Read file as string | `fs.readFile` + `toString()` | Deno built-in |
| `Deno.writeTextFile(path, str)` | Write string to file | `fs.writeFile()` | oneuptime.com |
| `Deno.mkdir(path, {recursive})` | Create directory tree | `fs.mkdir()` / `fs-extra.ensureDir()` | oneuptime.com |
| `Deno.cwd()` | Current working directory | `process.cwd()` | oneuptime.com |
| `jsr:@std/fs/ensure-dir` | Recursively ensure directory exists | `fs-extra` ensureDir | oneuptime.com |
| `import data from './file.json' with { type: 'json' }` | Native JSON import | `fs.readFileSync` + `JSON.parse` | deno.com/blog/build-cross-platform-cli |

### 2.5 Zip / Archive

| Specifier | What it does | Replaces (Node) | Source |
|---|---|---|---|
| `npm:adm-zip` | npm package usable via `npm:` specifier without install; bundled into `deno compile` output as of Deno 2.3 | `adm-zip` (Node) | user notes |
| `jsr:@std/archive` | Deno-native tar/zip support (prefer for new code) | `archiver` / `adm-zip` | user notes |

### 2.6 Hashing / Crypto

| Specifier | What it does | Replaces (Node) | Source |
|---|---|---|---|
| `crypto.subtle` (Web Crypto API, global) | SHA-256, SHA-512, HMAC, etc. — no import needed | `node:crypto` | Deno built-in |
| `jsr:@std/crypto` | Higher-level wrappers over Web Crypto; convenience helpers | `node:crypto` | user notes |
| `node:crypto` | Node-compat shim; available in Deno 2.x for migration | `node:crypto` | Deno compat layer |

### 2.7 Front-Matter / Markdown

| Specifier | What it does | Replaces (Node) | Source |
|---|---|---|---|
| `jsr:@std/front-matter` | Parse YAML/TOML/JSON front-matter from text | `gray-matter` | Deno std |
| `npm:marked` | Markdown parser via `npm:` specifier | `marked` (Node) | npm compat |

### 2.8 Caching / State

| Specifier | What it does | Replaces (Node) | Source |
|---|---|---|---|
| `node:sqlite` (`DatabaseSync`) | Native SQLite — transactional, no native build, available Deno 2.2 | flat JSON cache files | user notes |
| `Deno.openKv(path)` | Built-in key-value store (SQLite-backed); `get`/`set` operations | LevelDB / flat JSON | deno.com/blog/build-cross-platform-cli |

`node:sqlite` is the stronger candidate for yawcs's cache layer: it's transactional, handles concurrent writes safely, and replaces the fragile flat-JSON approach without adding a native module dependency.

`Deno.openKv` is simpler for settings/preferences persistence (see §3 snippets).

### 2.9 Logging

| Specifier | What it does | Replaces (Node) | Source |
|---|---|---|---|
| `jsr:@std/log` | Structured logging with levels DEBUG/INFO/WARN/ERROR; console and file handlers; formatters; integrates with `--verbose` flag | `pino` / `winston` / `debug` | user notes |

### 2.10 Formatting (human-readable output)

| Specifier | What it does | Replaces (Node) | Source |
|---|---|---|---|
| `jsr:@std/fmt/colors` | Terminal color/style functions: `bold`, `red`, `green`, `yellow`, `blue`, `cyan`, `gray`, `bgRed`, `bgGreen` | `chalk` | oneuptime.com |
| `jsr:@std/fmt/bytes` | Format byte counts as `1.2 MB`, `340 KB` | `bytes` / `filesize` | user notes |
| `jsr:@std/fmt/duration` | Format milliseconds as `1h 23m 4s` | `ms` / `pretty-ms` | user notes |

### 2.11 Dates & Durations

| Specifier | What it does | Replaces (Node) | Source |
|---|---|---|---|
| `Temporal` (global, Deno 2.7 stabilized) | `Temporal.Now.instant()`, `.until().total({unit})` for durations, "X ago" calculations | `date-fns` / `dayjs` / `moment` | user notes |

### 2.12 Child Processes

| Specifier | What it does | Replaces (Node) | Source |
|---|---|---|---|
| `new Deno.Command(cmd, {args, stdout:"piped"}).output()` | Promise-based subprocess execution; captures stdout/stderr as `Uint8Array` | `node:child_process` / `execa` | user notes, oneuptime.com |

### 2.13 Signals

| Specifier | What it does | Replaces (Node) | Source |
|---|---|---|---|
| `Deno.addSignalListener("SIGINT", handler)` | Graceful cleanup on Ctrl+C; call `Deno.exit(130)` in handler | `process.on("SIGINT", ...)` | user notes |

### 2.14 Interactive Prompts / Terminal UI

| Specifier | What it does | Replaces (Node) | Source |
|---|---|---|---|
| `prompt(question)` | Web Platform API — blocking line read from stdin | `readline` / `inquirer` | deno.com/blog/build-cross-platform-cli |
| `Deno.stdin.read()` + `Deno.stdout.writeSync()` | Raw byte-level stdin/stdout for custom prompts, progress bars, spinners | `readline` / `ora` / `cli-progress` | oneuptime.com |

### 2.15 Process & Exit

| Specifier | What it does | Replaces (Node) | Source |
|---|---|---|---|
| `Deno.exit(code)` | Terminate with exit code | `process.exit()` | All sources |

---

## 3. Annotated Code Snippets

### 3.1 Argument Parsing

```typescript
// Prefer jsr: specifier in new code (replaces URL import form)
import { parseArgs } from "jsr:@std/cli/parse-args";

interface CliArgs {
  help: boolean;
  version: boolean;
  verbose: boolean;
  output: string;
  _: (string | number)[];
}

const args = parseArgs<CliArgs>(Deno.args, {
  boolean: ["help", "version", "verbose"],
  string: ["output"],
  alias: {
    h: "help",
    v: "version",
    V: "verbose",
    o: "output",
  },
  default: {
    verbose: false,
    output: "./output",
  },
});

if (args.help) {
  console.log(`Usage: yawcs [options] <command>`);
  Deno.exit(0);
}
```

**yawcs note:** Replace `yargs` or `commander` invocations with this pattern. `args._` holds positional arguments (e.g., the watch target path). The `verbose` flag maps directly to yawcs's `--verbose` / `-V` behavior and should feed into `@std/log` log level configuration.

---

### 3.2 Subcommand Dispatch

```typescript
import { parseArgs } from "jsr:@std/cli/parse-args";

type CommandHandler = (args: string[]) => Promise<void>;

const commands: Record<string, CommandHandler> = {
  watch: handleWatch,
  build: handleBuild,
  clean: handleClean,
};

async function main(): Promise<void> {
  const [command, ...rest] = Deno.args;

  if (!command || command === "help") {
    showHelp();
    return;
  }

  const handler = commands[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    Deno.exit(1);
  }

  await handler(rest);
}

main().catch((err) => {
  console.error("Error:", err.message);
  Deno.exit(1);
});
```

**yawcs note:** yawcs has a small surface — `watch`, `build`, and `clean` are the likely subcommands. This Record-dispatch pattern scales cleanly and makes the command list self-documenting. Source: oneuptime.com.

---

### 3.3 Color / Logging Helpers

```typescript
import { bold, red, green, yellow, blue, cyan, gray } from "jsr:@std/fmt/colors";

const log = {
  success: (msg: string) => console.log(green("✓ ") + msg),
  error:   (msg: string) => console.error(red("✗ ") + msg),
  warn:    (msg: string) => console.warn(yellow("⚠ ") + msg),
  info:    (msg: string) => console.log(blue("ℹ ") + msg),
  debug:   (msg: string, verbose: boolean) => {
    if (verbose) console.log(gray("  " + msg));
  },
  step:    (num: number, total: number, msg: string) => {
    console.log(cyan(`[${num}/${total}]`) + " " + msg);
  },
  header:  (msg: string) => {
    console.log("\n" + bold(msg));
    console.log(gray("─".repeat(msg.length)));
  },
};
```

**yawcs note:** Drop-in replacement for `chalk`-based logging. Named imports only — no class, no config object. The `debug` helper with a `verbose` guard maps directly to yawcs's `--verbose` flag. For file-based logging (CI environments), replace or supplement with `jsr:@std/log`. Source: oneuptime.com.

---

### 3.4 Human-Readable Output

```typescript
import { format as formatBytes } from "jsr:@std/fmt/bytes";
import { format as formatDuration } from "jsr:@std/fmt/duration";

// File sizes
console.log(formatBytes(1_234_567));  // "1.18 MB"

// Durations (input in milliseconds)
console.log(formatDuration(3_661_000));  // "1h 1m 1s"
```

**yawcs note:** yawcs reports archive sizes and build durations. These helpers replace `filesize` and `pretty-ms` packages. Source: user notes.

---

### 3.5 Date / Duration ("X ago")

```typescript
// Temporal is a Deno global as of 2.7 — no import needed
const start = Temporal.Now.instant();
// ... do work ...
const end = Temporal.Now.instant();
const durationMs = start.until(end).total({ unit: "milliseconds" });
console.log(`Completed in ${durationMs}ms`);

// "X ago" display
const then = Temporal.Now.instant();
// later:
const agoMs = then.until(Temporal.Now.instant()).total({ unit: "milliseconds" });
```

**yawcs note:** Replaces `date-fns` or `dayjs` for any duration or relative-time display in yawcs output. Zero import — just use `Temporal.*`. Source: user notes (Deno 2.7).

---

### 3.6 Child Processes (replaces `execa` / `child_process`)

```typescript
// Run git and capture output
const result = await new Deno.Command("git", {
  args: ["rev-parse", "--short", "HEAD"],
  stdout: "piped",
  stderr: "piped",
}).output();

if (result.code !== 0) {
  const err = new TextDecoder().decode(result.stderr);
  throw new Error(`git failed: ${err}`);
}

const sha = new TextDecoder().decode(result.stdout).trim();
```

**yawcs note:** yawcs shells out for git operations and potentially other tools. `Deno.Command` is the direct replacement for `child_process.spawn` / `execa`. `stdout: "piped"` captures output as `Uint8Array`; decode with `TextDecoder`. Source: user notes, oneuptime.com.

---

### 3.7 Signal Handling (graceful cleanup)

```typescript
Deno.addSignalListener("SIGINT", () => {
  // Clean up partial zip files, temp dirs, etc.
  console.log("\nInterrupted — cleaning up...");
  cleanupTempFiles();
  Deno.exit(130);  // 128 + SIGINT(2) = conventional exit code
});
```

**yawcs note:** Avoids leaving partial archives on disk when the user hits Ctrl+C during a build. Source: user notes.

---

### 3.8 SQLite State / Cache

```typescript
import { DatabaseSync } from "node:sqlite";  // Deno 2.2+

const db = new DatabaseSync("./yawcs-cache.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER
  )
`);

function getCached(key: string): string | null {
  const row = db.prepare("SELECT value FROM cache WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function setCached(key: string, value: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)"
  ).run(key, value, Date.now());
}
```

**yawcs note:** Replaces the fragile flat-JSON cache. `DatabaseSync` is synchronous (no async/await overhead), transactional, and ships with Deno 2.2 via the `node:sqlite` compat layer — no native build required. Source: user notes.

---

### 3.9 Persistent Settings with Deno KV

```typescript
const kv = await Deno.openKv("./yawcs-settings.db");

// Read a setting with fallback
let outputDir = (await kv.get(["outputDir"])).value as string | null;
if (!outputDir) {
  outputDir = prompt("Output directory?") ?? "./dist";
  await kv.set(["outputDir"], outputDir);
}
```

**yawcs note:** Lighter than SQLite for simple key/value user preferences (output directory, default flags). Use `node:sqlite` for structured cache data, `Deno.openKv` for simple settings. Requires `--allow-read --allow-write`. Source: deno.com/blog/build-cross-platform-cli.

---

### 3.10 Progress Bar

```typescript
import { green, gray } from "jsr:@std/fmt/colors";

class ProgressBar {
  constructor(
    private total: number,
    private label = "Progress",
    private width = 40
  ) {}

  update(current: number, suffix = ""): void {
    const pct = Math.min(100, Math.floor((current / this.total) * 100));
    const filled = Math.floor((this.width * current) / this.total);
    const bar = green("█".repeat(filled)) + gray("░".repeat(this.width - filled));
    Deno.stdout.writeSync(
      new TextEncoder().encode(`\r${this.label}: ${bar} ${pct}% ${suffix}`)
    );
  }

  complete(message?: string): void {
    this.update(this.total);
    console.log(message ? ` ${green("✓")} ${message}` : "");
  }
}
```

**yawcs note:** No `cli-progress` package needed. The `\r` trick rewrites the current terminal line in-place. Source: oneuptime.com.

---

### 3.11 Cross-Platform Binary Build

```typescript
// build.ts
const targets = [
  { name: "linux-x64",   triple: "x86_64-unknown-linux-gnu",  ext: "" },
  { name: "macos-arm64", triple: "aarch64-apple-darwin",       ext: "" },
  { name: "windows-x64", triple: "x86_64-pc-windows-msvc",    ext: ".exe" },
];

const permissions = ["--allow-read", "--allow-write", "--allow-run", "--allow-env"];

for (const t of targets) {
  const out = `./dist/yawcs-${t.name}${t.ext}`;
  const { code, stderr } = await new Deno.Command("deno", {
    args: ["compile", ...permissions, "--target", t.triple, "--output", out, "./mod.ts"],
    stderr: "piped",
  }).output();

  if (code !== 0) {
    throw new Error(new TextDecoder().decode(stderr));
  }
  console.log(`Built ${out}`);
}
```

**yawcs note:** As of Deno 2.3, `deno compile` bundles npm dependencies (e.g., `npm:adm-zip`) into the single binary. This replaces the current Makefile distribution step. Source: user notes, oneuptime.com.

---

### 3.12 Shebang Entry Point

```bash
#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env
```

**yawcs note:** Add this as the first line of `mod.ts` (or a thin `yawcs` shell script) to make the tool directly executable on Unix without an explicit `deno run` invocation. The `-S` flag lets `env` split the `deno run` arguments. Source: oneuptime.com.

---

### 3.13 Interactive Prompt (Web API style)

```typescript
// Simple blocking prompt — no import needed
const name = prompt("What is your name?");
const confirmed = prompt("Save settings? [Y/n]")?.toUpperCase() === "Y";
```

**yawcs note:** For simple yes/no or single-value prompts, the Web Platform `prompt()` global is sufficient and requires no package. For richer multi-select / numeric-choice prompts, use the raw `Deno.stdin.read()` approach shown in §3 of the oneuptime.com snippet. Source: deno.com/blog/build-cross-platform-cli.

---

## 4. Packaging & Distribution

### 4.1 `deno.json` — Task Runner (replaces Makefile)

```json
{
  "name": "@yourscope/yawcs",
  "version": "0.1.0",
  "exports": "./mod.ts",
  "tasks": {
    "dev":     "deno run --allow-read --allow-write --allow-run --allow-env --watch mod.ts",
    "build":   "deno run --allow-read --allow-write --allow-run build.ts",
    "test":    "deno test --allow-read --allow-write",
    "lint":    "deno lint",
    "fmt":     "deno fmt",
    "audit":   "deno audit",
    "doc":     "deno doc --html --output=./docs src/lib/"
  }
}
```

Run with: `deno task dev`, `deno task build`, etc. As of Deno 2.6, `deno task` supports shell autocompletion. Source: user notes, oneuptime.com.

### 4.2 `deno compile` — Standalone Binary

```bash
# Current platform
deno compile --allow-read --allow-write --allow-run --allow-env --output ./dist/yawcs mod.ts

# Cross-compile for all targets (see build.ts snippet above)
# As of Deno 2.3: npm: deps (e.g. npm:adm-zip) are bundled into the binary
```

Permissions declared at compile time are embedded — end users are not prompted. Replaces `pkg` / `nexe`. Source: user notes, all sources.

### 4.3 `deno audit` — Dependency CVE Scan

```bash
deno audit
```

Scans all `npm:` and `jsr:` dependencies for known CVEs. Add to CI pipeline. Available as of Deno 2.6. Source: user notes.

### 4.4 `deno doc --html` — API Documentation

```bash
deno doc --html --output=./docs src/lib/
```

Generates a browsable HTML SDK reference from JSDoc comments and TypeScript exports in `src/lib/`. Source: user notes.

### 4.5 `dx` — Remote CLI Runner ("new npx")

```bash
# Run a JSR or npm CLI without installing it globally
dx @scope/some-tool --flag
```

Available as of Deno 2.6; caches the tool on first run. Source: user notes.

### 4.6 OpenTelemetry

Auto-instrumented as of Deno 2.4 (stabilized). No code changes needed for basic fetch and console tracing:

```bash
DENO_OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317 deno run --allow-net mod.ts
```

`fetch()` calls and `console.*` output are automatically captured as spans and log records. Source: user notes.

### 4.7 GitHub Actions — Multi-Platform Release

```yaml
# .github/workflows/release.yml
name: Release
on:
  push:
    tags: ['v*']

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: ubuntu-latest
            target: x86_64-unknown-linux-gnu
            name: linux-x64
          - os: macos-latest
            target: aarch64-apple-darwin
            name: macos-arm64
          - os: windows-latest
            target: x86_64-pc-windows-msvc
            name: windows-x64
            ext: .exe
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v1
        with:
          deno-version: v2.x
      - run: |
          deno compile --allow-read --allow-write --allow-run --allow-env \
            --target ${{ matrix.target }} \
            --output yawcs-${{ matrix.name }}${{ matrix.ext }} \
            mod.ts
      - uses: actions/upload-artifact@v4
        with:
          name: yawcs-${{ matrix.name }}
          path: yawcs-${{ matrix.name }}${{ matrix.ext }}

  release:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
      - uses: softprops/action-gh-release@v1
        with:
          files: |
            yawcs-linux-x64/yawcs-linux-x64
            yawcs-macos-arm64/yawcs-macos-arm64
            yawcs-windows-x64/yawcs-windows-x64.exe
```

Source: oneuptime.com.

---

## 5. Open Questions / Decisions

### 5.1 Arg Parsing: `@std/cli/parse-args` vs `cliffy`

| Option | Pros | Cons |
|---|---|---|
| `jsr:@std/cli/parse-args` | Zero external dep; same API as std/flags; JSR-native | No subcommand framework; manual dispatch boilerplate |
| `npm:cliffy` or `jsr:@cliffy/*` | Rich subcommand framework; table/prompt/select built in | Third-party; API churn risk; larger surface |

**Recommendation:** Start with `@std/cli/parse-args` + manual dispatch (the Record-based pattern in §3.2). Migrate to cliffy only if yawcs grows to 5+ subcommands with complex flag inheritance.

### 5.2 Crypto: `jsr:@std/crypto` vs `node:crypto` vs Web Crypto

| Option | Pros | Cons |
|---|---|---|
| `crypto.subtle` (Web Crypto, global) | Zero import; W3C standard | Verbose API for simple hashing |
| `jsr:@std/crypto` | Convenience wrappers; JSR-native | Extra import |
| `node:crypto` | Familiar API; compat shim | Not idiomatic Deno; may lag behind |

**Recommendation:** Use `jsr:@std/crypto` for convenience. Fall back to `crypto.subtle` directly for one-off SHA operations.

### 5.3 Archive: `jsr:@std/archive` vs `npm:adm-zip`

| Option | Pros | Cons |
|---|---|---|
| `jsr:@std/archive` | Deno-native; no npm; JSR integrity checks | API may differ from adm-zip; less battle-tested for edge cases |
| `npm:adm-zip` | Already used in yawcs; proven; bundled into `deno compile` as of 2.3 | npm dep; not idiomatic Deno |

**Recommendation:** Migrate to `jsr:@std/archive` as a goal, but use `npm:adm-zip` as a bridge during initial migration — it works without changes via the `npm:` specifier.

### 5.4 SQLite Cache: `node:sqlite` vs `Deno.openKv`

| Option | Pros | Cons |
|---|---|---|
| `node:sqlite` (`DatabaseSync`) | Full SQL; transactional; structured queries; schema evolution | Synchronous API; slightly more boilerplate |
| `Deno.openKv` | Simple get/set; async; built into Deno | No relations; harder to query or migrate structure |

**Recommendation:** `node:sqlite` for yawcs's cache layer (structured entries, possible future query needs). `Deno.openKv` for user preferences (simple key/value).

### 5.5 Logging: manual `log` object vs `jsr:@std/log`

| Option | Pros | Cons |
|---|---|---|
| Manual `log` object (see §3.3) | Simple; zero deps; full control | No file handler; no structured output |
| `jsr:@std/log` | Log levels; file+console handlers; formatters; pairs well with `--verbose` | More setup boilerplate |

**Recommendation:** Use `jsr:@std/log` from the start if yawcs needs CI-friendly log files or structured output. Otherwise, the manual approach is sufficient for an interactive terminal tool.

### 5.6 Prompts: `prompt()` vs raw `Deno.stdin.read()`

| Option | Pros | Cons |
|---|---|---|
| Web Platform `prompt()` | One-liner; no import | Blocking; no styling; basic only |
| Raw `Deno.stdin.read()` | Full control; colorized output; multi-select | ~30 lines of boilerplate per prompt type |

**Recommendation:** Use `prompt()` for one-off confirmations. Build the raw helpers (§3.13 pattern) only if yawcs adds an interactive setup wizard or multi-step prompt flow.

### 5.7 Dependency Management Style: URL imports vs `deno.json` import map

| Option | Pros | Cons |
|---|---|---|
| URL imports (e.g. `https://deno.land/std@0.200.0/...`) | Explicit; self-contained files | Version scattered across files; old style |
| `jsr:` specifiers with `deno.json` import map | Modern; deduplicates versions; JSR integrity | Requires `deno.json` `imports` section |
| `deps.ts` re-export pattern | Single version-change point; works with URL imports | Extra indirection layer |

**Recommendation:** Use `jsr:` specifiers directly in source files; pin versions in `deno.json`'s `imports` map. Skip `deps.ts` — it is an older convention predating `deno.json` import maps.

---

*Guide compiled from: deno.com/learn/scripts-clis, oneuptime.com/blog/post/2026-01-31-deno-cli-applications, kennyheard.dev/writing/building-a-cli-tool-with-deno, deno.com/blog/build-cross-platform-cli, and user-provided feature notes (Deno 2.2–2.7).*
