// LanguageModelChatProvider implementation

import * as vscode from 'vscode';
import { buildRequestHeaders, normalizeBaseUrl } from './auth';
import {
  ENDPOINTS_SECRET_KEY,
  EPHEMERAL_FILTER_SECRET_KEY,
  MAX_TOOLS_PER_REQUEST,
} from './constants';
import { Logger } from './log';
import { fetchModelsForEndpoint, mapModelToChatInformation } from './models';
import { SseChatParser } from './stream';
import { checkTokenLimit, convertMessages, convertTools, estimateTokenCount } from './utils';

import type { BifrostEndpoint } from './types';

/**
 * LanguageModelChatProvider for Bifrost
 * Implements VS Code LanguageModelChatProvider interface (VS Code 1.104+)
 *
 * Design notes:
 * - Never caches model information — fetches fresh from SecretStorage on each call
 * - Fires onDidChangeLanguageModelChatInformation when limits are updated
 * - Uses default endpoint if none stored (KD3)
 */
export class BifrostChatProvider implements vscode.LanguageModelChatProvider {
  private _secrets: vscode.SecretStorage;
  private _outputChannel: vscode.OutputChannel;
  private _userAgent: string;
  private _logger: Logger;
  private _filterEphemeral: boolean = true;
  private _onDidChangeLanguageModelChatInformation: vscode.EventEmitter<void> =
    new vscode.EventEmitter<void>();

  constructor(
    secrets: vscode.SecretStorage,
    outputChannel: vscode.OutputChannel,
    userAgent: string,
    logger: Logger,
  ) {
    this._secrets = secrets;
    this._outputChannel = outputChannel;
    this._userAgent = userAgent;
    this._logger = logger;
  }

  // ─── Public surface ───────────────────────────────────────────────────────

  /**
   * Entry point for the "Manage Bifrost Provider" command.
   * Delegates to the manage module (full UI implemented in a later plan).
   */
  public async manageEndpoints(): Promise<void> {
    this._logger.info('Endpoint management not yet implemented');
  }

  /**
   * Toggle filtering of ephemeral cache_control sentinel parts (VS Code 1.118+).
   */
  public setEphemeralFilter(enabled: boolean): void {
    this._filterEphemeral = enabled;
  }

  /**
   * Fire event to notify VS Code that language model information has changed.
   */
  public fireLanguageModelChangeEvent(): void {
    this._onDidChangeLanguageModelChatInformation.fire();
  }

  // ─── VS Code LanguageModelChatProvider interface ──────────────────────────

  get onDidChangeLanguageModelChatInformation(): vscode.Event<void> {
    return this._onDidChangeLanguageModelChatInformation.event;
  }

  /**
   * Return the list of available language models.
   * Called by VS Code on model picker open or when onDidChangeLanguageModelChatInformation fires.
   */
  public async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const endpoints = await this.getEndpoints();
    const infos: vscode.LanguageModelChatInformation[] = [];

    for (const endpoint of endpoints) {
      try {
        const result = await fetchModelsForEndpoint(endpoint, this._userAgent, this._logger);
        for (const model of result.models) {
          infos.push(mapModelToChatInformation(model, endpoint.shortname, endpoint));
        }
      } catch (e) {
        this._logger.warn(
          `Failed to list models: ${e instanceof Error ? e.message : String(e)}`,
          endpoint.shortname,
        );
      }
    }

