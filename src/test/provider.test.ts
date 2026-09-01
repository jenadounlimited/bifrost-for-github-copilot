// Tests for BifrostChatProvider

import { describe, expect, it, vi } from 'vitest';
import { BifrostChatProvider } from '../provider';
import type { BifrostEndpoint } from '../types';

// Minimal SecretStorage mock
function makeSecrets(initial: Record<string, string> = {}): import('vscode').SecretStorage {
  const store = { ...initial };
  return {
    get: (k: string) => Promise.resolve(store[k]),
    store: (k: string, v: string) => { store[k] = v; return Promise.resolve(); },
    delete: (k: string) => { delete store[k]; return Promise.resolve(); },
    keys: () => Promise.resolve(Object.keys(store)),
    onDidChange: { event: () => ({ dispose: () => {} }) } as never,
  };
}

// Minimal OutputChannel mock
const outputChannel = {
  appendLine: vi.fn(),
  show: vi.fn(),
  clear: vi.fn(),
  dispose: vi.fn(),
} as unknown as import('vscode').OutputChannel;

// Minimal Logger mock
class MockLogger {
  info = vi.fn();
  warn = vi.fn();
  error = vi.fn();
}

function makeProvider(endpoints: BifrostEndpoint[] = []) {
  const secrets = makeSecrets({
    'bifrost.endpoints': JSON.stringify(endpoints),
  });
  const logger = new MockLogger() as never;
  return new BifrostChatProvider(secrets, outputChannel, 'test-agent/1.0', logger);
}

// ─── getEndpoints / setEndpoints ──────────────────────────────────────────────

describe('BifrostChatProvider.getEndpoints', () => {
  it('returns empty array when no endpoints stored', async () => {
    const provider = makeProvider();
    const endpoints = await provider.getEndpoints();
    expect(endpoints).toEqual([]);
  });

  it('returns stored endpoints', async () => {
    const stored: BifrostEndpoint[] = [
      { shortname: 'local', url: 'http://localhost:8080/openai/v1' },
    ];
    const provider = makeProvider(stored);
    const result = await provider.getEndpoints();
    expect(result).toHaveLength(1);
    expect(result[0].shortname).toBe('local');
  });

  it('returns empty array when stored value is malformed JSON', async () => {
    const secrets = makeSecrets({ 'bifrost.endpoints': 'NOT JSON' });
    const provider = new BifrostChatProvider(secrets, outputChannel, 'ua', new MockLogger() as never);
    const result = await provider.getEndpoints();
    expect(result).toEqual([]);
  });

  it('returns empty array when stored value is not an array', async () => {
    const secrets = makeSecrets({ 'bifrost.endpoints': '{"key":"value"}' });
    const provider = new BifrostChatProvider(secrets, outputChannel, 'ua', new MockLogger() as never);
    const result = await provider.getEndpoints();
    expect(result).toEqual([]);
  });
});

describe('BifrostChatProvider.setEndpoints', () => {
  it('persists endpoints to SecretStorage', async () => {
    const provider = makeProvider();
    const endpoints: BifrostEndpoint[] = [{ shortname: 'remote', url: 'https://api.example.com/openai/v1' }];
    await provider.setEndpoints(endpoints);
    const result = await provider.getEndpoints();
    expect(result).toHaveLength(1);
    expect(result[0].shortname).toBe('remote');
  });
});

// ─── setEphemeralFilter ───────────────────────────────────────────────────────

describe('BifrostChatProvider.setEphemeralFilter', () => {
  it('does not throw when called', () => {
    const provider = makeProvider();
    expect(() => provider.setEphemeralFilter(false)).not.toThrow();
    expect(() => provider.setEphemeralFilter(true)).not.toThrow();
  });
});

// ─── provideTokenCount ────────────────────────────────────────────────────────

describe('BifrostChatProvider.provideTokenCount', () => {
  it('estimates token count for a plain string', async () => {
    const provider = makeProvider();
    const fakeModel = {} as import('vscode').LanguageModelChatInformation;
    const fakeToken = { isCancellationRequested: false, onCancellationRequested: vi.fn() } as never;

    const count = await provider.provideTokenCount(fakeModel, 'a'.repeat(400), fakeToken);
    expect(count).toBe(100); // 400/4
  });
});

// ─── provideLanguageModelChatResponse ────────────────────────────────────────

/**
 * Build a minimal streaming fetch mock that serves the given SSE body.
 */
function makeFetchMock(sseBody: string, status = 200) {
  const encoded = new TextEncoder().encode(sseBody);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const StreamCtor = (globalThis as any).ReadableStream as new (init: {
    start: (controller: { enqueue: (v: Uint8Array) => void; close: () => void }) => void;
  }) => { getReader: () => unknown };
  const stream = new StreamCtor({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => `HTTP ${status}`,
    body: stream,
  });
}

function makeCancellationToken(cancelled = false) {
  const listeners: (() => void)[] = [];
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: (fn: () => void) => { listeners.push(fn); return { dispose: () => {} }; },
    cancel: () => { listeners.forEach(fn => fn()); },
  } as never;
}

function makeProgress() {
  const parts: unknown[] = [];
  return { report: (p: unknown) => parts.push(p), parts };
}

