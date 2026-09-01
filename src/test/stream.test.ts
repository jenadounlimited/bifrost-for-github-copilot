// Tests for SseChatParser streaming logic

import { describe, expect, it } from 'vitest';
import { LanguageModelTextPart, LanguageModelToolCallPart } from 'vscode';
import { SseChatParser } from '../stream';
import {
  basicTextStream,
  deduplicatedStream,
  mixedContentAndToolsStream,
  nativeToolCallStream,
  textEmbeddedToolCallStream,
  thinkingContentStream,
  truncatedStream,
} from './fixtures/sse';

function makeProgress() {
  const reported: unknown[] = [];
  return {
    report: (part: unknown) => reported.push(part),
    reported,
  };
}

function textParts(reported: unknown[]): string[] {
  return reported
    .filter(p => p instanceof LanguageModelTextPart)
    .map(p => (p as LanguageModelTextPart).value);
}

function toolParts(reported: unknown[]): LanguageModelToolCallPart[] {
  return reported.filter(p => p instanceof LanguageModelToolCallPart) as LanguageModelToolCallPart[];
}

// ── Baseline tests ────────────────────────────────────────────────────────────

describe('SseChatParser', () => {
  it('emits text part for a plain text delta (flat shape)', () => {
    const parser = new SseChatParser();
    const progress = makeProgress();

    // Build the delta shape the parser also accepts (flat content)
    const deltaChunk = `data: {"content":"Hello world"}\n\n`;
    parser.processChunk(deltaChunk, progress as never);

    const texts = textParts(progress.reported);
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.join('')).toBe('Hello world');
  });

  it('emits no parts for an empty chunk', () => {
    const parser = new SseChatParser();
    const progress = makeProgress();
    parser.processChunk('', progress as never);
    expect(progress.reported).toHaveLength(0);
  });

  it('handles [DONE] without throwing', () => {
    const parser = new SseChatParser();
    const progress = makeProgress();
    parser.processChunk('data: [DONE]\n\n', progress as never);
    // No throw expected
  });

  it('ignores lines without data: prefix', () => {
    const parser = new SseChatParser();
    const progress = makeProgress();
    parser.processChunk(': keep-alive\nevent: message\n', progress as never);
    expect(progress.reported).toHaveLength(0);
  });

  it('emits a LanguageModelToolCallPart for a complete native tool call (flat shape)', () => {
    const parser = new SseChatParser();
    const progress = makeProgress();

    const delta = {
      tool_calls: [
        {
          index: 0,
          id: 'call_abc',
          name: 'get_weather',
          arguments: JSON.stringify({ city: 'Paris' }),
        },
      ],
    };
    parser.processChunk(`data: ${JSON.stringify(delta)}\n\n`, progress as never);

    const tools = toolParts(progress.reported);
    expect(tools.length).toBe(1);
    expect(tools[0].callId).toBe('call_abc');
    expect(tools[0].name).toBe('get_weather');
    expect(tools[0].input).toEqual({ city: 'Paris' });
  });

  it('buffers incomplete tool call arguments across chunks', () => {
    const parser = new SseChatParser();
    const progress = makeProgress();

    // First chunk: id + name, partial args
    parser.processChunk(
      `data: ${JSON.stringify({ tool_calls: [{ index: 0, id: 'call_1', name: 'fn', arguments: '{"x"' }] })}\n\n`,
      progress as never,
    );
    expect(toolParts(progress.reported)).toHaveLength(0);

    // Second chunk: rest of args
    parser.processChunk(
      `data: ${JSON.stringify({ tool_calls: [{ index: 0, arguments: ':1}' }] })}\n\n`,
      progress as never,
    );
    const tools = toolParts(progress.reported);
    expect(tools.length).toBe(1);
    expect(tools[0].input).toEqual({ x: 1 });
  });

  it('strips control tokens from visible text', () => {
    const parser = new SseChatParser();
    const progress = makeProgress();

    parser.processChunk(
      `data: {"content":"hello<|tool_call_begin|>world"}\n\n`,
      progress as never,
    );

    const combined = textParts(progress.reported).join('');
    expect(combined).not.toContain('<|tool_call_begin|>');
  });
});

// ── Real OpenAI choices[0].delta shape ───────────────────────────────────────

describe('SseChatParser – real OpenAI SSE shape', () => {
  it('assembles full text from basicTextStream fixture', () => {
    const parser = new SseChatParser();
    const progress = makeProgress();

    for (const line of basicTextStream.split('\n\n')) {
      if (line.trim()) {parser.processChunk(line + '\n\n', progress as never);}
    }

    const combined = textParts(progress.reported).join('');
    expect(combined).toBe('Hello, world!');
  });

  it('assembles native tool call from nativeToolCallStream fixture', () => {
    const parser = new SseChatParser();
    const progress = makeProgress();

    for (const line of nativeToolCallStream.split('\n\n')) {
      if (line.trim()) {parser.processChunk(line + '\n\n', progress as never);}
    }

    const tools = toolParts(progress.reported);
    expect(tools.length).toBe(1);
    expect(tools[0].callId).toBe('call_abc123');
    expect(tools[0].name).toBe('get_weather');
    expect(tools[0].input).toEqual({ city: 'Paris' });
  });
});

