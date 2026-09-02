# Bifrost for GitHub Copilot — MCP Auto-Registration

| Field        | Value                                                        |
| ------------ | ------------------------------------------------------------ |
| **Document** | Software Design Document                                     |
| **Feature**  | Automatic MCP Server Registration from Bifrost Endpoints     |
| **Status**   | Draft                                                        |
| **Date**     | 2026-01-01                                                   |
| **Repo**     | `jenadounlimited/bifrost_for_github_copilot`                 |
| **Depends on** | v1 extension (LM Chat Provider) — see `docs/DESIGN.md`    |

---

## Overview

Bifrost exposes an MCP (Model Context Protocol) gateway at `{origin}/mcp` alongside its OpenAI-compatible chat surface. This document describes adding automatic VS Code MCP server registration so that every Bifrost gateway the user has already configured as a chat endpoint is also registered as a first-class MCP server in VS Code — with no additional configuration required.

When this feature is active, tools made available through Bifrost's MCP gateway appear automatically in Copilot Agent mode alongside Copilot's own built-in tools, using the same virtual key and URL the user already stored in `SecretStorage`.

---

## Background

### Current state

The v1 extension (see `docs/DESIGN.md`) registers a `LanguageModelChatProvider` for the `bifrost` vendor, auto-discovers chat models from `GET {base}/models`, and stores gateway URLs plus optional virtual keys in `SecretStorage` as [`BifrostEndpoint`](../src/types.ts) objects.

KD17 in the v1 design explicitly deferred MCP registration:

> **MCP helper commands: no for v1.** Document the pointer to Bifrost MCP docs in README. Lemonade also does not register MCP. Copilot already has MCP config.

### Why add it now

- Users already store one or more Bifrost gateway endpoints. Re-using that stored state to also register an MCP server is a zero-friction upgrade — no new credentials, no new URLs, no new UI required for the common case.
- VS Code 1.99+ ships a programmatic `vscode.lm.registerMcpServer()` API. The extension's engine floor is already `^1.104.0`, which is above the requirement.
- Bifrost's MCP endpoint uses the same virtual key auth as the OpenAI surface, so the existing `buildRequestHeaders()` helper in [`src/auth.ts`](../src/auth.ts) covers authentication without new logic.

---

## Goals

1. On extension activation, register one VS Code MCP server per configured Bifrost endpoint automatically.
2. Re-register (dispose old, register new) whenever the user adds, edits, or removes a gateway via the Manage UI.
3. Reuse existing auth helpers and `BifrostEndpoint` storage — no new credential storage or UI prompts for the common case.
4. Fail silently per endpoint (log a warning, skip) if MCP registration is unavailable or the gateway does not expose `/mcp`.
5. Zero new runtime npm dependencies.

## Non-Goals

- Discovering which specific MCP tool groups or servers a given API key has access to (per-user MCP enumeration). Each endpoint gets a single registration at `{origin}/mcp`. If Bifrost later exposes a discovery endpoint, that can be a follow-up.
- A UI for enabling/disabling MCP registration per endpoint. All endpoints are registered; users manage endpoints via the existing Manage UI.
- SSE transport fallback probing. Start with Streamable HTTP (`type: 'http'`); add SSE fallback only if field reports indicate older Bifrost deployments require it.
- Workspace-scoped MCP server registration. User-global (matching `SecretStorage` scope) only.

---

## Key Decisions

