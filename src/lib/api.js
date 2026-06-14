import { readFileSync } from 'fs';
import { basename } from 'path';
import { getBaseHeaders } from './auth.js';
import { logRequest, logResponse } from './log.js';
import { isRemoteCached, storeRemote, getEntry, ensureCache } from './cache.js';

ensureCache();

const BASE = 'https://claude.ai/api';

// Module-level cache — org ID doesn't change within a single CLI invocation.
let _orgId = null;

/**
 * Fetch the org UUID from the bootstrap endpoint.
 * Caches the result for the lifetime of the process.
 */
async function getOrgId() {
  if (_orgId) return _orgId;

  const url = `${BASE}/bootstrap`;
  const headers = getBaseHeaders();

  logRequest('GET', url, headers);

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
      'Could not read org UUID from bootstrap response.\n' +
        'Check that your sessionKey is valid and your account has an organization membership.\n' +
        'Full response was logged above.'
    );
  }

  console.log(`  org ID: ${_orgId}`);
  return _orgId;
}

/**
 * Upload a .skill archive to claude.ai.
 * Always uses overwrite=true — the repo is the source of truth.
 *
 * @param {string} skillPath - path to the .skill file
 */
export async function upload(skillPath) {
  const orgId = await getOrgId();
  const url = `${BASE}/organizations/${orgId}/skills/upload-skill?overwrite=true`;

  const buffer = readFileSync(skillPath);
  const blob = new Blob([buffer], { type: 'application/zip' });
  const fileName = basename(skillPath);

  const formData = new FormData();
  formData.append('file', blob, fileName);

  // Must NOT set content-type manually — native fetch sets multipart/form-data with
  // the correct boundary when body is FormData. If we set it, the boundary is missing
  // and the server rejects the request.
  const headers = getBaseHeaders();
  delete headers['content-type'];

  logRequest('POST', url, headers, `FormData { file: ${fileName}, ${buffer.length} bytes }`);

  const res = await fetch(url, { method: 'POST', headers, body: formData });
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
 * @returns {Promise<object[]>}
 */
export async function fetchSkills({ includeWiggleSkills = false } = {}) {
  const orgId = await getOrgId();
  const qs = includeWiggleSkills ? '?include_wiggle_skills=true' : '';
  const url = `${BASE}/organizations/${orgId}/skills/list-skills${qs}`;
  const headers = getBaseHeaders();

  logRequest('GET', url, headers);

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
 * Download a skill's .skill ZIP file as a Buffer.
 * Endpoint confirmed via browser DevTools.
 *
 * @param {string} skillId - the skill's id field (e.g. skill_01...)
 * @returns {Promise<Buffer>}
 */
async function downloadSkillFile(skillId) {
  const orgId = await getOrgId();
  const url = `${BASE}/organizations/${orgId}/skills/download-dot-skill-file?skill_id=${skillId}`;
  const headers = getBaseHeaders();
  delete headers['content-type']; // binary response

  logRequest('GET', url, headers);

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    logResponse(res.status, res.headers, body);
    throw new Error(`Download failed (${res.status}): ${body}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  logResponse(res.status, res.headers, null);
  return buf;
}

/**
 * Fetch a remote skill's .skill file, store it in the content-addressed cache,
 * and return its content hash. Short-circuits if the remote version (by updatedAt)
 * is already cached — no network request made.
 *
 * @param {string} skillId      - skill.id from fetchSkills()
 * @param {string} skillName    - skill.name (cache index key)
 * @param {string} updatedAt    - skill.updated_at (freshness key)
 * @returns {Promise<{ contentHash: string, fromCache: boolean }>}
 */
export async function fetchAndCacheRemoteSkill(skillId, skillName, updatedAt) {
  if (isRemoteCached(skillName, updatedAt)) {
    return { contentHash: getEntry(skillName).content_hash, fromCache: true };
  }
  const buf = await downloadSkillFile(skillId);
  const contentHash = storeRemote(skillName, updatedAt, buf);
  return { contentHash, fromCache: false };
}

/**
 * Fetch and display the list of skills on claude.ai.
 */
export async function listSkills({ includeWiggleSkills = false } = {}) {
  const skills = await fetchSkills({ includeWiggleSkills });

  if (skills.length === 0) {
    console.log('No skills found.');
    return;
  }

  const col = (s, n) => String(s ?? '').padEnd(n);
  console.log('\n' + col('NAME', 28) + col('ENABLED', 9) + col('UPDATED', 22) + 'DESCRIPTION');
  console.log('-'.repeat(95));
  for (const s of skills) {
    const updated = s.updated_at ? new Date(s.updated_at).toLocaleString() : '—';
    const desc = (s.description ?? '').slice(0, 40);
    console.log(col(s.name, 28) + col(s.enabled ? 'yes' : 'no', 9) + col(updated, 22) + desc);
  }
}
