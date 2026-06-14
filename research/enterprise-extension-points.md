---
created: 2026-05-14
updated: 2026-05-14
---
# Enterprise Extension Points

> Part of the claude.ai web reverse-engineering research set. See [README.md](./README.md) for the full index.

Reconnaissance of `snapshots/normalized/BL8bstaL/index-BL8bstaL.js` (304,801 lines).
Goal: surface breadcrumbs of intentional extension points that enterprise clients, desktop hosts, or browser extensions could use to integrate with, configure, or extend the claude.ai web UI harness.

---

## Executive Summary

The Claude.ai web application ships with **well-architected, intentional APIs for enterprise integrations**. These are not accidental globals — they form a coherent host-injection system designed to support:

1. **`globalThis['claude.web']`** — 30+ namespaced APIs a container (Electron, enterprise wrapper) injects into the web context
2. **`window.claudeAppBindings`** — Desktop-specific bindings for MCP server management, file pickers, and native OS features
3. **`CustomPlugins.installPlugin()`** — Host-controlled plugin installation that completely locks down or opens up the plugin system
4. **`ChildFrameBridge`** — A protocol allowing Claude.ai to be embedded as an iframe inside third-party applications
5. **MCP `variables` theming schema** — CSS variable injection for org-level white-labeling

All five are already in production use by Anthropic's own products (desktop app, Cowork, custom deployments).

---

## A. `globalThis['claude.web']` — Host Namespace Injection

**Lines:** 31514–31549

The application reads 30+ APIs from a single namespace key on `globalThis`. Any container environment (Electron, enterprise SSO wrapper, desktop app) can inject capabilities by setting this before page load:

```js
globalThis['claude.web'] = {
  Auth: { ... },
  FileSystem: { ... },
  CustomPlugins: { installPlugin: ..., uninstallPlugin: ... },
  // etc.
}
```

**All observed namespace bindings:**

| Namespace | Purpose |
|---|---|
| `Auth` | SSO/enterprise identity integration |
| `FileSystem` | Native OS file access |
| `Navigation` | Host-controlled routing |
| `WindowControl` | Desktop window management |
| `QuickEntry` | OS-level quick-entry (spotlight-like) |
| `FloatingPenguinMini` | Floating widget control |
| `LocalSessions` | Local conversation state management |
| `LocalAgentModeSessions` | Local agent session management |
| `CoworkScheduledTasks` | Scheduled task management |
| `CoworkRadar` | Cowork event/feed integration |
| `CoworkMemory` | Cowork memory system |
| `LocalPlugins` | Local plugin registry |
| `CustomPlugins` | Custom plugin installation API |
| `AutoUpdater` | App auto-update hooks |
| `DesktopNotifications` | OS notification dispatch |
| `Toast` | Toast notification injection |
| `Account` | Account state injection |
| `MenuEvents` | Native OS menu event wiring |
| `AgentModeFeedback` | Agent feedback hooks |
| `NestDev` | Internal dev tools |
| `BrowserNavigation` | Host browser navigation control |
| `ChromeExtension` | Chrome extension integration |
| `ClaudeCode` | Claude Code CLI integration |
| `ClaudeVM` | VM/container integration |

**Pattern:** All reads use optional chaining (`globalThis['claude.web']?.Auth`) — the web app degrades gracefully when not running in a host environment.

**Interpretation:** Unambiguously designed for host injection. The `claude.web` key naming suggests this is part of a documented enterprise SDK.

---

## B. `window.claudeAppBindings` — Desktop Bindings API

**Lines:** 17608, 58089–58094, 109023, 294935–294950

A secondary injection point, separate from `globalThis['claude.web']`, specifically for desktop app bindings:

```js
if (window.claudeAppBindings) {
  window.claudeAppBindings.registerBinding(key, callback);
  window.claudeAppBindings.connectToMcpServer(name);
  window.claudeAppBindings.listMcpServers();
  window.claudeAppBindings.openMcpSettings(name);
  window.claudeAppBindings.filePickers.getPathForFile(file);
}
```

