// Type definitions for Bifrost and OpenAI-compatible APIs

/**
 * Authentication mode for Bifrost endpoints
 */
export type BifrostAuthMode = 'auto' | 'bearer' | 'x-bf-vk' | 'both';

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
}

/**
 * Bifrost model architecture with modality fields
 */
export interface BifrostModelArchitecture {
  modality?: string[];
  input_modalities?: string[];
  output_modalities?: string[];
}

/**
 * Bifrost model catalog entry
 */
export interface BifrostModel {
  id: string;
  name: string;
  normalized_name?: string;
  created?: number;

  // Context
  context_length?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;

  // Architecture
  architecture?: BifrostModelArchitecture;
  supported_parameters?: string[];
  supported_methods?: string[];

  // Additional
  description?: string;
  top_provider?: string;
  reasoning?: boolean;
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

