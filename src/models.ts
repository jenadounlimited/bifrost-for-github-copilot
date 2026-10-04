// Model discovery, filtering, and mapping to VS Code LanguageModelChatInformation

import * as vscode from 'vscode';
import {
  DEFAULT_CONTEXT_LENGTH,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_PASSTHROUGH_HYPERPARAMETERS,
  MODELS_MAX_PAGES,
  MODELS_PAGE_SIZE,
} from './constants';
import {
  buildRequestHeaders,
  fallbackV1ModelsBase,
  listingAbortSignal,
  normalizeBaseUrl,
} from './auth';
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
  const listed = await listModelPages(
    normalizeBaseUrl(endpoint.url),
    endpoint,
    userAgent,
    logger,
    true,
  );
  // `/openai/v1/models` is the OpenAI shape: id, owned_by, and `context_window`.
  // The native `/v1/models` catalog also carries max_output_tokens and top_provider
  // (the upstream window). Merge those onto the models this virtual key can see.
  let models = await enrichModelLimits(listed.models, listed.listBase, endpoint, userAgent, logger);
  models = await enrichFromUpstreamCatalog(models, endpoint, userAgent, logger);
  return { ...listed, models };
}

async function listModelPages(
  initialBase: string,
  endpoint: BifrostEndpoint,
  userAgent: string,
  logger: Logger,
  allowFallback: boolean,
): Promise<FetchAllModelsResult> {
  let listBase = initialBase;
  let fallbackUsed = false;

  const models: BifrostModel[] = [];
  let page = 1;
  let pagesFetched = 0;
  let pageToken = '';
  let truncated = false;

  while (page <= MODELS_MAX_PAGES) {
    const params = new URLSearchParams({ page_size: String(MODELS_PAGE_SIZE) });
    if (pageToken) {
      params.set('page_token', pageToken);
    }
    const url = `${listBase}/models?${params.toString()}`;
    logger.info(`Fetching models page ${page} from ${url}`, endpoint.shortname);

    const headers = buildRequestHeaders(endpoint, userAgent);
    // Ask Bifrost to attach the provider body. Lemonade's loaded window lives in
    // fields the OpenAI list converter drops (`context_length`, `recipe_options.ctx_size`).
    headers['x-bf-send-back-raw-response'] = 'true';
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
    if (
      allowFallback &&
      (response.status === 401 || response.status === 403) &&
      endpoint.virtualKey &&
      !fallbackUsed
    ) {
      const fallback = fallbackV1ModelsBase(listBase);
      if (fallback !== listBase) {
        logger.warn(
          `Received ${response.status}, retrying with fallback base: ${fallback}`,
          endpoint.shortname,
        );
        listBase = fallback;
        fallbackUsed = true;
        pageToken = '';
        continue;
      }
    }

    if (!response.ok) {
      logger.warn(`Unexpected ${response.status} from ${url}`, endpoint.shortname);
      break;
    }

    const data = (await response.json()) as Record<string, unknown>;
    pagesFetched++;
    const pageModels = mergeUpstreamContext(
      Array.isArray(data.data) ? (data.data as BifrostModel[]) : [],
      extractUpstreamModels(data),
    );

    for (const model of pageModels) {
      if (model && typeof model.id === 'string' && model.id.length > 0 && isChatModel(model)) {
        models.push(model);
      }
    }

    const next = typeof data.next_page_token === 'string' ? data.next_page_token : '';
    if (!next || pageModels.length === 0) {
      break;
    }
    if (page === MODELS_MAX_PAGES) {
      truncated = true;
      break;
    }

    pageToken = next;
    page++;
  }

  return { models, truncated, pages: pagesFetched, listBase, fallbackUsed };
}

/**
 * Native Bifrost catalog base for a list URL. Undefined when the list is already `/v1`.
 */
