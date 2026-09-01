// Message and tool conversion utilities

import * as vscode from 'vscode';

/**
 * Convert VS Code LanguageModelChatRequestMessage[] or LanguageModelChatMessage[] to
 * OpenAI-compatible messages.
 * @param messages - VS Code chat messages (provider API or client API)
 * @param filterEphemeral - Drop cache_control sentinels (default: true)
 * @returns OpenAI-compatible message array
 */
export function convertMessages(
  messages: readonly (vscode.LanguageModelChatRequestMessage | vscode.LanguageModelChatMessage)[],
  filterEphemeral: boolean = true,
): OpenAIMessage[] {
  const openaiMessages: OpenAIMessage[] = [];

  for (const msg of messages) {
    const roleValue = msg.role;

    // Determine numeric role - both LanguageModelChatRequestMessage and LanguageModelChatMessage
    // use LanguageModelChatMessageRole enum (User=1, Assistant=2).
    const isAssistant = roleValue === vscode.LanguageModelChatMessageRole.Assistant;
    const isUser = roleValue === vscode.LanguageModelChatMessageRole.User;

    // content may be a string (LanguageModelChatMessage) or a ReadonlyArray (LanguageModelChatRequestMessage)
    const rawContent: unknown =
      'content' in msg
        ? (msg as vscode.LanguageModelChatRequestMessage).content
        : (msg as vscode.LanguageModelChatMessage).content;

    const parts: unknown[] = typeof rawContent === 'string' ? [new vscode.LanguageModelTextPart(rawContent)] : Array.isArray(rawContent) ? [...rawContent] : [];

    // Check if this is a tool-result message (has LanguageModelToolResultPart in content)
    const toolResultParts = parts.filter(p => p instanceof vscode.LanguageModelToolResultPart);
    if (toolResultParts.length > 0) {
      for (const trp of toolResultParts as vscode.LanguageModelToolResultPart[]) {
        const textContent = trp.content
          .filter(p => p instanceof vscode.LanguageModelTextPart)
          .map(p => (p as vscode.LanguageModelTextPart).value)
          .join('');

        openaiMessages.push({
          role: 'tool',
          tool_call_id: trp.callId,
          content: textContent,
        });
      }
      continue;
    }

    // Handle assistant messages with tool calls
    if (isAssistant) {
      const textParts: string[] = [];
      const toolCalls: OpenAIToolCall[] = [];

      for (const part of parts) {
        if (part instanceof vscode.LanguageModelTextPart) {
          textParts.push(part.value);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push({
            id: part.callId,
            type: 'function',
            function: {
              name: part.name,
              arguments: JSON.stringify(part.input),
            },
          });
        } else if (part instanceof vscode.LanguageModelDataPart) {
          const imageData = handleImageDataPart(part);
          if (imageData) {
            if (textParts.length > 0) {
              openaiMessages.push({
                role: 'assistant',
                content: textParts.join(''),
              });
              textParts.length = 0;
            }
            openaiMessages.push(imageData);
          }
        }
      }

      // Emit text content
      if (textParts.length > 0) {
        openaiMessages.push({
          role: 'assistant',
          content: textParts.join(''),
        });
      }

      // Emit tool calls if any
      if (toolCalls.length > 0) {
        openaiMessages.push({
          role: 'assistant',
          content: undefined,
          tool_calls: toolCalls,
        });
      }
      continue;
    }

    // Handle user/system messages
    const contentParts: (string | OpenAIMessageImageContent)[] = [];

    for (const part of parts) {
      if (part instanceof vscode.LanguageModelTextPart) {
        // Filter ephemeral cache_control sentinels (sent as DataPart with cache_control mime)
        if (!filterEphemeral || part.value !== '') {
          contentParts.push(part.value);
        }
      } else if (part instanceof vscode.LanguageModelDataPart) {
        // Filter cache_control ephemeral sentinels
        if (filterEphemeral && part.mimeType === 'cache_control') {
          continue;
        }
        const imageData = handleImageDataPart(part);
        if (imageData && Array.isArray(imageData.content)) {
          for (const c of imageData.content) {
            contentParts.push(c as OpenAIMessageImageContent);
          }
        }
      }
    }

    const role: 'user' | 'system' = isUser ? 'user' : 'system';
    let combinedContent: string | (string | OpenAIMessageImageContent)[] | undefined;
    if (contentParts.length === 0) {
      combinedContent = undefined;
    } else if (contentParts.length === 1 && typeof contentParts[0] === 'string') {
      combinedContent = contentParts[0];
    } else {
      combinedContent = contentParts;
    }
    openaiMessages.push({
      role,
      content: combinedContent,
    });
  }

  return openaiMessages;
}