| #    | Decision | Rationale |
| ---- | -------- | --------- |
| KD-M1 | **Always register at `{origin}/mcp`** — derive MCP URL from the stored endpoint URL using the existing `dashboardUrl()` helper. No probe request before registering. | VS Code handles unreachable MCP servers gracefully (shows "not connected" in the tools panel). A probe would add latency on every activation and duplicate the connection test already in the Manage UI. |
| KD-M2 | **Use `type: 'http'` (Streamable HTTP) transport.** | MCP 2025-03-26 spec; Bifrost supports it. SSE (`type: 'sse'`) is the legacy fallback and can be added later if needed. |
| KD-M3 | **Auth via `buildRequestHeaders()`** — same function used for chat completions. | Virtual key format (`sk-bf-*` → `Authorization: Bearer`; legacy → `x-bf-vk`) is identical on the MCP surface. No new auth logic. |
| KD-M4 | **Track live registrations as `vscode.Disposable[]`** in a mutable ref in `extension.ts`. On endpoint change: dispose all, re-register all. | Simpler than per-endpoint diffing. Registration count is bounded by the number of gateways (typically 1–5). |
| KD-M5 | **New file `src/mcp.ts`** for registration logic. No changes to `src/provider.ts`, `src/models.ts`, or `src/auth.ts`. | Keeps the MCP surface isolated from the chat surface. Consistent with the module-per-concern layout of v1. |
| KD-M6 | **Engine floor stays at `^1.104.0`.** `vscode.lm.registerMcpServer` is available from VS Code 1.99+, which is below the current floor. | No floor bump needed. |
| KD-M7 | **No new `contributes` manifest entry.** Programmatic registration via the API requires no `contributes.mcpServerDefinitionProviders` or similar manifest key. | Keeps `package.json` minimal. |

---

## Design

### MCP URL derivation

Given a stored `BifrostEndpoint.url` such as `http://localhost:8080/openai/v1`, the MCP endpoint is at the origin: `http://localhost:8080/mcp`.

The existing [`dashboardUrl()`](../src/auth.ts) function already extracts `{protocol}//{host}` from any stored URL:

```ts
// src/auth.ts — already exists
export function dashboardUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  return `${parsed.protocol}//${parsed.host}`;
}
```

So the MCP URL is simply `dashboardUrl(endpoint.url) + '/mcp'`.

---

### New file: `src/mcp.ts`

```ts
// MCP server registration for configured Bifrost endpoints

import * as vscode from 'vscode';
import { buildRequestHeaders, dashboardUrl } from './auth';
import type { BifrostEndpoint } from './types';
import type { Logger } from './log';

/**
 * Register one VS Code MCP server per Bifrost endpoint.
 * Returns the disposables — caller must push them onto context.subscriptions
 * or track them for re-registration on endpoint changes.
 */
export function registerMcpServersForEndpoints(
  endpoints: BifrostEndpoint[],
  userAgent: string,
  logger: Logger,
): vscode.Disposable[] {
  return endpoints.map(endpoint => {
    const origin = dashboardUrl(endpoint.url);
    const mcpUrl = `${origin}/mcp`;
    logger.info(`Registering MCP server at ${mcpUrl}`, endpoint.shortname);

    return vscode.lm.registerMcpServer({
      name: `Bifrost (${endpoint.shortname})`,
      transport: {
        type: 'http',
        url: vscode.Uri.parse(mcpUrl),
        headers: buildRequestHeaders(endpoint, userAgent),
      },
    });
  });
}
```

> **Note:** `vscode.lm.registerMcpServer` is the proposed API name based on VS Code 1.99+ MCP programmatic registration. Verify the exact symbol name against the `@types/vscode` version installed (run `pnpm run download-api` after bumping `@types/vscode` if needed).

---

### Changes to `src/extension.ts`

Two changes are needed:

1. **Initial registration on activation** — call `registerMcpServersForEndpoints` after loading endpoints from `SecretStorage`.
2. **Re-registration on endpoint changes** — replace the no-op `onEndpointsChanged` callback with one that disposes and re-registers.

```ts
import { loadEndpoints } from './manage';
import { registerMcpServersForEndpoints } from './mcp';

