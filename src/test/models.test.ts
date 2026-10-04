// Tests for model discovery, filtering, and mapping

import { describe, expect, it, vi } from 'vitest';
import {
  fetchModelsForEndpoint,
  isChatModel,
  mapModelToChatInformation,
  resolveChatTokenLimits,
} from '../models';
import type { BifrostEndpoint, BifrostModel } from '../types';

function makeModel(overrides: Partial<BifrostModel> = {}): BifrostModel {
  return {
    id: 'openai/gpt-4o',
    name: 'GPT-4o',
    ...overrides,
  };
}

// ─── isChatModel ──────────────────────────────────────────────────────────────

describe('isChatModel', () => {
  it('returns true when supported_methods includes chat.completions', () => {
    const model = makeModel({ supported_methods: ['chat.completions'] });
    expect(isChatModel(model)).toBe(true);
  });

  it('returns true when architecture modality includes text', () => {
    const model = makeModel({ architecture: { modality: ['text->text'] } });
    expect(isChatModel(model)).toBe(true);
  });

  it('accepts architecture.modality as a string from the Bifrost catalog', () => {
    const model = makeModel({ architecture: { modality: 'text->text' } });
    expect(isChatModel(model)).toBe(true);
  });

  it('returns true when output_modalities includes text', () => {
    const model = makeModel({
      architecture: { output_modalities: ['text'] },
    });
    expect(isChatModel(model)).toBe(true);
  });

  it('returns true for model IDs containing "gpt"', () => {
    const model = makeModel({ id: 'provider/gpt-4-turbo', supported_methods: [] });
    expect(isChatModel(model)).toBe(true);
  });

  it('returns true for model IDs containing "claude"', () => {
    const model = makeModel({ id: 'anthropic/claude-3-5-sonnet', supported_methods: [] });
    expect(isChatModel(model)).toBe(true);
  });

  it('returns true when nothing matches (keep by default, KD10)', () => {
    const model = makeModel({ id: 'some-embedding-model', supported_methods: [] });
    expect(isChatModel(model)).toBe(true);
  });
});

// ─── mapModelToChatInformation ────────────────────────────────────────────────

describe('mapModelToChatInformation', () => {
  it('builds id as {shortname}/{modelId}', () => {
    const model = makeModel({ id: 'gpt-4o' });
    const info = mapModelToChatInformation(model, 'myendpoint');
    expect(info.id).toBe('myendpoint/gpt-4o');
  });

  it('uses normalized_name when available', () => {
    const model = makeModel({ normalized_name: 'GPT-4o (normalized)' });
    const info = mapModelToChatInformation(model, 'ep');
    expect(info.name).toBe('GPT-4o (normalized)');
  });

  it('falls back to name then id for display name', () => {
    const noNorm = makeModel({ normalized_name: undefined, name: 'GPT-4o Name' });
    expect(mapModelToChatInformation(noNorm, 'ep').name).toBe('GPT-4o Name');

    const idOnly = makeModel({ normalized_name: undefined, name: '' });
    // empty name → falls through to id
    const infoIdOnly = mapModelToChatInformation(idOnly, 'ep');
    expect(infoIdOnly.name).toBeTruthy();
  });

  it('sets family to "bifrost"', () => {
    const info = mapModelToChatInformation(makeModel(), 'ep');
    expect(info.family).toBe('bifrost');
  });

  it('uses catalog context lengths', () => {
    const model = makeModel({ max_input_tokens: 32_000, max_output_tokens: 8_000 });
    const info = mapModelToChatInformation(model, 'ep');
    expect(info.maxInputTokens).toBe(32_000);
    expect(info.maxOutputTokens).toBe(8_000);
    // The language models dialog shows maxInputTokens + maxOutputTokens.
    expect(info.maxInputTokens + info.maxOutputTokens).toBe(40_000);
  });

  it('falls back to defaults when token limits missing', () => {
    const model = makeModel({ max_input_tokens: undefined, max_output_tokens: undefined });
    const info = mapModelToChatInformation(model, 'ep');
    expect(info.maxInputTokens).toBeGreaterThan(0);
    expect(info.maxOutputTokens).toBeGreaterThan(0);
  });

  it('sets imageInput capability for models with vision input modality', () => {
    const model = makeModel({ architecture: { input_modalities: ['text', 'image'] } });
    const info = mapModelToChatInformation(model, 'ep');
    expect(info.capabilities?.imageInput).toBe(true);
  });

  it('does not set imageInput for text-only models', () => {
    const model = makeModel({ architecture: { input_modalities: ['text'] } });
    const info = mapModelToChatInformation(model, 'ep');
    expect(info.capabilities?.imageInput).toBe(false);
  });
});

