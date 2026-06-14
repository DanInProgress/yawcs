---
created: 2026-04-18
updated: 2026-04-18
---
# Code Execution and Wiggle

_Source: `snapshots/derived/D72Sf481/primary.js`, bundle captured 2026-04-17._

This doc consolidates everything known about Claude.ai's code execution capability ("wiggle"), the browser iframe sandbox that runs the code, the three additional server-side execution mechanisms, the wiggle artifact and file-egress pipeline, and the loosely-related MCP transport layer.

> **Disambiguation**: Code _execution_ uses the `RunCode` method — wiggle scripts that run arbitrary JS in a bare sandbox. Artifact _rendering_ uses the `SetContent` method — HTML, React, SVG, Mermaid previews — and is covered in [`artifacts-and-sandbox-runtime.md`](artifacts-and-sandbox-runtime.md). Both share the same `i7e` SandboxHandler bridge, but the renderer side is entirely different.

---

## 1. What Wiggle Is

Wiggle is **not a skill type**. It is a **feature capability** that gates three related subsystems:

1. Code execution — running scripts in the browser sandbox.
2. File creation and egress — uploading created files out of the conversation context.
3. Network access — outbound HTTP from executed code.

When wiggle is enabled, Claude can produce `wiggle_artifact` outputs that are executable, downloadable, and shareable. A wiggle artifact is distinct from both widget tools (ephemeral inline renderers) and regular artifact skills: it persists as a real file tied to the conversation and can be downloaded, shared, or exported to Google Drive.

### The Three-Level Feature Gate

Three-level hierarchical gate (lines 31894–31905) — **all** must be enabled:

```js
wiggle: yP({
  feature: 'wiggle',
  useClientSideGate: () => XN('trials_and_tribulations_of_high_school_football'),
  useOrgSetting: () => mP('wiggle', { loadingFallback: true }),
  useUserPreference: () => { ...account.settings.enabled_monkeys_in_a_barrel... }
})
```

| Level | Flag / Field | Notes |
|---|---|---|
| Statsig | `trials_and_tribulations_of_high_school_football` | Client-side A/B gate (can toggle per-cohort independently of org/user settings) |
| Org setting | `wiggle` | Org-level toggle |
| User preference | `enabled_monkeys_in_a_barrel` | Labeled "Code execution and file creation" in settings (line 31903) |

**Runtime check**: `enabled_wiggle` org field (line 177364), with `rbacEntitlement: 'code_execution'`. This is the field read at execution time to decide whether to create the sandbox.

**Related tool-injection gate**: `rely_on_analysis_flag` — when true, this is a gating condition for `repl_v0` / code-execution tool injection (line 230053). Distinct from the three-level `wiggle` gate above: it governs whether the code-execution *tool* is offered to the model, not whether the sandbox runtime is enabled for the org/user.

### Toggle Side Effects

When `enabled_monkeys_in_a_barrel` is enabled, the client also sets `enabled_artifacts_attachments: false` and `preview_feature_uses_artifacts: true` (line 48750).

### The wiggle → skills → skill-creation Dependency Chain

The dependency chain runs in one direction: **wiggle → skills → skill creation/sharing**. Skills depend on wiggle (line 177365). If the org has `enabled_wiggle: false`, the skills system is disabled entirely — a hard dependency, since skill creation requires code execution capability.

---

## 2. Mechanism 1 — Artifact Iframe Sandbox (browser-side, primary)

The primary code execution path is a hidden, dynamically-created `<iframe>` loaded from a separate origin — **not** a server-side container.

### Sandbox Architecture

**Production URL**: `https://www.claudeusercontent.com` (line 260558: `userContentRendererUrl`)
**Page path**: `/isolated-segment.html?v={version}&domain={domain}&parentOrigin={origin}`
**Alt CDN path**: `https://a.claude.ai/isolated-segment.html?v={version}` (lines 18776–18777)

The iframe is positioned off-screen and hidden:
- CSS: `opacity-0 pointer-events-none`, `h-full w-full`
- Created dynamically by `executeReplCode(e)` (line 260198)

