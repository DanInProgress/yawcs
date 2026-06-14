---
created: 2026-04-09
updated: 2026-04-18
---
# Skills API and Web Architecture

> **Index:** See [README.md](./README.md) for the full research doc index.

How skills are authored, packaged, uploaded, and managed via the claude.ai web UI. This doc consolidates the bundle-extracted HTTP API reference, the bookmarklet-confirmed web UI findings, the client-side runtime architecture, the SKILL.md file format, and the contrast with the official `api.anthropic.com/v1/skills` product.

**Base URL:** `https://claude.ai`

> All paths below are relative (e.g. `/api/organizations/…`). The web app sends these as relative URLs directly; no host prefix is added in the request code.

The authoritative HTTP reference (Section 1) was reverse-engineered from the normalized Vite bundle (hash `BFFVt7tV`, captured 2026-04-10) via ast-grep pattern extraction — all endpoint paths, request shapes, response schemas, and error codes are read directly from the bundle, not inferred from client code. Section 6 (client-side runtime) was extracted from `snapshots/derived/D72Sf481/primary.js` (bundle captured 2026-04-17).

---

## 1. Authoritative HTTP API Reference

### 1.1 Fetch wrappers and headers

All skill endpoints use one of two internal fetch wrappers — `Zh()` or `Kh()` (which wraps `Zh()`) — both of which always set `credentials: 'include'`. No `Authorization` header is used.

- **`Zh()`** is used directly by the upload and download endpoints.
- **`Kh()`** is used by list, enable, disable, and delete endpoints. It adds Cloudflare challenge detection on top of `Zh()`: if the response contains `cf-mitigated: challenge`, the page is redirected to `/api/challenge_redirect?to=<current-url>` and an error is thrown.

These headers are added by `Wh()` (called inside `Zh()`) on every request:

| Header | Value | Description |
|---|---|---|
| `anthropic-client-platform` | see below | Platform identifier. Set by the `md()` helper based on `applicationType` and UA. |
| `anthropic-client-sha` | build git hash | Release SHA from build env. |
| `anthropic-client-version` | version string | Claude AI version from build env. |
| `anthropic-anonymous-id` | string | Segment analytics anonymous ID. |
| `anthropic-device-id` | string | Device ID from cookie storage. |
| `x-activity-session-id` | string | Session tracking ID, if present. |
| `Content-Type` | `application/json` | Set by `Zh()` unless the body is `FormData` or the header is already present. |

`credentials: 'include'` is set on every fetch, which sends the session cookies automatically.

### 1.2 Bootstrap (auth + org UUID)

Authenticate and retrieve the organization UUID required by all other endpoints.

```
GET /api/bootstrap
GET /api/bootstrap/{org_id}/app_start
```

The web app reads `LAST_ACTIVE_ORG` from a cookie (via `document.cookie`). If set, it tries the org-scoped path first. On 404 it clears `LAST_ACTIVE_ORG` and retries the generic path. On 403 with the org path it retries without it. On 401 or 403 on the generic path it returns `undefined` (unauthenticated).

> **Provenance:** The `GET /api/bootstrap` call and the response path `account.memberships[0].organization.uuid` appear verbatim in `claude_upload_skill.js`, along with the `anthropic-client-platform: web_claude_ai` header — **confirmed** from bookmarklet source. This supersedes the earlier `GET /api/organizations` approach (see Section 3, Corrections).

**Query parameters** (hardcoded by the web app, not variable):

| Parameter | Hardcoded value | Notes |
|---|---|---|
| `statsig_hashing_algorithm` | `djb2` | Always sent. |
| `growthbook_format` | `sdk` | Always sent. |
| `include_system_prompts` | `false` | Sent on all web clients. Omitted entirely on the desktop app (when `qc(navigator.userAgent)` is true, i.e. `window.claudeAppBindings` is present). See Section 6 for the client-side rationale. |

**Request:**

```http
GET /api/bootstrap?statsig_hashing_algorithm=djb2&growthbook_format=sdk&include_system_prompts=false HTTP/1.1
Host: claude.ai
anthropic-client-platform: web_claude_ai
anthropic-client-sha: <build-sha>
anthropic-client-version: <version>
anthropic-anonymous-id: <id>
anthropic-device-id: <id>
Cookie: sessionKey=sk-ant-sid01-...
```

Note: the bootstrap call does **not** use `Zh()`. It builds its own `Headers` object and calls `fetch()` directly with `credentials: 'include'`.

**Response:** The generic `/api/bootstrap` response is returned as-is. The org-scoped `/api/bootstrap/{org_id}/app_start` response is reshaped client-side when the raw response contains `org_statsig`. The reshaped object:

```json
{
  "account": {
    "memberships": [
      { "organization": { "uuid": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" } }
    ]
  },
  "statsig": { ... },
  "growthbook": { ... },
  "statsigOrgUuid": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "intercom_account_hash": "...",
  "locale": "en-US",
  "system_prompts": [ ... ],
  "current_user_access": { ... }
}
```

The raw API response uses `org_statsig` and `org_growthbook`; the client renames these to `statsig` and `growthbook` and adds `statsigOrgUuid`. The org UUID is at `account.memberships[0].organization.uuid`. Even personal accounts operate within a single-member organization.

**Error matrix:**

| Status | Behavior |
|---|---|
| `401` | Returns `undefined`. User is not authenticated. |
| `403` (generic path) | Returns `undefined`. |
| `403` (org path) | Retries without org path. |
| `404` (org path) | Clears `LAST_ACTIVE_ORG` cookie, retries without org path. |
| Other non-2xx | Throws `Error: Bootstrap request failed: {status} {statusText}`. |