function nativeCatalogBase(listBase: string): string | undefined {
  try {
    const parsed = new URL(listBase);
    const path = parsed.pathname.replace(/\/+$/, '');
    if (path === '/v1') {
      return undefined;
    }
    parsed.pathname = '/v1';
    parsed.search = '';
    parsed.hash = '';
    return parsed.href.replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

async function enrichModelLimits(
  models: BifrostModel[],
  listBase: string,
  endpoint: BifrostEndpoint,
  userAgent: string,
  logger: Logger,
): Promise<BifrostModel[]> {
  if (models.length === 0) {
    return models;
  }
  const nativeBase = nativeCatalogBase(listBase);
  if (!nativeBase) {
    return models;
  }

  try {
    const rich = await listModelPages(nativeBase, endpoint, userAgent, logger, false);
    if (rich.models.length === 0) {
      return models;
    }
    return mergeLimitMetadata(models, rich.models);
  } catch (e) {
    logger.warn(
      `Could not read native model catalog: ${e instanceof Error ? e.message : String(e)}`,
      endpoint.shortname,
    );
    return models;
  }
}

function mergeLimitMetadata(models: BifrostModel[], richModels: BifrostModel[]): BifrostModel[] {
  const byId = new Map<string, BifrostModel>();
  for (const rich of richModels) {
    byId.set(rich.id.toLowerCase(), rich);
    const slash = rich.id.indexOf('/');
    if (slash !== -1 && !byId.has(rich.id.slice(slash + 1).toLowerCase())) {
      byId.set(rich.id.slice(slash + 1).toLowerCase(), rich);
    }
  }

  return models.map(model => {
    const id = model.id.toLowerCase();
    const slash = model.id.indexOf('/');
    const rich =
      byId.get(id) ??
      (slash !== -1 ? byId.get(model.id.slice(slash + 1).toLowerCase()) : undefined);
    if (!rich || rich === model) {
      return model;
    }
    return {
      ...rich,
      ...model,
      name: model.name || rich.name,
      normalized_name: model.normalized_name || rich.normalized_name,
      created: model.created ?? rich.created,
      alias: model.alias || rich.alias,
      context_length: model.context_length ?? rich.context_length,
      context_window: model.context_window ?? rich.context_window,
      max_context_window: model.max_context_window ?? rich.max_context_window,
      ctx_size: model.ctx_size ?? rich.ctx_size,
      recipe_options: model.recipe_options ?? rich.recipe_options,
      max_input_tokens: model.max_input_tokens ?? rich.max_input_tokens,
      max_output_tokens: model.max_output_tokens ?? rich.max_output_tokens,
      top_provider: model.top_provider ?? rich.top_provider,
      per_request_limits: model.per_request_limits ?? rich.per_request_limits,
      architecture: model.architecture ?? rich.architecture,
      supported_parameters: model.supported_parameters ?? rich.supported_parameters,
      supported_methods: model.supported_methods ?? rich.supported_methods,
      reasoning: model.reasoning ?? rich.reasoning,
      description: model.description || rich.description,
    };
  });
}

/**
 * Determine whether a Bifrost model supports chat completions (KD10)
 *
 * - Check supported_methods for 'chat.completions'
 * - Check architecture modality for text
 * - Heuristic on model ID/name
 * - When unsure, keep the model
 */
function modalityText(modality: string | string[] | undefined): string {
  if (!modality) {
    return '';
  }
  return (Array.isArray(modality) ? modality.join(',') : modality).toLowerCase();
}

export function isChatModel(model: BifrostModel): boolean {
  if (model.supported_methods?.includes('chat.completions')) {
    return true;
  }

  if (model.architecture?.modality) {
    const m = modalityText(model.architecture.modality);
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
 * Read a Lemonade (or other upstream) model catalog when Bifrost did not forward
 * the loaded window. The Bifrost virtual key is not sent to that host.
 */
async function enrichFromUpstreamCatalog(
  models: BifrostModel[],
  endpoint: BifrostEndpoint,
  userAgent: string,
  logger: Logger,
): Promise<BifrostModel[]> {
  const base = endpoint.upstreamModelsUrl?.trim();
  if (
    !base ||
    models.length === 0 ||
    models.every(model => loadedContextWindow(model) !== undefined)
  ) {
    return models;
  }

  const url = upstreamModelsRequestUrl(base);
  logger.info(`Fetching upstream context from ${url}`, endpoint.shortname);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': userAgent, Accept: 'application/json' },
      signal: listingAbortSignal(),
    });
    if (!response.ok) {
      logger.warn(`Upstream catalog ${url} returned ${response.status}`, endpoint.shortname);
      return models;
    }
    const payload = (await response.json()) as unknown;
    const upstream = modelRows(payload).filter(
      row => typeof row.id === 'string' && row.id.length > 0,
    );
    const merged = mergeUpstreamContext(models, upstream);
    const filled = merged.filter(model => loadedContextWindow(model) !== undefined).length;
    logger.info(
      `Upstream catalog supplied a context window for ${filled} model(s)`,
      endpoint.shortname,
    );
    return merged;
  } catch (e) {
    logger.warn(
      `Could not read upstream catalog ${url}: ${e instanceof Error ? e.message : String(e)}`,
      endpoint.shortname,
    );
    return models;
  }
}

function upstreamModelsRequestUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, '');
  if (trimmed.toLowerCase().endsWith('/models')) {
    return trimmed;
  }
  return `${trimmed}/models`;
}