**No Docker/container/Kubernetes signals visible in bundle.** Server-side execution infrastructure (if any backs this path) is not exposed to the web client.

#### Sandbox Iframe Attributes

```
sandbox: 'allow-scripts allow-same-origin'
referrerPolicy: 'no-referrer'
title: 'Claude content'
```

What these allow/block:
- ✅ JavaScript execution (`allow-scripts`)
- ✅ Same-origin API calls (`allow-same-origin`)
- ❌ Form submission, plugin access, top-level navigation, popup windows

### 8-Step Execution Flow

1. `CreateExecutionSandbox` function (lines 260202–260275) creates the hidden iframe
2. `SandboxHandler` class `i7e` (line 118679) is initialized to manage communication
3. Parent sends `__sandbox_handshake__` via `postMessage` to establish `MessageChannel` (line 118748)
4. Iframe sends `ReadyForContent` method call back over the channel
5. Parent sends `RunCode` with the code string
6. **10-second timeout** (`1e4` ms at line 260256) — execution aborted if exceeded
7. Iframe sends `RunCodeResponse` with results
8. Results streamed back to message UI

### SandboxHandler (`i7e`) Internals

The bridge between parent page and iframe (lines 118679–118887):
- Validates origin on every message: `e.origin !== this.allowedOrigin` check (line 118757)
- **Rate limit**: 30 messages per 5-second window (lines 118689–118690)
- Routes incoming method calls to registered capability handlers
- Logs all requests and responses

### Two-Layer Communication Protocol

#### Layer 1 — postMessage Handshake

```js
iframe.contentWindow?.postMessage(
  { type: '__sandbox_handshake__' },
  allowedOrigin,
  [messageChannel.port2]   // transfers port ownership
)
```

Sets up a `MessageChannel` — port2 goes to the iframe, port1 stays with parent.

#### Layer 2 — MessageChannel (secure bidirectional)

Message format:
```js
{
  channel: 'request' | 'response',
  method: 'anthropic.claude.usercontent.sandbox.<MethodName>',
  requestId: UUID,
  payload: {
    '@type': 'type.googleapis.com/anthropic.claude.usercontent.sandbox.<PayloadType>',
    // method-specific fields
  }
}
```

The `anthropic.claude.usercontent.sandbox.*` namespace (lines 116139–116191) is the stable anchor for all sandbox method calls.

### Full Sandbox API — 21 Methods

All 21 methods defined in `i4e` constants (lines 115791–115813):

#### Lifecycle
| Method | Direction | Description |
|---|---|---|
| `ReadyForContent` | sandbox → host | Iframe signals it's ready to receive code (handshake complete) |
| `DOMContentLoaded` | sandbox → host | DOM ready signal |

#### Content & Rendering
| Method | Description |
|---|---|
| `GetFile` | Fetch artifact file content |
| `SetContent` | Update HTML/CSS/JS in artifact (renderer path, not execution) |
| `GetScreenshot` | Render artifact to image / capture current frame |
| `CopyHtmlContent` | Copy HTML to clipboard |
| `GetDOMSnapshot` | Serialize DOM tree |

#### API & Communication
| Method | Permission | Description |
|---|---|---|
| `RunCode` | Always (host → sandbox) | Send code string for execution |
| `SendConversationMessage` | Always | Send message to parent Claude session |
| `ClaudeCompletion` | **Gated** (line 119178) | Request inline Claude completion |
| `ProxyFetch` | Always | HTTP request through parent proxy |
| `ProxyFetchStream` | Always | Streaming HTTP via chunked responses |
| `OpenExternal` | Dialog | Request external link open |
| `DownloadFile` | Dialog | Trigger file download |

#### Storage
| Method | Description |
|---|---|
| `StorageGet` | Read artifact-scoped KV entry |
| `StorageSet` | Write artifact-scoped KV entry |
| `StorageDelete` | Delete artifact-scoped KV entry |
| `StorageList` | List all keys in artifact store |

