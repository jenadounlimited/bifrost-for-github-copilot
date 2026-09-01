// Extension entry point - activation and deactivation

import * as vscode from 'vscode';
import { VENDOR_ID } from './constants';
import { Logger } from './log';
import { showManageEndpointsUI, toggleEphemeralFilter } from './manage';
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

  // Register manage command — opens the full management UI
  context.subscriptions.push(
    vscode.commands.registerCommand('bifrost.manage', async () => {
      await showManageEndpointsUI(
        context.secrets,
        provider,
        async () => {
          // Provider reads endpoints fresh from SecretStorage on each request — nothing to do here.
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