/**
 * Pull provider model rows out of a Bifrost list payload, including
 * `extra_fields.raw_response` when the gateway attaches the upstream body.
 */
function extractUpstreamModels(payload: unknown): BifrostModel[] {
  const bodies: unknown[] = [];
  if (payload && typeof payload === 'object' && 'extra_fields' in payload) {
    const raw = (payload as { extra_fields?: { raw_response?: unknown } }).extra_fields
      ?.raw_response;
    if (typeof raw === 'string') {
      try {
        bodies.push(JSON.parse(raw) as unknown);
      } catch {
        // Not JSON. The typed catalog rows are still used.
      }
    } else if (raw !== undefined && raw !== null) {
      bodies.push(raw);
    }
  }
  return bodies
    .flatMap(body => modelRows(body))
    .filter(row => typeof row.id === 'string' && row.id.length > 0);
}

function modelRows(payload: unknown): BifrostModel[] {
  if (Array.isArray(payload)) {
    return payload as BifrostModel[];
  }
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const record = payload as { data?: unknown; models?: unknown };
  if (Array.isArray(record.data)) {
    return record.data as BifrostModel[];
  }
  if (Array.isArray(record.models)) {
    return record.models as BifrostModel[];
  }
  return [];
}

/**
 * Copy loaded-context fields onto Bifrost rows.
 * Match the full id, the id after the provider slash, or Bifrost's alias
 * (`Lemonade/Qwen3` → `Qwen3.8-27B-GGUF-UD-Q4_K_XL`).
 * When both sides advertise a window, the smaller one is kept.
 */
export function mergeUpstreamContext(
  models: BifrostModel[],
  upstreamModels: BifrostModel[],
): BifrostModel[] {
  if (upstreamModels.length === 0) {
    return models;
  }
  return models.map(model => {
    const match = upstreamModels.find(upstream => sameUpstreamModel(model, upstream));
    if (!match || match === model) {
      return model;
    }
    return {
      ...model,
      alias: model.alias || match.alias,
      context_length: smallerToken(model.context_length, match.context_length),
      context_window: smallerToken(model.context_window, match.context_window),
      max_context_window: smallerToken(model.max_context_window, match.max_context_window),
      ctx_size: model.ctx_size ?? match.ctx_size,
      recipe_options: model.recipe_options ?? match.recipe_options,
      max_input_tokens: model.max_input_tokens ?? match.max_input_tokens,
      max_output_tokens: model.max_output_tokens ?? match.max_output_tokens,
      top_provider: model.top_provider ?? match.top_provider,
      per_request_limits: model.per_request_limits ?? match.per_request_limits,
    };
  });
}

function sameUpstreamModel(model: BifrostModel, upstream: BifrostModel): boolean {
  const keys = new Set<string>();
  const add = (value: string | undefined) => {
    if (value && value.trim()) {
      keys.add(value.trim().toLowerCase());
    }
  };
  add(model.id);
  add(model.alias);
  const slash = model.id.indexOf('/');
  if (slash !== -1) {
    add(model.id.slice(slash + 1));
  }
  return (
    keys.has(upstream.id.trim().toLowerCase()) ||
    (!!upstream.alias && keys.has(upstream.alias.trim().toLowerCase()))
  );
}

/**
 * Token budgets reported to VS Code.
 *
 * The Manage Language Models dialog shows a single Context Size equal to
 * `maxInputTokens + maxOutputTokens`. `contextWindow` is that sum.
 */