#### Monitoring
| Method | Description |
|---|---|
| `ReportError` | Log error to parent |
| `TrackInteraction` | Analytics event |
| `BroadcastContentSize` | Communicate iframe dimensions to parent |

#### RunCode vs SetContent
- **`RunCode`** (host → sandbox): execute arbitrary JS — the wiggle/code-execution path.
- **`SetContent`**: replace the artifact's HTML/CSS/JS for rendering — the artifact preview path. Both flow through the same `i7e` bridge but serve different subsystems.

#### ClaudeCompletion Gating
`ClaudeCompletion` is the only API method gated behind an additional check at line 119178; all other communication methods are always available once the handshake completes.

### What the Sandbox Cannot Do

- ❌ Access parent DOM (cross-origin isolation)
- ❌ Make arbitrary fetch requests (all HTTP goes through `ProxyFetch` proxy, restricted to `api.anthropic.com`)
- ❌ Access browser localStorage or IndexedDB directly
- ❌ Open popups or navigate top-level frame
- ❌ Execute past 10 seconds without timeout

---

## 3. Mechanism 2 — Self-Hosted Code Runners (enterprise)

Enterprise customers can provision their own execution infrastructure. The web client communicates with these through a dedicated endpoint family.

Base path: `/v1/code/runners/self-hosted/` (lines 232259–232462)

| Endpoint | Purpose |
|---|---|
| `/pools` | Pool management (create, list, delete) |
| `/runners` | Individual runner instance management |
| `/sessions` | Execution session lifecycle |
| `/sessions/{id}/requeue` | Requeue a failed session |
| `/sessions/{id}/release-from-runner` | Release session from a specific runner |

Session data includes:
- `self_hosted_runner_pool_id` — identifies which enterprise pool to use
- `environment_id` — alternative environment selection field
- Pool secrets management for credential injection

Enterprise customers provision and maintain their own execution infrastructure; Claude.ai routes sessions to their runners via these APIs.

---

## 4. Mechanism 3 — Scheduled Tasks / Triggers (server-side autonomous)

Triggers allow code or prompts to run autonomously on a schedule without a user present.

Base path: `/v1/code/triggers/` (lines 257537–257684)

| Endpoint | Purpose |
|---|---|
| `POST /v1/code/triggers` | Create a new trigger |
| `POST /v1/code/triggers/{triggerId}/run` | Execute a trigger immediately |
| `PATCH /v1/code/triggers/{triggerId}` | Update trigger configuration |

Scheduling options:
- `cronExpression` — standard 5-field cron syntax for recurring runs
- `fireAt` — ISO 8601 timestamp for one-shot scheduled execution

When a scheduled task fires, the server wraps the user's prompt in an XML tag (line 79922):

```
<scheduled-task name="{name}" file="{file}">{prompt}</scheduled-task>
```

The model receives autonomous mode instructions (lines 79903–79905):

> "This is an automated run of a scheduled task. The user is not present..."

**MCP write operation gating in scheduled context**: write/destructive MCP operations are only permitted if the task description explicitly requests them (line 80344). This prevents unintended side effects in unattended runs.

---

## 5. Mechanism 4 — Remote Agents / Epitaxy (server-side Anthropic infra)

A separate server-side execution layer handles remote agent dispatch on Anthropic's backend.

- Route: `/epitaxy` (line 44358)
- Handlers: `EpitaxyRemoteAgentsRoute` (line 300045), `CodeRemoteAgentsRoute` (line 300044)
- Session source is tagged `dispatch` or `remote/` (lines 134612, 134805) to distinguish from interactive sessions

No further implementation details are visible in the web bundle — this executes entirely on Anthropic's backend infrastructure. The web client only initiates and monitors these sessions.

---

## 6. NOT Code Execution (common confusion)

These are frequently mistaken for execution mechanisms but perform no code execution:

