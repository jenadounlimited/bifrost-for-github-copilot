// Extension entry point - activation and deactivation

import * as vscode from 'vscode';
import { VENDOR_ID } from './constants';
import { Logger } from './log';
import { loadEndpoints, showManageEndpointsUI, toggleEphemeralFilter } from './manage';
import { registerMcpServersForEndpoints } from './mcp';
import { BifrostChatProvider, EPHEMERAL_FILTER_SECRET_KEY } from './provider';

/**
 * Activate the extension
 */
export function activate(context: vscode.ExtensionContext): void {
  // Build User-Agent: bifrost-for-github-copilot/{ver} VSCode/{ver}
  const extension = vscode.extensions.getExtension(`${VENDOR_ID}.bifrost-for-github-copilot`);
  const extVersion = extension?.packageJSON?.version || '0.0.0';
  const userAgent = `bifrost-for-github-copilot/${extVersion} VSCode/${vscode.version}`;

  const logger = new Logger('Bifrost');
  const outputChannel = vscode.window.createOutputChannel('Bifrost Chat');
  context.subscriptions.push(outputChannel);

  const provider = new BifrostChatProvider(context.secrets, outputChannel, userAgent, logger);

  // Register provider with VS Code LM API
  const providerSubscription = vscode.lm.registerLanguageModelChatProvider(VENDOR_ID, provider);
  context.subscriptions.push(providerSubscription);

  // Track live MCP registrations so they can be replaced on endpoint changes (KD-M4)
  let mcpRegistrations: vscode.Disposable[] = [];

  const refreshMcpServers = async () => {
    mcpRegistrations.forEach(d => d.dispose());
    const endpoints = await loadEndpoints(context.secrets);
    mcpRegistrations = registerMcpServersForEndpoints(endpoints, userAgent, logger);
    // Push new registrations so VS Code disposes them on deactivation
    mcpRegistrations.forEach(d => context.subscriptions.push(d));
  };

  // Initial registration on activation
  void refreshMcpServers();

  // Register manage command — opens the full management UI
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

  // Register ephemeral filter toggle command
  context.subscriptions.push(
    vscode.commands.registerCommand('bifrost.toggleEphemeralFilter', async () => {
      await toggleEphemeralFilter(context.secrets, provider);
      // Also persist the initial state so provider reads it on next activation
      const current = await context.secrets.get(EPHEMERAL_FILTER_SECRET_KEY);
      logger.info(`Ephemeral filter is now ${current === 'false' ? 'disabled' : 'enabled'}`);
    }),
  );

  logger.info(`Bifrost extension activated (v${extVersion})`);
}

/**
 * Deactivate the extension
 */
export function deactivate(): void {
  // VS Code disposes subscriptions automatically
}