export interface ResolvedChatTokenLimits {
  contextWindow: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  /** True when a catalog or upstream field supplied the loaded window. */
  fromUpstream: boolean;
}

/**
 * Resolve the context window VS Code should display for a catalog row.
 *
 * Sources, in order:
 * 1. The loaded window: Bifrost `context_length`, OpenAI-compat `context_window`,
 *    `top_provider.context_length`, and Lemonade `recipe_options.ctx_size` / `ctx_size`.
 *    The smallest positive value is the limit a request will actually hit.
 *    `max_context_window` is the architecture ceiling and only shrinks that window.
 * 2. Explicit `max_input_tokens` / `max_output_tokens` (and per-request caps) when
 *    no window was advertised. Their sum is the context size the dialog shows.
 * 3. A model-id heuristic, then the KD7 defaults (128k context, 16k output).
 *
 * When a window is known, output is capped inside it and input is the remainder,
 * so the dialog's sum equals the real window instead of window + output.
 */
export function resolveChatTokenLimits(model: BifrostModel): ResolvedChatTokenLimits {
  const contextWindow = loadedContextWindow(model);

  const explicitOutput = smallestPositive([
    model.max_output_tokens,
    model.top_provider?.max_completion_tokens,
    model.per_request_limits?.completion_tokens,
  ]);

  const explicitInput =
    positiveInt(model.max_input_tokens) ?? positiveInt(model.per_request_limits?.prompt_tokens);

  if (contextWindow !== undefined) {
    const maxOutput = fitOutput(
      explicitOutput ?? inferOutputTokens(model.id),
      contextWindow,
      explicitOutput !== undefined,
    );
    return {
      contextWindow,
      maxOutputTokens: maxOutput,
      maxInputTokens: contextWindow - maxOutput,
      fromUpstream: true,
    };
  }

  if (explicitInput !== undefined && explicitOutput !== undefined) {
    return {
      contextWindow: explicitInput + explicitOutput,
      maxInputTokens: explicitInput,
      maxOutputTokens: explicitOutput,
      fromUpstream: false,
    };
  }

  if (explicitInput !== undefined) {
    const maxOutput = capOutput(inferOutputTokens(model.id), explicitInput);
    return {
      contextWindow: explicitInput,
      maxOutputTokens: maxOutput,
      maxInputTokens: explicitInput - maxOutput,
      fromUpstream: false,
    };
  }

  const inferredWindow = inferContextLength(model.id);
  const maxOutput = capOutput(explicitOutput ?? inferOutputTokens(model.id), inferredWindow);
  return {
    contextWindow: inferredWindow,
    maxOutputTokens: maxOutput,
    maxInputTokens: inferredWindow - maxOutput,
    fromUpstream: false,
  };
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
 * - maxInputTokens / maxOutputTokens: see {@link resolveChatTokenLimits}. Their sum is the
 *   context size shown in the language models dialog.
 * - capabilities.toolCalling:  from catalog or assumed true (KD9)
 * - capabilities.imageInput:   from architecture.input_modalities (KD8)
 *
 * A loaded upstream window is a hard ceiling: a hand-entered limit can tighten it
 * but cannot raise it, and while passthrough is on the loaded window is what the
 * dialog shows. With no loaded window, a hand-entered limit
 * (`source: 'manual'`, or a limit saved before `source` existed) is the fallback.
 * A stored `source: 'catalog'` snapshot is ignored. An endpoint `maxOutputTokens`
 * cap shrinks output and gives the difference back to input. Passthrough skips that cap.
 */
export function mapModelToChatInformation(
  model: BifrostModel,
  shortname: string,
  endpoint?: BifrostEndpoint,
): vscode.LanguageModelChatInformation {
  const id = `${shortname}/${model.id}`;
  const name = model.normalized_name || model.name || model.id;
  const created = model.created ? new Date(model.created * 1000).toLocaleDateString() : 'unknown';

  const resolved = resolveChatTokenLimits(model);
  const usePassthrough =
    endpoint?.passthroughHyperparameters ?? DEFAULT_PASSTHROUGH_HYPERPARAMETERS;
  const { maxInputTokens, maxOutputTokens } = applyLimitOverrides(
    resolved,
    model.id,
    endpoint,
    usePassthrough,
  );

  // Capabilities
  const hasTools =
    model.supported_parameters?.includes('tools') ||
    model.supported_methods?.includes('chat.completions') ||
    true; // assume true (KD9)

  const inputModalities = model.architecture?.input_modalities || [];
  const hasVision = inputModalities.some(m => m.includes('image') || m.includes('vision'));

  const contextWindow = maxInputTokens + maxOutputTokens;
  const tooltipLines = [
    `Model: ${model.id}`,
    `Context window: ${contextWindow.toLocaleString()} tokens`,
    `Input budget: ${maxInputTokens.toLocaleString()}`,
    `Output budget: ${maxOutputTokens.toLocaleString()}`,
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
  if (usePassthrough) {
    tooltipLines.push(
      resolved.fromUpstream
        ? 'Passthrough: enabled (loaded upstream window, endpoint output cap skipped)'
        : 'Passthrough: enabled (endpoint output cap skipped)',
    );
  } else {
    tooltipLines.push('Passthrough: disabled (endpoint output cap active)');
  }

  return {
    id,
    name,
    detail: model.id,
    tooltip: tooltipLines.join('\n'),
    family: 'bifrost',
    version: '1.0.0',
    maxInputTokens,
    maxOutputTokens,
    capabilities: {
      toolCalling: hasTools,
      imageInput: hasVision,
    },
  };
}

function applyLimitOverrides(
  resolved: ResolvedChatTokenLimits,
  modelId: string,
  endpoint: BifrostEndpoint | undefined,
  usePassthrough: boolean,
): { maxInputTokens: number; maxOutputTokens: number } {
  if (!endpoint) {
    return { maxInputTokens: resolved.maxInputTokens, maxOutputTokens: resolved.maxOutputTokens };
  }

  const manual = endpoint.modelTokenLimits?.find(
    limit => sameModelId(limit.modelId, modelId) && limit.source !== 'catalog',
  );
  const manualHasValue =
    !!manual && (manual.maxInputTokens !== undefined || manual.maxOutputTokens !== undefined);

  // Passthrough means the loaded upstream window is authoritative. A saved manual
  // number is only the fallback for when Bifrost and the upstream catalog omit one.
  if (usePassthrough && resolved.fromUpstream) {
    return { maxInputTokens: resolved.maxInputTokens, maxOutputTokens: resolved.maxOutputTokens };
  }

  if (manual && manualHasValue) {
    let maxOutputTokens = positiveInt(manual.maxOutputTokens) ?? resolved.maxOutputTokens;
    let maxInputTokens = positiveInt(manual.maxInputTokens) ?? resolved.maxInputTokens;
    if (resolved.fromUpstream) {
      maxOutputTokens = capOutput(maxOutputTokens, resolved.contextWindow);
      maxInputTokens = Math.min(maxInputTokens, resolved.contextWindow - maxOutputTokens);
      maxInputTokens = Math.max(1, maxInputTokens);
    }
    return { maxInputTokens, maxOutputTokens };
  }

  if (usePassthrough) {
    return { maxInputTokens: resolved.maxInputTokens, maxOutputTokens: resolved.maxOutputTokens };
  }

  const endpointOutput = positiveInt(endpoint.maxOutputTokens);
  if (endpointOutput !== undefined && endpointOutput < resolved.contextWindow) {
    const maxOutputTokens = endpointOutput;
    return { maxInputTokens: resolved.contextWindow - maxOutputTokens, maxOutputTokens };
  }

  return { maxInputTokens: resolved.maxInputTokens, maxOutputTokens: resolved.maxOutputTokens };
}

function sameModelId(saved: string, live: string): boolean {
  return saved.trim().toLowerCase() === live.trim().toLowerCase();
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return undefined;
  }
  return Math.floor(value);
}

/** Accept a token count, or a numeric string. `"auto"` and other text are ignored. */
function numericToken(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    return positiveInt(Number(trimmed));
  }
  return positiveInt(value);
}

