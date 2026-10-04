// Type definitions for Bifrost and OpenAI-compatible APIs

/**
 * Authentication mode for Bifrost endpoints
 */
export type BifrostAuthMode = 'auto' | 'bearer' | 'x-bf-vk' | 'both';

/**
 * Model-specific token limits configuration
 */
export interface ModelTokenLimits {
  modelId: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  /** Source of the limit: 'catalog' (from Bifrost API), 'manual' (user-set), or 'default' */
  source?: 'catalog' | 'manual' | 'default';
}

/**
 * Bifrost endpoint configuration
 */
export interface BifrostEndpoint {
  shortname: string;
  url: string;
  virtualKey?: string;
  authMode?: BifrostAuthMode;
  /** Per-endpoint request timeout in milliseconds. Overrides DEFAULT_REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
  /** Per-endpoint max output tokens override. Overrides model catalog value. */
  maxOutputTokens?: number;
  /** Model-specific token limits. When null/undefined, uses model catalog defaults. */
  modelTokenLimits?: ModelTokenLimits[];
  /** Enable passthrough hyperparameters to let target models set their own defaults */
  passthroughHyperparameters?: boolean;
  /**
   * Upstream model-catalog base, such as a Lemonade `/v1` URL.
   * Used when Bifrost's list response omits the loaded context window.
   * The plugin reads `/models` there and does not send the Bifrost virtual key.
   */
  upstreamModelsUrl?: string;
}

/**
 * Bifrost model architecture with modality fields.
 * `modality` is a string in the Bifrost catalog (`text->text`) and an array on some upstreams.
 */
export interface BifrostModelArchitecture {
  modality?: string | string[];
  input_modalities?: string[];
  output_modalities?: string[];
}

/**
 * Upstream provider limits nested on a Bifrost or OpenRouter-style catalog row.
 * When this is smaller than the top-level window, it is the limit the request will actually hit.
 */
export interface BifrostTopProvider {
  is_moderated?: boolean;
  context_length?: number;
  max_completion_tokens?: number;
}

/**
 * Per-request token caps advertised by the catalog.
 */
export interface BifrostPerRequestLimits {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/**
 * Lemonade load options. `ctx_size` is the window the model was actually loaded with.
 * It may be a number or the string `"auto"` before a load resolves it.
 */
export interface BifrostRecipeOptions {
  ctx_size?: number | string;
}

/**
 * Bifrost model catalog entry.
 *
 * `GET /v1/models` returns the fields below. `GET /openai/v1/models` keeps the OpenAI shape
 * and puts the window in `context_window` (Groq and other upstreams use that name too).
 */
export interface BifrostModel {
  id: string;
  name: string;
  normalized_name?: string;
  created?: number;

  /** Bifrost key alias. For Lemonade this is the upstream model id the request is loaded as. */
  alias?: string;

  // Context. Any one of these may be present depending on which list endpoint answered.
  context_length?: number;
  /** OpenAI-compatible / Groq field. Bifrost copies `context_length` here on `/openai/v1/models`. */
  context_window?: number;
  /**
   * Architecture maximum from Lemonade. This is not the loaded window.
   * A request fails at `context_length` / `recipe_options.ctx_size` when that is smaller.
   */
  max_context_window?: number;
  /** Loaded context size when a catalog puts it on the model instead of `recipe_options`. */
  ctx_size?: number | string;
  recipe_options?: BifrostRecipeOptions;
  max_input_tokens?: number;
  max_output_tokens?: number;
  top_provider?: BifrostTopProvider;
  per_request_limits?: BifrostPerRequestLimits;

  // Architecture
  architecture?: BifrostModelArchitecture;
  supported_parameters?: string[];
  supported_methods?: string[];

  // Additional
  description?: string;
  reasoning?: boolean | { mandatory?: boolean; default_enabled?: boolean };
}

/**
 * OpenAI-compatible tool call
 */
export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * OpenAI-compatible function tool definition
 */
export interface OpenAIFunctionToolDef {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * OpenAI chat content part (text or image_url)
 */
export type OpenAIChatContentPart =
  { type: 'text'; text?: string } | { type: 'image_url'; image_url: { url: string } };

/**
 * OpenAI chat message
 */
export interface OpenAIChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: string | OpenAIChatContentPart[];
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

/**
 * Buffer for accumulating tool call arguments during streaming
 */
export interface ToolCallBuffer {
  id?: string;
  name?: string;
  arguments: string;
}

/**
 * Bifrost models response
 */
export interface BifrostModelsResponse {
  data: BifrostModel[];
  object: 'list';
}

/**
 * Fetch all models result
 */
export interface FetchAllModelsResult {
  models: BifrostModel[];
  truncated: boolean;
  pages: number;
  listBase: string;
  fallbackUsed: boolean;
}
