#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net=claude.ai --allow-env=CLAUDE_SESSION_KEY,CF_CLEARANCE,CF_BM,USER_AGENT
// yawcs — Deno-native entry point.
import { main } from "./src/cli.ts";

export { main };

if (import.meta.main) {
  await main().catch((err) => {
    console.error(err?.message ?? err);
    Deno.exit(1);
  });
}