export function activate(context: vscode.ExtensionContext): void {
  // ... existing setup (userAgent, logger, outputChannel, provider) ...

  // Track live MCP registrations so they can be replaced on endpoint changes
  let mcpRegistrations: vscode.Disposable[] = [];

  const refreshMcpServers = async () => {
    mcpRegistrations.forEach(d => d.dispose());
    const endpoints = await loadEndpoints(context.secrets);
    mcpRegistrations = registerMcpServersForEndpoints(endpoints, userAgent, logger);
    // Push new registrations so VS Code disposes them on deactivation
    mcpRegistrations.forEach(d => context.subscriptions.push(d));
  };

  // Initial registration
  void refreshMcpServers();

  // Wire manage command to also refresh MCP on endpoint changes
  context.subscriptions.push(
    vscode.commands.registerCommand('bifrost.manage', async () => {
      await showManageEndpointsUI(
        context.secrets,
        provider,
        async () => {
          await refreshMcpServers();
        },
      );
    }),
  );

  // ... rest of existing command registrations ...
}
```

> **Subscription note:** `context.subscriptions.push(d)` is called on each new registration after a refresh. Disposed registrations pushed earlier are no-ops when VS Code calls `.dispose()` on them at deactivation. This is safe and matches how other dynamic disposables are handled in VS Code extensions.

---

### Sequence diagram

```
activate()
  │
  ├── loadEndpoints(secrets)
  │     └── SecretStorage.get('bifrost.endpoints')
  │
  └── registerMcpServersForEndpoints(endpoints, userAgent, logger)
        │
        └── for each endpoint:
              dashboardUrl(endpoint.url)  →  "{origin}"
              mcpUrl = "{origin}/mcp"
              buildRequestHeaders(endpoint, userAgent)
              vscode.lm.registerMcpServer({ name, transport: { type:'http', url, headers } })
              → vscode.Disposable

user: Manage Bifrost Provider → Add/Edit/Remove gateway
  │
  └── onEndpointsChanged()
        │
        ├── dispose all mcpRegistrations[]
        └── registerMcpServersForEndpoints(newEndpoints, ...)  →  new mcpRegistrations[]
```

---

### File tree delta

Only two files change; one new file is added:

```
src/
  mcp.ts          ← NEW  (~30 lines)
  extension.ts    ← MODIFIED  (initial registration + refresh callback)
src/test/
  mcp.test.ts     ← NEW  (~60 lines)
```

No changes to `src/auth.ts`, `src/provider.ts`, `src/models.ts`, `src/manage.ts`, `src/types.ts`, or `src/constants.ts`.

---

## API Reference

### `vscode.lm.registerMcpServer(definition)`

Available from VS Code 1.99+. Programmatically registers an MCP server visible to Copilot Agent and any other VS Code MCP consumer.

```ts
interface McpServerDefinition {
  name: string;
  transport:
    | { type: 'http'; url: vscode.Uri; headers?: Record<string, string> }
    | { type: 'sse'; url: vscode.Uri; headers?: Record<string, string> };
}