/**
 * Handle LanguageModelDataPart (images, etc.)
 */
function handleImageDataPart(part: vscode.LanguageModelDataPart): OpenAIMessage | null {
  if (part.mimeType && part.mimeType.startsWith('image/')) {
    const data = part.data as Uint8Array | undefined;
    if (data) {
      const base64 = Buffer.from(data).toString('base64');
      return {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: `data:${part.mimeType};base64,${base64}`,
            },
          },
        ],
      };
    }
  }
  return null;
}

/**
 * Validate tools for OpenAI compatibility
 * @param tools - Tool definitions
 * @returns Validated tool array
 */
export function validateTools(tools: OpenAITool[]): OpenAITool[] {
  const validNameRegex = /^[\w-]+$/;
  const invalidTools: string[] = [];

  for (const tool of tools) {
    if (!validNameRegex.test(tool.function.name)) {
      invalidTools.push(tool.function.name);
    }
  }

  if (invalidTools.length > 0) {
    throw new Error(`Invalid tool names: ${invalidTools.join(', ')}. Must match ^[\\w-]+$`);
  }

  return tools;
}

/**
 * Sanitize and convert tools to OpenAI format
 * Based on Lemonade sanitizer
 */
export function convertTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): OpenAITool[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  const result: OpenAITool[] = [];

  for (const tool of tools) {
    const sanitized = sanitizeToolSchema(tool);
    if (sanitized) {
      result.push(sanitized);
    }
  }

  return result.length > 0 ? result : undefined;
}

/**
 * Sanitize a single tool schema
 */
function sanitizeToolSchema(tool: vscode.LanguageModelChatTool): OpenAITool | null {
  // Validate function name
  let name = tool.name;
  if (!name) {
    return null;
  }

  // Sanitize name: must start with letter, max 64 chars
  if (!/^[a-zA-Z]/.test(name)) {
    name = 'tool_' + name;
  }
  name = name.slice(0, 64);

  // Default schema
  const schema: SchemaObject = {
    type: 'object',
    properties: {},
    required: [],
  };

  if (tool.inputSchema) {
    const inputSchema = tool.inputSchema as SchemaObject;
    schema.properties = inputSchema.properties || {};
    schema.required = inputSchema.required || [];
  }

  // Recursively sanitize schema
  sanitizeSchema(schema);

  return {
    type: 'function',
    function: {
      name,
      description: tool.description || '',
      parameters: schema,
    },
  };
}

/**
 * Recursively sanitize JSON schema
 */