function smallestPositive(values: unknown[]): number | undefined {
  let smallest: number | undefined;
  for (const value of values) {
    const parsed = numericToken(value);
    if (parsed === undefined) {
      continue;
    }
    if (smallest === undefined || parsed < smallest) {
      smallest = parsed;
    }
  }
  return smallest;
}

function smallerToken(left: unknown, right: unknown): number | undefined {
  return smallestPositive([left, right]);
}

/**
 * Loaded window a request will hit. `max_context_window` is the architecture
 * ceiling and is not used when no loaded size was advertised.
 */
function loadedContextWindow(model: BifrostModel): number | undefined {
  const loaded = smallestPositive([
    model.context_length,
    model.top_provider?.context_length,
    model.context_window,
    model.ctx_size,
    model.recipe_options?.ctx_size,
  ]);
  const architecture = positiveInt(model.max_context_window);
  if (loaded !== undefined && architecture !== undefined && architecture < loaded) {
    return architecture;
  }
  return loaded;
}

function capOutput(output: number, contextWindow: number): number {
  if (contextWindow <= 1) {
    return 1;
  }
  return Math.max(1, Math.min(Math.floor(output), contextWindow - 1));
}

/**
 * Keep an inferred output reserve from consuming the whole loaded window.
 * An explicit upstream output budget is only capped so it still fits.
 */