**Observed methods:**
- `registerBinding(key, callback)` / `unregisterBinding(key)` — generic hook registration
- `connectToMcpServer(name)` — initiate MCP server connection via desktop app
- `listMcpServers()` — enumerate MCP servers known to desktop host
- `openMcpSettings(name)` — open native MCP settings UI
- `filePickers.getPathForFile(file)` — resolve native file path from a File object

**Interpretation:** The `claudeAppBindings` object lets the Electron desktop app expose OS-level capabilities to the web UI. The generic `registerBinding` / `unregisterBinding` pattern suggests this was designed to be extensible without updating the web bundle.

---

## C. `CustomPlugins.installPlugin()` — Host-Controlled Plugin System

**Lines:** 55410–55417, 279184–279194

Plugin installation is gated entirely behind the host API:

```js
const YG = globalThis['claude.web']?.CustomPlugins;

// Installation call:
if (!YG?.installPlugin) return { success: false, pluginId: e, error: 'Not available.' };
return YG.installPlugin(pluginId, scope, { pluginSource, marketplaceScope, workspacePath });
```

**Parameters:**
- `pluginId` — identifier
- `scope` — `'user'` or workspace-level
- `workspacePath` — for workspace-scoped installs (multi-tenant)
- `marketplaceScope` — marketplace source identifier

**Security implication:** If the host does not provide `CustomPlugins.installPlugin`, plugin installation is fully locked down — no user or model action can bypass it. Enterprise deployments can use this to whitelist exactly which plugins are allowed.

---

## D. `ChildFrameBridge` — Embedding Claude as an Iframe

**Lines:** 262410–262490

Claude.ai includes a protocol for being embedded inside third-party applications. The embedded Claude posts an initial ready signal with `'*'` origin (intentionally broad), then negotiates a private `MessageChannel`:

```js
// Step 1: Claude (in iframe) announces readiness to parent
window.parent.postMessage({ type: 'CLAUDE_AI_READY' }, '*');

// Step 2: Parent responds with auth payload and MessageChannel port
// Claude validates e.origin on this response

// Step 3: Subsequent tool calls go over the private port
this.port.postMessage({
  type: 'TOOL_CALL',
  requestId: n,
  payload: { tool_name: e, arguments: t }
});
```

**Message types observed:**
- `CLAUDE_AI_READY` — iframe → any parent (initial broadcast)
- `CLAUDE_AI_AUTH` — parent → iframe (auth payload + port transfer)
- `TOOL_CALL` — iframe → parent (tool invocation request)

**Security note:** The initial `CLAUDE_AI_READY` uses `'*'` as the target origin. Any parent frame (including malicious ones) can intercept this. Subsequent messages are validated against `e.origin`, but the initial handshake is open. This is a recognized trade-off for embedding use cases.

**Contrast with artifact sandbox:** The artifact sandbox (`__sandbox_handshake__`) is parent-initiated with strict origin enforcement. `ChildFrameBridge` is child-initiated and intentionally permissive for discoverability.

---

## E. MCP Server Theming — CSS Variable Injection

**Lines:** 46166–46252

MCP server definitions include an optional `variables` schema for CSS theming:

```js
variables: Optional().describe('CSS variables for theming the app')
// type: Record<string, string | undefined>
// Example: { '--primary-color': '#007AFF', '--font-family': 'system-ui' }
```

**Interpretation:** Enterprise clients deploying Claude with custom MCP servers can pass a `variables` map that overrides CSS custom properties. This is the primary white-labeling surface.

---

## F. `new Function()` Dynamic Evaluation

**Line:** 49298

```js
const s = new Function(
  `${n.default.self}`,
  `${n.default.scope}`,
  g
)(this, this.scope.get());
```

**Context:** Appears inside an expression evaluator (likely CodeMirror extension or REPL-adjacent feature). `n.default.self` and `n.default.scope` are injected as named parameters, giving evaluated code access to a controlled scope object.