| Asset | What it actually does |
|---|---|
| `/monaco-workers/json.worker.js`, `/monaco-workers/editor.worker.js` | Monaco editor web workers — syntax highlighting and validation only |
| `/tree-sitter/wasm/web-tree-sitter.wasm` | Tree-Sitter WASM module — AST parsing for syntax analysis only |
| `createObjectURL` blob URLs | File handling for uploads/downloads — not execution |

**No Docker/container/Kubernetes signals** appear anywhere in the bundle.

---

## 7. Wiggle Artifact Lifecycle

### Creation

Wiggle artifacts are created at lines 212869–212872:

```js
{
  type: 'wiggle_artifact',
  id: uuid(filePath + conversationUuid),  // deterministic from path + conv
  conversation_uuid: conversationUuid,
  file_path: filePath
}
```

Both `conversation_uuid` and `file_path` are **required** for any artifact-scoped API call. The UUID is **deterministically derived** from `filePath + conversationUuid`, so repeated calls produce stable artifact IDs.

The `wiggle_artifact` type (lines 118576, 19898–19925, 212870) tells the client this is an executable artifact, not a static document.

### ProxyFetch Context Headers

Every ProxyFetch request from a wiggle artifact context injects:
- `anthropic-artifact-id: {uuid}`
- `anthropic-artifact-entity-type: wiggle_artifact`
- `anthropic-chat-conversation-uuid: {uuid}`
- `anthropic-file-path: {path}`

These headers allow the server-side proxy to scope API calls to the specific artifact context.

---

## 8. File Upload & Egress Pipeline

### Upload Endpoint

```
POST /api/organizations/{org}/conversations/{conv}/wiggle/upload-file
```
(line 52502)

### Handler Chain

Files are routed through handlers in order (first match wins):

1. **`SimpleUploadToWiggleHandler`** (line 52930) — handles all files when wiggle is enabled. Sends directly to the wiggle upload endpoint.
2. **`OutOfContextFileHandler`** (line 52775) — files exceeding the in-context size limit or feature-gated types. Routes oversized files through wiggle upload.
3. **`TextAttachmentHandler`** (line 52845) — text-safe files that stay in context. Processes inline without upload.

The `GetFile` sandbox method (see §2) is how executed code reads uploaded file content back into the sandbox.

### Size Limit

`vle()` function (line 52286) reads config key `max_in_context_file_bytes`. Default: **15,360 bytes (15 KB)**. Files larger than this threshold are automatically routed to `OutOfContextFileHandler` → wiggle upload, even when the user hasn't explicitly triggered code execution.

### Network Egress — Hard Allowlist (Client-Enforced)

```js
J6e = ['api.anthropic.com']  // line 118543
```

The ProxyFetch handler only allows requests to this hostname. Any other URL throws an error at line 118602. This is enforced client-side — the iframe cannot bypass it.

### Proxy Handler Map (org-scoped rewrite)

```js
s7e = {
  'api.anthropic.com': (req) => fetch(`/api/organizations/${orgUuid}/proxy/v1/messages`, req)
}
// line 118567
```

The proxy rewrites all `api.anthropic.com` calls to the organization-scoped proxy endpoint `/api/organizations/{org}/proxy/v1/messages`, where the server injects auth credentials.

### Egress Settings (dual-gated)

| Setting | Description |
|---|---|
| `enabled_wiggle_egress` | User toggle for network access from executed code |
| `wiggle_egress_allowed_hosts` | Per-org allowlist of permitted outbound hostnames (server-enforced) |
| `claudeai_default_wiggle_egress_enabled` | Default value for new users |
| `wiggle_egress_spotlight_viewed_at` | Tracks whether user has seen the egress feature discovery spotlight |

Settings functions (lines 48635–48671): `pse()`, `mse()`, `hse()`, `fse()`, `gse()`, `xse()` manage org/user toggles and allowlist lookups.

**Egress is dual-gated**: both the org setting (`wiggle_egress_allowed_hosts`) and the user setting (`enabled_wiggle_egress`) must enable it. As a **prerequisite**, the egress spotlight feature-discovery banner must be viewed before egress can be enabled (tracked via `wiggle_egress_spotlight_viewed_at`).

