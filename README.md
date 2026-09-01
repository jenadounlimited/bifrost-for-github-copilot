# Bifrost for GitHub Copilot (Unofficial)

VS Code extension that registers a first-class language model chat provider for the Bifrost AI gateway.

**Note**: This is an **unofficial** community extension. It is not an official Maxim HQ product.

## Overview

GitHub Copilot Chat in VS Code can consume third-party models through the `LanguageModelChatProvider` API. This extension registers a first-class vendor (`bifrost`) so gateway models appear in Copilot Chat's model picker, auto-discovers them from `GET {base}/models`, streams chat completions (including Copilot Agent tool calls) to `POST {base}/chat/completions`, and stores gateway URLs plus optional virtual keys in VS Code `SecretStorage`.

This extension talks to the existing Bifrost OpenAI-compatible HTTP API. It does not embed, fork, or ship Bifrost itself.

## Installation

### From Marketplace

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X or Cmd+Shift+X)
3. Search for "Bifrost for GitHub Copilot (Unofficial)"
4. Click Install

### From Source

```bash
pnpm install
pnpm run compile
pnpm exec vsce package --no-dependencies
```

Then install the generated `.vsix` file.

## Usage

### Prerequisites

1. Install and run Bifrost:

```bash
npx -y @maximhq/bifrost
# or
docker run -p 8080:8080 maximhq/bifrost
```

2. Configure providers in the Bifrost dashboard: http://localhost:8080

### Copilot Chat Setup

1. Open Copilot Chat in VS Code
2. Click the model picker (top-right)
3. Select **Manage Models...**
4. Choose **Bifrost (Unofficial)**
5. Select a discovered model (e.g., `openai/gpt-4o-mini`)

### Managing Endpoints

1. Open Command Palette (Ctrl+Shift+P or Cmd+Shift+P)
2. Run **Manage Bifrost Provider**
3. Add/Edit/Remove gateway endpoints
4. Test connection to gateways
5. Open dashboard in browser

### Ephemeral Filter

When VS Code 1.118+ sends cache_control sentinels, they are filtered out by default. Toggle with:

- Command Palette → **Toggle Bifrost filter ephemeral data**

## Security & Privacy

### Data Handling

- Virtual keys are stored in VS Code `SecretStorage` (encrypted, never in plaintext settings)
- No prompts or completions are logged by this extension
- No additional logging beyond what Bifrost itself provides
- Logs contain only: endpoint shortname, model ID, HTTP status, duration, token estimates

### Gateway May Route to Cloud

**Important**: This extension is a connector to Bifrost, which may route requests to cloud APIs (OpenAI, Anthropic, Bedrock, etc.). Prompts may leave your machine depending on your Bifrost configuration.

This extension does **not** claim "never leaves your machine" — that depends entirely on your Bifrost provider configuration.

### HTTP Warnings

- Local Bifrost (`localhost`, `127.0.0.1`, `::1`) can use HTTP safely
- Remote HTTP gateways show a warning (insecure transport); HTTPS is recommended
- HTTP warnings are non-blocking — your configuration is preserved

### Key Rotation

To update a virtual key: open **Manage Bifrost Provider**, select the endpoint, choose **Edit**, and re-enter the key. The old value is overwritten in `SecretStorage`.

### Clearing All Data

To remove all stored endpoints and keys:

1. Open Command Palette → **Manage Bifrost Provider** → **Remove** each endpoint, or
2. Uninstall the extension — VS Code removes all `SecretStorage` entries for the extension automatically

### Timeout Behaviour

- **Chat requests**: no read timeout — long agent tool loops are supported; cancellation is via VS Code's `CancellationToken`
- **Model listing / connection test**: 10-second timeout per HTTP call
- Each request uses its own `AbortController`; controllers are never shared

## Development

### Prerequisites

- Node.js 22+
- pnpm 8.15.4+

### Setup

```bash
pnpm install
```

### Build

```bash
pnpm run compile
```

### Test

```bash
pnpm run test
```

### Lint & Format

```bash
pnpm run lint
pnpm run format
```

## Attribution

This extension is based on:

- [lemonade-sdk/lemonade-vscode](https://github.com/lemonade-sdk/lemonade-vscode) (MIT)
- [huggingface/huggingface-vscode-chat](https://github.com/huggingface/huggingface-vscode-chat) (MIT)

It implements the same pattern but adapted for Bifrost's OpenAI-compatible API.

## License

MIT - See LICENSE file for details.

## Disclaimer

**Unofficial**: This is not an official Maxim HQ product. It is a community extension that talks to the existing Bifrost OpenAI-compatible HTTP API. Maxim may adopt the repo later.
