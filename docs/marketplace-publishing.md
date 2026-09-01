# Marketplace Publishing — Step-by-Step Guide

This document covers everything needed to publish **Bifrost for GitHub Copilot (Unofficial)** to the VS Code Marketplace for the first time, and for all future version releases.

---

## Prerequisites

- Access to the `jenadounlimited/bifrost-for-github-copilot` GitHub repository with permission to create repository secrets and push tags
- A Microsoft account with the `JenadoUnlimited` publisher identity on the VS Code Marketplace
- The extension code is already packaged and all pre-publish checks pass (see [Pre-Publish Checklist](#pre-publish-checklist))

---

## Part 1 — One-Time Publisher Setup

These steps only need to be done once, before the very first publish.

### Step 1 — Verify the `JenadoUnlimited` publisher account

1. Go to [https://marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage)
2. Sign in with the Microsoft account associated with the `JenadoUnlimited` publisher
3. Confirm the publisher name shown is exactly **`JenadoUnlimited`** — this must match the `"publisher"` field in [`package.json`](../package.json):

   ```json
   "publisher": "JenadoUnlimited"
   ```

4. If the publisher does not exist yet:
   - Click **Create publisher**
   - Set the name to `JenadoUnlimited`
   - Complete the form and save

---

### Step 2 — Create a Personal Access Token (PAT)

The release workflow authenticates with the Marketplace using a PAT. You need to create one scoped to the `JenadoUnlimited` publisher.

1. Go to [https://dev.azure.com](https://dev.azure.com) and sign in with the same Microsoft account
2. Click your avatar (top right) → **Personal access tokens**
3. Click **New Token**
4. Fill in:
   - **Name**: `vsce-publish-bifrost` (or any memorable name)
   - **Organization**: Select **All accessible organizations**
   - **Expiration**: Choose an appropriate duration (e.g., 1 year)
   - **Scopes**: Select **Custom defined**, then find and check **Marketplace → Manage**
5. Click **Create**
6. **Copy the token immediately** — it is shown only once

> **Security note**: treat this token like a password. Do not commit it to source code or share it in chat.

---

### Step 3 — Add `VSCE_PAT` to GitHub repository secrets

The [`release.yml`](../.github/workflows/release.yml) workflow reads the token from `secrets.VSCE_PAT`. You must add it to the repository before pushing any release tag.

1. Go to the repository on GitHub: `https://github.com/jenadounlimited/bifrost-for-github-copilot`
2. Click **Settings** (top navigation bar)
3. In the left sidebar, click **Secrets and variables** → **Actions**
4. Click **New repository secret**
5. Fill in:
   - **Name**: `VSCE_PAT`
   - **Secret**: paste the PAT you copied in Step 2
6. Click **Add secret**

The secret is now available to the workflow as `${{ secrets.VSCE_PAT }}`.

---

## Part 2 — Pre-Publish Checklist

Run these checks locally before pushing a release tag. The release workflow also runs them, but catching failures locally saves time.

```bash
# 1. Install / update dependencies
pnpm install

# 2. Compile TypeScript
pnpm run compile

# 3. Lint (must report 0 errors)
pnpm run lint

# 4. Format check
pnpm run format:check

# 5. Tests (must all pass — currently 170)
pnpm run test

# 6. Package dry-run — verify VSIX builds cleanly
pnpm exec vsce package --no-dependencies
```

Verify the output of the last command:
- VSIX filename matches `bifrost-for-github-copilot-<version>.vsix`
- Package size is under 5 MB (current: ~901 KB)
- No warnings about missing fields or large files

Also confirm these fields in [`package.json`](../package.json):

| Field         | Expected value                                               |
| ------------- | ------------------------------------------------------------ |
| `name`        | `bifrost-for-github-copilot`                                 |
| `publisher`   | `JenadoUnlimited`                                            |
| `version`     | matches the tag you are about to push (e.g. `0.0.1`)        |
| `repository`  | `https://github.com/jenadounlimited/bifrost-for-github-copilot` |
| `categories`  | `["AI", "Chat"]`                                             |
| `license`     | `MIT`                                                        |

---

## Part 3 — Releasing (Every Release)

Once the one-time setup is complete, every release follows these steps.

### Step 4 — Bump the version (for releases after v0.0.1)

> Skip this step for the initial v0.0.1 release — `package.json` is already at `0.0.1`.

For subsequent releases, update the version in [`package.json`](../package.json):

```bash
# Example: patch release
npm version patch --no-git-tag-version
# or edit package.json manually, then commit:
git add package.json
git commit -m "chore: bump version to X.Y.Z"
```

---

### Step 5 — Update CHANGELOG.md

Edit [`CHANGELOG.md`](../CHANGELOG.md):

1. Change `## [0.0.1] — Unreleased` to `## [0.0.1] — YYYY-MM-DD` (today's date)
2. For future releases, add a new section above the previous one using the template at the bottom of the file
3. Commit the change:

```bash
git add CHANGELOG.md
git commit -m "chore: release v0.0.1"
```

---

### Step 6 — Push the release tag

The release workflow triggers on any tag matching `v*.*.*`. Push the tag that matches the version in `package.json`:

```bash
git tag v0.0.1
git push origin v0.0.1
```

> If you also need to push pending commits on `main` first:
>
> ```bash
> git push origin main
> git tag v0.0.1
> git push origin v0.0.1
> ```

---

### Step 7 — Monitor the release workflow

1. Go to `https://github.com/jenadounlimited/bifrost-for-github-copilot/actions`
2. Find the **Release** workflow run triggered by the tag push
3. Watch it progress through the steps:
   - Install dependencies
   - Compile TypeScript
   - Run ESLint
   - Run tests
   - Package extension (`vsce package`)
   - Upload VSIX artifact
   - Create GitHub Release
   - Publish to VS Code Marketplace

If any step fails, the workflow stops. Fix the issue, delete the tag, and re-push:

```bash
git tag -d v0.0.1          # delete local tag
git push origin :v0.0.1    # delete remote tag
# fix the issue, commit, then re-tag and re-push
git tag v0.0.1
git push origin v0.0.1
```

---

### Step 8 — Verify the GitHub Release

1. Go to `https://github.com/jenadounlimited/bifrost-for-github-copilot/releases`
2. Confirm the release `v0.0.1` was created with:
   - The `.vsix` file attached
   - Auto-generated release notes listing commits since the previous tag

---

### Step 9 — Verify the Marketplace listing

Marketplace propagation typically takes 2–10 minutes after a successful publish.

1. Go to [https://marketplace.visualstudio.com/items?itemName=JenadoUnlimited.bifrost-for-github-copilot](https://marketplace.visualstudio.com/items?itemName=JenadoUnlimited.bifrost-for-github-copilot)
2. Confirm all of the following:
   - **Display name**: `Bifrost for GitHub Copilot (Unofficial)`
   - **Publisher**: `JenadoUnlimited`
   - **Version**: `0.0.1`
   - **Icon**: extension icon present
   - **README**: rendered correctly with all sections visible
   - **Categories**: `AI`, `Chat`
   - **Repository link**: points to the correct GitHub URL

3. Install from the Marketplace in VS Code to do a final smoke test:
   - Open VS Code → Extensions → search `Bifrost for GitHub Copilot`
   - Install and activate
   - Open Copilot Chat → model picker → confirm `Bifrost (Unofficial)` appears

---

## Troubleshooting

### Workflow fails at "Publish to VS Code Marketplace"

- **`VSCE_PAT` not set or expired**: re-create the PAT (Step 2) and update the secret (Step 3)
- **Publisher mismatch**: confirm the PAT was created under the Azure DevOps organisation linked to the `JenadoUnlimited` publisher

### Workflow fails at "Create GitHub Release"

- Check that the workflow has `permissions: contents: write` — this is already set in [`release.yml`](../.github/workflows/release.yml)
- Ensure the tag does not already have a GitHub Release attached

### Extension does not appear in Marketplace search immediately

- The Marketplace index can take up to 30 minutes to update after a new extension's first publish
- The direct URL (`/items?itemName=JenadoUnlimited.bifrost-for-github-copilot`) works as soon as propagation completes

### `vsce package` fails locally

```bash
# Ensure vsce is installed
pnpm exec vsce --version

# Run with verbose output
pnpm exec vsce package --no-dependencies --out bifrost-debug.vsix
```

---

## Related Files

| File | Purpose |
| ---- | ------- |
| [`package.json`](../package.json) | Extension manifest — version, publisher, categories |
| [`.github/workflows/release.yml`](../.github/workflows/release.yml) | Tag-triggered release CI/CD pipeline |
| [`.vscodeignore`](../.vscodeignore) | Controls which files are included in the VSIX |
| [`CHANGELOG.md`](../CHANGELOG.md) | Release history — update before each tag push |
| [`docs/plans/07-release-documentation.md`](plans/07-release-documentation.md) | Master release plan with acceptance criteria |