**Interpretation:** Not a general extension point — this is scoped code evaluation for artifact/REPL execution. The scope injection pattern (`this.scope.get()`) suggests it's sandboxed by design. Worth watching to see if `scope` contents expand.

---

## G. Analytics Iframe with `allow-same-origin`

**Line:** 18758

```js
sandbox: 'allow-scripts allow-same-origin'
```

**Context:** The `isolated-segment.html` analytics iframe (Segment.io) is sandboxed with `allow-same-origin`. This grants the iframe cookie access and same-origin fetch capability — intentional for analytics, but worth flagging as a supply chain risk if the analytics provider were compromised.

---

## H. Patterns That Look Intentional vs. Accidental

### Intentional by Design
| Pattern | Signal |
|---|---|
| `globalThis['claude.web']` optional-chain reads | Defensive coding; expects absent in browser-only mode |
| `claudeAppBindings` feature-flag gating | Explicit `if (window.claudeAppBindings)` guards everywhere |
| `installPlugin` returning `{ success: false, error: 'Not available.' }` | Designed graceful degradation for non-host environments |
| ChildFrameBridge `'*'` + subsequent origin check | Known pattern for embeddable child frames |
| MCP `variables` schema with `.describe()` docs | Documented, typed API surface |

### Possibly Accidental / Worth Watching
| Pattern | Signal |
|---|---|
| `CLAUDE_AI_READY` posted to `'*'` | No allowlist for parent origins; any page embedding the iframe gets the signal |
| `allow-same-origin` on analytics iframe | Grants more capability than strictly needed for telemetry |
| `new Function(...)` with injected scope | Scope contents could expand in future builds |

---

## Ranked Extension Points

| Rank | Extension Point | Line(s) | Who Uses It |
|---|---|---|---|
| 1 | `globalThis['claude.web']` (30+ namespaces) | 31514–31549 | Desktop app, Cowork, enterprise wrappers |
| 2 | `window.claudeAppBindings` | 17608, 294935 | Electron desktop host |
| 3 | `CustomPlugins.installPlugin()` | 55417 | Enterprise plugin governance |
| 4 | `ChildFrameBridge` (CLAUDE_AI_READY / TOOL_CALL) | 262415–262490 | Third-party SaaS embedding |
| 5 | MCP `variables` theming schema | 46166–46252 | White-labeling / org branding |
| 6 | `claudeAppBindings.registerBinding()` | 17608 | Generic desktop hook registration |
| 7 | `globalThis['claude.web'].Auth` | 31535 | Enterprise SSO injection |
| 8 | `new Function(scope)` evaluator | 49298 | REPL/artifact code execution scope |

---

## Key Unknowns

- Whether `globalThis['claude.web']` is documented in an Anthropic enterprise SDK (not visible in bundle)
- Full message payload schema for `CLAUDE_AI_AUTH` (auth info shape)
- Whether `ChildFrameBridge` `TOOL_CALL` maps to the same 21-method set as the artifact sandbox, or a different surface
- What happens when `globalThis['claude.web'].Auth` is provided — does it bypass the standard Anthropic auth flow?
- Whether `registerBinding` on `claudeAppBindings` accepts arbitrary string keys or is limited to a fixed set

---

## Platform Activation Analysis (Follow-up Pass)

Which extension points activate in a plain web browser vs. requiring the desktop app or extension context.

### Platform Detection — How the Bundle Infers Its Host

Platform detection is **behavioral, not declarative** — no platform enum is read at startup. Instead the app infers context by checking for injected bindings:

- **`Iv()` function (line 9714):** Returns `true` only if `window.claudeAppBindings` is present. Used as the desktop gate.
- **Electron detection (line 59011):** `window.process?.versions?.electron` — returns `'browser'` if Electron, `null` otherwise.
- **`anthropic-client-platform` header (line 9908):** Auto-populated as one of `DESKTOP_APP`, `WEB_CLAUDE_AI`, `WEB_CONSOLE`, or `WEB_CUSTOM_AGENTS` based on `Iv()` result and `applicationType` config string (`'claude-dot'`, `'console'`, `'custom-agents'`).