### 1.3 List Skills

Retrieve skills available to the account. Two separate endpoints exist — one for personal/shared skills and one scoped to the organization.

```
GET /api/organizations/{org_id}/skills/list-skills
```

Feature-flag gated: skipped entirely when the `claudeai_skills_list` feature flag is active.

**Query parameters:**

| Parameter | Type | Description |
|---|---|---|
| `include_wiggle_skills` | boolean | When `true`, includes Anthropic-provided built-in ("wiggle") skills. Omitted entirely when false — not sent as `false`. |

**Response:**

```json
{
  "skills": [
    {
      "id": "skill_01...",
      "name": "my-skill",
      "description": "What this skill does",
      "creator_type": "user",
      "updated_at": "2026-03-20T14:30:00.000Z",
      "enabled": true,
      "partition_by": "user",
      "is_public_provisioned": false,
      "user_invocable": true,
      "is_shared": false,
      "has_outgoing_shares": false,
      "shared_via": null,
      "owner": null,
      "enable_count": null
    }
  ]
}
```

The client handles both `{ "skills": [...] }` and a bare array (`data.skills || data || []`). The response is transformed client-side (mapper `IAe`) before use. Field mapping (API → client):

| API field | Client field | Notes |
|---|---|---|
| `id` | `skillId` | |
| `name` | `skillName` | |
| `description` | `skillDescription` | |
| `creator_type` | `creatorType` | `"user"` or `"anthropic"` |
| `updated_at` | `updatedAt` | ISO 8601 |
| `enabled` | `enabled` | |
| `partition_by` | `partitionBy` | `"user"` or `"organization"` |
| `is_public_provisioned` | `isPublicProvisioned` | |
| `user_invocable` | `userInvocable` | |
| `is_shared` | `isShared` | Defaults to `false` if absent |
| `has_outgoing_shares` | `hasOutgoingShares` | Defaults to `false` if absent |
| `shared_via` | `sharedVia` | Defaults to `null` if absent |
| `owner` | `owner` | `null` or object with `tagged_id`, `uuid`, `full_name`, `email_address` |
| `enable_count` | `enableCount` | Defaults to `null` if absent |

Skills are sorted: user skills before Anthropic skills; within user skills, by `updated_at` descending, then org-partitioned first; within Anthropic skills, alphabetically by name.

> **Bookmarklet-confirmed subset:** The fields `name`, `description`, `enabled`, `updated_at`, and `created_at` are rendered by `claude_list_skills.js`/`claude_my_skills.js` and so must exist; the full schema above is from the bundle. (`created_at` is rendered by the bookmarklet but is not in the bundle-extracted mapper — it is likely present but unmapped client-side.)

**Org skills:**

```
GET /api/organizations/{org_id}/skills/list-org-skills
```

No query parameters observed. Returns the same response shape as `list-skills` and uses the same `IAe` skill mapper. Gated on a separate feature flag (`Bae()`).

