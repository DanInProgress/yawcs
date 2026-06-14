---
created: 2026-04-18
updated: 2026-05-14
---
# Artifacts and Sandbox Runtime

_Sources: `snapshots/derived/D72Sf481/primary.js` (bundle captured 2026-04-17), the `research/` directory sweep, and `snapshots/changelog.md` git history. Companion mock: `mock-mcpusercontent-window.ts` (kept as-is)._

This doc covers the `claudeusercontent.com` iframe runtime, the artifact system, and inline widget tools. It consolidates: artifact rendering, the sandbox bridge/API, artifact MIME/wrapper parsing, network brokering, storage and auth, published artifacts, the streaming markdown renderer, prompting for self-contained artifacts, adjacent shells (Epitaxy/Melange), and the inline widget-tools subsystem.

> **Disambiguation**: Artifact _rendering_ (`SetContent` — HTML, React, SVG, Mermaid) and code _execution_ (`RunCode` — wiggle scripts, see [`code-execution-wiggle.md`](code-execution-wiggle.md)) share the **same** `i7e` SandboxHandler bridge and `__sandbox_handshake__` protocol, but diverge completely on the renderer side.

---

## 1. Shared Sandbox Bridge

Both the code-execution sandbox and the artifact renderer run in cross-origin iframes on `https://www.claudeusercontent.com`. All privileged operations (network, storage, auth, completions) are brokered by a parent `SandboxHandler` over a `MessageChannel`. Sandbox code never holds credentials directly.

### SandboxHandler (`i7e`)

- **Class**: `i7e` (lines 118679–118887)
- **Handshake type**: `__sandbox_handshake__` (line 118748)
- **Origin validation**: enforced on every message
- **Rate limit**: 30 messages per 5-second window
- **Namespace**: `anthropic.claude.usercontent.sandbox.*`

There is **no separate bridge class** for artifacts vs. code execution — the same `i7e` handler, same handshake, same MessageChannel protocol, same 21 method constants serve both.

### Handshake protocol

```
Parent                                    Iframe
  |                                          |
  |--  postMessage({type:'__sandbox_handshake__'}, '*', [port]) -->  |
  |                                          |-- ReadyForContent -->  |
  |                  (all subsequent messages via MessageChannel port)
```

The parent transfers a `MessageChannel` port during the handshake; all subsequent traffic flows over that port.

### Message shape

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

### The 21 sandbox methods (`i4e` constants, lines 115791–115813)

#### Lifecycle
| Method | Direction | Notes |
|---|---|---|
| `ReadyForContent` | iframe → parent | Sandbox ready signal |
| `DOMContentLoaded` | iframe → parent | DOM loaded signal |
| `BroadcastContentSize` | iframe → parent | Resize reporting |

#### Content I/O
| Method | Direction | Notes |
|---|---|---|
| `SetContent` | parent → iframe | Push content to render (`type`, `content`, `tailwindStylesEnabled`) |
| `RunCode` | parent → iframe | Execute wiggle script (code-execution path; see code-execution doc) |
| `GetFile` | iframe → parent | File read from artifact/wiggle store |
| `GetScreenshot` | iframe → parent | Screenshot of iframe content |
| `CopyHtmlContent` | iframe → parent | Copy HTML content to clipboard |
| `GetDOMSnapshot` | iframe → parent | Full DOM snapshot |

#### Communication back to Claude
| Method | Direction | Notes |
|---|---|---|
| `SendConversationMessage` | iframe → parent | Inject message into conversation |
| `ClaudeCompletion` | iframe → parent | Direct model call (requires explicit user permission, line 119178) |
| `ProxyFetch` | iframe → parent | HTTP request (proxied, whitelist-only) |
| `ProxyFetchStream` | iframe → parent | Streaming variant, max 10 MB chunks |

#### Storage (artifact-scoped KV)
| Method | Direction | Notes |
|---|---|---|
| `StorageGet` | iframe → parent | Read by key |
| `StorageSet` | iframe → parent | Write key/value |
| `StorageDelete` | iframe → parent | Delete by key |
| `StorageList` | iframe → parent | List all keys |

#### Actions
| Method | Direction | Notes |
|---|---|---|
| `OpenExternal` | iframe → parent | Open external URL (dialog required) |
| `DownloadFile` | iframe → parent | Download file (dialog required) |
| `ReportError` | iframe → parent | Error telemetry |
| `TrackInteraction` | iframe → parent | Interaction telemetry |

> The list above is the complete categorized set. `SetContent` and `RunCode` are the two parent→iframe content-delivery methods that distinguish the rendering vs. execution paths; everything else is shared and available to either environment.

### Shared iframe sandbox attributes

Identical for both systems (lines 119290, 149397):

```html
<iframe
  sandbox="allow-scripts allow-same-origin"
  allow="fullscreen; clipboard-write"
  referrerPolicy="no-referrer"
  data-no-service-worker="true"  <!-- Firefox workaround -->
/>
```

`allow-same-origin` is what enables the MessageChannel bridge to work across the iframe boundary. (`allow: 'fullscreen; clipboard-write'` is present on artifact iframes.)

---

