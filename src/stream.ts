// SSE streaming parser for chat completions

import * as vscode from 'vscode';

/**
 * Buffer for accumulating tool call arguments during streaming.
 * Kept internal — exported type lives in types.ts.
 */
interface ToolCallBuffer {
  id?: string;
  name?: string;
  arguments: string;
}

/**
 * SSE Chat Parser — processes OpenAI-compatible SSE chat completion streams.
 *
 * Handles:
 *  - Standard content deltas (`choices[0].delta.content`)
 *  - Native tool call deltas (`choices[0].delta.tool_calls`)
 *  - Text-embedded control-token tool calls (`<|tool_call_begin|>…<|tool_call_end|>`)
 *  - Thinking / reasoning content (`choices[0].delta.reasoning_content`)
 *  - Cross-chunk buffering so tokens split across TCP packets work correctly
 *  - Deduplication so the same tool call is never emitted twice
 *
 * Based on Lemonade's SseChatParser pattern, adapted for VS Code 1.104+ API.
 */
export class SseChatParser {
  // ── Buffers ────────────────────────────────────────────────────────────────

  /** Tool call accumulator keyed by delta index. */
  private _toolCallBuffers: Map<number, ToolCallBuffer> = new Map();

  /** Indices whose tool calls have been fully emitted. */
  private _completedToolCallIndices: Set<number> = new Set();

  /** True once the first non-empty text part has been emitted (for space-before-tools). */
  private _hasEmittedAssistantText: boolean = false;

  /** (reserved) True once the tools-begin hint space has been emitted. */
  private _emittedBeginToolCallsHint: boolean = false;

  /** Canonical keys of text-embedded tool calls already emitted; prevents duplicates. */
  private _emittedTextToolCallKeys: Set<string> = new Set();

  /** Call IDs of text-embedded tool calls already emitted. */
  private _emittedTextToolCallIds: Set<string> = new Set();

  /** Partial text waiting for a complete `<|tool_call_begin|>…<|tool_call_end|>` block. */
  private _textToolParserBuffer: string = '';

  /** Partial text waiting to be stripped of an incomplete control token. */
  private _controlTokenBuffer: string = '';

  /** Set to true when the request is aborted — prevents flushing incomplete tool JSON. */
  private _aborted: boolean = false;

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Mark this parser as aborted.
   * After this, any pending `[DONE]` flush will be suppressed so incomplete
   * JSON fragments are never emitted.
   */
  public abort(): void {
    this._aborted = true;
  }

