import { basename } from "@std/path";
import { getBaseHeaders } from "./auth.ts";
import { logRequest, logResponse } from "./log.ts";
import { ensureCache, getEntry, isRemoteCached, storeRemote } from "./cache.ts";

ensureCache();

const BASE = "https://claude.ai/api";

// Module-level cache — org ID doesn't change within a single CLI invocation.
let _orgId: string | null = null;

/**
 * Fetch the org UUID from the bootstrap endpoint.
 * Caches the result for the lifetime of the process.
 */
async function getOrgId(): Promise<string> {
  if (_orgId) return _orgId;

  const url = `${BASE}/bootstrap`;
  const headers = getBaseHeaders();

  logRequest("GET", url, headers);

  const res = await fetch(url, { headers });
  const rawBody = await res.text();
  logResponse(res.status, res.headers, rawBody);

  if (!res.ok) {
    throw new Error(`Bootstrap failed (${res.status}): ${rawBody}`);
  }

  let data;
  try {
    data = JSON.parse(rawBody);
  } catch {
    throw new Error(`Bootstrap response was not valid JSON: ${rawBody.slice(0, 200)}`);
  }

  // Confirmed path from oaustegard/bookmarklets source code
  _orgId = data?.account?.memberships?.[0]?.organization?.uuid;

  if (!_orgId) {
    throw new Error(
      "Could not read org UUID from bootstrap response.\n" +
        "Check that your sessionKey is valid and your account has an organization membership.\n" +
        "Full response was logged above.",
    );
  }

  console.log(`  org ID: ${_orgId}`);
  return _orgId;
}

/**
 * Upload a .skill archive to claude.ai.
 * Always uses overwrite=true — the repo is the source of truth.
 *
 * @param skillPath - path to the .skill file
 */
export async function upload(skillPath: string): Promise<void> {
  const orgId = await getOrgId();
  const url = `${BASE}/organizations/${orgId}/skills/upload-skill?overwrite=true`;

  const buffer = await Deno.readFile(skillPath);
  const blob = new Blob([buffer], { type: "application/zip" });
  const fileName = basename(skillPath);

  const formData = new FormData();
  formData.append("file", blob, fileName);

  // Must NOT set content-type manually — native fetch sets multipart/form-data with
  // the correct boundary when body is FormData. If we set it, the boundary is missing
  // and the server rejects the request.
  const headers = getBaseHeaders();
  delete headers["content-type"];

  logRequest("POST", url, headers, `FormData { file: ${fileName}, ${buffer.length} bytes }`);

  const res = await fetch(url, { method: "POST", headers, body: formData });
  const rawBody = await res.text();
  logResponse(res.status, res.headers, rawBody);

  if (!res.ok) {
    throw new Error(`Upload failed (${res.status}): ${rawBody}`);
  }
}

/**
 * Fetch the raw list of skills from claude.ai.
 * Returns the skills array for programmatic use.
 *
 * @returns the skills array
 */
export async function fetchSkills(
  { includeWiggleSkills = false }: { includeWiggleSkills?: boolean } = {},
): Promise<Record<string, unknown>[]> {
  const orgId = await getOrgId();
  const qs = includeWiggleSkills ? "?include_wiggle_skills=true" : "";
  const url = `${BASE}/organizations/${orgId}/skills/list-skills${qs}`;
  const headers = getBaseHeaders();

  logRequest("GET", url, headers);

  const res = await fetch(url, { headers });
  const rawBody = await res.text();
  logResponse(res.status, res.headers, rawBody);

  if (!res.ok) {
    throw new Error(`List failed (${res.status}): ${rawBody}`);
  }

  let data;
  try {
    data = JSON.parse(rawBody);
  } catch {
    throw new Error(`list-skills response was not valid JSON: ${rawBody.slice(0, 200)}`);
  }

  // Defensive: server may return { skills: [...] } or a bare array
  return data.skills || (Array.isArray(data) ? data : []);
}

/**
 * Download a skill's .skill ZIP file as bytes.
 * Endpoint confirmed via browser DevTools.
 *
 * @param skillId - the skill's id field (e.g. skill_01...)
 * @returns the raw .skill ZIP bytes
 */
async function downloadSkillFile(skillId: string): Promise<Uint8Array> {
  const orgId = await getOrgId();
  const url = `${BASE}/organizations/${orgId}/skills/download-dot-skill-file?skill_id=${skillId}`;
  const headers = getBaseHeaders();
  delete headers["content-type"]; // binary response

  logRequest("GET", url, headers);

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    logResponse(res.status, res.headers, body);
    throw new Error(`Download failed (${res.status}): ${body}`);
  }

  const buf = new Uint8Array(await res.arrayBuffer());
  logResponse(res.status, res.headers, null);
  return buf;
}

/**
 * Fetch a remote skill's .skill file, store it in the content-addressed cache,
 * and return its content hash. Short-circuits if the remote version (by updatedAt)
 * is already cached — no network request made.
 *
 * @param skillId      - skill.id from fetchSkills()
 * @param skillName    - skill.name (cache index key)
 * @param updatedAt    - skill.updated_at (freshness key)
 * @returns the content hash and whether it came from the cache
 */
export async function fetchAndCacheRemoteSkill(
  skillId: string,
  skillName: string,
  updatedAt: string,
): Promise<{ contentHash: string; fromCache: boolean }> {
  if (isRemoteCached(skillName, updatedAt)) {
    return { contentHash: getEntry(skillName)!.content_hash, fromCache: true };
  }
  const buf = await downloadSkillFile(skillId);
  const contentHash = await storeRemote(skillName, updatedAt, buf);
  return { contentHash, fromCache: false };
}

/**
 * Fetch and display the list of skills on claude.ai.
 */
export async function listSkills(
  { includeWiggleSkills = false }: { includeWiggleSkills?: boolean } = {},
): Promise<void> {
  const skills = await fetchSkills({ includeWiggleSkills });

  if (skills.length === 0) {
    console.log("No skills found.");
    return;
  }

  const col = (s: unknown, n: number) => String(s ?? "").padEnd(n);
  console.log("\n" + col("NAME", 28) + col("ENABLED", 9) + col("UPDATED", 22) + "DESCRIPTION");
  console.log("-".repeat(95));
  for (const s of skills) {
    const updated = s.updated_at ? new Date(s.updated_at as string).toLocaleString() : "—";
    const desc = ((s.description as string) ?? "").slice(0, 40);
    console.log(
      col(s.name, 28) + col(s.enabled ? "yes" : "no", 9) + col(updated, 22) + desc,
    );
  }
}