## 2. The Two Sandbox Environments Compared

Both environments share the same SandboxHandler infrastructure but diverge in origin path, feature gating, timeouts, and what gets injected.

### 2a. Code Execution Sandbox ("wiggle")

| Property | Value |
|---|---|
| Origin | `https://www.claudeusercontent.com` |
| URL template | `/isolated-segment.html?v={version}&domain={domain}&parentOrigin={origin}` |
| Alt CDN | `https://a.claude.ai/isolated-segment.html?v={version}` |
| Sandbox attr | `allow-scripts allow-same-origin` |
| Artifact type | `wiggle_artifact` (requires `conversation_uuid` + `file_path`) |
| Feature flag | `enabled_wiggle` (org) + `enabled_monkeys_in_a_barrel` (user) |
| Execution timeout | 10 seconds (`1e4` ms, line 260198) |
| Entry point | `executeReplCode()` (line 260198) |
| Method used | `RunCode` |
| Framework injection | None (bare JS) |

### 2b. Artifact Rendering Sandbox (HTML / React / Mermaid / SVG / Markdown)

| Property | Value |
|---|---|
| Origin | `https://www.claudeusercontent.com` (config: `userContentRendererUrl`, line 260558) |
| Sandbox attr | `allow-scripts allow-same-origin` + `allow: 'fullscreen; clipboard-write'` |
| MIME types | `text/html`, `application/vnd.ant.react`, `application/vnd.ant.mermaid`, `image/svg+xml`, `text/markdown` |
| Published URL | `https://www.claudeusercontent.com/artifact/{uuid}` (line 118973) |
| Method used | `SetContent` |
| Execution timeout | None |
| Framework injection | Remote server decides (React, Mermaid, Tailwind) — opaque to the bundle |

### Divergence summary

| | Code Execution | Artifact Rendering |
|---|---|---|
| **Method used** | `RunCode` | `SetContent` |
| **Content sent** | Script to execute | Source code to render |
| **Timeout** | 10 s (enforced by parent) | No timeout |
| **Framework injection** | None (bare JS) | Remote server handles (React, Mermaid, Tailwind) |
| **Artifact type** | `wiggle_artifact` | `text/html`, `application/vnd.ant.react`, etc. |
| **Entry function** | `executeReplCode()` (line 260198) | Artifact renderer component |

The renderer config object (`Wrn`, line 260558) carries both `userContentRendererUrl: 'https://www.claudeusercontent.com'` and the surrounding `conwayShellOrigin` config.

---

## 3. Artifact MIME-Type Registry

### `xge` enum (line 60537) — full set

| Type constant | MIME / type string | Display name | Notes |
|---|---|---|---|
| `Text` | `text/plain` | — | Plain text block |
| `Markdown` | `text/markdown` | Document | Rendered markdown |
| `Html` | `text/html` | Interactive artifact | Self-contained HTML — primary type for skills |
| `Code` | `application/vnd.ant.code` | Code | Syntax-highlighted code display |
| `Svg` | `image/svg+xml` | Image | SVG rendered directly |
| `Mermaid` | `application/vnd.ant.mermaid` | Diagram | Diagram rendered server-side |
| `React` | `application/vnd.ant.react` | Interactive artifact | Rendered TSX/JSX; Tailwind optionally injected |
| `Skill` | `application/vnd.ant.skill` | Skill definition | Not rendered as interactive |
| `Plugin` | `application/vnd.ant.plugin` | Plugin definition | Plugin definition |

> This is the superset: `Text`/`text/plain` and `Plugin`/`application/vnd.ant.plugin` are present in the full enum and were absent from the partial rendering-environment list.

### `Cge` file-extension mappings (lines 60572–60593)

| Extension(s) | MIME Type |
|---|---|
| `tsx`, `jsx` | `application/vnd.ant.react` |
| `html`, `htm` | `text/html` |
| `svg` | `image/svg+xml` |
| `mermaid`, `mmd` | `application/vnd.ant.mermaid` |
| `md`, `markdown` | `text/markdown` |
| `skill` | `application/vnd.ant.skill` |

### Renderer URL and query params

Regular preview URL:
```
https://www.claudeusercontent.com?domain={hostname}&parentOrigin={origin}
```

Optional query params:
- `errorReportingMode=parent` — routes iframe errors to parent window
- `formattedSpreadsheets=true` — always set
- `routeHandlerPdf` — feature-gated PDF rendering mode
- `theme=light|dark` — sent for Mermaid diagrams

The `data-no-service-worker="true"` attribute on the iframe is a Firefox workaround (line 119295).

---

## 4. Artifact Authoring Paths: `antArtifact` XML and `artifacts_v0` Tool Use

Artifacts reach the frontend through two parsing paths.

### 4a. `antArtifact` XML wrapper

The model emits artifacts wrapped in `<antArtifact>` tags (constant `Rge = 'antArtifact'`, line 61001):

```
<antArtifact identifier="..." type="text/html" title="...">
  <!-- full HTML here -->
</antArtifact>
```

Attributes parsed by `Bge()` (line 61008): `identifier`, `type`, `title`, `language`, `isClosed`.

