# Contributing to Bifrost for GitHub Copilot (Unofficial)

Thank you for your interest in contributing. This document outlines the code style, testing requirements, commit conventions, and PR process.

## Development Setup

```bash
# Install dependencies
pnpm install

# Compile TypeScript
pnpm run compile

# Run tests
pnpm run test

# Run tests with coverage
pnpm run test:coverage

# Lint
pnpm run lint

# Format
pnpm run format
```

## Code Style

- **TypeScript strict mode** — `strict: true` is enforced in `tsconfig.json`; no `any` casts without justification
- **ESLint + Prettier** — all code must pass `pnpm lint` and `pnpm format:check` with zero errors/warnings
- **No `console.log`** — use the `Logger` class (`src/log.ts`); the ESLint rule `no-console` is enabled
- **Minimal changes** — only change what is needed; avoid unrelated refactors in a PR
- **Match existing style** — follow the patterns in `src/auth.ts`, `src/provider.ts`, and `src/stream.ts`

## Testing Requirements

- **Unit tests for new features** — add tests in `src/test/<module>.test.ts` alongside each source module
- **≥80% line coverage** — the CI enforces this via `vitest run --coverage`
- **Use Vitest** — `describe` / `it` / `expect` from `vitest`; no Mocha or Jest
- **Test fixtures** — add SSE fixture streams to `src/test/fixtures/sse.ts` for new streaming patterns
- **No integration tests** — all tests run without a live Bifrost instance; mock the VS Code API via `src/test/__mocks__/vscode.ts`

## Commit Message Format

```
type(scope): short description
```

**Types**: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`

**Scopes** (optional): `provider`, `stream`, `auth`, `manage`, `utils`, `models`, `log`, `ci`, `readme`

**Examples**:

```
feat(provider): support maxOutputTokens per endpoint
fix(stream): flush remaining text on stream end
docs(readme): add key rotation instructions
test(privacy): add virtual key redaction tests
chore(ci): add pnpm audit step
```

## Pull Request Process

1. **Fork** the repository and create a feature branch from `main`
2. **Implement** your change with appropriate tests
3. **Run validation** locally before opening a PR:
   ```bash
   pnpm run compile && pnpm run lint && pnpm run test
   ```
4. **Open a PR** with:
   - A clear description of what changed and why
   - Reference to any related issue (e.g. `Closes #42`)
   - An update to `CHANGELOG.md` under `[Unreleased]` if the change is user-visible
5. **Wait for CI** — all checks must pass before merging

## Security & Privacy Rules

- **Never log prompts, completions, or virtual keys** — use `redact()` from `src/log.ts` if there is any chance sensitive data could appear in a log message
- **Always use `SecretStorage`** for keys and credentials — never `globalState` or workspace settings
- **No new runtime dependencies** — this extension has zero production dependencies by design; adding one requires strong justification

## Release Process

Releases are managed by the maintainer. If you are preparing a release:

1. Bump the version in `package.json`
2. Update `CHANGELOG.md` — move `[Unreleased]` items to the new version with a date
3. Run `pnpm exec vsce package --no-dependencies` to verify the VSIX builds cleanly
4. Tag the commit: `git tag v0.x.y && git push --tags`

## Attribution

If your contribution draws from or adapts code in [lemonade-sdk/lemonade-vscode](https://github.com/lemonade-sdk/lemonade-vscode) or [huggingface/huggingface-vscode-chat](https://github.com/huggingface/huggingface-vscode-chat), note it in your PR description. Both projects are MIT-licensed.
