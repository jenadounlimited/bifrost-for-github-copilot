// MCP server registration for configured Bifrost endpoints

import * as vscode from 'vscode';
import { buildRequestHeaders, dashboardUrl } from './auth';
import type { Logger } from './log';
import type { BifrostEndpoint } from './types';

/** Manifest id — must match contributes.mcpServerDefinitionProviders[].id in package.json */
const MCP_PROVIDER_ID = 'bifrost.mcp';

/**
 * VS Code MCP server definition provider for Bifrost endpoints.
 *
 * Implements McpServerDefinitionProvider<McpHttpServerDefinition>:
 * - provideMcpServerDefinitions() returns one McpHttpServerDefinition per endpoint
 * - refresh() fires onDidChangeMcpServerDefinitions so VS Code re-queries definitions
 *
 * Register once via vscode.lm.registerMcpServerDefinitionProvider; call
 * refresh() whenever the endpoint list changes.
 */
export class BifrostMcpProvider implements vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition> {
  private _endpoints: BifrostEndpoint[] = [];
  private readonly _emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeMcpServerDefinitions = this._emitter.event;

  constructor(
    private readonly _userAgent: string,
    private readonly _logger: Logger,
  ) {}

  /** Replace the current endpoint list and signal VS Code to re-query. */
  refresh(endpoints: BifrostEndpoint[]): void {
    this._endpoints = endpoints;
    this._emitter.fire();
  }

  provideMcpServerDefinitions(
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.McpHttpServerDefinition[]> {
    return this._endpoints.map(endpoint => {
      const origin = dashboardUrl(endpoint.url);
      const mcpUrl = `${origin}/mcp`;
      this._logger.info(`Providing MCP server definition at ${mcpUrl}`, endpoint.shortname);

      return new vscode.McpHttpServerDefinition(
        `Bifrost (${endpoint.shortname})`,
        vscode.Uri.parse(mcpUrl),
        buildRequestHeaders(endpoint, this._userAgent),
      );
    });
  }
}

/**
 * Register the BifrostMcpProvider with VS Code.
 * Returns both the provider (for calling refresh()) and its registration disposable.
 */
export function registerMcpProvider(
  userAgent: string,
  logger: Logger,
): { provider: BifrostMcpProvider; disposable: vscode.Disposable } {
  const provider = new BifrostMcpProvider(userAgent, logger);
  try {
    const disposable = vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, provider);
    return { provider, disposable };
  } catch (err) {
    logger.warn(
      `Failed to register MCP server definition provider: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { provider, disposable: { dispose: () => {} } };
  }
}