### 4b. `artifacts_v0` tool-use path

Alongside the XML path, artifacts can arrive as tool use. Registered as:

```js
{ type: 'artifacts_v0', name: 'artifacts' }
```

Pushed into the tool list at lines 116850 and 230052. When the model uses this tool, `Wge()` parses `command` (`create` | `rewrite` | `update`), `id`, `type`, `title`, `language`, `content`, `old_str`, `new_str`.

---

## 5. SetContent Rendering Dispatch

After the handshake, the parent sends `SetContent` over the MessageChannel (lines 119254–119259):

```js
{
  method: 'anthropic.claude.usercontent.sandbox.SetContent',
  payload: {
    content: '<string>',                  // artifact source code
    type: 'application/vnd.ant.react',     // MIME type
    tailwindStylesEnabled: true            // React artifacts only (line 119257)
  }
}
```

**What happens on the remote side (not visible in the bundle):**
- The renderer receives the MIME type and decides what to inject.
- `application/vnd.ant.react` → React + ReactDOM loaded, component compiled and mounted.
- `application/vnd.ant.mermaid` → Mermaid.js loaded, diagram rendered to SVG.
- `text/html` → document written directly; may or may not inject utilities.
- `tailwindStylesEnabled: true` → Tailwind CSS loaded for React artifacts.

There is **no per-MIME-type dependency table in the bundle**. React, Mermaid, and Tailwind injection are all decided server-side. You cannot determine artifact framework versions from bundle analysis alone — see §13 for the network-capture procedure.

---

## 6. ProxyFetch — Network Brokering

The artifact sandbox runs cross-origin; all network requests are brokered by the parent. Sandbox code never holds credentials.

```
┌─────────────────────────────────────────────────────────────────┐
│  Parent Window (claude.ai)                                      │
│                                                                 │
│  ┌──────────────────┐        ┌──────────────────────────────┐  │
│  │  SandboxHandler  │◄──────►│  MessageChannel (postMessage) │  │
│  └────────┬─────────┘        └──────────────────────────────┘  │
│           │                                   ▲                 │
│           │ proxies to                        │                 │
│           ▼                                   │                 │
│  /api/organizations/{orgUuid}/proxy/v1/messages                 │
│           │                                                     │
└───────────┼─────────────────────────────────────────────────────┘
            │ (server-side auth, session cookies)
            ▼
   api.anthropic.com
            ▲
            │
┌───────────┴─────────────────────────────────────────────────────┐
│  Sandbox iframe (cross-origin)                                  │
│                                                                 │
│   sendRequest(ProxyFetch, { url, headers, body })               │
│        │                                                        │
│        └──► ProxyFetch handler (a7e, line 118540)               │
│              • validates host against J6e whitelist             │
│              • strips disallowed headers                        │
│              • injects artifact metadata headers                │
│              • streams response back as ProxyFetchStream msgs   │
└─────────────────────────────────────────────────────────────────┘
```

**Handler**: `a7e` (lines 118540–118676).

### Proxy target whitelist
```js
J6e = ['api.anthropic.com']   // line 118543
```
Only `api.anthropic.com` is permitted. Any other host is rejected before the request leaves the broker.

### Proxy endpoint
```
/api/organizations/{orgUuid}/proxy/v1/messages   // line 118567
```
The `orgUuid` is injected server-side; sandbox code never reads it directly.

### Allowed request headers
```js
Q6e = ['accept', 'accept-language', 'content-type', 'content-length']   // line 118541
```
Any header not in this set is stripped before forwarding.

### Blocked response headers
```js
X6e = ['set-cookie', 'x-api-key', 'x-auth-token', 'authorization']   // line 118542
```
Removed from the proxy response before returning to the iframe. Credentials cannot leak back.

### Artifact metadata injected per request (lines 118573–118578)
| Header | Value |
|---|---|
| `anthropic-artifact-id` | `{uuid}` of the artifact |
| `anthropic-artifact-entity-type` | artifact type, e.g. `wiggle_artifact` |
| `anthropic-chat-conversation-uuid` | conversation UUID (if available) |
| `anthropic-file-path` | file path (if available) |

### Streaming
Responses are delivered as `ProxyFetchStream` messages. Max payload per chunk is **10 MB** (`10485760` bytes, line 118625).

### MCP permission gate
If the request payload contains an `mcp_servers` array, the handler triggers an MCP permission modal instead of proxying (line 118550). The fetch is not performed until the user accepts.

---

## 7. Storage API and Authentication Model

### Artifact-scoped Storage API

Schemas at lines 116061–116133. The sandbox exposes an artifact-scoped key-value store. It is **not** raw browser `localStorage` or `IndexedDB` — all calls travel over the MessageChannel to the parent host, which owns the actual storage backend. Storage is keyed **per artifact**; it is not shared across artifacts or conversations.

| Method | Signature | Description |
|---|---|---|
| `StorageGet` | `(key) → value \| null` | Read a value by key |
| `StorageSet` | `(key, value)` | Write a value |
| `StorageDelete` | `(key)` | Remove a key |
| `StorageList` | `() → keys[]` | List all keys in the artifact's store |

