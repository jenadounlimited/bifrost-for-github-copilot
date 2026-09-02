# Changelog

All notable changes to **Bifrost for GitHub Copilot (Unofficial)** are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). Versions follow [Semantic Versioning](https://semver.org/).

---

## [0.2.0] — 2026-09-02

### Added

- **MCP auto-registration** — every configured Bifrost gateway is automatically registered as an MCP server at `{origin}/mcp` using the Streamable HTTP transport; tools appear in Copilot Agent mode alongside Copilot's own built-in tools with no extra configuration required
- **Live MCP refresh** — adding, editing, or removing a gateway via **Manage Bifrost Provider** immediately disposes old MCP registrations and re-registers all current endpoints; no restart needed
- **Unified auth for MCP** — the same virtual key already stored for chat completions is reused for MCP (`Authorization: Bearer` for `sk-bf-*` keys, `x-bf-vk` header for legacy keys); no new credentials or UI prompts

### Changed

- Test suite expanded to 181 tests (+11 MCP registration tests)

---

## [0.1.0] — 2026-09-01

### Added

- **Language model provider** — registers a first-class `bifrost` vendor with VS Code's `LanguageModelChatProvider` API; models appear in Copilot Chat's model picker
- **Model discovery** — auto-discovers models from `GET {base}/models` and `GET {base}/v1/models` with fallback pagination
- **SSE streaming** — streams chat completions via `POST {base}/chat/completions`; supports native tool calls, text-embedded tool calls (`<tool_call>` JSON), and deduplication
- **Copilot Agent tool calling** — passes `tools` and `tool_choice: "any"` for `ToolMode.Required`; enforces 128-tool limit
- **Management UI** — add, edit, remove, test, and open dashboard for multiple Bifrost endpoints; all stored in VS Code `SecretStorage`
- **Virtual key support** — optional `Authorization: Bearer` (modern `sk-bf-*` keys) or `x-bf-vk` header (legacy keys); auto-detected from key prefix
- **Ephemeral data filter** — filters VS Code 1.118+ `cache_control` sentinel messages; togglable via command
- **Per-endpoint configuration** — `requestTimeoutMs` (chat requests) and `maxOutputTokens` per endpoint
- **Loopback / HTTP safety** — allows HTTP for localhost; warns on remote HTTP; never blocks user choice
- **Abort handling** — honours VS Code `CancellationToken`; `AbortController` per request; incomplete tool JSON is never flushed on abort
- **Logging with redaction** — output channel logging; `redact()` strips `sk-bf-*` keys, Bearer tokens, and `x-bf-vk` values before writing
- **CI pipeline** — GitHub Actions workflow: compile, lint, format-check, test, `vsce package`; Node.js 22 and 24 matrix
- **Release pipeline** — automated GitHub Release and VS Code Marketplace publish on `v*.*.*` tag push
- **Test suite** — 170 tests across auth, utils, stream, models, provider, manage, log, and privacy modules; ≥80% coverage

### Notes

- This is an **unofficial** community extension — not an official Maxim HQ product
- Requires VS Code `^1.104.0` and a running Bifrost gateway
- No runtime dependencies; all dev-only

---

## Template for future releases

## [X.Y.Z] — YYYY-MM-DD

### Added

### Changed

### Fixed

### Removed