// ── Text-embedded tool calls ──────────────────────────────────────────────────

describe('SseChatParser – text-embedded tool calls', () => {
  it('parses a text-embedded tool call from control tokens', () => {
    const parser = new SseChatParser();
    const progress = makeProgress();

    for (const line of textEmbeddedToolCallStream.split('\n\n')) {
      if (line.trim()) {parser.processChunk(line + '\n\n', progress as never);}
    }

    const tools = toolParts(progress.reported);
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('get_weather');
    expect(tools[0].input).toEqual({ city: 'London' });
    // IDs for text-embedded calls are prefixed with tct_
    expect(tools[0].callId).toMatch(/^tct_/);
  });
});

// ── Mixed content + tools ─────────────────────────────────────────────────────

describe('SseChatParser – mixed content and tools', () => {
  it('emits text before a native tool call', () => {
    const parser = new SseChatParser();
    const progress = makeProgress();

    for (const line of mixedContentAndToolsStream.split('\n\n')) {
      if (line.trim()) {parser.processChunk(line + '\n\n', progress as never);}
    }

    const texts = textParts(progress.reported);
    const tools = toolParts(progress.reported);

    // Text appeared before tool call
    expect(texts.some(t => t.includes('Let me check'))).toBe(true);
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('search');
    expect(tools[0].input).toEqual({ q: 'weather' });
  });
});

// ── Thinking / reasoning content ─────────────────────────────────────────────

describe('SseChatParser – thinking content', () => {
  it('emits reasoning_content as a text part', () => {
    const parser = new SseChatParser();
    const progress = makeProgress();

    for (const line of thinkingContentStream.split('\n\n')) {
      if (line.trim()) {parser.processChunk(line + '\n\n', progress as never);}
    }

    const texts = textParts(progress.reported);
    expect(texts.some(t => t.includes('Step 1'))).toBe(true);
    expect(texts.some(t => t.includes('42'))).toBe(true);
  });
});

// ── Deduplication ─────────────────────────────────────────────────────────────

describe('SseChatParser – deduplication', () => {
  it('does not emit a text-embedded duplicate of an already-emitted native tool call', () => {
    const parser = new SseChatParser();
    const progress = makeProgress();

    for (const line of deduplicatedStream.split('\n\n')) {
      if (line.trim()) {parser.processChunk(line + '\n\n', progress as never);}
    }

    const tools = toolParts(progress.reported);
    // Only one get_info call — the text-embedded duplicate is suppressed
    const getInfoCalls = tools.filter(t => t.name === 'get_info');
    expect(getInfoCalls.length).toBe(1);
  });
});

// ── Abort does not flush ──────────────────────────────────────────────────────

describe('SseChatParser – abort', () => {
  it('does not flush incomplete tool JSON after abort()', () => {
    const parser = new SseChatParser();
    const progress = makeProgress();

    // Feed partial arguments
    parser.processChunk(truncatedStream, progress as never);

    // No tool emitted yet (args are incomplete)
    expect(toolParts(progress.reported)).toHaveLength(0);

    // Abort, then deliver [DONE] as if the connection was cleanly closed after abort
    parser.abort();
    parser.processChunk('data: [DONE]\n\n', progress as never);

    // Still no tool call — abort suppresses the [DONE] flush
    expect(toolParts(progress.reported)).toHaveLength(0);
  });
});

// ── Cross-chunk control token buffering ──────────────────────────────────────

describe('SseChatParser – cross-chunk control token buffering', () => {
  it('buffers an incomplete control token at chunk boundary and strips it when rest arrives', () => {
    const parser = new SseChatParser();
    const progress = makeProgress();

    // Split '<|tool_call_begin|>' across two chunks — first chunk ends mid-token
    parser.processChunk(
      `data: {"content":"hello <|tool_ca"}\n\n`,
      progress as never,
    );
    // At this point the buffer may hold a partial token; no visible '<|tool_ca...' should leak
    const textAfterFirst = textParts(progress.reported).join('');
    expect(textAfterFirst).not.toMatch(/<\|tool_ca/);

    // Second chunk: completes and adds more text
    parser.processChunk(
      `data: {"content":"ll_begin|> world"}\n\n`,
      progress as never,
    );
    const combined = textParts(progress.reported).join('');
    // Control token should be stripped entirely
    expect(combined).not.toContain('<|tool_call_begin|>');
  });
});