  /**
   * Feed one decoded SSE chunk into the parser.
   *
   * @param chunk - UTF-8 text decoded from the network (may span multiple SSE lines)
   * @param progress - VS Code progress callback to receive response parts
   */
  public processChunk(
    chunk: string,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): void {
    const lines = chunk.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip empty lines and SSE comment lines (`: keep-alive`, etc.)
      if (!trimmed || trimmed.startsWith(':')) {
        continue;
      }

      if (trimmed.startsWith('data:')) {
        const data = trimmed.slice(5).trim();

        if (data === '[DONE]') {
          // Flush only when not aborted — prevents emitting broken JSON on cancel
          if (!this._aborted) {
            this._flushToolCalls(progress, false);
          }
          continue;
        }

        try {
          const json = JSON.parse(data) as Record<string, unknown>;
          this._processEvent(json, progress);
        } catch {
          // Non-JSON data lines are silently ignored
        }
      }
    }
  }

  // ── Private: event routing ─────────────────────────────────────────────────

  /**
   * Route a parsed SSE event object.
   *
   * Real OpenAI SSE events have the shape:
   * ```json
   * { "choices": [{ "delta": { "content": "…", "tool_calls": […] }, "finish_reason": null }] }
   * ```
   *
   * Some Bifrost-wrapped models may send a flat `{ "content": "…" }` delta directly.
   * We handle both.
   */
  private _processEvent(
    event: Record<string, unknown>,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): void {
    // Standard OpenAI shape: choices[0].delta
    if (Array.isArray(event.choices) && event.choices.length > 0) {
      const choice = event.choices[0] as Record<string, unknown>;
      const delta = (choice.delta ?? {}) as Record<string, unknown>;
      const finishReason = choice.finish_reason as string | null | undefined;

      this._processDelta(delta, progress);

      if (finishReason === 'tool_calls' || finishReason === 'stop') {
        this._flushToolCalls(progress, true);
      }
      return;
    }

    // Flat delta shape (some Bifrost variants / test fixtures)
    this._processDelta(event, progress);
  }

  /**
   * Process a single delta object (content, tool_calls, reasoning_content).
   */
  private _processDelta(
    delta: Record<string, unknown>,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): void {
    // Reasoning / thinking content (Claude extended thinking, o-series, etc.)
    // Emitted as a plain text part with a leading marker so the UI can distinguish.
    const reasoning = (delta.reasoning_content ?? delta.thinking) as string | undefined;
    if (reasoning && typeof reasoning === 'string' && reasoning.length > 0) {
      // Emit as invisible text — VS Code has no dedicated thinking part yet
      progress.report(new vscode.LanguageModelTextPart(reasoning));
      return;
    }

    // Text content
    if (delta.content !== undefined && delta.content !== null) {
      this._processTextContent(delta.content as string | unknown[], progress);
    }

    // Native tool calls (OpenAI delta.tool_calls)
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls as Record<string, unknown>[]) {
        this._processNativeToolCallDelta(tc, progress);
      }
    }

    // Flat finish_reason on the delta itself (some Bifrost variants)
    if (delta.finish_reason) {
      if (delta.finish_reason === 'tool_calls' || delta.finish_reason === 'stop') {
        this._flushToolCalls(progress, true);
      }
    }
  }

  // ── Private: text processing ───────────────────────────────────────────────

  /**
   * Process a text content value from a delta.
   * Strips control tokens, then checks for text-embedded tool calls before emitting.
   */
  private _processTextContent(
    content: string | unknown[],
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): void {
    if (typeof content !== 'string') {
      return;
    }

    // Scan for text-embedded tool calls BEFORE stripping control tokens,
    // because stripping removes the tokens the parser needs to detect.
    this._parseTextToolCalls(content, progress);

    // Strip control tokens to produce visible text
    const visibleText = this._stripControlTokensWithBuffering(content);

    if (visibleText.length > 0) {
      // Emit a leading space before the first tool call when there has been no
      // prior assistant text (matches Lemonade behaviour).
      if (!this._hasEmittedAssistantText && this._toolCallBuffers.size > 0) {
        progress.report(new vscode.LanguageModelTextPart(' '));
        this._emittedBeginToolCallsHint = true;
        this._hasEmittedAssistantText = true;
      }
      progress.report(new vscode.LanguageModelTextPart(visibleText));
      this._hasEmittedAssistantText = true;
    }
  }

  // ── Private: native tool calls ─────────────────────────────────────────────

  /**
   * Accumulate one tool_call delta by index.
   * Emits a `LanguageModelToolCallPart` as soon as the JSON is complete.
   */
  private _processNativeToolCallDelta(
    tc: Record<string, unknown>,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): void {
    const index = (tc.index as number) ?? 0;

    // Emit leading space before the first tool call if no text has been sent yet
    if (!this._hasEmittedAssistantText) {
      progress.report(new vscode.LanguageModelTextPart(' '));
      this._emittedBeginToolCallsHint = true;
      this._hasEmittedAssistantText = true;
    }

    let buffer = this._toolCallBuffers.get(index);
    if (!buffer) {
      buffer = { arguments: '' };
      this._toolCallBuffers.set(index, buffer);
    }

    if (tc.id) {buffer.id = tc.id as string;}
    if (tc.name) {buffer.name = tc.name as string;}

    // OpenAI streams arguments inside a nested `function` object
    const fn = tc.function as Record<string, unknown> | undefined;
    if (fn?.name) {buffer.name = fn.name as string;}
    if (fn?.arguments) {buffer.arguments += fn.arguments as string;}

    // Also accept flat `arguments` (some non-OpenAI variants)
    if (!fn && tc.arguments) {buffer.arguments += tc.arguments as string;}

    this._tryEmitBufferedToolCall(index, progress);
  }

  /**
   * Attempt to emit a buffered tool call once its JSON arguments are complete.
   */
  private _tryEmitBufferedToolCall(
    index: number,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): void {
    const buffer = this._toolCallBuffers.get(index);
    if (!buffer || !buffer.name) {return;}

    let parsed: object;
    try {
      parsed = JSON.parse(buffer.arguments);
    } catch {
      return; // Arguments not yet complete
    }

    const callId = buffer.id || `call_${Math.random().toString(36).slice(2, 10)}`;
    progress.report(new vscode.LanguageModelToolCallPart(callId, buffer.name, parsed));

    this._completedToolCallIndices.add(index);
    this._toolCallBuffers.delete(index);

    // Register so text-embedded duplicate detection can match against this
    const key = `${buffer.name}:${JSON.stringify(parsed)}`;
    this._emittedTextToolCallKeys.add(key);
  }

  /**
   * Flush all buffered (not-yet-emitted) tool calls.
   * Called on `finish_reason` or `[DONE]`.
   *
   * @param throwOnInvalid - When true, warn if JSON is still broken at flush time.
   */
  private _flushToolCalls(
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    throwOnInvalid: boolean,
  ): void {
    for (const [_idx, buffer] of this._toolCallBuffers) {
      if (!buffer.name) {continue;}

      try {
        const parsed: object = JSON.parse(buffer.arguments);
        const callId = buffer.id || `call_${Math.random().toString(36).slice(2, 10)}`;
        progress.report(new vscode.LanguageModelToolCallPart(callId, buffer.name, parsed));
      } catch (e) {
        if (throwOnInvalid) {
          // Log but do not throw — we must not crash the stream on malformed JSON
          console.warn('[Bifrost] Failed to parse tool call arguments at flush:', buffer.arguments, e);
        }
      }
    }
    this._toolCallBuffers.clear();
    this._completedToolCallIndices.clear();
  }

  // ── Private: text-embedded tool calls ─────────────────────────────────────

  /**
   * Scan the text-tool-parser buffer for complete `<|tool_call_begin|>…<|tool_call_end|>` blocks
   * and emit `LanguageModelToolCallPart` for each valid one.
   *
   * Buffer semantics:
   *  - Text before a BEGIN token is left in the buffer and flushed as regular text by `_processTextContent`
   *  - Incomplete blocks (no END token yet) stay in the buffer until the next chunk
   */
  private _parseTextToolCalls(
    text: string,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): void {
    this._textToolParserBuffer += text;

    // Process all complete tool call blocks in the buffer
    while (true) {
      const beginIdx = this._textToolParserBuffer.indexOf('<|tool_call_begin|>');
      if (beginIdx === -1) {break;}

      const afterBegin = this._textToolParserBuffer.slice(beginIdx + 19); // len('<|tool_call_begin|>') = 19

      // Header: function_name:index (index is optional)
      const headerMatch = afterBegin.match(/^([A-Za-z0-9_\-.]+)(?::(\d+))?/);
      if (!headerMatch) {break;}

      const fnName = headerMatch[1];
      const fnIndex = headerMatch[2] ? parseInt(headerMatch[2], 10) : 0;

      const argBeginIdx = afterBegin.indexOf('<|tool_call_arg_begin|>');
      if (argBeginIdx === -1) {break;} // Incomplete — wait for more chunks

      const argEndIdx = afterBegin.indexOf('<|tool_call_end|>', argBeginIdx);
      if (argEndIdx === -1) {break;} // Incomplete — wait for more chunks

      const argsJson = afterBegin.slice(argBeginIdx + 23, argEndIdx).trim(); // len('<|tool_call_arg_begin|>') = 23

      this._emitTextToolCallIfValid(fnName, fnIndex, argsJson, progress);

      // Advance the buffer past this complete block
      const blockEnd = beginIdx + 19 + argEndIdx + 17; // 17 = len('<|tool_call_end|>')
      this._textToolParserBuffer = this._textToolParserBuffer.slice(blockEnd);
    }
  }

  /**
   * Emit a text-embedded tool call if the JSON is a valid non-array object
   * and has not already been emitted (deduplication).
   */
  private _emitTextToolCallIfValid(
    name: string,
    _index: number,
    argsJson: string,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): void {
    let parsed: object;
    try {
      const result: unknown = JSON.parse(argsJson);
      if (!result || typeof result !== 'object' || Array.isArray(result)) {return;}
      parsed = result;
    } catch {
      return;
    }

    const key = `${name}:${JSON.stringify(parsed)}`;
    if (this._emittedTextToolCallKeys.has(key)) {return;}

    const callId = `tct_${Math.random().toString(36).slice(2, 10)}`;
    progress.report(new vscode.LanguageModelToolCallPart(callId, name, parsed));
    this._emittedTextToolCallKeys.add(key);
    this._emittedTextToolCallIds.add(callId);
  }

  // ── Private: control token stripping ──────────────────────────────────────

  /**
   * Strip Lemonade/Bifrost control tokens from text, buffering across chunk boundaries.
   *
   * Control tokens like `<|tool_call_begin|>` may arrive split across two TCP packets.
   * We hold the tail of the control-token buffer until we are sure no incomplete token
   * spans the chunk boundary.
   */
  private _stripControlTokensWithBuffering(text: string): string {
    this._controlTokenBuffer += text;

    // Regex list ported verbatim from Lemonade
    const patterns: RegExp[] = [
      /<\|tool_calls_begin\|>/g,
      /<\|tool_calls_end\|>/g,
      /<\|tool_call_begin\|>/g,
      /<\|tool_call_arg_begin\|>/g,
      /<\|tool_call_end\|>/g,
      /<\|tool_call_arguments_start\|>/g,
      /<\|tool_call_arguments_end\|>/g,
      /<\|tool_call_argument_begin\|>/g,
      /<\|tool_call_argument_end\|>/g,
      /<\|tool_call_args_start\|>/g,
      /<\|tool_call_args_end\|>/g,
      /<\|tool_call_arguments\|>/g,
      /<\|tool_call\|>/g,
      /<\|tool\|>/g,
      /<\|begin_tool_call\|>/g,
      /<\|end_tool_call\|>/g,
      /<\|tool_begin\|>/g,
      /<\|tool_end\|>/g,
    ];

    for (const re of patterns) {
      this._controlTokenBuffer = this._controlTokenBuffer.replace(re, '');
    }

    const incompletePos = this._findLastIncompleteToken(this._controlTokenBuffer);
    if (incompletePos !== -1) {
      const safe = this._controlTokenBuffer.slice(0, incompletePos);
      this._controlTokenBuffer = this._controlTokenBuffer.slice(incompletePos);
      return safe;
    }

    const out = this._controlTokenBuffer;
    this._controlTokenBuffer = '';
    return out;
  }

  /**
   * Return the index of the start of the last incomplete control-token prefix,
   * or -1 if none exists.
   *
   * An incomplete token is a `<|` prefix that begins a known pattern but does not
   * yet have a closing `|>`.
   */
  private _findLastIncompleteToken(text: string): number {
    // Prefixes that could begin a control token split across chunks
    const prefixes = [
      '<|tool_calls',
      '<|tool_call_',
      '<|tool_call',
      '<|begin_tool_call',
      '<|end_tool_call',
      '<|tool_begin',
      '<|tool_end',
      '<|tool',
      '<|',
    ];

    for (const prefix of prefixes) {
      const idx = text.lastIndexOf(prefix);
      if (idx === -1) {continue;}
      // If the text from idx doesn't contain the closing |>, it's incomplete
      const tail = text.slice(idx);
      if (!tail.includes('|>')) {return idx;}
    }

    return -1;
  }
}