> **Known instability (Team/Enterprise):** `list-skills` returns spurious 404s for Team/Enterprise accounts, causing all skills to vanish from the dashboard and making their UUIDs unrecoverable for subsequent deletes. Tracked at [anthropics/skills#61](https://github.com/anthropics/skills/issues/61). Retry with backoff before treating a 404 as a real error. Whether this surfaces from a browser context or is Cloudflare-specific is unconfirmed.

### 1.4 Upload Skill

Upload a `.skill` ZIP archive to create or update a skill. Two paths exist — one for personal skills and one for org-owned skills. The underlying mutation logic is identical.

```
POST /api/organizations/{org_id}/skills/upload-skill
POST /api/organizations/{org_id}/skills/upload-org-skill
```

**Query parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `overwrite` | `"true"` \| `"false"` | Yes | `"false"` — create only; fails with `upload_skill_already_exists` if a skill with the same name exists. `"true"` — upsert; server matches by name from SKILL.md frontmatter. |
| `check_skill_name` | string | No | Only appended when present and a non-empty string. Exact server behavior undocumented. |

The `overwrite` value is coerced client-side before the request is sent: any value other than the string `"true"` is sent as `"false"`.

> **Provenance:** `overwrite=false` is **confirmed** — the `claude_upload_skill.js` bookmarklet uses it exclusively, sends a single `file` field as `multipart/form-data`, sets no explicit Content-Type, and determines success from `res.ok` (HTTP 200) without parsing an ID. `overwrite=true` upsert behavior is **inferred** — not exercised by any bookmarklet; extrapolated from the parameter name and community reports. The `?overwrite=true` parameter eliminates the need to track skill IDs for update routing.

**Request:** Do not set `Content-Type` manually. The `Zh()` wrapper detects `FormData` bodies and skips setting `Content-Type`, allowing the browser to set `multipart/form-data` with the correct boundary automatically.

```http
POST /api/organizations/{org_id}/skills/upload-skill?overwrite=true HTTP/1.1
Host: claude.ai
anthropic-client-platform: web_claude_ai
[...standard headers, NO Content-Type]
Cookie: sessionKey=sk-ant-sid01-...
Content-Type: multipart/form-data; boundary=----FormBoundaryXXX

------FormBoundaryXXX
Content-Disposition: form-data; name="file"; filename="my-skill.skill"
Content-Type: application/zip

<binary ZIP data>
------FormBoundaryXXX--
```

Form field: `file` (binary) — the `.skill` ZIP archive. Archive structure and SKILL.md frontmatter requirements are in Section 7.

**Response** — always JSON, not empty on success.

Normal success (no validation step):
```json
{
  "id": "skill_01...", "name": "my-skill", "description": "...",
  "creator_type": "user", "updated_at": "2026-04-09T00:00:00.000Z",
  "enabled": true, "partition_by": "user", "is_public_provisioned": false,
  "user_invocable": true, "is_shared": false, "has_outgoing_shares": false,
  "shared_via": null, "owner": null, "enable_count": null
}
```

With validation (when server runs validation):
```json
{ "validation_errors": [], "skill": { ... } }
```

If `validation_errors` is a non-empty array the `skill` field is `null` and the upload is considered failed.

**Error response** (`4xx`/`5xx`):
```json
{ "error": { "type": "...", "message": "..." } }
```

When `overwrite=false` and a skill with the same name already exists, the error code is `upload_skill_already_exists`.

### 1.5 Enable / Disable Skill

```
POST /api/organizations/{org_id}/skills/enable-skill
POST /api/organizations/{org_id}/skills/disable-skill
```

Identical in all respects. Request body:

```json
{ "skill_id": "skill_01..." }
```

```http
POST /api/organizations/{org_id}/skills/enable-skill HTTP/1.1
Host: claude.ai
Content-Type: application/json
anthropic-client-platform: web_claude_ai
[...standard headers]
Cookie: sessionKey=sk-ant-sid01-...

{"skill_id":"skill_01..."}
```

HTTP 200 on success. The client optimistically updates the cache without waiting for a full list re-fetch.

### 1.6 Delete Skill

Two endpoints exist — one for personal skills and one for org-owned skills.

```
POST /api/organizations/{org_id}/skills/delete-skill
POST /api/organizations/{org_id}/skills/delete-org-skill
```

Request body: `{ "skill_id": "skill_01..." }`. HTTP 200 on success. Cache update differs by endpoint:

- **`delete-skill`**: removes the skill from the personal skills cache only (`list-skills` query key).
- **`delete-org-skill`**: removes the skill from both the org skills cache (`list-org-skills` query key) and the personal skills cache.

### 1.7 Download Skill

Download a skill's `.skill` ZIP archive. Two call sites exist in the bundle with different behaviors:

- **Query hook** (`RAe`): fetches the ZIP, extracts it client-side via `wAe()`, and returns `{ files: Array<{ path: string, content: string | Blob | ArrayBuffer }> }` sorted alphabetically by path. Content type is detected per file (text, image → Blob, binary → ArrayBuffer).
- **Browser download mutation** (`qAe`): fetches the ZIP, reads the filename from `Content-Disposition`, creates a temporary object URL, and triggers a browser file download via a synthetic anchor click (`URL.createObjectURL` + `<a>.click()`). Throws if `Content-Disposition` is missing or unparseable.

```
GET /api/organizations/{org_id}/skills/download-dot-skill-file?skill_id={skill_id}
```

Query parameter `skill_id` (required) — the skill's `id` value from list-skills (e.g. `skill_01...`).

```http
GET /api/organizations/{org_id}/skills/download-dot-skill-file?skill_id=skill_01... HTTP/1.1
Host: claude.ai
anthropic-client-platform: web_claude_ai
[...standard headers, NO Content-Type]
Cookie: sessionKey=sk-ant-sid01-...
```

Response: `200 OK` — binary ZIP (`Content-Type: application/zip`). The `Content-Disposition` header carries the filename; the client parses it with RFC 5987 priority:

1. `filename*=<charset>'<lang>'<encoded-name>` (RFC 5987, percent-encoded)
2. `filename="<name>"` (quoted)
3. `filename=<name>` (unquoted)

On failure, the body is JSON: `{ "error": { "type": "...", "message": "..." } }`.

### 1.8 Endpoint summary

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/bootstrap` | Auth + org UUID |
| `GET` | `/api/bootstrap/{org_id}/app_start` | Auth + org UUID (org-scoped, tried first) |
| `GET` | `/api/organizations/{org_id}/skills/list-skills` | Personal + optionally wiggle skills |
| `GET` | `/api/organizations/{org_id}/skills/list-org-skills` | Org-owned skills |
| `POST` | `/api/organizations/{org_id}/skills/upload-skill` | Upload/upsert personal skill |
| `POST` | `/api/organizations/{org_id}/skills/upload-org-skill` | Upload/upsert org skill |
| `POST` | `/api/organizations/{org_id}/skills/enable-skill` | Enable a skill |
| `POST` | `/api/organizations/{org_id}/skills/disable-skill` | Disable a skill |
| `POST` | `/api/organizations/{org_id}/skills/delete-skill` | Delete a personal skill |
| `POST` | `/api/organizations/{org_id}/skills/delete-org-skill` | Delete an org skill |
| `GET` | `/api/organizations/{org_id}/skills/download-dot-skill-file` | Download skill ZIP |

---

## 2. Auth and Headers

**Primary token:** the `sessionKey` cookie, value format `sk-ant-sid01-...`. Extract from browser DevTools → Application → Cookies → claude.ai. Lifespan: ~30 days. For bookmarklets and other in-browser scripts, `credentials: 'include'` handles all cookies automatically — no explicit token header is needed.

**Session cookies:**

| Cookie | Description |
|---|---|
| `sessionKey` | Claude session token. |
| `cf_clearance` | Cloudflare clearance. Required for non-browser clients. Longer-term cryptographic voucher (up to 1 year); tied to the exact User-Agent that solved the Cloudflare challenge. |
| `__cf_bm` | Cloudflare bot-management cookie. Required for non-browser clients. Rotates every ~30 minutes. |

Without the Cloudflare cookies, bare HTTP requests from `requests` or `axios` get a 403 from Cloudflare before reaching Anthropic's servers. Workaround: a headless browser (Playwright + stealth) to harvest `cf_clearance`, then reuse it in subsequent REST calls.

**`anthropic-client-platform` values** (set by `md()` based on context):

| Value | Condition |
|---|---|
| `desktop_app` | Desktop app UA detected (`window.claudeAppBindings` present) |
| `web_claude_ai` | `applicationType === 'claude-dot'` (main web app) |
| `web_console` | `applicationType === 'console'` |
| `web_custom_agents` | `applicationType === 'custom-agents'` |
| `unknown` | Default fallback |

Whether `anthropic-client-platform` is validated server-side or advisory is unconfirmed. Some telemetry headers (`anthropic-client-version`, `anthropic-client-sha`) accept `unknown`; others check for current production hashes and return 404 on stale values.

**No explicit CSRF token** has been identified. The API appears to rely on `SameSite` cookie attributes plus `Origin`/`Referer` header validation. Standard browser headers worth including for non-browser clients: `Origin: https://claude.ai`, `Referer: https://claude.ai/settings`, `Sec-Fetch-Dest: empty`, `Sec-Fetch-Mode: cors`, `Sec-Fetch-Site: same-origin`.

---

## 3. Provenance and Corrections / History

**Evidence base.** Section 1 is bundle-extracted (hashes `BFFVt7tV` 2026-04-10 and `D72Sf481` 2026-04-17) and is canonical. The web-UI findings were independently corroborated by three bookmarklets in [oaustegard/bookmarklets](https://github.com/oaustegard/bookmarklets) (`claude_upload_skill`, `claude_list_skills`, `claude_my_skills`) and the companion [oaustegard/claude-skills](https://github.com/oaustegard/claude-skills) repo (skills distributed as GitHub release ZIP assets). Confirmed-vs-inferred labels are noted inline above where they apply.

**Superseded endpoint forms (do not use).** Earlier research documented forms that the bundle and bookmarklets have since corrected:

| Earlier (wrong) | Correct |
|---|---|
| Upload at `POST /api/organizations/{org_id}/skills/upload` (flat `multipart/form-data`) | `POST .../skills/upload-skill` (and `upload-org-skill`); single `file` field |
| Org UUID from `GET https://claude.ai/api/organizations` (returns JSON array, parse `[0].uuid`) | `GET /api/bootstrap` → `account.memberships[0].organization.uuid` |
| Toggle via `PUT`/`PATCH /api/organizations/{org_id}/skills/{skill_id}` with `{ "enabled": true }` | Dedicated `POST .../enable-skill` / `disable-skill` with `{ "skill_id": ... }` |
| Delete via `DELETE /api/organizations/{org_id}/skills/{skill_id}` | `POST .../delete-skill` / `delete-org-skill` with `{ "skill_id": ... }` |
| Create vs update requires storing the skill ID for routing | `?overwrite=true` — server matches by `name`, no ID needed |

The earlier `PUT/PATCH` toggle and `DELETE` forms were never confirmed from bookmarklet source. The backend validation noted for the old toggle path (`name` ≤ 64 chars, `description` ≤ 1024 chars) still holds as a format constraint — see Section 7.

---

## 4. Official Product Contrast (`api.anthropic.com/v1/skills`)

> The official Anthropic API is a **completely separate product** from the claude.ai web UI. Skills uploaded here are invisible in the browser UI. Retained for reference only.

| Aspect | Official API (`api.anthropic.com`) | Internal Web API (`claude.ai/api/`) |
|---|---|---|
| Authentication | `x-api-key` header | `sessionKey` cookie + org UUID (in the path, or supplied as an `x-organization-uuid` header) |
| Skills CRUD | Fully documented `/v1/skills` | Partially reverse-engineered |
| Skills sync | Does NOT sync to claude.ai | Does NOT sync to official API |
| Stability | Versioned, stable beta | Undocumented, changes without notice |
| Community status | Well-supported | Most wrappers broken by Cloudflare |

**Anthropic's stated policy:** *"Custom Skills do not sync across surfaces. Skills uploaded to one surface are not automatically available on others."* The one exception: claude.ai web and Claude Desktop share skills. Implication: to manage skills visible in the claude.ai UI, the internal API is the only path; the official API only reaches skills usable via `POST /v1/messages`.

**Required headers:**
```
x-api-key: $ANTHROPIC_API_KEY
anthropic-version: 2023-06-01
anthropic-beta: skills-2025-10-02
```
For invocation via the Messages API, also add `anthropic-beta: code-execution-2025-08-25`.

**CRUD endpoints:**

- **Create** — `POST /v1/skills` (multipart/form-data):
  ```bash
  curl https://api.anthropic.com/v1/skills \
    -X POST \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: skills-2025-10-02" \
    -H "X-Api-Key: $ANTHROPIC_API_KEY" \
    -F "display_title=My Skill" \
    -F "files[]=@my-skill/SKILL.md;filename=my-skill/SKILL.md"
  ```
  Response: `{ "id": "skill_01...", "created_at": "...", "display_title": "My Skill", "latest_version": "1759178010641129", "source": "custom", "type": "skill" }`. The `files` parameter requires all files share a common top-level directory containing `SKILL.md` at its root. Total upload size limit: **30 MB**.
- **List** — `GET /v1/skills?source=custom`
- **Get** — `GET /v1/skills/{skill_id}`
- **Delete** — `DELETE /v1/skills/{skill_id}` → `{"id":"...","type":"skill_deleted"}`. You must delete all versions before deleting the skill itself, or you get a **400 error**.

**Version management:**

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/skills/{skill_id}/versions` | Upload new version |
| `GET` | `/v1/skills/{skill_id}/versions` | List versions (paginated) |
| `GET` | `/v1/skills/{skill_id}/versions/{version}` | Get specific version |
| `DELETE` | `/v1/skills/{skill_id}/versions/{version}` | Delete specific version |

Version IDs use epoch timestamps for custom skills (e.g. `"1759178010641129"`) and date strings for Anthropic built-ins (e.g. `"20251013"`). Both accept `"latest"` as shorthand.

**Invoking via the Messages API:**
```json
{
  "model": "claude-opus-4-6",
  "max_tokens": 4096,
  "container": {
    "skills": [
      {"type": "anthropic", "skill_id": "xlsx", "version": "latest"},
      {"type": "custom", "skill_id": "skill_01AbCdEf", "version": "latest"}
    ]
  },
  "tools": [{"type": "code_execution_20250825", "name": "code_execution"}],
  "messages": [{"role": "user", "content": "..."}]
}
```
Max **8 skills** per request. Pre-built Anthropic skills: `pptx`, `xlsx`, `docx`, `pdf`.

**Python SDK:** `client.beta.skills.create(...)`, `.list(...)`, `.retrieve(...)`, `.delete(...)`. Docs: https://platform.claude.com/docs/en/build-with-claude/skills-guide

---

## 5. Distribution and Tooling

### 5.1 GitHub / GitLab Releases one-click distribution

The companion repo `oaustegard/claude-skills` publishes each skill as a **GitHub Release** with a `.zip` asset. The `claude_my_skills.js` bookmarklet:

1. Calls `GET https://api.github.com/repos/oaustegard/claude-skills/releases`
2. Filters releases to those with `.zip` assets
3. On click: downloads the ZIP via `GET https://api.github.com/repos/oaustegard/claude-skills/releases/assets/{id}` with `Accept: application/octet-stream`
4. Uploads to claude.ai via `POST .../upload-skill?overwrite=false`

Skills stored as tagged releases, installable in one click. The pattern maps directly to GitLab — the differences are in the release-host API surface only; the claude.ai upload side is identical:

| Step | GitHub API | GitLab API |
|---|---|---|
| List releases | `GET https://api.github.com/repos/{owner}/{repo}/releases` | `GET https://gitlab.com/api/v4/projects/{id}/releases` |
| Get asset download URL | Asset `url` field, redirect with `Accept: application/octet-stream` | Asset `direct_asset_url` field in the release's `assets.links[]` |
| Download asset | `GET {asset_url}` + `Accept: application/octet-stream` | `GET {direct_asset_url}` (no special header) |
| Auth (public repo) | None required | None required |
| Auth (private repo) | `Authorization: token {PAT}` | `PRIVATE-TOKEN: {PAT}` header |

GitLab release asset structure (confirmed from GitLab API docs):
```json
{ "assets": { "links": [ { "name": "my-skill.zip", "url": "https://gitlab.com/...", "direct_asset_url": "https://gitlab.com/...", "link_type": "other" } ] } }
```

Key difference: GitLab uses `direct_asset_url` (no redirect) and authenticates with `PRIVATE-TOKEN` rather than `Authorization: Bearer`. For public repos, both hosts' assets download without authentication. Open question: whether GitLab's `direct_asset_url` works via CORS with browser-only cookies for private repos.

### 5.2 Community wrapper inventory

Conversation-focused wrappers targeting the internal claude.ai API (most partially or fully broken by Cloudflare; included for their auth patterns — **none implement skills endpoints**):

- **[KoushikNavuluri/Claude-API](https://github.com/KoushikNavuluri/Claude-API)** (874 stars, Python) — `curl_cffi` with Chrome impersonation to bypass bot detection. Conversations, messages, attachments. Most actively maintained.
- **[st1vms/unofficial-claude-api](https://github.com/st1vms/unofficial-claude-api)** (193 stars, Python) — Selenium/geckodriver for session harvesting. Supports proxies.
- **[Explosion-Scratch/claude-unofficial-api](https://github.com/Explosion-Scratch/claude-unofficial-api)** (743 stars, JS/Node) — Notice that Anthropic blocked non-browser traffic. Effectively broken.
- **[AshwinPathi/claude-api-py](https://github.com/AshwinPathi/claude-api-py)** — Simple `sessionKey` wrapper, conversations only.

Skills-specific tooling:

- **[PrashamTrivedi/agent-config-adapter](https://github.com/PrashamTrivedi/agent-config-adapter)** — Full REST layer (Hono) over skill management; `SkillsService` and `SkillZipService` for ZIP construction. Most relevant for ZIP construction and service structure.
- **[kalil0321/reverse-api-engineer](https://github.com/kalil0321/reverse-api-engineer)** — MCP + Playwright tool capturing browser traffic as HAR, then using Claude to auto-generate Python API clients.
- **[Quiver/skillserver](https://github.com/mudler/skillserver)** — Web GUI for managing skill `.zip` archives with drag-and-drop import and in-browser markdown editing; targets the web UI upload flow.
- **[yusufkaraaslan/Skill_Seekers](https://github.com/yusufkaraaslan/Skill_Seekers)** — Converts doc URLs, GitHub repos, and PDFs into `skill.md` + ZIP archives ready for web UI upload.

Not relevant (Claude Code filesystem conventions / multi-editor symlink sync, no claude.ai web API interaction): [runkids/skillshare](https://github.com/runkids/skillshare), [dhruvwill/skills](https://github.com/dhruvwill/skills).

### 5.3 DIY API-capture methodology

If endpoints change, recapture them:

1. claude.ai → Settings → Customize → Skills
2. DevTools → Network → filter Fetch/XHR
3. Perform: toggle skill on/off, upload a ZIP, delete a skill
4. Capture: full URL, method, request headers, request body (multipart or JSON), response shape

Alternative: [mitmweb](https://mitmproxy.org/) as a reverse proxy against `https://claude.ai`, though Cloudflare may complicate it.

### 5.4 Practical notes for `upload.js`

1. **Auth setup:** store `SESSION_KEY`, `ORG_ID`, optionally `CF_CLEARANCE` + `CF_BM` in `.env`. Fetch the org UUID dynamically on first run and cache it.
2. **Cloudflare bypass:** for fully unattended uploads, use `curl_cffi` (Python) or Playwright stealth (Node). For a developer-run script with a browser already open, copy cookies manually — much simpler.
3. **ZIP construction:** the archive must have the skill directory as the single root entry (see Section 7).
4. **Idempotency / drift detection:** store a UUID → local skill name mapping in a lockfile (e.g. `skills/.skillmap.json`) to branch update vs create.
5. **Error handling:** `list-skills` returns spurious 404s — retry with backoff. Upload returns HTTP 500 during infrastructure congestion — also retry.

---

## 6. Client-Side Runtime Architecture

_Source: `snapshots/derived/D72Sf481/primary.js`, bundle captured 2026-04-17._

### 6.1 How skills enter the session

Skills are **not injected into the system prompt by the client**. The client explicitly opts out:

```
/edge-api/bootstrap/{org}/app_start?include_system_prompts=false   (line 16368)
```

System prompts (including skill context) come from the server. The client maintains a local **plugin registry** populated from server messages.

**Session plugin registry** — state variable `sessionPlugins` (line 69387), populated from server `init` subtype messages:
```js
// line 69833
if (message.subtype === 'init' && message.plugins) {
  setSessionPlugins(message.plugins)
}
```
Refreshable via `reloadPlugins()` (line 69714–69732), which returns `{ plugins: [], commands: [], skills: [], agents: [], mcpServers: [] }`. Skills coexist with legacy "commands" (slash commands), agents, and MCP servers in a unified plugin model.

### 6.2 Skill selection flow

On selecting a skill from the slash menu or chip picker, Redux stores (action `SELECT_SKILL`, line 45065–45066):
```js
{ type: 'skill', skillName: t.skillName, pluginName: t.pluginName }
```
Stored under `chatResourceState.selectedItem`.

**Skill chip content block** (line 42776–42778):
```js
{ type: 'skillChip', skillId: string, skillDisplayName: string, skillDescription: string, skillArgumentHint: string }
```
Legacy `commandChip` blocks are up-converted to `skillChip` by `$2()` (line 42883–42897): `commandId → skillId`, `commandDisplayName → skillDisplayName`, etc.

### 6.3 Slash command resolution (desktop)

The desktop app resolves slash command skill matches via IPC:

- IPC message type: `slash_menu_skills_resolve` (line 107478)
- Input: `{ requestId, skillNames: string[], keywords: string[] }`
- Handler: `KZe()` (line 102804) — filters/ranks by keyword match. If `skillNames` provided → exact name filter; if `keywords` provided → score = `(name_match × 2) + (desc_match × 1)`, sorted descending; returns matched array.
- Display formatting: `VZe()` (line 102738) strips the org prefix: `'org:skillname' → 'skillname'`.
- Response sent back via `respondSlashMenuSkills(requestId, JSON.stringify(matched))`.

### 6.4 Skill activation event flow

When the backend executes a skill, it emits a `skill_invoked` subtype server event (line 107665):
```js
case 'skill_invoked':
  const enriched = await x1e(rawData, session)  // track telemetry
```
`x1e(t, s)` (line 107671) builds the telemetry payload: `is_plugin` (boolean), `plugin_name` (hashed for official plugins, `'third-party'` for custom), `is_official_plugin` (boolean), `plugin_source`, `marketplace_name`. Telemetry event fired: `claudeai.cowork.skill.invoked` version 5 (line 19150) with fields `session_id`, `skill_name`, `skill_name_hash`, `is_plugin`, `plugin_name_hash`.

### 6.5 Skill MIME type

`application/vnd.ant.skill` is registered in the `bge` artifact type enum (line 60557):
```js
{ mimeType: 'application/vnd.ant.skill', syntaxName: 'skill', extension: () => 'skill' }
```
File extension mapping in `Cge`: `['skill', 'application/vnd.ant.skill']` (line 60591). A skill artifact is treated as a code artifact with syntax mode `'skill'` — content is the skill definition (YAML/JSON/Markdown depending on format).

> Note: `artifacts-and-sandbox-runtime.md` documents the same artifact-type enum as `xge` (line 60537), captured from a different bundle hash. `bge`/60557 and `xge`/60537 are the same registry under a drifted minified symbol name across captures — not two separate enums.

### 6.6 TipTap editor integration

Skills integrate into the composer as TipTap nodes:
- DOM attribute: `data-skill-chip` (line 200716)
- Rendered as `/<skillDisplayName>` inline
- Tracked attributes: `skillId`, `skillDisplayName`, `skillDescription`, `skillArgumentHint`
- Callback on insertion: `onSkillChipInserted` (line 200724); `addOptions: () => ({ onSkillChipInserted: void 0 })`

### 6.7 Telemetry event catalog

| Event | Trigger |
|---|---|
| `claudeai.cowork.skill.invoked` | Skill executed in session |
| `claudeai.skill.suggestion.viewed` | Suggestion panel visible |
| `claudeai.skill.suggestion.expanded` | Expand view |
| `claudeai.skill.suggestion.view_all_clicked` | Open directory |
| `claudeai.skill.suggestion.dismissed` | Close panel |
| `claudeai.skill.suggestion.try_clicked` | Insert chip |
| `claudeai.cowork.skill_save_card.viewed/dismissed/approved` | Save flow |
| `claudeai.skills.skill.upload.succeeded/upload_failed` | Upload events |
| `claudeai.skills.file_save_skill.clicked` | Save to skill folder |
| `claudeai.skills.skill.toggled/deleted` | Toggle/delete skill |

### 6.8 What the client does NOT handle

- **First-run detection** — no client-side hook fires on the first script execution in a skill folder.
- **Reference file loading** — loading additional context files is a backend concern, not client-enforced.
- **System prompt injection** — entirely server-side; client passes `include_system_prompts=false` at bootstrap.

### 6.9 primary.js search-anchor table

| String | Line(s) | Purpose |
|---|---|---|
| `include_system_prompts=false` | 16368 | Bootstrap query opts out of client-side system prompt |
| `sessionPlugins` | 69387, 69833 | Session plugin registry state variable |
| `reloadPlugins` | 69714, 69780 | Function to refresh plugin list |
| `SELECT_SKILL` | 45065–45066 | Redux action for skill selection |
| `{ type: 'skill', skillName:` | 45066 | Skill selection state shape |
| `skillChip` | 42776, 42734, 42886 | Content block type for skill references |
| `case 'skill_invoked':` | 107665 | Server event handler for skill execution |
| `claudeai.cowork.skill.invoked` | 19150, 107674 | Telemetry event + handler |
| `async function x1e(` | 107671 | Skill telemetry enrichment function |
| `application/vnd.ant.skill` | 60557 | MIME type registration in artifact enum |
| `data-skill-chip` | 200716 | TipTap DOM attribute for skill chip node |
| `onSkillChipInserted` | 200724 | TipTap callback on chip insertion |
| `slash_menu_skills_resolve` | 107478 | IPC message type for slash menu |
| `KZe` | 102804 | Skill ranking/filter function |
| `VZe` | 102738 | Display name formatter (strips org prefix) |

---

## 7. SKILL.md File Format

> **Scope:** the SKILL.md format as it applies to **web UI uploads** (claude.ai). Several frontmatter fields and runtime features (shell injection, subagent forking, hooks, model override) are Claude Code CLI-only and have no effect when uploaded to claude.ai. The agentskills.io JSON Schema URL is confirmed dead (ECONNREFUSED).

A skill is a **directory** containing a `SKILL.md` file with optional YAML frontmatter and a markdown body. For claude.ai it is delivered as a `.zip` archive uploaded via the web UI.

### 7.1 Directory structure

The directory name becomes the slash command and is the skill's identifier.

```
my-skill/
├── SKILL.md           # Required: frontmatter + instructions
├── scripts/           # Optional: executable code Claude runs via Bash
│   └── helper.py
├── references/        # Optional: docs loaded into context on demand
│   └── policy.md
└── assets/            # Optional: templates/data, NOT auto-loaded
    └── template.csv
```

Key distinction: `references/` content is loaded into the context window when referenced (costs tokens); `assets/` files are only referenced by path (zero context cost at load time).

**Naming rules for the directory:**
- Lowercase letters, numbers, hyphens only — no spaces, underscores, or capitals
- No consecutive, leading, or trailing hyphens
- Max 64 characters
- Cannot contain `claude` or `anthropic` (reserved)

`SKILL.md` is **case-sensitive** — not `skill.md`, `Skill.md`, or `SKILLS.md`.

### 7.2 Format

```markdown
---
name: my-skill
description: Does X. Use when the user asks for Y or mentions Z.
---

Instructions for Claude go here, in standard markdown.
```

Both `name` and `description` are **required for web UI uploads** — the server uses `name` as the identity key for create/update matching (`?overwrite=true`). Example with web-effective fields:

```markdown
---
name: fix-issue
description: Fix a GitHub issue by number. Use when someone asks to fix or resolve an issue.
argument-hint: [issue-number]
user-invocable: true
compatibility: Requires GitHub CLI (gh) installed and authenticated.
license: MIT
metadata:
  author: platform-team
  version: "1.2.0"
---

Fix GitHub issue $ARGUMENTS following our coding standards.
```

### 7.3 Frontmatter field reference

**Required for web UI:**

| Field | Constraints | Purpose |
|---|---|---|
| `name` | Max 64 chars, `[a-z0-9-]` only, no `claude`/`anthropic` | Slash command identifier; server-side identity key |
| `description` | Max 1024 chars; **200 chars shown in listings on claude.ai** | Trigger heuristic for auto-invocation |

`description` is the **sole signal** the model uses to decide whether to invoke the skill autonomously. Best practices:
- Write in third person: "Extracts text from PDF files" not "Help with PDFs"
- Include explicit trigger phrases: "Use when the user requests... or mentions..."
- Include explicit anti-triggers if needed: "Do NOT trigger when..."
- Cannot contain XML angle brackets (`<`, `>`) — security measure against prompt injection
- Keep under 200 chars to avoid truncation in the claude.ai listing UI (vs 250 chars in Claude Code CLI)

**Optional fields (effective on claude.ai):**

| Field | Type | Default | Purpose |
|---|---|---|---|
| `argument-hint` | String | None | Autocomplete hint, e.g. `[issue-number]` |
| `user-invocable` | Boolean | `true` | `false` = hidden from `/` menu; Claude invokes autonomously only |
| `compatibility` | String | None | Environment requirements note, max 500 chars |
| `license` | String | None | e.g. `MIT`, `Apache-2.0` |
| `metadata` | Object | None | Arbitrary key-value map: author, version, etc. |

**CLI-only fields (parsed but ignored on claude.ai):** `disable-model-invocation`, `allowed-tools`, `model`, `effort`, `context`, `agent`, `hooks`, `paths`, `shell`. Shell injection (`!`\`...\``) and `$ARGUMENTS` substitution are also Claude Code CLI-only — they are passed through as literal text in the web UI.

### 7.4 ZIP packaging

The archive must have the **skill folder as the single root entry**:

```
# Correct:
my-skill/
└── SKILL.md

# Wrong (flat — will 500 or create a phantom skill with no files):
SKILL.md
```

**Double-nesting trap:** if extraction yields `my-skill/my-skill/SKILL.md`, the parser silently ignores it. `SKILL.md` must be exactly one level deep inside the named skill directory. Script dependencies in `scripts/` must use **relative paths** — absolute paths valid locally will fault inside the cloud container.

### 7.5 Cloud sandbox constraints

Scripts run in an x86_64 Linux container with:
- 1 vCPU, 5 GB RAM, 5 GB ephemeral storage
- **Outbound network: completely disabled** — no `curl`, no external API calls, no `pip install` at runtime
- Pre-installed Python libraries:

| Category | Packages |
|---|---|
| Data science | `pandas`, `numpy`, `scipy`, `scikit-learn`, `statsmodels`, `sympy`, `mpmath` |
| Visualization | `matplotlib`, `seaborn` |
| Document parsing | `python-pptx`, `python-docx`, `pypdf`, `pdfplumber`, `pypdfium2`, `tabula-py` |
| Data extraction | `openpyxl`, `xlsxwriter`, `xlrd`, `pyarrow`, `pillow`, `pdfkit`, `Img2pdf` |
| Utilities | `tqdm`, `joblib`, `sqlite`, `unzip`, `7zip`, `ripgrep` |

Files generated in the cloud sandbox are not automatically saved locally — they are returned via the Files API as download links.

### 7.6 Content limits

- **`SKILL.md` body:** recommended under **500 lines / 5,000 tokens**. Soft limit; exceeding it degrades focus and wastes context.
- **Description in listings:** 200 chars on claude.ai (vs 250 in Claude Code CLI).
- **No shell injection or argument substitution** in the web UI.

### 7.7 Validation checklist (for `upload.js` / `make validate`)

Enforce locally before uploading:

1. Directory name is kebab-case (`[a-z0-9-]`), ≤ 64 chars, no reserved words (`claude`, `anthropic`), no consecutive/leading/trailing hyphens
2. `SKILL.md` exists at exactly one level deep inside the directory (not nested further, not at the ZIP root)
3. `name` frontmatter field is present and matches the directory name
4. `description` field is present, ≤ 1024 chars, ideally ≤ 200 chars
5. No `<` or `>` in any frontmatter string values (prompt injection guard)
6. Body ≤ 500 lines (warn, not block)
7. ZIP structure has the skill directory as the single root entry (not flat)

---

## 8. Open Questions

- **Upload identity key for `overwrite=true`:** does the server match on the SKILL.md frontmatter `name` field, or on the ZIP root directory name? These can differ.
- **`overwrite=true` versioning:** in-place update (same `id`) or new version? Web UI versioning semantics unknown.
- **`check_skill_name` parameter:** purpose and accepted values unknown.
- **`list-org-skills` query parameters:** whether it supports `include_wiggle_skills` or any other params is not shown in the bundle.
- **Enable/disable/delete response bodies:** the client only checks `res.ok` — the success response shape is unknown.
- **Personal accounts:** whether bootstrap works for accounts without an organization (`memberships[0]` may be absent).
- **`partition_by` values:** `"user"` and `"organization"` observed in sort logic; whether others exist is unknown.
- **`anthropic-client-platform` server-side validation:** advisory or enforced for non-browser clients?
- **Cloudflare cookies for CI scripts:** confirmed required for non-browser clients; the exact rotation/harvest cadence for unattended use is untested.
- **`list-skills` 404 from a browser context:** is the Team/Enterprise spurious-404 Cloudflare-specific or also server-side?
- **GitLab `direct_asset_url` via CORS:** does a browser-only (no PAT) one-click installer work for private GitLab repos?

---

## Sources

- [anthropics/skills GitHub repo](https://github.com/anthropics/skills)
- [anthropics/skills#61 — "Not found" error when loading Skills](https://github.com/anthropics/skills/issues/61)
- [oaustegard/bookmarklets](https://github.com/oaustegard/bookmarklets), [oaustegard/claude-skills](https://github.com/oaustegard/claude-skills)
- [jahwag/ClaudeSync#24 — 403 response](https://github.com/jahwag/ClaudeSync/issues/24)
- [Kir Shatrov — Reverse engineering Claude Code](https://kirshatrov.com/posts/claude-code-internals)
- [What Cookies Does Anthropic Use?](https://privacy.claude.com/en/articles/10023541-what-cookies-does-anthropic-use)
- [Agent Skills overview — Anthropic docs](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
- [Skill authoring best practices — Anthropic docs](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- [Using Skills with the API — Anthropic docs](https://platform.claude.com/docs/en/build-with-claude/skills-guide)
- [The SKILL.md Pattern — Bibek Poudel (Medium)](https://bibek-poudel.medium.com/the-skill-md-pattern-how-to-write-ai-agent-skills-that-actually-work-72a3169dd7ee)
- [Claude Agent Skills: A First Principles Deep Dive — leehanchung](https://leehanchung.github.io/blogs/2025/10/26/claude-skills-deep-dive/)
- Primary research reports (April 2026): *Claude.ai skills API: internal endpoints and official alternatives*; *Reverse-Engineering the Claude.ai Skills Architecture*; *Claude skills file format: the complete technical specification*; *Architectural Specification and Engineering Analysis of the Agent Skills Open Standard*
