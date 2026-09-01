// Tests for model discovery, filtering, and mapping

import { describe, expect, it, vi } from 'vitest';
import { fetchModelsForEndpoint, isChatModel, mapModelToChatInformation } from '../models';
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

  it('uses context_length as fallback for max_input_tokens', () => {
    const model = makeModel({ context_length: 64_000, max_input_tokens: undefined });
    const info = mapModelToChatInformation(model, 'ep');
    expect(info.maxInputTokens).toBe(64_000);
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
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      callCount++;
      if (callCount === 1) {
        // First call to /openai/v1/models → 401
        return Promise.resolve({ ok: false, status: 401, json: async () => ({}), text: async () => '' });
      }
      // Second call to /v1/models → success
      expect(url).toContain('/v1/models');
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [fakeModel] }), text: async () => '' });
    }));
    try {
      const result = await fetchModelsForEndpoint(endpointWithKey, 'ua', fakeLogger as never);
      expect(result.fallbackUsed).toBe(true);
      expect(result.models).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
