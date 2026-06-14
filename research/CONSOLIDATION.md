---
created: 2026-06-14
updated: 2026-06-14
---
# Consolidation Proposal

## Before (16 files)

```
api-research.md
artifact-rendering-environment.md
artifact-sandbox-api.md
changelog-Bz3c8o5k-2026-04-15.md
claude-ai-artifacts-research.md
code-execution-all-mechanisms.md
code-execution-environment.md
enterprise-extension-points.md
format-research.md
mock-mcpusercontent-window.ts
sandbox-iframe-api-research.md
skills-api-reference.md
skills-web-architecture.md
webui-api-research.md
widget-tools.md
wiggle.md
```

## After (5 files + 2 preserved + 1 README)

```
skills-api-and-web-architecture.md     ← group (a)
artifacts-and-sandbox-runtime.md       ← group (b)
code-execution-wiggle.md               ← group (c)
enterprise-extension-points.md         ← group (d), no changes
mock-mcpusercontent-window.ts          ← kept as-is (TypeScript source, referenced by group b)
README.md                              ← new index
[RECOMMEND DROP] changelog-Bz3c8o5k-2026-04-15.md
```

---

## Merge Plan

### (a) `skills-api-and-web-architecture.md`

Merges: `api-research.md` + `webui-api-research.md` + `skills-api-reference.md` + `skills-web-architecture.md` + `format-research.md`

Rationale: All five documents describe the same subject — how skills are authored, packaged, uploaded, and managed via the claude.ai web UI. `api-research.md` and `webui-api-research.md` are explicitly layered (the latter supersedes the former on several points); merging them removes the cross-file "trust this one, not that one" indirection. `skills-api-reference.md` is the authoritative bundle-extracted HTTP reference and belongs beside the background research. `skills-web-architecture.md` covers the client-side runtime that *uses* those APIs. `format-research.md` describes the SKILL.md format and ZIP packaging that feed into the upload API.

Date span: 2026-04-09 (api-research, webui-api-research, format-research) → 2026-04-18 (skills-web-architecture).

### (b) `artifacts-and-sandbox-runtime.md`

Merges: `artifact-rendering-environment.md` + `artifact-sandbox-api.md` + `claude-ai-artifacts-research.md` + `sandbox-iframe-api-research.md` + `widget-tools.md`

Rationale: All five cover the `claudeusercontent.com` iframe runtime. `artifact-rendering-environment.md` and `artifact-sandbox-api.md` are already tightly coupled (same bundle, same SandboxHandler). `claude-ai-artifacts-research.md` adds artifact MIME types, the `antArtifact` XML format, Melange memory, and the AlluviumMarkDown renderer — complementary, not redundant. `sandbox-iframe-api-research.md` is a synthesis document that already draws from the others; merging prevents it from drifting out of sync. `widget-tools.md` belongs here because widget tools are the *third* rendering path alongside the iframe sandbox (inline renderers in the same message stream).

`mock-mcpusercontent-window.ts` is TypeScript source (not a doc); it is referenced by this group but kept as-is.

Date span: 2026-04-18 (all artifact/sandbox/widget sources) → 2026-05-14 (sandbox-iframe-api-research).

### (c) `code-execution-wiggle.md`

Merges: `code-execution-environment.md` + `code-execution-all-mechanisms.md` + `wiggle.md`

Rationale: `code-execution-environment.md` covers the browser iframe sandbox in detail. `code-execution-all-mechanisms.md` adds three more execution paths (self-hosted runners, scheduled tasks/triggers, remote agents/Epitaxy) plus the full MCP transport/safety gating section. `wiggle.md` covers the wiggle feature gate, artifact lifecycle, file egress pipeline, and egress settings — all preconditions and downstream effects of code execution. These three are a natural trilogy; any reader who needs one needs context from the others.

Date span: 2026-04-18 (all three sources).

### (d) `enterprise-extension-points.md`

No change. This doc stands alone; nothing else covers `globalThis['claude.web']`, `claudeAppBindings`, `ChildFrameBridge`, or the browser extension injection recipes.

---

## Changelog recommendation

`changelog-Bz3c8o5k-2026-04-15.md` is a **dated point-in-time snapshot** of a specific bundle diff (hash `Bz3c8o5k`, captured 2026-04-15). It documents:
- A React Query wrapper rename (`Qh` → `zj`)
- A tracker bug fix in `scripts/track/index.js`
- Extractor output drift in `api-diff.json` notes fields

None of this content is reference material for the ongoing research. The tracker fix it documents has already been applied. The bundle hash it describes is superseded. **Recommend deleting this file.** If bundle changelog history needs to be preserved for audit purposes, move it to `snapshots/` rather than keeping it in `research/`.

Do not delete without explicit confirmation.
