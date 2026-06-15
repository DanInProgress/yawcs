#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run
/**
 * Cross-platform compile script for the `yawcs` CLI.
 *
 * Replaces the distribution role of the old Makefile: it invokes
 * `deno compile` for each supported target triple, producing standalone
 * binaries in `dist/`. The runtime permission flags baked into each binary
 * mirror the scoped permissions decided in the migration plan.
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-run build.ts            # all targets
 *   deno run --allow-read --allow-write --allow-run build.ts macos-arm64 # single target
 *
 * @module
 */

import { format as formatDuration } from "@std/fmt/duration";
import { format as formatBytes } from "@std/fmt/bytes";

/** Entry point compiled into each binary. */
const ENTRY = "mod.ts";

/** Directory that receives the compiled binaries (gitignored). */
const DIST_DIR = "dist";

/**
 * Scoped runtime permissions baked into every compiled binary.
 * These match the permissions the plan decided the CLI needs at runtime.
 */
const RUNTIME_PERMISSIONS: readonly string[] = [
  "--allow-read",
  "--allow-write",
  "--allow-net=claude.ai",
  "--allow-env=CLAUDE_SESSION_KEY,CF_CLEARANCE,CF_BM,USER_AGENT",
];

/** A cross-compile target: a friendly name, a Deno target triple, and an output path. */
interface Target {
  /** Friendly name used as the CLI argument (e.g. `macos-arm64`). */
  readonly name: string;
  /** Deno `--target` triple. */
  readonly triple: string;
  /** Output binary path within `dist/`. */
  readonly output: string;
}

/** The three release targets required by the migration plan. */
const TARGETS: readonly Target[] = [
  {
    name: "linux-x64",
    triple: "x86_64-unknown-linux-gnu",
    output: `${DIST_DIR}/yawcs-linux-x64`,
  },
  {
    name: "macos-arm64",
    triple: "aarch64-apple-darwin",
    output: `${DIST_DIR}/yawcs-macos-arm64`,
  },
  {
    name: "windows-x64",
    triple: "x86_64-pc-windows-msvc",
    output: `${DIST_DIR}/yawcs-windows-x64.exe`,
  },
];

/** Outcome of attempting to compile a single target. */
interface BuildResult {
  readonly target: Target;
  readonly ok: boolean;
  /** Wall-clock build duration in milliseconds. */
  readonly elapsedMs: number;
  /** Size of the produced binary in bytes, when the build succeeded. */
  readonly size?: number;
}

/**
 * Ensure the `dist/` output directory exists.
 *
 * Uses a recursive mkdir and ignores the case where it already exists, so
 * existing artifacts in `dist/` (e.g. `dist/example-skill.skill`) are left
 * untouched.
 */
function ensureDistDir(): void {
  try {
    Deno.mkdirSync(DIST_DIR, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
  }
}

/**
 * Compile a single target via `deno compile`.
 *
 * @param target The target to build.
 * @returns The build result, including elapsed time and (on success) file size.
 */
async function buildTarget(target: Target): Promise<BuildResult> {
  console.log(`\n→ Building ${target.name} (${target.triple})…`);

  const args = [
    "compile",
    ...RUNTIME_PERMISSIONS,
    "--target",
    target.triple,
    "--output",
    target.output,
    ENTRY,
  ];

  const start = performance.now();
  const command = new Deno.Command("deno", {
    args,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { success } = await command.output();
  const elapsedMs = performance.now() - start;

  if (!success) {
    console.error(`✗ ${target.name} failed after ${formatDuration(elapsedMs)}`);
    return { target, ok: false, elapsedMs };
  }

  const size = Deno.statSync(target.output).size;
  console.log(
    `✓ ${target.name} → ${target.output} ` +
      `(${formatBytes(size)}, ${formatDuration(elapsedMs, { ignoreZero: true })})`,
  );
  return { target, ok: true, elapsedMs, size };
}

/**
 * Resolve which targets to build from CLI arguments.
 *
 * @param args Raw CLI arguments (`Deno.args`).
 * @returns The selected targets. With no args, all targets are returned.
 * @throws If a named target is not recognized.
 */
function selectTargets(args: readonly string[]): readonly Target[] {
  if (args.length === 0) return TARGETS;

  return args.map((name) => {
    const target = TARGETS.find((t) => t.name === name);
    if (!target) {
      const known = TARGETS.map((t) => t.name).join(", ");
      throw new Error(`Unknown target "${name}". Known targets: ${known}`);
    }
    return target;
  });
}

/** Print a summary table of all build results. */
function printSummary(results: readonly BuildResult[]): void {
  console.log("\n=== Build summary ===");
  for (const r of results) {
    const status = r.ok ? "ok " : "FAIL";
    const size = r.size !== undefined ? formatBytes(r.size) : "-";
    console.log(
      `  [${status}] ${r.target.name.padEnd(12)} ${size.padStart(10)}  ` +
        `${formatDuration(r.elapsedMs)}`,
    );
  }
}

let selected: readonly Target[];
try {
  selected = selectTargets(Deno.args);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  Deno.exit(2);
}

ensureDistDir();

const results: BuildResult[] = [];
for (const target of selected) {
  results.push(await buildTarget(target));
}

printSummary(results);

const failures = results.filter((r) => !r.ok);
if (failures.length > 0) {
  console.error(`\n${failures.length} of ${results.length} build(s) failed.`);
  Deno.exit(1);
}

console.log(`\nAll ${results.length} build(s) succeeded.`);