function fitOutput(output: number, contextWindow: number, explicit: boolean): number {
  const capped = capOutput(output, contextWindow);
  if (explicit) {
    return capped;
  }
  const minInput = Math.floor(contextWindow / 2);
  if (contextWindow - capped < minInput) {
    return capOutput(Math.floor(contextWindow / 2), contextWindow);
  }
  return capped;
}

/**
 * Context window encoded in a model id, such as `llama-3.1-128k` or `mistral-32k`.
 */
function inferContextFromId(modelId: string): number | undefined {
  const match = modelId.toLowerCase().match(/(?:^|[^0-9])(\d+)\s*k(?:[^a-z]|$)/);
  if (!match) {
    return undefined;
  }
  const tokens = Number(match[1]) * 1000;
  if (tokens < 1000 || tokens > 10_000_000) {
    return undefined;
  }
  return tokens;
}

/**
 * Fallback context window when the catalog and the upstream both omit one.
 */
function inferContextLength(modelId: string): number {
  const fromId = inferContextFromId(modelId);
  if (fromId !== undefined) {
    return fromId;
  }

  const idLower = modelId.toLowerCase();

  if (idLower.includes('gpt-4.1') || idLower.includes('gpt-4-1')) {
    return 1_047_576;
  }
  if (idLower.includes('gpt-4o')) {
    return 128_000;
  }
  if (
    idLower.includes('gpt-4-turbo') ||
    idLower.includes('gpt-4-1106') ||
    idLower.includes('gpt-4-0125')
  ) {
    return 128_000;
  }
  if (idLower.includes('gpt-4')) {
    return 32_000;
  }
  if (
    idLower.includes('claude-3-5') ||
    idLower.includes('claude-3.') ||
    idLower.includes('claude-3-')
  ) {
    return 200_000;
  }
  if (
    idLower.includes('claude-sonnet-4') ||
    idLower.includes('claude-opus-4') ||
    idLower.includes('claude-haiku-4')
  ) {
    return 200_000;
  }
  if (idLower.includes('claude-2')) {
    return 100_000;
  }
  if (idLower.includes('llama')) {
    return 128_000;
  }

  return DEFAULT_CONTEXT_LENGTH;
}

/**
 * Fallback max output when the catalog and the upstream both omit one.
 */
function inferOutputTokens(modelId: string): number {
  const idLower = modelId.toLowerCase();

  if (idLower.includes('gpt-4.1') || idLower.includes('gpt-4-1')) {
    return 32_768;
  }
  if (idLower.includes('gpt-4o')) {
    return 16_384;
  }
  if (
    idLower.includes('gpt-4-turbo') ||
    idLower.includes('gpt-4-1106') ||
    idLower.includes('gpt-4-0125')
  ) {
    return 4096;
  }
  if (idLower.includes('gpt-4')) {
    return 8192;
  }
  if (idLower.includes('gpt-3.5') || idLower.includes('gpt-35')) {
    return 4096;
  }
  if (idLower.includes('claude')) {
    return 8192;
  }

  return DEFAULT_MAX_OUTPUT_TOKENS;
}