Note the two layers: `J6e` is a hard client-side allowlist limited to `api.anthropic.com`; `wiggle_egress_allowed_hosts` is the additional server-enforced per-org layer.

---

## 9. Wiggle Skills, UI Surfaces & Telemetry

### Wiggle Skills

When fetching the skills list, the client appends `include_wiggle_skills=true` (line 82442):

```
GET /api/organizations/{org}/skills/list-skills?include_wiggle_skills=true
```

**Separate cache key** when wiggle is included:
- Without wiggle: `[sN, orgId]`
- With wiggle: `[sN, orgId, 'with-wiggle']` (line 82444)

Wiggle skills are skills designed for sandbox execution — they run inside the browser code execution environment and are incompatible with standard artifact/plugin contexts. They appear as a distinct category in the skills list only when `include_wiggle_skills=true` is passed.

### Wiggle File Card (`I8e`, line 124371)

The `I8e` React component renders the persistent file card for a wiggle artifact. Actions available:
- Download (single file and all-files)
- Copy to clipboard
- Add to project
- Share artifact (generates share link)
- Publish artifact
- Google Drive export

### Settings Toggle & File-Access Warning

- The `enabled_monkeys_in_a_barrel` field controls the "Code execution and file creation" toggle in user settings (line 31903).
- When attached files require code execution to process (line 93838): _"Claude needs code execution to access some attached files"_. Context-dependent messaging appears based on file type and wiggle availability.

### Telemetry — 14-Event Catalog

14 event types across three groups (lines 19898–19925):

#### File Events (8)
| Event | Trigger |
|---|---|
| `wiggle.file.created` | Wiggle artifact first created |
| `wiggle.file.downloaded` | Single file downloaded |
| `wiggle.file.downloaded_all` | Bulk download triggered |
| `wiggle.file.copy_to_clipboard` | Copy action used |
| `wiggle.file.add_to_project` | Added to project library |
| `wiggle.file.download_as_pdf` | PDF export triggered |
| `wiggle.file.share_artifact` | Share link generated |
| `wiggle.file.publish_artifact` | Artifact published |

#### Google Drive Events (3)
| Event | Trigger |
|---|---|
| `wiggle.file.gdrive_export.attempted` | Drive export started |
| `wiggle.file.gdrive_export.success` | Drive export succeeded |
| `wiggle.file.gdrive_export.failed` | Drive export failed |

(Plus Drive connection events `wiggle.gdrive.connection.modal_shown`, `.initiated`, `.success` at lines 19915–19917.)

#### Egress Spotlight Events (3)
| Event | Trigger |
|---|---|
| `wiggle_egress_spotlight.viewed` | Egress feature discovery shown |
| `wiggle_egress_spotlight.toggle_changed` | Egress toggle flipped |
| `wiggle_egress_spotlight.cta_clicked` | Egress CTA button clicked |

---

## 10. MCP Transport & Gating (loosely related)

> This section is only **loosely tied to code execution** — it concerns the Model Context Protocol transport layer and tool-permission gating, included here because artifact `ProxyFetch` can intercept `mcp_servers` payloads. It is kept as its own clearly-labeled section.

### MCP Transport Types

#### SSE (primary)
Class `Iwn` (line 294778) implements SSE transport via `/v1/toolbox/shttp/mcp/{serverId}` (line 295549).

Request headers:
- `x-organization-uuid`
- `x-mcp-client-session-id`
- `x-mcp-client-name: ClaudeAI`
- `Authorization: Bearer {token}`

Features: auto-reconnect with exponential backoff; resumption tokens for reconnect continuity. Error types: `lwn` (unauthorized, line ~294778), `Ewn` (connection error).

#### WebSocket (fallback)
Class `qwn` (line 295272) implements WebSocket transport via `/api/ws/organizations/{orgId}/mcp/servers/{serverId}/`.
- Subprotocol: `['mcp']`
- Messages: JSON-encoded
- Auth: `onAuthError` and `onConnect` callbacks handle token lifecycle

