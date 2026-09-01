// Model discovery, filtering, and mapping to VS Code LanguageModelChatInformation

import * as vscode from 'vscode';
import {
  DEFAULT_CONTEXT_LENGTH,
  DEFAULT_MAX_OUTPUT_TOKENS,
  MODELS_MAX_PAGES,
  MODELS_PAGE_SIZE,
} from './constants';
import { buildRequestHeaders, fallbackV1ModelsBase, listingAbortSignal, normalizeBaseUrl } from './auth';
import type { BifrostEndpoint, BifrostModel, FetchAllModelsResult } from './types';
import type { Logger } from './log';

/**
 * Fetch all models from a single endpoint with pagination and fallback (KD11, KD12)
 *
 * - Paginates up to MODELS_MAX_PAGES pages of MODELS_PAGE_SIZE each
 * - Falls back from /openai/v1 to /v1 on 401/403 when a virtual key is present
 * - Returns the combined model list, truncation flag, and diagnostics
 */
export async function fetchModelsForEndpoint(
  endpoint: BifrostEndpoint,
  userAgent: string,
  logger: Logger,
): Promise<FetchAllModelsResult> {
  const baseUrl = normalizeBaseUrl(endpoint.url);
  let listBase = baseUrl;
  let fallbackUsed = false;

  const models: BifrostModel[] = [];
  let page = 1;
  let truncated = false;

  while (page <= MODELS_MAX_PAGES) {
    const url = `${listBase}/models?page=${page}&size=${MODELS_PAGE_SIZE}`;
    logger.info(`Fetching models page ${page} from ${url}`, endpoint.shortname);

    const headers = buildRequestHeaders(endpoint, userAgent);
    const signal = listingAbortSignal();

    let response: Response;
    try {
      response = await fetch(url, { headers, signal });
    } catch (e) {
      logger.warn(
        `Fetch error on page ${page}: ${e instanceof Error ? e.message : String(e)}`,
        endpoint.shortname,
      );
      break;
    }

    // Fallback: try /v1 instead of /openai/v1 on auth failures (KD12)
    if ((response.status === 401 || response.status === 403) && endpoint.virtualKey && !fallbackUsed) {
      const fallback = fallbackV1ModelsBase(listBase);
      logger.warn(
        `Received ${response.status}, retrying with fallback base: ${fallback}`,
        endpoint.shortname,
      );
      listBase = fallback;
      fallbackUsed = true;
      continue;
    }

    if (!response.ok) {
      logger.warn(`Unexpected ${response.status} from ${url}`, endpoint.shortname);
      break;
    }

    const data = (await response.json()) as Record<string, unknown>;
    const pageModels = (data.data as BifrostModel[]) || [];

    if (pageModels.length === 0) {
      break;
    }

    for (const model of pageModels) {
      if (isChatModel(model)) {
        models.push(model);
      }
    }

    if (pageModels.length < MODELS_PAGE_SIZE) {
      break; // Last page
    }

    page++;
  }

  truncated = page > MODELS_MAX_PAGES;

  return { models, truncated, pages: page - 1, listBase, fallbackUsed };
}

/**
 * Determine whether a Bifrost model supports chat completions (KD10)
 *
 * - Check supported_methods for 'chat.completions'
 * - Check architecture modality for text
 * - Heuristic on model ID/name
 * - When unsure, keep the model
 */
export function isChatModel(model: BifrostModel): boolean {
  if (model.supported_methods?.includes('chat.completions')) {
    return true;
  }

  if (model.architecture?.modality) {
    const m = model.architecture.modality.join(',').toLowerCase();
    if (m.includes('text') || m.includes('chat')) {
      return true;
    }
  }

  if (model.architecture?.output_modalities) {
    const out = model.architecture.output_modalities.join(',').toLowerCase();
    if (out.includes('text')) {
      return true;
    }
  }

  // Heuristic: keep models whose ID/name suggests chat
  const idLower = model.id.toLowerCase();
  if (idLower.includes('chat') || idLower.includes('gpt') || idLower.includes('claude')) {
    return true;
  }

  // When unsure, keep (KD10)
  return true;
}

/**
 * Map a BifrostModel + endpoint shortname to a VS Code LanguageModelChatInformation object.
 *
 * - id:             `{shortname}/{bifrostModelId}` — used to route requests back to the right endpoint
 * - name:           normalized_name || name || id
 * - detail:         raw Bifrost model ID
 * - tooltip:        multi-line summary (context, created, capabilities)
 * - family:         `"bifrost"`
 * - version:        `"1.0.0"`
 * - maxInputTokens: from catalog or DEFAULT_CONTEXT_LENGTH (KD7)
 * - maxOutputTokens: from catalog or DEFAULT_MAX_OUTPUT_TOKENS (KD7)
 * - capabilities.toolCalling:  from catalog or assumed true (KD9)
 * - capabilities.imageInput:   from architecture.input_modalities (KD8)
 */
export function mapModelToChatInformation(
  model: BifrostModel,
  shortname: string,
): vscode.LanguageModelChatInformation {
  const id = `${shortname}/${model.id}`;
  const name = model.normalized_name || model.name || model.id;

  const contextLength = model.context_length || DEFAULT_CONTEXT_LENGTH;
  const maxInput = model.max_input_tokens || contextLength;
  const maxOutput = model.max_output_tokens || DEFAULT_MAX_OUTPUT_TOKENS;
  const created = model.created
    ? new Date(model.created * 1000).toLocaleDateString()
    : 'unknown';

  // Capabilities
  const hasTools =
    model.supported_parameters?.includes('tools') ||
    model.supported_methods?.includes('chat.completions') ||
    true; // assume true (KD9)

  const inputModalities = model.architecture?.input_modalities || [];
  const hasVision = inputModalities.some(m => m.includes('image') || m.includes('vision'));

  const tooltipLines = [
    `Model: ${model.id}`,
    `Context: ${maxInput.toLocaleString()} input / ${maxOutput.toLocaleString()} output tokens`,
    `Created: ${created}`,
  ];
  if (model.reasoning) {
    tooltipLines.push('Reasoning model');
  }
  if (hasTools) {
    tooltipLines.push('Tool calling: supported');
  }
  if (hasVision) {
    tooltipLines.push('Vision: supported');
  }

  return {
    id,
    name,
    detail: model.id,
    tooltip: tooltipLines.join('\n'),
    family: 'bifrost',
    version: '1.0.0',
    maxInputTokens: maxInput,
    maxOutputTokens: maxOutput,
    capabilities: {
      toolCalling: hasTools,
      imageInput: hasVision,
    },
  };
}
