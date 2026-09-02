// MCP server registration for configured Bifrost endpoints

import * as vscode from 'vscode';
import { buildRequestHeaders, dashboardUrl } from './auth';
import type { BifrostEndpoint } from './types';
import type { Logger } from './log';

/**
 * Register one VS Code MCP server per Bifrost endpoint.
 * Returns the disposables — caller must push them onto context.subscriptions
 * or track them for re-registration on endpoint changes.
 *
 * Fails silently per endpoint (logs a warning, skips) if
 * vscode.lm.registerMcpServer is unavailable or throws.
 */
export function registerMcpServersForEndpoints(
  endpoints: BifrostEndpoint[],
  userAgent: string,
  logger: Logger,
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  for (const endpoint of endpoints) {
    const origin = dashboardUrl(endpoint.url);
    const mcpUrl = `${origin}/mcp`;

    try {
      const disposable = vscode.lm.registerMcpServer({
        name: `Bifrost (${endpoint.shortname})`,
        transport: {
          type: 'http',
          url: vscode.Uri.parse(mcpUrl),
          headers: buildRequestHeaders(endpoint, userAgent),
        },
      });
      logger.info(`Registered MCP server at ${mcpUrl}`, endpoint.shortname);
      disposables.push(disposable);
    } catch (err) {
      logger.warn(
        `Failed to register MCP server at ${mcpUrl}: ${err instanceof Error ? err.message : String(err)}`,
        endpoint.shortname,
      );
    }
  }

  return disposables;
}