Call pattern (sandbox side):
```js
sendRequest(i4e.StorageGet, { key })
sendRequest(i4e.StorageSet, { key, value })
sendRequest(i4e.StorageDelete, { key })
sendRequest(i4e.StorageList, {})
```

> Note: from inside an authored HTML artifact's iframe, ordinary `localStorage`/`sessionStorage` also work for ephemeral page state. The Storage API above is the parent-brokered, durable, per-artifact KV store.

### No-credentials auth model

Zero API keys or auth tokens exist in the sandbox iframe context. The `authorization` header is blocked in both directions:
- **Outbound**: not in `Q6e`, so sandbox code cannot send it.
- **Inbound**: in `X6e`, so it cannot be read from responses.

Authentication is implicit: the parent page makes same-origin requests to the proxy endpoint using the user's session cookies. The sandbox never participates in the auth handshake. The `orgUuid` segment of the proxy URL is resolved server-side before the URL reaches the iframe.

### Permission gates
```
onPermissionRequested(method) → 'accepted' | 'denied'   // lines 118810–118819
```
`ClaudeCompletion` requires explicit user approval and only proceeds if the user accepts (line 119178). The same pattern applies to MCP server access (see §6), `OpenExternal`, and `DownloadFile`.

### Possible vs. blocked

**Possible:**
- Fetch to `api.anthropic.com` only, via the org proxy endpoint
- Read/write artifact-scoped KV storage
- Call back to Claude via `ClaudeCompletion` (with user permission)
- Download files / open external links (each behind a permission dialog)

**Blocked:**
- Arbitrary cross-origin fetch (only `api.anthropic.com` whitelisted)
- Reading auth tokens, API keys, or cookies from any source
- Direct `localStorage`/`IndexedDB` access for durable cross-session state (goes through the parent broker)
- Accessing or manipulating the parent page DOM

---

## 8. Published / Shared Artifacts

Published artifacts get a stable public URL:
```
https://www.claudeusercontent.com/artifact/{uuid}   // line 118973
```

Query keys (lines 16302–16304):
- `shared_artifact_version` — fetches a specific published artifact version
- `artifact_visibility` — public/private setting
- `published_artifact_embed_whitelist` — domains allowed to embed artifacts

---

## 9. AlluviumMarkDown Streaming Renderer

`AlluviumMarkDown` (line 117342) is the streaming markdown renderer used for Claude.ai chat messages.

- Renders incrementally via a `feed()` / `snapshot()` streaming parser (`l6e` class).
- Tracks a committed/frontier split so stable blocks don't re-render.
- Block kinds handled: `paragraph`, `heading` (h1–h6), `list` (ordered/unordered), plus code and inline nodes.
- CSS class `alluvium-markdown` applied to the wrapper div.

**Impact on skill output:** skills that return markdown text in a message are rendered through AlluviumMarkDown:
- Headings, lists, bold, italic, code fences work as expected.
- Large or frequently-updating streaming responses should prefer structured Markdown blocks that stabilize quickly to avoid layout thrash.
- For rich interactive output (charts, forms, widgets) prefer the `text/html` artifact type — HTML renders in the iframe sandbox, completely outside AlluviumMarkDown.

---

## 10. Prompting Claude for Self-Contained HTML Artifacts

### 10a. API (Anthropic SDK) approach