// Returns a vscode.Disposable. Disposing unregisters the server.
vscode.lm.registerMcpServer(definition: McpServerDefinition): vscode.Disposable;
```

> Verify this interface against `@types/vscode` at the target version. The exact shape may differ slightly from the above; check `vscode.d.ts` after running `pnpm run download-api`.

---

## Authentication

The MCP endpoint at `{origin}/mcp` is expected to use the same virtual key authentication scheme as the OpenAI surface. The existing [`buildRequestHeaders()`](../src/auth.ts) function handles all three modes:

| Key format | Auth mode (auto) | Header sent |
| ---------- | ---------------- | ----------- |
| `sk-bf-*` | `bearer` | `Authorization: Bearer {key}` |
| other prefix | `x-bf-vk` | `x-bf-vk: {key}` |
| none | `auto` | (no auth headers) |

No changes to `buildRequestHeaders()` are needed.

> **Field validation needed:** Confirm with Bifrost docs or a test deployment that `/mcp` accepts the same virtual key headers as `/openai/v1/chat/completions`. If `/mcp` requires a different auth scheme, a new `buildMcpRequestHeaders()` function would be added to `src/auth.ts`.

---

## Error Handling

| Scenario | Behaviour |
| -------- | --------- |
| Gateway does not expose `/mcp` | VS Code shows the server as "not connected" in the MCP tools panel. The extension logs a warning via `logger.warn`. No user-visible error pop-up. |
| `vscode.lm.registerMcpServer` throws (API unavailable) | Wrapped in a try/catch in `registerMcpServersForEndpoints`. Logs the error; does not affect chat model registration. |
| Endpoint has no virtual key | Registers unauthenticated (no auth headers). Bifrost's unauthenticated access policy applies. Consistent with chat model behaviour. |
| Network error after registration | Handled by VS Code's MCP client, not the extension. The extension only registers; it does not manage the ongoing connection. |

---

## Security Considerations

- Virtual keys are read from `SecretStorage` at registration time and passed directly to `buildRequestHeaders()`. They are not stored in any additional location.
- The `headers` map passed to `registerMcpServer` is held in memory by the VS Code MCP client for the duration of the registration. VS Code's handling of these headers is subject to its own security model.
- HTTP (non-TLS) endpoints: the existing `isInsecureRemoteHttp()` warning in the Manage UI already flags insecure remote endpoints when they are added. No additional warning is needed at MCP registration time.
- MCP tools returned by the server execute via Copilot Agent's tool-call loop, not directly by this extension. The extension has no visibility into which tools are called or what arguments are sent.

---

## Testing

### Unit tests: `src/test/mcp.test.ts`

| Test | Assertion |
| ---- | --------- |
| `registerMcpServersForEndpoints` with one endpoint | Calls `vscode.lm.registerMcpServer` once with `name: 'Bifrost (default)'`, `transport.type: 'http'`, URL ending in `/mcp` |
| `registerMcpServersForEndpoints` with multiple endpoints | Returns one disposable per endpoint; each has a distinct `name` and MCP URL |
| Endpoint with virtual key `sk-bf-abc` | Headers contain `Authorization: Bearer sk-bf-abc` |
| Endpoint with legacy key `vk-abc` | Headers contain `x-bf-vk: vk-abc` |
| Endpoint with no virtual key | Headers contain only `User-Agent` |
| `registerMcpServer` throws | `registerMcpServersForEndpoints` does not throw; logs warning; returns empty array for that endpoint |
| URL derivation from `/openai/v1` base | MCP URL is `http://localhost:8080/mcp` (not `http://localhost:8080/openai/v1/mcp`) |

The `vscode` mock at `src/test/__mocks__/vscode.ts` needs a stub for `vscode.lm.registerMcpServer` returning a mock disposable.

---

## Open Questions

| # | Question | Resolution needed before |
| - | -------- | ------------------------- |
| OQ-1 | Does Bifrost's `/mcp` endpoint accept the same virtual key headers as `/openai/v1`? | Implementation |
| OQ-2 | Is `vscode.lm.registerMcpServer` the correct API symbol name in the current `@types/vscode`? | Implementation — run `pnpm run download-api` and inspect `vscode.d.ts` |
| OQ-3 | Does Bifrost expose per-user MCP server enumeration (e.g. `GET {origin}/mcp/servers`) that would allow registering named sub-servers rather than a single gateway? | Design — can ship as a follow-up |
| OQ-4 | Are there Bifrost deployments in the field using only SSE transport (not Streamable HTTP)? If so, is there a probe or version-detection path? | Can be deferred; add SSE option to `BifrostEndpoint` config if reports emerge |

---

## References

- [Bifrost MCP + GitHub Copilot docs](https://docs.getbifrost.ai/cli-agents/github-copilot.md#adding-mcp-servers-via-bifrost)
- [VS Code MCP server programmatic registration](https://code.visualstudio.com/api/extension-guides/mcp) (VS Code 1.99+)
- [MCP Streamable HTTP transport spec — 2025-03-26](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http)
- `docs/DESIGN.md` — v1 extension design (KD17: MCP deferred)
- `src/auth.ts` — `buildRequestHeaders()`, `dashboardUrl()`
- `src/types.ts` — `BifrostEndpoint`
- `src/manage.ts` — `loadEndpoints()`, `showManageEndpointsUI()`
