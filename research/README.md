---
title: Research Index
created: 2026-04-09
updated: 2026-06-14
---

# Research Index

This directory holds reverse-engineering research on the claude.ai web bundle and skills surface, consolidated from an earlier 16-file sweep into four thematic docs (2026-06-14).

| Doc | Description |
| --- | --- |
| [skills-api-and-web-architecture.md](skills-api-and-web-architecture.md) | claude.ai web UI skills HTTP API, auth/headers, official `api.anthropic.com/v1/skills` contrast, distribution/tooling, client-side runtime, and the `SKILL.md` file format. |
| [artifacts-and-sandbox-runtime.md](artifacts-and-sandbox-runtime.md) | `claudeusercontent.com` iframe runtime, the `SandboxHandler` bridge and its 21-method protocol, artifact MIME/XML formats, ProxyFetch and Storage APIs, AlluviumMarkDown/Melange, and inline widget tools. |
| [code-execution-wiggle.md](code-execution-wiggle.md) | The `wiggle` capability and feature gate, all four code-execution mechanisms (browser sandbox, self-hosted runners, scheduled triggers, remote agents), the file egress pipeline, and MCP transport/gating. |
| [enterprise-extension-points.md](enterprise-extension-points.md) | Host-injection surfaces (`globalThis['claude.web']`, `claudeAppBindings`, `ChildFrameBridge`), the platform activation matrix, and browser-extension injection recipes. |

## Supporting files

- `mock-mcpusercontent-window.ts` — TypeScript mock window referenced by the artifacts doc.
- `CONSOLIDATION.md` — the proposal documenting this merge.

Note: bundle line numbers and search strings throughout these docs are anchored to specific bundle hashes and may drift across rebuilds.
