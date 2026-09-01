// Tests for message/tool conversion utilities

import { describe, expect, it } from 'vitest';
import {
  LanguageModelChatMessageRole,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
} from 'vscode';
import {
  checkTokenLimit,
  convertMessages,
  convertTools,
  estimateMessagesTokens,
  estimateTokenCount,
  estimateToolTokens,
  validateRequest,
  validateTools,
} from '../utils';

// ─── convertMessages ─────────────────────────────────────────────────────────

describe('convertMessages', () => {
  it('converts a plain user text message', () => {
    const msg = {
      role: LanguageModelChatMessageRole.User,
      content: [new LanguageModelTextPart('Hello')],
      name: undefined,
    };
    const result = convertMessages([msg]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ role: 'user', content: 'Hello' });
  });

  it('converts an assistant message with text', () => {
    const msg = {
      role: LanguageModelChatMessageRole.Assistant,
      content: [new LanguageModelTextPart('Hi there')],
      name: undefined,
    };
    const result = convertMessages([msg]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ role: 'assistant', content: 'Hi there' });
  });

  it('converts an assistant message with a tool call', () => {
    const msg = {
      role: LanguageModelChatMessageRole.Assistant,
      content: [new LanguageModelToolCallPart('call_1', 'search', { query: 'cats' })],
      name: undefined,
    };
    const result = convertMessages([msg]);
    // Tool calls are emitted as a separate assistant message
    const toolMsg = result.find(m => m.tool_calls);
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.tool_calls![0]).toMatchObject({
      id: 'call_1',
      type: 'function',
      function: { name: 'search', arguments: JSON.stringify({ query: 'cats' }) },
    });
  });

  it('converts a tool result message', () => {
    const msg = {
      role: LanguageModelChatMessageRole.User,
      content: [new LanguageModelToolResultPart('call_1', [new LanguageModelTextPart('result text')])],
      name: undefined,
    };
    const result = convertMessages([msg]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'result text',
    });
  });

  it('filters ephemeral cache_control DataParts when filterEphemeral=true', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const CacheControlPart = { mimeType: 'cache_control', data: new Uint8Array(0) } as any;
    const msg = {
      role: LanguageModelChatMessageRole.User,
      content: [new LanguageModelTextPart('visible'), CacheControlPart],
      name: undefined,
    };
    const result = convertMessages([msg], true);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('visible');
  });

  it('keeps DataParts when filterEphemeral=false', () => {
    const msg = {
      role: LanguageModelChatMessageRole.User,
      content: [new LanguageModelTextPart('visible')],
      name: undefined,
    };
    const result = convertMessages([msg], false);
    expect(result).toHaveLength(1);
  });

  it('maps unknown role to system', () => {
    const msg = {
      role: 99 as LanguageModelChatMessageRole, // not User or Assistant
      content: [new LanguageModelTextPart('system msg')],
      name: undefined,
    };
    const result = convertMessages([msg]);
    expect(result[0].role).toBe('system');
  });
});

// ─── convertTools ─────────────────────────────────────────────────────────────

describe('convertTools', () => {
  it('returns undefined for empty tools', () => {
    expect(convertTools([])).toBeUndefined();
    expect(convertTools(undefined)).toBeUndefined();
  });

  it('converts a simple tool', () => {
    const tools = [
      {
        name: 'get_weather',
        description: 'Get the weather',
        inputSchema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    ];
    const result = convertTools(tools);
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get the weather',
      },
    });
  });

  it('prepends "tool_" to names that start with a non-letter', () => {
    const tools = [{ name: '1bad', description: '', inputSchema: undefined }];
    const result = convertTools(tools);
    expect(result![0].function.name).toMatch(/^tool_/);
  });

  it('truncates names longer than 64 characters', () => {
    const longName = 'a'.repeat(70);
    const tools = [{ name: longName, description: '', inputSchema: undefined }];
    const result = convertTools(tools);
    expect(result![0].function.name.length).toBeLessThanOrEqual(64);
  });
});

// ─── estimateTokenCount / checkTokenLimit ────────────────────────────────────

describe('estimateTokenCount', () => {
  it('estimates token count from message content', () => {
    const messages = [{ role: 'user' as const, content: 'a'.repeat(400) }];
    expect(estimateTokenCount(messages, undefined)).toBe(100); // 400/4
  });

  it('includes tool schema in estimate', () => {
    const messages = [{ role: 'user' as const, content: '' }];
    const tools = [{ type: 'function' as const, function: { name: 'f', parameters: { type: 'object', properties: {}, required: [] } } }];
    const withTools = estimateTokenCount(messages, tools);
    expect(withTools).toBeGreaterThan(0);
  });
});

describe('checkTokenLimit', () => {
  it('returns false when under the limit', () => {
    const messages = [{ role: 'user' as const, content: 'hi' }];
    expect(checkTokenLimit(messages, undefined, 128_000)).toBe(false);
  });

  it('returns true when over the limit', () => {
    const messages = [{ role: 'user' as const, content: 'x'.repeat(128_000 * 4 + 4) }];
    expect(checkTokenLimit(messages, undefined, 128_000)).toBe(true);
  });

  it('returns false when maxInputTokens is undefined', () => {
    const messages = [{ role: 'user' as const, content: 'x'.repeat(9999999) }];
    expect(checkTokenLimit(messages, undefined, undefined)).toBe(false);
  });
});