function sanitizeSchema(schema: SchemaObject): void {
  if (!schema || typeof schema !== 'object') {
    return;
  }

  // Default type to object if missing
  if (!schema.type) {
    schema.type = 'object';
  }

  // Allowed keys only
  const allowedKeys = new Set([
    'type',
    'properties',
    'required',
    'additionalProperties',
    'description',
    'enum',
    'default',
    'items',
    'minLength',
    'maxLength',
    'minimum',
    'maximum',
    'pattern',
    'format',
  ]);

  // Drop unknown keys
  for (const key of Object.keys(schema)) {
    if (!allowedKeys.has(key)) {
      delete schema[key];
    }
  }

  // Coerce number to integer for ID/limit/count fields
  if (schema.type === 'number') {
    const nameLower = (schema.description || '').toLowerCase();
    if (nameLower.includes('id') || nameLower.includes('limit') || nameLower.includes('count')) {
      schema.type = 'integer';
    }
  }

  // Default array items
  if (schema.type === 'array' && schema.items === undefined) {
    schema.items = { type: 'string' };
  }

  // Collapse anyOf/oneOf/allOf to first branch or string
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (schema[key]) {
      const branches = schema[key] as SchemaObject[];
      if (Array.isArray(branches) && branches.length > 0) {
        // Prefer string branch
        const stringBranch = branches.find(b => b.type === 'string');
        schema.type = stringBranch ? 'string' : branches[0].type || 'string';
        delete schema[key];
      }
    }
  }

  // Recursively process properties and items
  if (schema.properties && typeof schema.properties === 'object') {
    for (const prop of Object.values(schema.properties)) {
      sanitizeSchema(prop as SchemaObject);
    }
  }

  if (schema.items && typeof schema.items === 'object') {
    sanitizeSchema(schema.items as SchemaObject);
  }
}

/**
 * Validate chat request
 */
export function validateRequest(
  messages: OpenAIMessage[],
  tools: OpenAITool[] | undefined,
  _maxInputTokens: number | undefined,
): void {
  // Check message count and structure
  if (!messages || messages.length === 0) {
    throw new Error('Messages array is empty or undefined');
  }

  // Validate last message is user or system
  const lastRole = messages[messages.length - 1].role;
  if (lastRole !== 'user' && lastRole !== 'system') {
    throw new Error('Last message must be from user or system');
  }

  // Validate tool mode constraints (if tools provided)
  if (tools && tools.length > 0) {
    // Check for required tool mode - exactly 1 tool
    // This is validated at provider level based on ToolMode.Required
  }
}

/**
 * Estimate token count for messages and tools
 * Heuristic: chars/4 for text, chars/4 for JSON.stringify(tools)
 */
export function estimateTokenCount(
  messages: OpenAIMessage[],
  tools: OpenAITool[] | undefined,
): number {
  let charCount = 0;

  // Count message content
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      charCount += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === 'string') {
          charCount += part.length;
        } else if (part && typeof part === 'object') {
          if (typeof (part as OpenAIMessageImageContent & { text?: string }).text === 'string') {
            charCount += ((part as OpenAIMessageImageContent & { text?: string }).text as string).length;
          }
        }
      }
    }
  }

  // Count tools JSON
  if (tools) {
    charCount += JSON.stringify(tools).length;
  }

  return Math.ceil(charCount / 4);
}

/**
 * Estimate token count for messages only (chars/4 heuristic).
 */
export function estimateMessagesTokens(messages: OpenAIMessage[]): number {
  return estimateTokenCount(messages, undefined);
}

/**
 * Estimate token count for tools only (chars/4 heuristic).
 */
export function estimateToolTokens(tools: OpenAITool[]): number {
  return estimateTokenCount([], tools);
}

/**
 * Check if request exceeds token limit
 */
export function checkTokenLimit(
  messages: OpenAIMessage[],
  tools: OpenAITool[] | undefined,
  maxInputTokens: number | undefined,
): boolean {
  if (!maxInputTokens) {
    return false;
  }
  const estimated = estimateTokenCount(messages, tools);
  return estimated > maxInputTokens;
}

// Internal schema type for recursive sanitization
interface SchemaObject {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
  description?: string;
  [key: string]: unknown;
}

// OpenAI-compatible types

interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: string | (string | OpenAIMessageImageContent)[];
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAIMessageImageContent {
  type: 'image_url';
  image_url: {
    url: string;
  };
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: SchemaObject;
  };
}
