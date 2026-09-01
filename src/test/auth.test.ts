// Authentication tests

import { describe, expect, it } from 'vitest';
import {
  buildRequestHeaders,
  dashboardUrl,
  fallbackV1ModelsBase,
  isInsecureRemoteHttp,
  isLoopbackUrl,
  listingAbortSignal,
  normalizeBaseUrl,
  resolveAuthMode,
} from '../auth';

// ─── resolveAuthMode ──────────────────────────────────────────────────────────

describe('resolveAuthMode', () => {
  it('returns bearer for sk-bf-* key', () => {
    expect(resolveAuthMode({ virtualKey: 'sk-bf-test123' })).toBe('bearer');
  });

  it('returns x-bf-vk for legacy key', () => {
    expect(resolveAuthMode({ virtualKey: 'x-bf-vk-legacy-key' })).toBe('x-bf-vk');
  });

  it('returns auto when no virtual key', () => {
    expect(resolveAuthMode({})).toBe('auto');
  });

  it('returns explicit authMode when set (non-auto)', () => {
    expect(resolveAuthMode({ authMode: 'both', virtualKey: 'sk-bf-x' })).toBe('both');
    expect(resolveAuthMode({ authMode: 'x-bf-vk', virtualKey: 'sk-bf-x' })).toBe('x-bf-vk');
  });
});

// ─── buildRequestHeaders ─────────────────────────────────────────────────────

describe('buildRequestHeaders', () => {
  it('returns only User-Agent when no virtual key', () => {
    const h = buildRequestHeaders({}, 'test-ua/1');
    expect(h['User-Agent']).toBe('test-ua/1');
    expect(h['Authorization']).toBeUndefined();
    expect(h['x-bf-vk']).toBeUndefined();
  });

  it('sets Authorization header for bearer key', () => {
    const h = buildRequestHeaders({ virtualKey: 'sk-bf-abc' }, 'ua');
    expect(h['Authorization']).toBe('Bearer sk-bf-abc');
    expect(h['x-bf-vk']).toBeUndefined();
  });

  it('sets x-bf-vk header for legacy key', () => {
    const h = buildRequestHeaders({ virtualKey: 'legacykey' }, 'ua');
    expect(h['x-bf-vk']).toBe('legacykey');
    expect(h['Authorization']).toBeUndefined();
  });

  it('sets both headers when authMode=both', () => {
    const h = buildRequestHeaders({ virtualKey: 'sk-bf-abc', authMode: 'both' }, 'ua');
    expect(h['Authorization']).toBe('Bearer sk-bf-abc');
    expect(h['x-bf-vk']).toBe('sk-bf-abc');
  });
});

// ─── normalizeBaseUrl ─────────────────────────────────────────────────────────

describe('normalizeBaseUrl', () => {
  it('appends /openai/v1 to bare origin', () => {
    expect(normalizeBaseUrl('http://localhost:8080')).toBe('http://localhost:8080/openai/v1');
  });

  it('keeps /openai/v1 as-is', () => {
    expect(normalizeBaseUrl('http://localhost:8080/openai/v1')).toBe('http://localhost:8080/openai/v1');
  });

  it('converts /openai to /openai/v1', () => {
    expect(normalizeBaseUrl('http://localhost:8080/openai')).toBe('http://localhost:8080/openai/v1');
  });

  it('converts /v1 to /openai/v1', () => {
    expect(normalizeBaseUrl('http://localhost:8080/v1')).toBe('http://localhost:8080/openai/v1');
  });

  it('strips trailing slashes', () => {
    expect(normalizeBaseUrl('http://localhost:8080/openai/v1/')).toBe('http://localhost:8080/openai/v1');
  });

  it('strips /chat/completions suffix', () => {
    expect(normalizeBaseUrl('http://localhost:8080/openai/v1/chat/completions')).toBe('http://localhost:8080/openai/v1');
  });

  it('strips /models suffix', () => {
    expect(normalizeBaseUrl('http://localhost:8080/openai/v1/models')).toBe('http://localhost:8080/openai/v1');
  });

  it('throws for non-http protocols', () => {
    expect(() => normalizeBaseUrl('ftp://example.com')).toThrow(/Invalid protocol/);
  });

  it('throws for empty string', () => {
    expect(() => normalizeBaseUrl('')).toThrow();
  });
});

// ─── isLoopbackUrl ────────────────────────────────────────────────────────────

describe('isLoopbackUrl', () => {
  it('returns true for localhost variants', () => {
    expect(isLoopbackUrl('http://localhost:8080')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1:8080')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:8080')).toBe(true);
  });

  it('returns false for remote hosts', () => {
    expect(isLoopbackUrl('http://example.com')).toBe(false);
  });

  it('returns false for invalid URLs', () => {
    expect(isLoopbackUrl('not a url')).toBe(false);
  });
});

// ─── isInsecureRemoteHttp ─────────────────────────────────────────────────────

describe('isInsecureRemoteHttp', () => {
  it('returns true for remote HTTP', () => {
    expect(isInsecureRemoteHttp('http://example.com/api')).toBe(true);
  });

  it('returns false for HTTPS remote', () => {
    expect(isInsecureRemoteHttp('https://example.com/api')).toBe(false);
  });

  it('returns false for localhost HTTP', () => {
    expect(isInsecureRemoteHttp('http://localhost:8080/api')).toBe(false);
  });

  it('returns false for invalid URL', () => {
    expect(isInsecureRemoteHttp('not a url')).toBe(false);
  });
});

// ─── fallbackV1ModelsBase ─────────────────────────────────────────────────────

describe('fallbackV1ModelsBase', () => {
  it('replaces /openai/v1 with /v1', () => {
    expect(fallbackV1ModelsBase('http://localhost:8080/openai/v1')).toBe('http://localhost:8080/v1');
  });

  it('leaves other paths unchanged', () => {
    expect(fallbackV1ModelsBase('http://localhost:8080/v1')).toBe('http://localhost:8080/v1');
  });
});

// ─── dashboardUrl ─────────────────────────────────────────────────────────────

describe('dashboardUrl', () => {
  it('extracts the origin from a full URL', () => {
    expect(dashboardUrl('http://localhost:8080/openai/v1')).toBe('http://localhost:8080');
    expect(dashboardUrl('https://api.example.com/openai/v1')).toBe('https://api.example.com');
  });

  it('returns the raw string on invalid URL', () => {
    expect(dashboardUrl('not a url')).toBe('not a url');
  });
});

// ─── listingAbortSignal ───────────────────────────────────────────────────────

describe('listingAbortSignal', () => {
  it('returns an AbortSignal that is not yet aborted', () => {
    const signal = listingAbortSignal();
    expect(signal.aborted).toBe(false);
  });
});