#### Connection Pooling
Class `Bwn` (line 295330) wraps both transports with pooling behavior:
- Debounced disconnect when idle (avoids teardown during brief pauses)
- Tracks `inflightRequestCount` to determine when it is safe to disconnect

### MCP Server Configuration Schema

Defined at line 118540:

```js
Z6e = a({ name: o().optional(), url: o().optional(), type: o().optional() })
```

Additional per-server fields:
- `mcp_directory_server_uuid` — links to a directory-managed server
- `attestations` — server trust attestation data
- `sensitiveDataTypes` — declares what sensitive data categories this server handles

### MCP Safety Gating

#### Permission Flags
| Flag | Line | Effect |
|---|---|---|
| `disable_destructive_mcp_tools_by_default` | 59993 | Hides write/destructive ops from Claude by default |
| `cowork_show_tool_permissioning_always_allow` | 60042 | Offers users an option to skip per-call prompts |
| `sensitive_mcps_per_call_consent` | 104283 | Requires per-call approval for servers with sensitive data |

#### Permission Resolution Flow
```
'always_allow' setting?          → auto-approve
Feature flag disabled?           → { permission: 'blocked' }
User has explicit setting?        → use that setting
Otherwise                        → { permission: 'ask', approvalState: { approvalRequired: true } }
```

#### Server Events & Approval Endpoint
- `tool_permission_request` (lines 146068–146106) — emitted when Claude requests tool use that requires approval
- `tool_permission_resolved` — emitted when the user approves or denies
- `POST /v1/sessions/{sessionId}/mcp-approvals` (line 245458) — submits the user's approval decision

#### Artifact ProxyFetch Interaction
When an artifact's `ProxyFetch` payload contains an `mcp_servers` field, the host intercepts it and triggers the MCP permission modal instead of proxying the request directly (line 118550).

### Built-in MCP Directory Servers (hardcoded URLs)
| Service | URL |
|---|---|
| Google Calendar | `https://gcal.mcp.claude.com/mcp` |
| Gmail | `https://gmail.mcp.claude.com/mcp` |
| Google Drive | `https://api.anthropic.com/mcp/gdrive/mcp` |
| Microsoft 365 | `https://microsoft365.mcp.claude.com/mcp` |
| Linear | Detected via URL pattern `mcp.linear.app` |

---

## Consolidated Stable Search Strings

Union of all three source docs, deduped. Use these to relocate code in future bundle captures for diffing.

### Browser Sandbox (Mechanism 1)
| String | Line(s) | Purpose |
|---|---|---|
| `userContentRendererUrl` | 260558 | Points to `https://www.claudeusercontent.com` sandbox origin |
| `'/isolated-segment.html?v='` | 18776 | Sandbox iframe URL pattern (alt CDN at 18777) |
| `executeReplCode` | 260198 | Code execution entry point (iframe creation) |
| `CreateExecutionSandbox` | 260202 | Iframe creation + initialization |
| `__sandbox_handshake__` | 118748 | postMessage handshake type |
| `i7e` (class) | 118679 | SandboxHandler class definition |
| `i4e` (constants) | 115791–115813 | Method name constants object (21 methods) |
| `anthropic.claude.usercontent.sandbox.` | 116139 | Method namespace prefix |
| `1e4` (near `RunCode`) | 260256 | 10-second execution timeout |
| `'allow-scripts allow-same-origin'` | 18852, 46909, 119290 | iframe sandbox attribute |
| `ReadyForContent` | 115791 | First sandbox method (handshake anchor) |
| `RunCode` | ~115795 | Method to send code for execution |
| `ClaudeCompletion` gate | 119178 | Gated completion-request method |

### Feature Gate & Artifact
| String | Line(s) | Purpose |
|---|---|---|
| `trials_and_tribulations_of_high_school_football` | 31896 | Statsig feature flag for wiggle |
| `enabled_monkeys_in_a_barrel` | 31903 | User preference field (code execution toggle) |
| `wiggle: yP({` | 31894 | Three-level gate definition |
| `enabled_wiggle` | 177364 | Runtime org gate; `rbacEntitlement: 'code_execution'` |
| skills depend on wiggle | 177365 | Org wiggle=false disables skills |
| `enabled_artifacts_attachments` side effect | 48750 | Toggle side effects |
| `wiggle_artifact` | 118576, 19898, 212870 | Artifact type string |