The implication: the same bundle handles all deployment contexts. A userscript that injects `window.claudeAppBindings` before page load would cause the bundle to self-report as `DESKTOP_APP`.

---

### 1. `window.claudeAppBindings` — Desktop-Only; Spoofable via Userscript

**Web browser (plain):** Does not activate. The `Iv()` gate (line 9714) prevents all code paths from running.
**Userscript / browser extension:** Can fully activate by injecting `window.claudeAppBindings = { registerBinding, connectToMcpServer, listMcpServers, openMcpSettings, filePickers }` before page initialization. The app accepts it without additional verification.
**Desktop app:** Primary intended host. Electron preload script injects the object.

Key guard (line 294947):
```js
if (!window.claudeAppBindings?.listMcpServers || !window.claudeAppBindings?.connectToMcpServer) return;
```
No cryptographic check — presence of the object is sufficient.

---

### 2. `globalThis['claude.web']` — Web-Accessible; Activates Anywhere It's Injected

**Web browser (plain):** App runs normally; all 30+ namespace reads return `undefined` via optional chaining; graceful degradation. No errors, no locked-out features.
**Userscript / browser extension:** Can inject any or all namespaces. Example: setting `globalThis['claude.web'] = { Auth: {...} }` in a content script before page load makes the `Auth` API live. No platform check guards the reads.
**Desktop app:** Primary intended host — Electron preload populates the full namespace.

This is the **most accessible extension surface**: zero platform gating, pure optional-chaining reads throughout.

---

### 3. `ChildFrameBridge` — Web-Accessible in Any Iframe; No Platform Check

**Activation condition (line 262537):** Only `Mz()` — checks `window.self !== window.top`. Fires automatically when Claude runs inside any iframe.
**Platform check:** None. No `isDesktop`, no feature flag, no origin allowlist on the outbound `CLAUDE_AI_READY` message.
**Implication:** Embed `claude.ai` (or any path serving the bundle) in an iframe and you immediately receive `CLAUDE_AI_READY` with `'*'` target origin. The parent frame can then respond with a `MessageChannel` port and begin receiving `TOOL_CALL` messages.

```js
// Line 262415 — unconditional if in iframe
window.parent.postMessage({ type: 'CLAUDE_AI_READY' }, '*');
```

Subsequent auth response (`CLAUDE_AI_AUTH`) validates `e.origin`, so the *authenticated* session is bound to the first responder's origin — but the initial broadcast is open.

---

### 4. `claudeai_cc_epitaxy` Feature Flag — Web-Accessible; Statsig-Gated

**Not a platform gate.** Checked via Statsig (`DN('claudeai_cc_epitaxy')`, line 43480). Server-side flag — can be enabled for web users. No desktop-only guard surrounds it.
Note: prior research referenced `claudeai_cc_epitaxy_web` as a separate flag, but it was not found in this bundle version. Only `claudeai_cc_epitaxy` exists.

---

### 5. `ChromeExtension` — Two Separate Integration Paths

**`globalThis['claude.web'].ChromeExtension` (line 31548, 251629):** Host-injected namespace. Checked with optional chaining; called for install/restart prompts. Accessible from a browser extension content script that populates `globalThis['claude.web']` before page load.

**`chrome.runtime` native API (lines 96908–96945):** Separate path, automatically available when the bundle runs inside a Chrome extension context. Used for OAuth redirects:
```js
'undefined' != typeof chrome && chrome.runtime
  ? chrome.runtime.sendMessage(...)
  : s(new Error('Chrome extension API not available'));
```

Both can coexist. A Chrome extension can provide *both* the injected namespace and the native `chrome.runtime` surface simultaneously.

---

### Platform Activation Summary Table