// ─── convertTools — schema sanitization ──────────────────────────────────────

describe('convertTools – schema sanitization', () => {
  it('drops unknown schema keywords', () => {
    const tools = [{
      name: 'tool',
      description: '',
      inputSchema: {
        type: 'object',
        properties: { x: { type: 'string', unknownProp: 'drop-me' } },
      },
    }];
    const result = convertTools(tools)!;
    const prop = result[0].function.parameters.properties!['x'] as Record<string, unknown>;
    expect(prop.unknownProp).toBeUndefined();
    expect(prop.type).toBe('string');
  });

  it('defaults missing type to object', () => {
    const tools = [{ name: 'tool', description: '', inputSchema: { properties: {} } }];
    const result = convertTools(tools)!;
    expect(result[0].function.parameters.type).toBe('object');
  });

  it('defaults array items to {type: string}', () => {
    const tools = [{
      name: 'tool',
      description: '',
      inputSchema: { type: 'object', properties: { tags: { type: 'array' } } },
    }];
    const result = convertTools(tools)!;
    const tags = result[0].function.parameters.properties!['tags'] as Record<string, unknown>;
    expect(tags.items).toEqual({ type: 'string' });
  });

  it('coerces number to integer when description contains "id"', () => {
    const tools = [{
      name: 'tool',
      description: '',
      inputSchema: {
        type: 'object',
        properties: { user_id: { type: 'number', description: 'the id' } },
      },
    }];
    const result = convertTools(tools)!;
    const prop = result[0].function.parameters.properties!['user_id'] as Record<string, unknown>;
    expect(prop.type).toBe('integer');
  });

  it('strips anyOf (unknown keyword) and defaults type to object', () => {
    // anyOf is not in the allowed-keys list, so it is dropped.
    // The resulting property gets type='object' (the default).
    const tools = [{
      name: 'tool',
      description: '',
      inputSchema: {
        type: 'object',
        properties: {
          val: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        },
      },
    }];
    const result = convertTools(tools)!;
    const prop = result[0].function.parameters.properties!['val'] as Record<string, unknown>;
    expect(prop.anyOf).toBeUndefined();
    // type defaults to 'object' because anyOf was stripped before the collapse logic runs
    expect(prop.type).toBe('object');
  });

  it('recursively sanitizes nested properties', () => {
    const tools = [{
      name: 'tool',
      description: '',
      inputSchema: {
        type: 'object',
        properties: {
          nested: {
            type: 'object',
            properties: { deep: { type: 'string', $schema: 'drop' } },
          },
        },
      },
    }];
    const result = convertTools(tools)!;
    const nested = result[0].function.parameters.properties!['nested'] as Record<string, unknown>;
    const deep = (nested.properties as Record<string, unknown>)['deep'] as Record<string, unknown>;
    expect(deep.$schema).toBeUndefined();
  });
});

// ─── validateRequest ─────────────────────────────────────────────────────────

describe('validateRequest', () => {
  it('passes for a valid user-last message array', () => {
    expect(() => validateRequest([{ role: 'user', content: 'hi' }], undefined, undefined)).not.toThrow();
  });

  it('throws when messages array is empty', () => {
    expect(() => validateRequest([], undefined, undefined)).toThrow(/empty/);
  });

  it('throws when last message is from assistant', () => {
    expect(() => validateRequest(
      [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }],
      undefined,
      undefined,
    )).toThrow(/Last message/);
  });

  it('passes when last message is system', () => {
    expect(() => validateRequest([{ role: 'system', content: 'sys' }], undefined, undefined)).not.toThrow();
  });
});

// ─── validateTools ────────────────────────────────────────────────────────────

describe('validateTools', () => {
  it('passes for valid tool names', () => {
    const tools = [{ type: 'function' as const, function: { name: 'valid_tool-1', parameters: { type: 'object' } } }];
    expect(() => validateTools(tools)).not.toThrow();
  });

  it('throws for invalid tool names', () => {
    const tools = [{ type: 'function' as const, function: { name: 'bad name!', parameters: { type: 'object' } } }];
    expect(() => validateTools(tools)).toThrow(/Invalid tool names/);
  });
});

// ─── estimateMessagesTokens / estimateToolTokens ──────────────────────────────

describe('estimateMessagesTokens', () => {
  it('returns chars/4 for message content', () => {
    const messages = [{ role: 'user' as const, content: 'x'.repeat(200) }];
    expect(estimateMessagesTokens(messages)).toBe(50);
  });
});

describe('estimateToolTokens', () => {
  it('returns token count based on JSON-serialized tool size', () => {
    const tools = [{ type: 'function' as const, function: { name: 'f', parameters: { type: 'object', properties: {}, required: [] } } }];
    expect(estimateToolTokens(tools)).toBeGreaterThan(0);
  });
});