    return infos;
  }

  /**
   * Stream a chat completion response.
   * Results are pushed to the progress callback as they arrive.
   */
  public async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const modelId = model.id; // `{shortname}/{bifrostModelId}`

    const slashIdx = modelId.indexOf('/');
    const shortname = slashIdx !== -1 ? modelId.slice(0, slashIdx) : 'default';
    const bifrostModelId = slashIdx !== -1 ? modelId.slice(slashIdx + 1) : modelId;

    const endpoints = await this.getEndpoints();
    const endpoint = endpoints.find(e => e.shortname === shortname);
    if (!endpoint) {
      throw new Error(
        `No Bifrost endpoint configured for model "${modelId}". Run "Manage Bifrost Provider" to add one.`,
      );
    }

    // Convert VS Code messages → OpenAI format
    const openaiMessages = convertMessages(messages, this._filterEphemeral);

    // Convert tools
    const openaiTools = options.tools ? convertTools(options.tools) : undefined;

    // Guard: reject requests that exceed the input budget advertised for this model.
    if (checkTokenLimit(openaiMessages, openaiTools, model.maxInputTokens)) {
      throw new Error('Request exceeds maximum input token limit');
    }

    // Passthrough keeps the upstream output budget: do not apply the endpoint-wide
    // cap and do not invent a fallback. Otherwise endpoint cap > manual > advertised.
    // The advertised budget already fits inside the loaded window, so prompt + max_tokens
    // cannot exceed the window VS Code was told about.
    const manualOutput = getModelTokenLimit(endpoint, bifrostModelId, 'maxOutputTokens');
    const advertisedOutput =
      typeof model.maxOutputTokens === 'number' && model.maxOutputTokens > 0
        ? Math.floor(model.maxOutputTokens)
        : undefined;
    const selected = endpoint.passthroughHyperparameters
      ? (advertisedOutput ?? manualOutput)
      : (endpoint.maxOutputTokens ?? manualOutput ?? advertisedOutput ?? 4096);
    // Never ask the upstream for more completion tokens than the budget advertised
    // to VS Code. That budget already fits inside the loaded window.
    const maxTokens =
      selected !== undefined && advertisedOutput !== undefined
        ? Math.min(selected, advertisedOutput)
        : selected;

    // Build request body
    const requestBody: Record<string, unknown> = {
      model: bifrostModelId,
      messages: openaiMessages,
      stream: true,
    };
    if (maxTokens !== undefined) {
      requestBody.max_tokens = maxTokens;
    }

    // Guard: too many tools
    if (options.tools && options.tools.length > MAX_TOOLS_PER_REQUEST) {
      throw new Error(
        `Too many tools: ${options.tools.length} exceeds maximum of ${MAX_TOOLS_PER_REQUEST}`,
      );
    }

    if (openaiTools) {
      requestBody.tools = openaiTools;
      if (options.tools && options.toolMode === vscode.LanguageModelChatToolMode.Required) {
        requestBody.tool_choice = 'any';
      }
    }

    const headers = buildRequestHeaders(endpoint, this._userAgent);
    headers['Content-Type'] = 'application/json';

    const baseUrl = normalizeBaseUrl(endpoint.url);
    const url = `${baseUrl}/chat/completions`;

    this._logger.info(`POST ${url}`, endpoint.shortname);

    const abortController = new AbortController();
    const parser = new SseChatParser();
    token.onCancellationRequested(() => {
      parser.abort();
      abortController.abort();
    });

    // Per-endpoint request timeout (0 or undefined = no timeout)
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (endpoint.requestTimeoutMs) {
      timeoutHandle = setTimeout(() => {
        parser.abort();
        abortController.abort(new Error('Request timed out'));
      }, endpoint.requestTimeoutMs);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: abortController.signal,
      });
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        throw new Error('Request cancelled');
      }
      throw new Error(`Network error: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status}: ${body}`);
    }

    // Stream SSE chunks → progress
    try {
      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            parser.processChunk(decoder.decode(value, { stream: true }), progress);
          }
        } finally {
          reader.releaseLock();
        }
      }
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Estimate token count for a message or plain string.
   * Uses a chars/4 heuristic — no tokenizer dependency.
   */
  public async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    if (typeof text === 'string') {
      return Math.ceil(text.length / 4);
    }
    const openaiMessages = convertMessages([text], this._filterEphemeral);
    return estimateTokenCount(openaiMessages, undefined);
  }

  // ─── SecretStorage helpers ────────────────────────────────────────────────

  /**
   * Read stored endpoints. Returns empty array if none configured (KD3).
   */
  public async getEndpoints(): Promise<BifrostEndpoint[]> {
    const stored = await this._secrets.get(ENDPOINTS_SECRET_KEY);
    if (!stored) {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(stored);
      return Array.isArray(parsed) ? (parsed as BifrostEndpoint[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * Persist endpoints to SecretStorage.
   */
  public async setEndpoints(endpoints: BifrostEndpoint[]): Promise<void> {
    await this._secrets.store(ENDPOINTS_SECRET_KEY, JSON.stringify(endpoints));
  }

  /**
   * Suppress unused field warning — outputChannel is available for future use.
   */
  public getOutputChannel(): vscode.OutputChannel {
    return this._outputChannel;
  }
}

// Exported for use from extension.ts ephemeral toggle command
export { EPHEMERAL_FILTER_SECRET_KEY };

/**
 * Get model-specific token limit from endpoint configuration
 * @param endpoint - The Bifrost endpoint configuration
 * @param modelId - The model ID to look up
 * @param limitType - 'maxInputTokens' or 'maxOutputTokens'
 * @returns The token limit value, or undefined if not configured
 */
function getModelTokenLimit(
  endpoint: BifrostEndpoint,
  modelId: string,
  limitType: 'maxInputTokens' | 'maxOutputTokens',
): number | undefined {
  if (!endpoint.modelTokenLimits) {
    return undefined;
  }

  const limit = endpoint.modelTokenLimits.find(
    l => l.modelId.trim().toLowerCase() === modelId.trim().toLowerCase(),
  );
  // 'catalog' entries are a snapshot of a previous refresh. Live detection wins.
  // Missing source is a hand-entered limit from before the source field existed.
  if (!limit || limit.source === 'catalog') {
    return undefined;
  }

  return limitType === 'maxInputTokens' ? limit.maxInputTokens : limit.maxOutputTokens;
}
