# Local Development & Testing

This guide covers how to build the `bifrost-for-github-copilot` VS Code extension and run its test suite locally.

---

## Prerequisites

| Tool | Minimum version |
|------|----------------|
| Node.js | 22+ |
| pnpm | 8.15.4 |

Install pnpm if you don't have it:

```bash
npm install -g pnpm@8.15.4
```

---

## Initial Setup

Clone the repository and install all dependencies. A `postinstall` hook automatically downloads the `@types/vscode` definitions via `@vscode/dts`:

```bash
git clone https://github.com/jenadounlimited/bifrost-for-github-copilot.git
cd bifrost-for-github-copilot
pnpm install
```

---

## Building

Compile the TypeScript source to `out/`:

```bash
pnpm run compile
```

This runs `tsc -p ./` against [`tsconfig.json`](../tsconfig.json), emitting JavaScript, declaration files, declaration maps, and source maps into `out/`. The `main` entry point of the extension is `out/extension.js`.

To rebuild automatically on every file save, use watch mode:

```bash
pnpm run watch
```

---

## Running Tests

### Unit tests (single run)

```bash
pnpm run test
```

This executes `vitest run` — a headless, non-interactive pass. No live Bifrost instance or VS Code window is needed. All VS Code APIs are mocked via [`src/test/__mocks__/vscode.ts`](../src/test/__mocks__/vscode.ts) and the alias is wired in [`vitest.config.mts`](../vitest.config.mts).

### Interactive UI (watch + browser)

```bash
pnpm run test:ui
```

Opens Vitest's browser UI with live re-runs on file changes. Useful when writing new tests or debugging failures.

### With coverage

```bash
pnpm run test:coverage
```

Generates a V8 coverage report. Reports are written to `coverage/` in `text`, `json`, and `html` formats. The configured thresholds that CI enforces are:

| Metric | Threshold |
|--------|-----------|
| Statements | 80% |
| Lines | 80% |
| Functions | 75% |
| Branches | 70% |

Open `coverage/index.html` in a browser to browse the full report.

---

## Test Structure

All tests live under [`src/test/`](../src/test/) and are discovered by the glob `src/test/**/*.test.ts`.

| File | What it tests |
|------|--------------|
| [`auth.test.ts`](../src/test/auth.test.ts) | URL normalization, auth mode resolution, header construction, loopback/insecure detection |
| [`log.test.ts`](../src/test/log.test.ts) | Logger output, log level filtering |
| [`manage.test.ts`](../src/test/manage.test.ts) | Endpoint CRUD in `SecretStorage`, QuickPick flows |
| [`models.test.ts`](../src/test/models.test.ts) | Model list fetching, response parsing |
| [`privacy.test.ts`](../src/test/privacy.test.ts) | Virtual key redaction, prompt non-logging, SecretStorage usage |
| [`provider.test.ts`](../src/test/provider.test.ts) | `LanguageModelChatProvider` registration and request dispatch |
| [`stream.test.ts`](../src/test/stream.test.ts) | `SseChatParser` — all SSE shapes, tool call buffering, abort handling |
| [`utils.test.ts`](../src/test/utils.test.ts) | Shared utility functions |

### SSE fixtures

Realistic SSE stream fixtures (plain text, native tool calls, text-embedded tool calls, mixed content, thinking tokens, truncated/aborted streams, and deduplication) are centralised in [`src/test/fixtures/sse.ts`](../src/test/fixtures/sse.ts). Add new streaming patterns there when testing new SSE shapes.

### VS Code mock

The `vscode` module is aliased at test time to [`src/test/__mocks__/vscode.ts`](../src/test/__mocks__/vscode.ts). This mock exposes only the VS Code symbols actually exercised by the source modules (`window`, `env`, `lm`, `commands`, `Uri`, the `LanguageModel*Part` classes, etc.). Extend this file — not the source — when a new VS Code API surface needs to be covered.

---

## Lint & Formatting

```bash
# Run ESLint
pnpm run lint

# Auto-format with Prettier
pnpm run format

# Check formatting without writing
pnpm run format:check
```

The full local validation gate (same checks that CI runs) is:

```bash
pnpm run compile && pnpm run lint && pnpm run test
```

---

## Packaging a `.vsix`

To produce an installable extension file:

```bash
pnpm exec vsce package --no-dependencies
```

This outputs a `bifrost-for-github-copilot-<version>.vsix` in the project root. `--no-dependencies` is required because all dependencies are `devDependencies` and nothing is bundled at runtime.

To install the `.vsix` locally:

1. Open VS Code
2. Extensions panel → `...` menu → **Install from VSIX…**
3. Select the generated file

Or from the terminal:

```bash
code --install-extension bifrost-for-github-copilot-*.vsix
```

---

## Writing New Tests

1. Create `src/test/<module>.test.ts` alongside the source module it covers.
2. Import from `vitest` (`describe`, `it`, `expect`, `vi`) — do not use Mocha or Jest.
3. Use the `vscode` import normally; it resolves to the mock automatically.
4. No network calls, no spawned processes. All I/O must be mocked.
5. Run `pnpm run test:coverage` and verify the new code meets the ≥80% line threshold before committing.

Example skeleton:

```typescript
import { describe, expect, it } from 'vitest';
import { myFunction } from '../myModule';

describe('myFunction', () => {
  it('returns expected value', () => {
    expect(myFunction('input')).toBe('expected');
  });
});
```