function fakeModel(overrides: Partial<import('vscode').LanguageModelChatInformation> = {}): import('vscode').LanguageModelChatInformation {
  return {
    id: 'local/gpt-4o',
    name: 'GPT-4o',
    vendor: 'bifrost',
    version: '1',
    maxInputTokens: 128_000,
    maxOutputTokens: 4096,
    capabilities: {},
    ...overrides,
  } as never;
}

const basicSse =
  `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi!' }, finish_reason: 'stop' }] })}\n\n` +
  'data: [DONE]\n\n';

const endpoint: BifrostEndpoint = {
  shortname: 'local',
  url: 'http://localhost:8080/openai/v1',
};

describe('BifrostChatProvider.provideLanguageModelChatResponse', () => {
  it('throws when no endpoint is configured for the model', async () => {
    const provider = makeProvider([]); // no endpoints
    const progress = makeProgress();
    const token = makeCancellationToken();

    await expect(
      provider.provideLanguageModelChatResponse(
        fakeModel({ id: 'missing/model' }),
        [{ role: 1 /* User */, content: [{ value: 'hello' } as never] } as never],
        { tools: undefined, toolMode: undefined } as never,
        progress as never,
        token,
      ),
    ).rejects.toThrow(/No Bifrost endpoint configured/);
  });

  it('throws when tool count exceeds MAX_TOOLS_PER_REQUEST', async () => {
    const provider = makeProvider([endpoint]);
    const progress = makeProgress();
    const token = makeCancellationToken();
    const manyTools = Array.from({ length: 129 }, (_, i) => ({
      name: `tool_${i}`,
      description: 'a tool',
      inputSchema: { type: 'object', properties: {} },
    })) as never;

    await expect(
      provider.provideLanguageModelChatResponse(
        fakeModel(),
        [{ role: 1, content: [{ value: 'go' } as never] } as never],
        { tools: manyTools, toolMode: undefined } as never,
        progress as never,
        token,
      ),
    ).rejects.toThrow(/Too many tools/);
  });

  it('throws on HTTP error', async () => {
    const provider = makeProvider([endpoint]);
    const progress = makeProgress();
    const token = makeCancellationToken();

    const fetchMock = makeFetchMock('Unauthorized', 401);
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(
        provider.provideLanguageModelChatResponse(
          fakeModel(),
          [{ role: 1, content: [{ value: 'hello' } as never] } as never],
          { tools: undefined, toolMode: undefined } as never,
          progress as never,
          token,
        ),
      ).rejects.toThrow(/HTTP 401/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('streams text parts on success', async () => {
    const provider = makeProvider([endpoint]);
    const progress = makeProgress();
    const token = makeCancellationToken();

    const fetchMock = makeFetchMock(basicSse);
    vi.stubGlobal('fetch', fetchMock);

    try {
      await provider.provideLanguageModelChatResponse(
        fakeModel(),
        [{ role: 1, content: [{ value: 'hello' } as never] } as never],
        { tools: undefined, toolMode: undefined } as never,
        progress as never,
        token,
      );

      const { LanguageModelTextPart } = await import('vscode');
      const textParts = progress.parts.filter(p => p instanceof LanguageModelTextPart);
      expect(textParts.length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sets tool_choice to "any" when ToolMode.Required', async () => {
    const provider = makeProvider([endpoint]);
    const progress = makeProgress();
    const token = makeCancellationToken();

    const fetchMock = makeFetchMock(basicSse);
    vi.stubGlobal('fetch', fetchMock);

    try {
      await provider.provideLanguageModelChatResponse(
        fakeModel(),
        [{ role: 1, content: [{ value: 'go' } as never] } as never],
        {
          tools: [{ name: 'my_tool', description: 'x', inputSchema: {} }] as never,
          toolMode: 2, // LanguageModelChatToolMode.Required
        } as never,
        progress as never,
        token,
      );

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body) as Record<string, unknown>;
      expect(body.tool_choice).toBe('any');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ─── provideLanguageModelChatInformation ──────────────────────────────────────

describe('BifrostChatProvider.provideLanguageModelChatInformation', () => {
  it('returns empty array when no endpoints configured', async () => {
    const provider = makeProvider([]);
    const fakeToken = { isCancellationRequested: false, onCancellationRequested: vi.fn() } as never;
    const result = await provider.provideLanguageModelChatInformation({} as never, fakeToken);
    expect(result).toEqual([]);
  });

  it('returns model list from a configured endpoint', async () => {
    const endpoint: BifrostEndpoint = { shortname: 'local', url: 'http://localhost:8080/openai/v1' };
    const provider = makeProvider([endpoint]);
    const fakeToken = { isCancellationRequested: false, onCancellationRequested: vi.fn() } as never;

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'gpt-4o', name: 'GPT-4o' }] }),
    }));

    try {
      const result = await provider.provideLanguageModelChatInformation({} as never, fakeToken);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].id).toBe('local/gpt-4o');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('gracefully handles fetch errors and returns remaining models', async () => {
    const endpoint: BifrostEndpoint = { shortname: 'local', url: 'http://localhost:8080/openai/v1' };
    const provider = makeProvider([endpoint]);
    const fakeToken = { isCancellationRequested: false, onCancellationRequested: vi.fn() } as never;

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    try {
      const result = await provider.provideLanguageModelChatInformation({} as never, fakeToken);
      expect(result).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