Via the Anthropic API directly (not claude.ai's front-end tool protocol), Claude will not emit `<antArtifact>` wrappers unless asked. Instruct it to produce a raw HTML document:

```
System: Respond with a single, complete, standalone HTML file — nothing else.
        All CSS must be in <style> tags; all JS in <script> tags.
        No external CDN or network requests. Works at file:// protocol.
```

See `templates/create_artifact.py` and `templates/create_artifact.js` for runnable implementations.

### 10b. Within claude.ai (web UI)

To trigger an artifact panel, include explicit framing:
```
Create a self-contained HTML artifact titled "My Widget" that…
```
The UI routes the response through the `artifacts_v0` pipeline, displaying the result in the side-panel at `type="text/html"`. For React/TSX artifacts use the phrase "React component" — the UI routes to `application/vnd.ant.react`.

### 10c. Artifact constraints to communicate in your prompt

- No `<script src="...">` or `<link href="...">` to external hosts — the iframe sandbox blocks most outbound network requests (only `api.anthropic.com` via ProxyFetch).
- `localStorage` and `sessionStorage` work inside the artifact iframe (for ephemeral page state).
- `postMessage` between the artifact iframe and parent is supported (bundle shows the `iframe_ready` handshake at line 18804).
- Canvas, Web Audio, and most Web APIs are available.

---

## 11. Adjacent Shells: Epitaxy and Melange

### Epitaxy code-theme localStorage keys

`epitaxy:codeThemeDark` (constant `GNn`, line 301669) is a **localStorage key** used by the Epitaxy editor (Claude Code web shell).
- Paired key: `epitaxy:codeThemeLight` (`WNn`, line 301668)
- Default light theme `github-light`; default dark `github-dark`
- Passed to Monaco editor as the active syntax theme.
- Hook `QNn()` reads both keys via `yR()` (a typed localStorage hook) and returns a `codeTheme: { light, dark }` object consumed by the Epitaxy editor pane.

**Relevance for skills:** these keys have no effect on artifact rendering — they only apply to Monaco inside the Epitaxy experience. Skills targeting the standard chat UI should ignore them. A skill that embeds a code editor in an artifact should note the host page theme is not automatically forwarded into the artifact iframe sandbox.

Related Epitaxy feature flags: `claudeai_cc_epitaxy_web` (Claude Code web shell gate) and `claudeai_cc_epitaxy` (desktop gate).

### Melange memory integration

Melange is Claude.ai's server-side persistent memory store for organizations. Tool-name constants (lines 145057–145059):

| Constant | Value | Purpose |
|---|---|---|
| `ept` | `melange_probe` | Check whether the org has stored memories; returns `{ has_memories, file_count }` |
| `tpt` | `melange_list` | List all memory file paths for the org |
| `npt` | `melange_read` | Read a specific memory file by path |

Reset endpoint (line 145130):
```
POST /api/organizations/{orgUuid}/melange/reset
```

The `invalidateAll()` helper (line 145121) invalidates all three query keys at once — useful when testing cache invalidation after a reset.

**Stateful skill sessions via Melange:**
1. **Session start**: emit `melange_probe`. If `has_memories` is true, follow up with `melange_list` then `melange_read` on the relevant path to hydrate context.
2. **Artifact generation**: use hydrated context to personalize the HTML artifact (saved preferences, last-run data).
3. **Session end / user action**: write updated state back. The write tool is not enumerated in the bundle constants; the `melange_list` response includes a `path` field mirroring the read path — writes likely follow a `melange_write` pattern to the same namespace.
4. **Reset**: expose a "Clear memory" action that calls the reset endpoint (requires an authenticated session cookie — proxy via a skill-side endpoint rather than calling it from the artifact iframe directly).

---

## 12. Inline Widget Tools

Widget tools are specialized tool types that render inline, ephemeral UI directly in the chat message stream. Unlike artifact skills (persistent, shareable documents) or regular tools (execute and return structured data), widgets are transient React renderers that do not persist beyond the session. They are not skills, not artifacts, and not file-based — they are Claude API tool calls the frontend recognizes and routes to specialized rendering logic by `toolName`.

> **Key distinction:** widget tools render **inline** through `MessageBlocksRenderer`, **NOT** through the `__sandbox_handshake__` / MessageChannel sandbox bridge described above. There is no separate iframe; this is a client-side tool-injection + rendering system.

Widget rendering is **not** gated by `widgets_spotlight_enabled` — that flag only controls the promotional spotlight UI.

### Registries

- **`B5e` array** (lines 115577–115586) — canonical set of 8 widget tool names injected into the tool list:
  ```
  weather_fetch              — Fetch and display current weather data
  recipe_display_v0          — Render recipe with ingredients, steps, and images
  places_map_display_v0      — Show enriched place results on interactive map
  message_compose_v1         — Draft, edit, and share email, SMS, or other messages
  ask_user_input_v0          — Capture user input (alternative to AskUserQuestion)
  recommend_claude_apps      — Promote Claude apps (iOS, Android, VS Code, Excel, etc.)
  places_search              — Search and retrieve place data
  fetch_sports_data          — Fetch sports scores, schedules, statistics
  ```
- **`U5e` array** (lines 115540–115575) — extraction & render config for 10 tools. Superset of B5e: includes `AskUserQuestion` (server-driven) and `image_search`, but **excludes** `ask_user_input_v0`.
- **`q5e` set** (line 115576) — union of all widget tool names:
  ```js
  new Set([...U5e.map(e => e.toolName), 'ask_user_input_v0', 'AskUserQuestion'])
  ```
- **`$5e` array** (lines 115587–115644) — maps each `toolName` to a lazy React component and Tailwind className.

### Extractor functions

| Extractor | Lines | Used By |
|---|---|---|
| `z5e()` | 115523–115530 | Default. Scans `tool_result.content` for text blocks, parses first valid JSON. |
| `F5e()` | 115532–115538 | Image gallery. Scans for `image_gallery` type, filters by id and thumbnail_url. |
| Custom | varies | `message_compose_v1` (returns input if tool_result exists), `places_map_display_v0` (merges input + enriched_places), `recipe_display_v0` (merges JSON data + images + metadata), `AskUserQuestion` (merges answers + is_error flag). |

### Render components (`$5e`) → Tailwind mapping

| Tool Name | Component | Tailwind Class |
|---|---|---|
| `weather_fetch` | `F3e` (WeatherToolUseCell) | `pl-2 pt-1 pb-2` |
| `recipe_display_v0` | `E5e` (RecipeDisplay) | `pl-2 pt-4 pb-4` |
| `places_map_display_v0` | `P3e` (MapToolUseCell) | `pl-2 pt-1 pb-2` |
| `message_compose_v1` | `a5e` (MessageCompose) | `pl-2 pt-1 pb-2` |
| `recommend_claude_apps` | `R5e` (RecommendClaudeApps) | `pl-2 pt-1 pb-2` |
| `AskUserQuestion` | `D5e` (AskUserQuestionWidgetRenderer) | `my-4` |
| `image_search` | `O3e` (ImageSearchCell) | `pl-2 pt-1` |

**`previewOnly` flag**: entries marked `previewOnly: true` (`display_stock_data`, `quiz_display_v0`, `places_map_display_v1`) are not injected into B5e but can still render if called.

### Per-component deep dives

- **WeatherToolUseCell (`F3e`)** — lazy-loaded from `cc0c7aeb5-C9eQwwrK.js`. Props: `input`, `isStreaming`, `conversationUuid`. Current conditions + forecast. Loading skeleton 241px.
- **RecipeDisplay (`E5e`)** — lazy-loaded from `c730f5b27-BSOyTwSF.js`. Title/description/cuisine metadata; ingredient list with servings scaling (multiplier); step-by-step instructions with inline substitution; per-step timer; actions: copy, print to new window, cooking-mode toggle; shimmer skeleton while streaming.
- **MapToolUseCell (`P3e`)** — lazy-loaded. Props: `data` (`input` + `enriched_places`). Interactive map with markers, address, phone, hours, ratings. Falls back to direct `input` if tool_result missing.
- **MessageCompose (`a5e`)** — inline message editor. Props: `input` (variants array, kind email|sms|other). Tab-based variant selection (A/B/C); subject field for email; rich text body editor (max 400px, scrollable); copy, native Share API, Gmail/Mail launch; optimistic save on edit, revert on cancel; preference key `message-compose-email-share-method`.
- **RecommendClaudeApps (`R5e`)** — props: `input` (`app_ids` array). Rows for Claude iOS/Android, Claude Code (terminal/VS Code/JetBrains/Slack), Claude for Excel/PowerPoint/Chrome. Filters by feature flags (`public_api_swivel`, `public_api_crochet`) and org capabilities.
- **AskUserQuestionWidgetRenderer (`D5e`)** — props: `input` (questions array), `result` (answers or is_error), `toolUseId`. Uses `B3e` (AskUserQuestionToolUseCell) for the MCQ interface. Sets `disableAutoSkip: true` to prevent auto-submission on single-option questions. Shows "Dismissed" when `result.is_error` is true.

### Aggregation pipeline (`G5e`, lines 115657–115704)

1. **Predicate `W5e()`** (lines 115652–115656): returns true if a block is a `tool_use` whose `name` is in U5e and not already aggregated.
2. **Pair extraction**: scans forward from tool_use for matching tool_result. Fallback: parses `partial_json` or `buffered_input`.
3. **Extract call**: invokes the U5e extract function with `(tool_result, input, { mcqAnswers, toolUseId })`. Fallback to `z5e`.
4. **Push**: if result non-null, pushes `{ type: 'aggregated_widget', toolName, input, result, index, toolUseId }`.
5. **Mark consumed**: adds indices to `aggregatedIndices` so raw tool_use/result cards are hidden.

### Rendering (`MessageBlocksRenderer`, line 128728)

1. Encounters an `aggregated_widget` block.
2. Looks up the `$5e` entry by `toolName`.
3. Renders into `<div className={$5e.className}>` with render-function output.
4. Key: `toolUseId ?? aggregated-widget-{toolName}-{index}` for stable reconciliation.
5. If no `$5e` entry, returns null (tool_use stays hidden).

### Tool injection (`Z4e`, line 116854)

Widgets are injected **client-side only**, after MCP tools, artifacts, and web search:
```js
for (const e of B5e) t.push({ type: 'widget', name: e });
```
The backend does not control which widgets appear. Widgets are **not** part of `sessionPlugins` (those are remote/MCP tools) — they are hardcoded in the bundle. The backend can call any registered widget by name; the frontend routes it to the correct pipeline if it is in U5e.

### `ask_user_input_v0` vs `AskUserQuestion`

| | `ask_user_input_v0` | `AskUserQuestion` |
|---|---|---|
| **In B5e** | Yes | No |
| **In U5e** | No | Yes |
| **In $5e** | No | Yes |
| **Direction** | Claude-initiated | Server-driven |
| **Semantics** | Claude calls this to solicit input | Server returns structured question data |
| **Extraction** | None (no U5e entry) | Merges answers + is_error flag |
| **Renderer** | None/fallback | `D5e` MCQ interface with `disableAutoSkip` |
| **Status** | In spotlight but extraction absent — may be WIP | Fully active |

`ask_user_input_v0` is a tool Claude **calls**; `AskUserQuestion` is a structured **result** the server sends back containing questions for the user to answer.

### Spotlight gating

`widgets_spotlight_enabled` (line 229878) gates only the "Widgets Spotlight" promotional surface, not rendering:
```js
'widgets-spotlight': {
  useTargeting: function () {
    return { isTargeted: XN('widgets_spotlight_enabled') };
  },
}
```

### Telemetry

```js
'claudeai.widget.shown':   { version: 1, widget_type: '', conversation_uuid: '' }
'claudeai.widget.clicked': { version: 1, widget_type: '', action: '', conversation_uuid: '' }
```
Fired from a React hook/wrapper tracking first appearance (lines 83378, 83384); `widget_type` is the `toolName`.

Widget-specific actions:
| Widget | Actions |
|---|---|
| `message_compose_v1` | `variant_selected`, `send_to_chat`, `copy`, `email_share` |
| `recipe_display_v0` | `step_toggled`, `servings_changed`, `copy`, `print`, `cooking_mode_toggled` |
| `recommend_claude_apps` | `claudeai.recommend_claude_apps.viewed` (fires once on mount; payload `app_ids`, `app_count`) |

Widget tools have no special telemetry in the tool_use → tool_result execution cycle — only the rendering/interaction layer is tracked.

### 8-step lifecycle

```
1. Backend → calls widget tool (e.g., weather_fetch) via Claude API tool_use
2. tool_use + tool_result blocks land in conversation
3. G5e() scans blocks → identifies widget pair → invokes extract function
4. extract() returns structured result → aggregated_widget block pushed
5. MessageBlocksRenderer encounters aggregated_widget → looks up $5e render fn
6. Render fn → JSX inline in message stream
7. User interacts → claudeai.widget.clicked event fires
8. Conversation ends → widget is gone (no artifact, no file, no persistence)
```

---

## 13. Network Capture, Key Unknowns, and Integration-API Implications

### What requires network capture

The following cannot be determined from the bundle alone (the remote renderer decides them):

| Unknown | How to Discover |
|---|---|
| React version in `application/vnd.ant.react` | Capture `<script>` src URL from the iframe document |
| Mermaid.js version | Same |
| Tailwind CSS version | Same |
| Whether CDN or bundled | Check if src is `unpkg.com`, `esm.sh`, `cdn.jsdelivr.net`, or a local path |
| Content-Security-Policy rules | Check response headers on the iframe document request |
| Other injected globals | Inspect `window` in the rendered iframe DevTools context |

### Capture procedure

1. Open Claude.ai in Chrome → DevTools → **Network** tab.
2. Filter: type `claudeusercontent.com` in the URL filter.
3. Create an artifact of the target type (e.g., a React artifact).
4. Find the iframe document request (usually the first `document` response for that domain).
5. Inspect: **Response body** → `<script src="...">` tags reveal CDN URLs/versions; **Response headers** → `Content-Security-Policy` reveals allowed origins/script sources.
6. Repeat per MIME type — each may load different frameworks.

**Quick iframe context access**: in DevTools, switch the JavaScript context selector (top of Console) from `top` to the `claudeusercontent.com` frame, then run `window.React?.version`, `window.mermaid?.version`, etc.

### File abstraction — GetFile / wiggle file store

(Shared with the code-execution path; see [`code-execution-wiggle.md`](code-execution-wiggle.md) for detail.)
- Upload endpoint: `POST /api/organizations/{org}/conversations/{conv}/wiggle/upload-file` (line 52502)
- `wiggle_artifact` requires both `conversation_uuid` and `file_path`
- Size threshold ~15 KB default (`max_in_context_file_bytes`, line 52286)
- Handler chain (priority): `SimpleUploadToWiggleHandler` (line 52930) → `OutOfContextFileHandler` (line 52775) → `TextAttachmentHandler` (line 52845)
- `GetFile` lets the sandbox request file content from the parent via `anthropic.claude.usercontent.sandbox.GetFile`

### Key unknowns (not in bundle)

- Whether widget tools will migrate to an iframe-sandboxed model (only inline rendering observed)
- CSP headers on `www.claudeusercontent.com` (requires network capture)
- React / Mermaid / Tailwind versions in the artifact renderer (loaded remotely)
- Exact `GetFile` response shape beyond the method existing
- Whether `GetFile` can access arbitrary conversation files or only the current artifact's `file_path`

### Integration-API design implications

What the **outer app already provides** to iframes (via the 21 methods): file read (`GetFile`) and artifact-scoped KV storage; conversation message injection (`SendConversationMessage`); proxied model API calls (`ProxyFetch` → api.anthropic.com); direct model completion with consent (`ClaudeCompletion`); DOM inspection (`GetDOMSnapshot`, `GetScreenshot`); file download / external URL launch.

What the outer app does **not** currently expose: direct read/write of artifact content (only `SetContent` push parent→iframe); artifact listing/browsing from within the sandbox; real-time streaming updates parent→iframe (no observable push path beyond `SetContent`); widget tools in an isolated iframe context (currently inline-rendered only).

### Note on lazy-chunk strings

A search across all 251 lazy-chunk `string-changes.md` files found no entries matching `widget`, `artifact`, `iframe`, or `epitaxy` — the artifact/widget strings in this bundle diff are unchanged from the prior snapshot; the changes were in the primary bundle only.

---

## 14. Consolidated Stable Search Strings / Grep Anchors

| String / Symbol | Line(s) | Purpose |
|---|---|---|
| `__sandbox_handshake__` | 118748 | Handshake message type |
| `i7e` | 118679–118887 | SandboxHandler class |
| `i4e` | 115791–115813 | Method constants object (all 21) |
| `anthropic.claude.usercontent.sandbox.` | 116139 | Method namespace prefix |
| `anthropic.claude.usercontent.sandbox.SetContent` | 115797 | SetContent method constant (`i4e.SetContent`) |
| `userContentRendererUrl: 'https://www.claudeusercontent.com'` | 260558 | Renderer origin config (`Wrn`) |
| `conwayShellOrigin` | ~260558 | Surrounding config object name |
| `executeReplCode` | 260198 | Code-exec entry point / 10 s timeout |
| `xge` (enum) | 60537 | Artifact MIME-type enum |
| `application/vnd.ant.react` | ~60540 | React artifact MIME type |
| `application/vnd.ant.mermaid` | ~60541 | Mermaid artifact MIME type |
| `application/vnd.ant.plugin` | 60537 (enum) | Plugin artifact MIME type |
| `Cge` (extension map) | 60572–60593 | File-extension → MIME mappings |
| `Rge = 'antArtifact'` | 61001 | antArtifact XML tag constant |
| `Bge()` | 61008 | antArtifact attribute parser |
| `artifacts_v0` / `Wge()` | 116850, 230052 | Tool-use artifact path + command parser |
| `tailwindStylesEnabled` | 119257 | Flag sent with SetContent for React |
| `formattedSpreadsheets` | ~119262 | Query param always appended |
| `routeHandlerPdf` | ~119264 | Feature-gated PDF renderer param |
| `allow: 'fullscreen; clipboard-write'` | 119290 | Artifact iframe allow attribute |
| `data-no-service-worker` | 119295 | Firefox workaround attribute |
| `/artifact/` | 118973 | Published artifact URL path segment |
| `J6e = ['api.anthropic.com']` | 118543 | ProxyFetch target whitelist |
| `Q6e` | 118541 | Allowed request headers set |
| `X6e` | 118542 | Blocked response headers set |
| `a7e` | 118540 | ProxyFetch handler function |
| `/api/organizations/{orgUuid}/proxy/v1/messages` | 118567 | Proxy endpoint template |
| `anthropic-artifact-id` | 118573 | Artifact metadata header — UUID |
| `anthropic-artifact-entity-type` | 118575 | Artifact metadata header — type |
| `wiggle_artifact` | 118576 | Example/code-exec artifact type |
| `10485760` | 118625 | 10 MB max payload per streaming chunk |
| `StorageGet/Set/Delete/List` | 116061–116133 | Storage method schemas |
| `onPermissionRequested` | 118810 | Permission gate callback |
| `ClaudeCompletion` | 119178 | Completion requiring explicit user permission |
| `enabled_wiggle` | 177364 | Code-exec org feature flag |
| `shared_artifact_version` | 16302–16304 | Published artifact query keys |
| `AlluviumMarkDown` / `l6e` | 117342 | Streaming markdown renderer |
| `iframe_ready` | 18804 | Artifact iframe handshake (authored-page side) |
| `epitaxy:codeThemeDark` (`GNn`) | 301669 | Epitaxy Monaco theme localStorage key |
| `epitaxy:codeThemeLight` (`WNn`) | 301668 | Paired Epitaxy theme key |
| `melange_probe` (`ept`) | 145057 | Melange memory tool constant |
| `melange_list` / `melange_read` | 145058–145059 | Melange list/read tools |
| `melange/reset` | 145130 | Melange reset endpoint |
| `invalidateAll()` | 145121 | Melange query-key invalidation helper |
| `B5e` (array) | 115577–115586 | Canonical 8 widget tool names |
| `U5e` (array) | 115540–115575 | Widget extraction config (10 tools) |
| `$5e` (array) | 115587–115644 | Widget render components + Tailwind classes |
| `q5e` (set) | 115576 | Union of all widget tool names |
| `G5e()` | 115657–115704 | Widget aggregation logic |
| `W5e()` | 115652–115656 | Widget tool_use predicate |
| `z5e()` | 115523–115530 | Default JSON extractor |
| `F5e()` | 115532–115538 | Image-gallery extractor |
| `weather_fetch` | 115578 | First B5e entry; stable anchor |
| `ask_user_input_v0` | 115582 | In B5e, not U5e; Claude-initiated |
| `AskUserQuestion` | 115573, 115635 | Server-driven widget; U5e & $5e |
| `aggregated_widget` | 115700, 128728 | Widget block type |
| `{ type: 'widget', name:` / `Z4e` | 116854 | Widget injection in tool-list builder |
| `widgets_spotlight_enabled` | 229878 | Gates spotlight UI only |
| `F3e, E5e, P3e, a5e, R5e, D5e` | 113603–115488 | Lazy widget React component refs |
| `claudeai.widget.shown` | 20126, 83378 | Telemetry: widget visibility |
| `claudeai.widget.clicked` | 20127, 83384 | Telemetry: widget interaction |
| `MessageBlocksRenderer` | 128720–128835 | Renders aggregated blocks, dispatches $5e |

---

## Companion Mock

`mock-mcpusercontent-window.ts` (in this directory) is the companion TypeScript mock implementing the parent-side `SandboxHandler` bridge described in §1. Kept as-is.
