/**
 * Hash-parity / golden-vector test for src/lib/hash.ts.
 *
 * Locks the SHA-256 output against a Node-verified reference so any future
 * change — especially the Phase 4 async-crypto swap — that alters the hex
 * string fails CI immediately.
 *
 * PINNED_HASH was derived by running the legacy Node algorithm (src/lib/hash.js
 * from git history, using node:crypto + adm-zip@0.5 on Node v26) against the
 * same fixture directory. Both hashSkillDir and hashZipBuffer produced the same
 * value, confirming Deno parity with Node at port time.
 */

import { assertEquals } from "@std/assert";
// @ts-types="npm:@types/adm-zip@^0.5.8"
import AdmZip from "adm-zip";
import { basename, fromFileUrl, join, resolve } from "@std/path";
import { hashSkillDir, hashZipBuffer } from "../src/lib/hash.ts";

// Node-verified ground truth (see module comment above).
const PINNED_HASH = "87347e458e72c6d217bce5435a605c88697b3983218cbc3c3f27f35d7a0f1231";

const FIXTURE_DIR = resolve(join(fromFileUrl(import.meta.url), "../../test/fixtures/sample-skill"));

Deno.test("hashSkillDir produces the pinned golden hash", () => {
  const actual = hashSkillDir(FIXTURE_DIR);
  assertEquals(
    actual,
    PINNED_HASH,
    `hashSkillDir hash changed — update PINNED_HASH only after verifying the algorithm is correct`,
  );
});

Deno.test("hashZipBuffer agrees with hashSkillDir and the pinned hash", () => {
  // Mirror pack.ts: addLocalFolder(resolvedDir, basename) so entries are
  // "sample-skill/SKILL.md", "sample-skill/scripts/hello.txt", etc.
  const zip = new AdmZip();
  zip.addLocalFolder(FIXTURE_DIR, basename(FIXTURE_DIR));
  const buf: Uint8Array = zip.toBuffer();

  const dirHash = hashSkillDir(FIXTURE_DIR);
  const zipHash = hashZipBuffer(buf);

  assertEquals(
    zipHash,
    dirHash,
    "hashZipBuffer and hashSkillDir must agree for the same content",
  );
  assertEquals(
    zipHash,
    PINNED_HASH,
    `hashZipBuffer hash changed — update PINNED_HASH only after verifying the algorithm is correct`,
  );
});