### Wiggle Artifact, File & Egress
| String | Line(s) | Purpose |
|---|---|---|
| `/api/organizations/{org}/conversations/{conv}/wiggle/upload-file` | 52502 | File upload endpoint |
| `SimpleUploadToWiggleHandler` | 52930 | Handler class (wiggle-enabled path) |
| `OutOfContextFileHandler` | 52775 | Handler for oversized/out-of-context files |
| `TextAttachmentHandler` | 52845 | In-context text-safe file handler |
| `function vle()` | 52286 | Reads `max_in_context_file_bytes`; default 15 KB |
| `J6e = ['api.anthropic.com']` | 118543 | ProxyFetch hard allowlist (client-enforced) |
| ProxyFetch error throw | 118602 | Non-allowlisted URL rejection |
| `const s7e = { 'api.anthropic.com'` | 118567 | Proxy handler map (org-scoped endpoint) |
| `enabled_wiggle_egress` | 48641, 48658 | Network egress user toggle |
| `wiggle_egress_allowed_hosts` | 48645, 48662 | Per-org egress hostname allowlist |
| `claudeai_default_wiggle_egress_enabled` | ~48658 | Default egress setting for new users |
| `wiggle_egress_spotlight_viewed_at` | 48649 | Tracks egress feature discovery view |
| `function I8e({` | 124371 | Wiggle file card component |
| `include_wiggle_skills=true` | 82442 | Query param to include wiggle skills (cache key at 82444) |
| file-access warning | 93838 | "Claude needs code execution to access some attached files" |
| `wiggle.file.` | 19898–19908 | File event name prefix (8 events) |
| `wiggle.gdrive.` | 19915–19917 | Google Drive event prefix |
| `wiggle_egress_spotlight.` | ~19920–19925 | Egress spotlight event prefix (3 events) |

### Other Execution Mechanisms (2–4)
| String | Line(s) | Purpose |
|---|---|---|
| `/v1/code/runners/self-hosted/` | 232259–232462 | Enterprise runner API base path |
| `/v1/code/triggers` | 257537–257684 | Scheduled task API base path |
| `<scheduled-task` | 79922 | Prompt wrapper XML tag for scheduled tasks |
| autonomous-mode instructions | 79903–79905 | "automated run of a scheduled task" |
| scheduled MCP write gate | 80344 | Write ops only if task description requests them |
| `/epitaxy` | 44358 | Remote agents route |
| `EpitaxyRemoteAgentsRoute` | 300045 | Remote agents handler registration |
| `CodeRemoteAgentsRoute` | 300044 | Code remote agents handler |
| remote session source tags | 134612, 134805 | `dispatch` / `remote/` session tags |

### MCP Transport & Gating
| String | Line(s) | Purpose |
|---|---|---|
| `Iwn` class | 294778 | SSE MCP transport implementation |
| `qwn` class | 295272 | WebSocket MCP transport implementation |
| `Bwn` class | 295330 | MCP connection pool wrapper |
| `/v1/toolbox/shttp/mcp/` | 295549 | SSE MCP proxy endpoint |
| `Z6e` | 118540 | MCP server configuration schema |
| `disable_destructive_mcp_tools_by_default` | 59993 | MCP write operation gate flag |
| `cowork_show_tool_permissioning_always_allow` | 60042 | Always-allow permission option |
| `sensitive_mcps_per_call_consent` | 104283 | Per-call consent for sensitive servers |
| `tool_permission_request` | 146068 | MCP tool approval request event |
| `/v1/sessions/{id}/mcp-approvals` | 245458 | Approval submission endpoint |
| `mcp_servers` interception | 118550 | Artifact ProxyFetch MCP modal trigger |