// ─── mapModelToChatInformation — additional coverage ─────────────────────────

describe('mapModelToChatInformation – additional', () => {
  it('includes "Reasoning model" in tooltip when model.reasoning is true', () => {
    const model = makeModel({ reasoning: true });
    const info = mapModelToChatInformation(model, 'ep');
    expect(info.tooltip).toContain('Reasoning model');
  });

  it('includes "Tool calling: supported" in tooltip', () => {
    const info = mapModelToChatInformation(makeModel(), 'ep');
    expect(info.tooltip).toContain('Tool calling: supported');
  });

  it('includes "Vision: supported" in tooltip for vision models', () => {
    const model = makeModel({ architecture: { input_modalities: ['image', 'text'] } });
    const info = mapModelToChatInformation(model, 'ep');
    expect(info.tooltip).toContain('Vision: supported');
  });

  it('includes created date when model.created is set', () => {
    const model = makeModel({ created: 1_700_000_000 });
    const info = mapModelToChatInformation(model, 'ep');
    expect(info.tooltip).toMatch(/Created:/);
  });

  it('uses context_length as the context size shown in the dialog', () => {
    const model = makeModel({
      context_length: 64_000,
      max_input_tokens: undefined,
      max_output_tokens: 8_000,
    });
    const info = mapModelToChatInformation(model, 'ep');
    expect(info.maxOutputTokens).toBe(8_000);
    expect(info.maxInputTokens + info.maxOutputTokens).toBe(64_000);
  });

  it('reads context_window from the OpenAI-compatible model list', () => {
    const model = makeModel({ context_window: 200_000, max_output_tokens: 8_192 });
    const info = mapModelToChatInformation(model, 'ep');
    expect(info.maxOutputTokens).toBe(8_192);
    expect(info.maxInputTokens + info.maxOutputTokens).toBe(200_000);
    expect(info.tooltip).toContain('Context window:');
    expect(info.tooltip).toContain('200');
  });

  it('does not add max output on top of a context_length that already includes it', () => {
    const model = makeModel({
      context_length: 200_000,
      max_input_tokens: 200_000,
      max_output_tokens: 8_192,
    });
    const info = mapModelToChatInformation(model, 'ep');
    expect(info.maxInputTokens + info.maxOutputTokens).toBe(200_000);
    expect(info.maxOutputTokens).toBe(8_192);
  });

  it('prefers the smaller upstream window from top_provider', () => {
    const model = makeModel({
      context_length: 1_000_000,
      max_output_tokens: 8_192,
      top_provider: { context_length: 256_000, max_completion_tokens: 8_192 },
    });
    const limits = resolveChatTokenLimits(model);
    expect(limits.contextWindow).toBe(256_000);
    expect(limits.maxInputTokens + limits.maxOutputTokens).toBe(256_000);
  });

  it('reads a context suffix from the model id when the catalog omits limits', () => {
    const model = makeModel({ id: 'local/llama-3.1-70b-128k', name: 'Llama' });
    const info = mapModelToChatInformation(model, 'ep');
    expect(info.maxInputTokens + info.maxOutputTokens).toBe(128_000);
  });

  it('applies a manual limit and ignores a stale catalog snapshot', () => {
    const endpoint = {
      shortname: 'ep',
      url: 'http://localhost:8080/openai/v1',
      modelTokenLimits: [
        {
          modelId: 'openai/gpt-4o',
          maxInputTokens: 32_000,
          maxOutputTokens: 1024,
          source: 'catalog' as const,
        },
      ],
    };
    const fromCatalog = mapModelToChatInformation(
      makeModel({ context_window: 200_000, max_output_tokens: 8_192 }),
      'ep',
      endpoint,
    );
    expect(fromCatalog.maxInputTokens + fromCatalog.maxOutputTokens).toBe(200_000);

    const manual = mapModelToChatInformation(makeModel({ context_window: 200_000 }), 'ep', {
      ...endpoint,
      modelTokenLimits: [
        {
          modelId: 'openai/gpt-4o',
          maxInputTokens: 50_000,
          maxOutputTokens: 1_000,
          source: 'manual' as const,
        },
      ],
    });
    expect(manual.maxInputTokens).toBe(50_000);
    expect(manual.maxOutputTokens).toBe(1_000);
  });

  it('uses the loaded Lemonade window and ignores a larger manual limit when passthrough is on', () => {
    const model = makeModel({
      id: 'Lemonade/Qwen3',
      name: 'Qwen3',
      alias: 'Qwen3.8-27B-GGUF-UD-Q4_K_XL',
      context_length: 131_072,
      max_context_window: 262_144,
      recipe_options: { ctx_size: 131_072 },
    });
    const info = mapModelToChatInformation(model, 'Bifrost', {
      shortname: 'Bifrost',
      url: 'https://bifrost.example/openai/v1',
      passthroughHyperparameters: true,
      modelTokenLimits: [
        {
          modelId: 'Lemonade/Qwen3',
          maxInputTokens: 65_536,
          maxOutputTokens: 4_096,
          source: 'manual' as const,
        },
      ],
    });
    expect(info.maxInputTokens + info.maxOutputTokens).toBe(131_072);
    expect(info.maxOutputTokens).toBe(16_000);
    expect(info.maxInputTokens).toBe(131_072 - 16_000);
  });

  it('treats recipe_options.ctx_size as the loaded window when it is smaller than the architecture max', () => {
    const limits = resolveChatTokenLimits(
      makeModel({
        id: 'Lemonade/Qwen3-4B-Instruct-2507-GGUF',
        context_length: 65_536,
        max_context_window: 262_144,
        recipe_options: { ctx_size: 65_536 },
      }),
    );
    expect(limits.contextWindow).toBe(65_536);
    expect(limits.maxInputTokens + limits.maxOutputTokens).toBe(65_536);
    expect(limits.fromUpstream).toBe(true);
  });

  it('uses the smaller of context_length and recipe ctx_size', () => {
    const limits = resolveChatTokenLimits(
      makeModel({
        id: 'local/small',
        context_length: 65_536,
        recipe_options: { ctx_size: 8_192 },
      }),
    );
    expect(limits.contextWindow).toBe(8_192);
    expect(limits.maxInputTokens + limits.maxOutputTokens).toBe(8_192);
  });

  it('does not treat max_context_window alone as the loaded window', () => {
    const limits = resolveChatTokenLimits(
      makeModel({ id: 'Lemonade/Qwen3', max_context_window: 262_144 }),
    );
    expect(limits.fromUpstream).toBe(false);
    expect(limits.contextWindow).toBe(128_000);
  });

  it('reads a numeric ctx_size string and ignores auto', () => {
    const numeric = resolveChatTokenLimits(
      makeModel({ id: 'Lemonade/Qwen3', recipe_options: { ctx_size: '65536' } }),
    );
    expect(numeric.contextWindow).toBe(65_536);

    const auto = resolveChatTokenLimits(
      makeModel({ id: 'Lemonade/Qwen3', recipe_options: { ctx_size: 'auto' } }),
    );
    expect(auto.fromUpstream).toBe(false);
    expect(auto.contextWindow).toBe(128_000);
  });

  it('shrinks an inferred output reserve so a small loaded window still has prompt room', () => {
    const limits = resolveChatTokenLimits(
      makeModel({ id: 'Lemonade/granite-docling', context_length: 4_096 }),
    );
    expect(limits.contextWindow).toBe(4_096);
    expect(limits.maxOutputTokens).toBe(2_048);
    expect(limits.maxInputTokens).toBe(2_048);
  });

  it('clamps a manual limit so input plus output cannot exceed the loaded window', () => {
    const info = mapModelToChatInformation(
      makeModel({ id: 'Lemonade/Qwen3-4B', context_length: 65_536 }),
      'ep',
      {
        shortname: 'ep',
        url: 'http://localhost:8080/openai/v1',
        passthroughHyperparameters: false,
        modelTokenLimits: [
          {
            modelId: 'Lemonade/Qwen3-4B',
            maxInputTokens: 65_536,
            maxOutputTokens: 4_096,
            source: 'manual' as const,
          },
        ],
      },
    );
    expect(info.maxOutputTokens).toBe(4_096);
    expect(info.maxInputTokens).toBe(65_536 - 4_096);
    expect(info.maxInputTokens + info.maxOutputTokens).toBe(65_536);
  });

  it('keeps a manual limit when passthrough is on and the catalog has no window', () => {
    const model = makeModel({ id: 'Lemonade/Qwen3', name: 'Qwen3' });
    const endpoint = {
      shortname: 'Bifrost',
      url: 'https://bifrost.example/openai/v1',
      passthroughHyperparameters: true,
      modelTokenLimits: [
        {
          modelId: 'Lemonade/Qwen3',
          maxInputTokens: 65_536,
          maxOutputTokens: 4_096,
          source: 'manual' as const,
        },
      ],
    };
    const info = mapModelToChatInformation(model, 'Bifrost', endpoint);
    expect(info.maxInputTokens).toBe(65_536);
    expect(info.maxOutputTokens).toBe(4_096);
    expect(info.maxInputTokens + info.maxOutputTokens).toBe(69_632);

    const detected = mapModelToChatInformation(model, 'Bifrost', {
      ...endpoint,
      modelTokenLimits: [],
    });
    expect(detected.maxInputTokens + detected.maxOutputTokens).toBe(128_000);
  });

  it('does not apply the endpoint output cap while passthrough is on', () => {
    const model = makeModel({ context_length: 128_000, max_output_tokens: 16_384 });
    const info = mapModelToChatInformation(model, 'ep', {
      shortname: 'ep',
      url: 'http://localhost:8080/openai/v1',
      passthroughHyperparameters: true,
      maxOutputTokens: 4_096,
    });
    expect(info.maxOutputTokens).toBe(16_384);
    expect(info.maxInputTokens + info.maxOutputTokens).toBe(128_000);
  });

  it('keeps the context window when an endpoint output cap is set', () => {
    const model = makeModel({ context_length: 128_000, max_output_tokens: 16_384 });
    const info = mapModelToChatInformation(model, 'ep', {
      shortname: 'ep',
      url: 'http://localhost:8080/openai/v1',
      maxOutputTokens: 4_096,
    });
    expect(info.maxOutputTokens).toBe(4_096);
    expect(info.maxInputTokens + info.maxOutputTokens).toBe(128_000);
  });
});