| Extension Point | Plain Web | Browser Extension / Userscript | Desktop App (Electron) | Activation Requirement |
|---|---|---|---|---|
| `window.claudeAppBindings` | No | Yes (inject before load) | Yes (primary host) | Object must be present; no crypto check |
| `globalThis['claude.web']` (all namespaces) | Graceful no-op | Yes (inject any namespace) | Yes (primary host) | Optional chaining; zero platform gate |
| `ChildFrameBridge` (`CLAUDE_AI_READY`) | Yes (if in iframe) | N/A | Yes (if in iframe) | `window.self !== window.top` only |
| `claudeai_cc_epitaxy` flag | Yes (if Statsig enabled) | Yes | Yes | Statsig server-side flag |
| `globalThis['claude.web'].ChromeExtension` | No | Yes (inject namespace) | Yes | Host injection or content script |
| `chrome.runtime` native API | No | Yes (automatic) | No | Native extension context |
| `anthropic-client-platform` header | Yes (auto) | Yes (reflects injected state) | Yes (DESKTOP_APP) | Auto-derived from `Iv()` + `applicationType` |

### Key Takeaway

The bundle is **platform-agnostic by construction**. All desktop-specific features are gated by the *presence* of injected objects, not by user agent sniffing or platform enums. A browser extension or userscript with content script access to `claude.ai` can activate the full `globalThis['claude.web']` namespace and simulate the `window.claudeAppBindings` desktop surface with no cryptographic barrier — only behavioral convention separates web from desktop.

---

## Extension Bypass Mechanics (Chrome / Firefox)

What the prior pass glossed over: the *exact* technical requirements to actually pull off injection from a browser extension.

### Critical Issue: Content Script World Isolation

Chrome MV3 and Firefox MV3 content scripts run in an **isolated world** — they share the DOM but have a separate `window`/`globalThis` from the page's JavaScript. Setting `window.claudeAppBindings = {...}` in a standard content script is **invisible to the page bundle**.

This matters because **all `globalThis['claude.web']` reads happen at module scope** (lines 31514–31549 are top-level `const` declarations, not inside functions or effects):

```js
// Evaluated immediately when index-BL8bstaL.js is parsed — not lazily
const kG = globalThis['claude.web']?.WindowControl,
  jG = globalThis['claude.web']?.QuickEntry,
  $G = globalThis['claude.web']?.Auth,
  nH = globalThis['claude.web']?.ChromeExtension,
  // ... 25+ more
```

If the bundle has already evaluated these lines, no later injection can patch the cached `undefined` values. **Injection must occur before the `index-BL8bstaL.js` `<script type="module">` tag is parsed.**

---

### `Iv()` Gate — Full Truth Table (lines 9698–9714)

```js
function Iv(e, { version: t, platform: n } = {}) {
  const s = Sv(e)?.version ?? null;   // extracts version from UA string
  if (!s) return false;
  const a = e.toLowerCase(),
    r = !t || semverCheck(s, t),      // r = no version req, OR UA version matches
    i = !n ||
      ('mac' === n && a.includes('macintosh')) ||
      ('windows' === n && a.includes('windows'));  // i = no platform req, OR OS matches
  return r && i && ('undefined' == typeof window || !!window.claudeAppBindings);
}
```

Called without arguments at line 9901: `Iv(window.navigator.userAgent)` — so `t` and `n` are both `undefined`, meaning `r = true` and `i = true` automatically. **The only condition that matters for the extension is `!!window.claudeAppBindings`.** Any truthy object satisfies it — no version spoofing needed.

---

### CSP — Not a Blocker

Inspecting `snapshots/raw/claude.ai/index~no-etag-1778793301699.html`: script tags carry nonces but there is **no `<meta http-equiv="Content-Security-Policy">` tag**. CSP is enforced via server response headers (not inspectable from the bundle), but nonces on static tags do not block dynamically created `<script>` elements injected by an extension. The `<script>` tag injection technique works unless a `script-src` server header explicitly blocks it.

---

### `ChildFrameBridge` Origin Gate — Defaults to Closed

Line 257750: `iframeAllowedOrigins: []`

