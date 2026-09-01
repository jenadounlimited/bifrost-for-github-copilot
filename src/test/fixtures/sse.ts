// SSE test fixtures for SseChatParser

/**
 * Helper: wrap an object as an SSE data line.
 */
function dataLine(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// ── Basic text stream ─────────────────────────────────────────────────────────

/** Simple text-only SSE in real OpenAI choices[0].delta shape. */
export const basicTextStream: string =
  dataLine({ choices: [{ delta: { content: 'Hello' }, finish_reason: null }] }) +
  dataLine({ choices: [{ delta: { content: ', world' }, finish_reason: null }] }) +
  dataLine({ choices: [{ delta: { content: '!' }, finish_reason: 'stop' }] }) +
  'data: [DONE]\n\n';

// ── Native tool call stream ───────────────────────────────────────────────────

/**
 * Native `delta.tool_calls` SSE stream — arguments arrive in two chunks,
 * then a finish_reason flushes them.
 */
export const nativeToolCallStream: string =
  dataLine({
    choices: [{ delta: { content: null }, finish_reason: null }],
  }) +
  dataLine({
    choices: [{
      delta: {
        tool_calls: [{ index: 0, id: 'call_abc123', function: { name: 'get_weather', arguments: '{"city"' } }],
      },
      finish_reason: null,
    }],
  }) +
  dataLine({
    choices: [{
      delta: {
        tool_calls: [{ index: 0, function: { arguments: ':"Paris"}' } }],
      },
      finish_reason: null,
    }],
  }) +
  dataLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
  'data: [DONE]\n\n';

// ── Text-embedded tool call stream ────────────────────────────────────────────

/**
 * Text-embedded control-token style tool calls.
 * Parser should detect `<|tool_call_begin|>` … `<|tool_call_end|>` in text content.
 */
export const textEmbeddedToolCallStream: string =
  dataLine({
    choices: [{
      delta: {
        content: '<|tool_calls_begin|><|tool_call_begin|>get_weather:0<|tool_call_arg_begin|>{"city":"London"}<|tool_call_end|><|tool_calls_end|>',
      },
      finish_reason: null,
    }],
  }) +
  dataLine({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
  'data: [DONE]\n\n';

// ── Mixed content and tools stream ────────────────────────────────────────────

/**
 * Interleaved text and native tool calls — text before the tool call, then
 * a native tool call delta.
 */
export const mixedContentAndToolsStream: string =
  dataLine({ choices: [{ delta: { content: 'Let me check that. ' }, finish_reason: null }] }) +
  dataLine({
    choices: [{
      delta: {
        tool_calls: [{ index: 0, id: 'call_xyz', function: { name: 'search', arguments: '{"q":"weather"}' } }],
      },
      finish_reason: null,
    }],
  }) +
  dataLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
  'data: [DONE]\n\n';

// ── Thinking / reasoning content stream ──────────────────────────────────────

/**
 * Stream with a `reasoning_content` delta (extended thinking / o-series models).
 */
export const thinkingContentStream: string =
  dataLine({ choices: [{ delta: { reasoning_content: 'Step 1: analyse the query.' }, finish_reason: null }] }) +
  dataLine({ choices: [{ delta: { content: 'The answer is 42.' }, finish_reason: 'stop' }] }) +
  'data: [DONE]\n\n';

// ── Truncated / aborted stream ────────────────────────────────────────────────

/**
 * Incomplete stream — arguments never finish, no [DONE].
 * Used to verify that abort() suppresses flushing of incomplete JSON.
 */
export const truncatedStream: string =
  dataLine({
    choices: [{
      delta: {
        tool_calls: [{ index: 0, id: 'call_trunc', function: { name: 'fn', arguments: '{"x"' } }],
      },
      finish_reason: null,
    }],
  });
// No [DONE] — stream is cut off

// ── Deduplicated native + text-embedded ──────────────────────────────────────

/**
 * A native tool call followed immediately by the same call as a text-embedded token.
 * The parser should emit the native call and deduplicate the text-embedded duplicate.
 */
export const deduplicatedStream: string =
  dataLine({
    choices: [{
      delta: {
        tool_calls: [{ index: 0, id: 'call_dedup', function: { name: 'get_info', arguments: '{"id":1}' } }],
      },
      finish_reason: null,
    }],
  }) +
  dataLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
  dataLine({
    choices: [{
      delta: {
        content: '<|tool_calls_begin|><|tool_call_begin|>get_info:0<|tool_call_arg_begin|>{"id":1}<|tool_call_end|><|tool_calls_end|>',
      },
      finish_reason: null,
    }],
  }) +
  'data: [DONE]\n\n';