// ─── fetchModelsForEndpoint ───────────────────────────────────────────────────

const fakeEndpoint: BifrostEndpoint = {
  shortname: 'local',
  url: 'http://localhost:8080/openai/v1',
};

const fakeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const fakeModel: BifrostModel = { id: 'gpt-4o', name: 'GPT-4o' };

function makeFetch(pages: BifrostModel[][], opts: { status?: number } = {}) {
  let call = 0;
  return vi.fn().mockImplementation(() => {
    const status = opts.status ?? 200;
    if (status !== 200) {
      return Promise.resolve({ ok: false, status, json: async () => ({}), text: async () => '' });
    }
    const data = pages[call] ?? [];
    call++;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ data }),
      text: async () => '',
    });
  });
}

describe('fetchModelsForEndpoint', () => {
  it('returns models from a single page', async () => {
    vi.stubGlobal('fetch', makeFetch([[fakeModel]]));
    try {
      const result = await fetchModelsForEndpoint(fakeEndpoint, 'ua', fakeLogger as never);
      expect(result.models).toHaveLength(1);
      expect(result.models[0].id).toBe('gpt-4o');
      expect(result.truncated).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns empty array when fetch returns no models', async () => {
    vi.stubGlobal('fetch', makeFetch([[]]));
    try {
      const result = await fetchModelsForEndpoint(fakeEndpoint, 'ua', fakeLogger as never);
      expect(result.models).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('handles network errors gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    try {
      const result = await fetchModelsForEndpoint(fakeEndpoint, 'ua', fakeLogger as never);
      expect(result.models).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('handles non-ok HTTP response', async () => {
    vi.stubGlobal('fetch', makeFetch([], { status: 500 }));
    try {
      const result = await fetchModelsForEndpoint(fakeEndpoint, 'ua', fakeLogger as never);
      expect(result.models).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses fallback base URL on 401 when virtual key is present', async () => {
    const endpointWithKey = { ...fakeEndpoint, virtualKey: 'sk-bf-test' };
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        callCount++;
        if (callCount === 1) {
          // First call to /openai/v1/models → 401
          return Promise.resolve({
            ok: false,
            status: 401,
            json: async () => ({}),
            text: async () => '',
          });
        }
        // Second call to /v1/models → success
        expect(url).toContain('/v1/models');
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: [fakeModel] }),
          text: async () => '',
        });
      }),
    );
    try {
      const result = await fetchModelsForEndpoint(endpointWithKey, 'ua', fakeLogger as never);
      expect(result.fallbackUsed).toBe(true);
      expect(result.models).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('follows next_page_token and requests page_size', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        seen.push(url);
        if (url.includes('/openai/v1/models') && !url.includes('page_token=')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              data: [{ id: 'openai/gpt-4o', name: 'GPT-4o', context_window: 128_000 }],
              next_page_token: 'cursor-2',
            }),
          });
        }
        if (url.includes('page_token=cursor-2')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              data: [{ id: 'anthropic/claude-sonnet-4', name: 'Claude', context_window: 200_000 }],
            }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        });
      }),
    );
    try {
      const result = await fetchModelsForEndpoint(fakeEndpoint, 'ua', fakeLogger as never);
      expect(seen.some(url => url.includes('page_size=200'))).toBe(true);
      expect(seen.some(url => url.includes('page_token=cursor-2'))).toBe(true);
      expect(result.models.map(model => model.id)).toEqual([
        'openai/gpt-4o',
        'anthropic/claude-sonnet-4',
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('merges max output from the native /v1 catalog onto OpenAI-compat rows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('/openai/v1/models')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              data: [{ id: 'openai/gpt-4o', name: 'GPT-4o', context_window: 128_000 }],
            }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: 'openai/gpt-4o',
                name: 'GPT-4o',
                context_length: 128_000,
                max_input_tokens: 128_000,
                max_output_tokens: 16_384,
                top_provider: { context_length: 128_000, max_completion_tokens: 16_384 },
              },
            ],
          }),
        });
      }),
    );
    try {
      const result = await fetchModelsForEndpoint(fakeEndpoint, 'ua', fakeLogger as never);
      expect(result.models).toHaveLength(1);
      expect(result.models[0].context_window).toBe(128_000);
      expect(result.models[0].max_output_tokens).toBe(16_384);
      const info = mapModelToChatInformation(result.models[0], 'local', fakeEndpoint);
      expect(info.maxOutputTokens).toBe(16_384);
      expect(info.maxInputTokens + info.maxOutputTokens).toBe(128_000);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reads Lemonade context from extra_fields.raw_response by alias', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('/openai/v1/models')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              data: [
                {
                  id: 'Lemonade/Qwen3',
                  name: 'Qwen3',
                  alias: 'Qwen3.8-27B-GGUF-UD-Q4_K_XL',
                },
              ],
              extra_fields: {
                raw_response: {
                  data: [
                    {
                      id: 'Qwen3.8-27B-GGUF-UD-Q4_K_XL',
                      context_length: 131_072,
                      max_context_window: 262_144,
                      recipe_options: { ctx_size: 131_072 },
                    },
                  ],
                },
              },
            }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        });
      }),
    );
    try {
      const result = await fetchModelsForEndpoint(fakeEndpoint, 'ua', fakeLogger as never);
      expect(result.models[0].context_length).toBe(131_072);
      const info = mapModelToChatInformation(result.models[0], 'local', fakeEndpoint);
      expect(info.maxInputTokens + info.maxOutputTokens).toBe(131_072);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reads a Lemonade catalog URL without sending the Bifrost key', async () => {
    const endpoint: BifrostEndpoint = {
      ...fakeEndpoint,
      virtualKey: 'sk-bf-test',
      passthroughHyperparameters: true,
      upstreamModelsUrl: 'http://lemonade.local:13305/v1',
    };
    const seen: Array<{ url: string; authorization?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init?: { headers?: Record<string, string> }) => {
        seen.push({ url, authorization: init?.headers?.Authorization });
        if (url.startsWith('http://lemonade.local')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              data: [
                {
                  id: 'Qwen3-Coder-Next-GGUF',
                  context_length: 262_144,
                  max_context_window: 262_144,
                  recipe_options: { ctx_size: 262_144 },
                },
              ],
            }),
          });
        }
        if (url.includes('/openai/v1/models')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              data: [
                {
                  id: 'Lemonade/Qwen3-Coder',
                  name: 'Qwen3-Coder',
                  alias: 'Qwen3-Coder-Next-GGUF',
                },
              ],
            }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        });
      }),
    );
    try {
      const result = await fetchModelsForEndpoint(endpoint, 'ua', fakeLogger as never);
      const upstreamCall = seen.find(call => call.url.startsWith('http://lemonade.local'));
      expect(upstreamCall?.url).toBe('http://lemonade.local:13305/v1/models');
      expect(upstreamCall?.authorization).toBeUndefined();
      expect(result.models[0].context_length).toBe(262_144);
      const info = mapModelToChatInformation(result.models[0], 'local', endpoint);
      expect(info.maxInputTokens + info.maxOutputTokens).toBe(262_144);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