`isOriginAllowed()` immediately returns `false` when the array is empty (line 262385). The initial `CLAUDE_AI_READY` broadcast still fires with `'*'`, but the bridge **drops all parent responses** unless an origin has been explicitly added to the allowlist server-side. This is not an extension injection point — it requires backend configuration by an admin.

---

### `chrome.runtime` — Page-to-Extension, Not Extension-to-Page

The `chrome.runtime.sendMessage` at lines 96908–96945 is inside the page bundle's OAuth flow. It targets a hardcoded extension ID: `fcoeoabgfenejglbffodgkkbkcdhcgfn` (the official Claude browser extension). Page-side JS can call `chrome.runtime` only when a matching extension is installed and has declared `externally_connectable` for `claude.ai`. A third-party extension with a different ID will not receive these messages.

---

### Injection Recipe — Chrome MV3

Standard content scripts run in isolated world. Workaround: inject a `<script>` tag at `document_start` so the code runs in the main world before the bundle loads.

**manifest.json**
```json
{
  "manifest_version": 3,
  "host_permissions": ["*://claude.ai/*"],
  "content_scripts": [{
    "matches": ["*://claude.ai/*"],
    "js": ["content.js"],
    "run_at": "document_start"
  }]
}
```

**content.js** (runs in isolated world — uses script tag to reach main world)
```js
const s = document.createElement('script');
s.textContent = `
  window.claudeAppBindings = {
    registerBinding: () => {},
    unregisterBinding: () => {},
    connectToMcpServer: async () => {},
    listMcpServers: async () => [],
    openMcpSettings: () => {},
    filePickers: { getPathForFile: async (f) => f.name }
  };
  globalThis['claude.web'] = {
    WindowControl: {}, Auth: {}, FileSystem: {},
    CustomPlugins: { installPlugin: async () => ({ success: true }) },
    LocalPlugins: {}, Navigation: {}, DesktopNotifications: {},
    Toast: {}, Account: {}, ChromeExtension: {}, ClaudeCode: {},
    // ... remaining namespaces
  };
`;
document.documentElement.prepend(s);
s.remove();
```

The script tag executes synchronously in the main world. By the time the browser fetches and parses `index-BL8bstaL.js`, both globals are live. The bundle self-reports as `DESKTOP_APP` via the `anthropic-client-platform` request header.

---

### Injection Recipe — Firefox MV2

Firefox MV2 content scripts run in the **main world** (no isolation), so direct assignment works — no `<script>` tag needed.

**manifest.json**
```json
{
  "manifest_version": 2,
  "permissions": ["*://claude.ai/*"],
  "content_scripts": [{
    "matches": ["*://claude.ai/*"],
    "js": ["inject.js"],
    "run_at": "document_start"
  }]
}
```

**inject.js** (runs directly in the page's main world)
```js
window.claudeAppBindings = {
  registerBinding: () => {},
  connectToMcpServer: async () => {},
  listMcpServers: async () => [],
  openMcpSettings: () => {},
  filePickers: { getPathForFile: async (f) => f.name }
};
globalThis['claude.web'] = {
  Auth: {}, FileSystem: {}, CustomPlugins: {
    installPlugin: async () => ({ success: true })
  },
  // ... remaining namespaces
};
```

Firefox MV3 behaves like Chrome MV3 (isolated world) — use the `<script>` tag technique.

---

### Bypass Summary

| Blocker | Chrome MV3 | Firefox MV2 | Firefox MV3 |
|---|---|---|---|
| World isolation | Blocks direct assignment | Not present | Blocks direct assignment |
| Module-scope timing | Requires `document_start` | Requires `document_start` | Requires `document_start` |
| CSP inline scripts | Permissive (no meta CSP) | Permissive | Permissive |
| **Solution** | `<script>` tag at `document_start` | Direct assignment at `document_start` | `<script>` tag at `document_start` |
| `Iv()` gate | Satisfied by any truthy `claudeAppBindings` | Same | Same |
| `ChildFrameBridge` | Blocked by empty `allowedOrigins` | Same | Same |
| `chrome.runtime` OAuth | Requires matching extension ID | Same | Same |
