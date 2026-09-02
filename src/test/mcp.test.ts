// MCP server registration tests

import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { registerMcpServersForEndpoints } from '../mcp';
import type { BifrostEndpoint } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEndpoint(overrides: Partial<BifrostEndpoint> = {}): BifrostEndpoint {
  return {
    shortname: 'default',
    url: 'http://localhost:8080/openai/v1',
    ...overrides,
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    show: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
  };
}

// ─── registerMcpServersForEndpoints ──────────────────────────────────────────

describe('registerMcpServersForEndpoints', () => {
  const userAgent = 'test-ua/1';
  let registerSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    registerSpy = vi.spyOn(vscode.lm, 'registerMcpServer').mockReturnValue({ dispose: vi.fn() });
  });

  it('registers one MCP server for a single endpoint', () => {
    const logger = makeLogger();
    const endpoint = makeEndpoint();

    const disposables = registerMcpServersForEndpoints([endpoint], userAgent, logger);

    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(disposables).toHaveLength(1);
  });

  it('registers correct name and transport type', () => {
    const logger = makeLogger();
    const endpoint = makeEndpoint({ shortname: 'default' });

    registerMcpServersForEndpoints([endpoint], userAgent, logger);

    const call = registerSpy.mock.calls[0][0];
    expect(call.name).toBe('Bifrost (default)');
    expect(call.transport.type).toBe('http');
  });

  it('derives MCP URL as origin/mcp — strips /openai/v1 path', () => {
    const logger = makeLogger();
    const endpoint = makeEndpoint({ url: 'http://localhost:8080/openai/v1' });

    registerMcpServersForEndpoints([endpoint], userAgent, logger);

    const call = registerSpy.mock.calls[0][0];
    const url = call.transport.url.toString();
    expect(url).toBe('http://localhost:8080/mcp');
  });

  it('registers one disposable per endpoint for multiple endpoints', () => {
    const logger = makeLogger();
    const endpoints = [
      makeEndpoint({ shortname: 'alpha', url: 'http://alpha.example.com/openai/v1' }),
      makeEndpoint({ shortname: 'beta',  url: 'https://beta.example.com/openai/v1' }),
      makeEndpoint({ shortname: 'gamma', url: 'https://gamma.example.com/openai/v1' }),
    ];

    const disposables = registerMcpServersForEndpoints(endpoints, userAgent, logger);

    expect(registerSpy).toHaveBeenCalledTimes(3);
    expect(disposables).toHaveLength(3);
  });

  it('gives each endpoint a distinct name and MCP URL', () => {
    const logger = makeLogger();
    const endpoints = [
      makeEndpoint({ shortname: 'alpha', url: 'http://alpha.example.com/openai/v1' }),
      makeEndpoint({ shortname: 'beta',  url: 'https://beta.example.com/openai/v1' }),
    ];

    registerMcpServersForEndpoints(endpoints, userAgent, logger);

    const names = registerSpy.mock.calls.map(c => c[0].name);
    const urls  = registerSpy.mock.calls.map(c => c[0].transport.url.toString());

    expect(names).toEqual(['Bifrost (alpha)', 'Bifrost (beta)']);
    expect(urls).toEqual(['http://alpha.example.com/mcp', 'https://beta.example.com/mcp']);
  });

  it('sets Authorization: Bearer header for sk-bf-* key', () => {
    const logger = makeLogger();
    const endpoint = makeEndpoint({ virtualKey: 'sk-bf-abc123' });

    registerMcpServersForEndpoints([endpoint], userAgent, logger);

    const headers = registerSpy.mock.calls[0][0].transport.headers;
    expect(headers['Authorization']).toBe('Bearer sk-bf-abc123');
    expect(headers['x-bf-vk']).toBeUndefined();
  });

  it('sets x-bf-vk header for a legacy key', () => {
    const logger = makeLogger();
    const endpoint = makeEndpoint({ virtualKey: 'vk-legacy-key' });

    registerMcpServersForEndpoints([endpoint], userAgent, logger);

    const headers = registerSpy.mock.calls[0][0].transport.headers;
    expect(headers['x-bf-vk']).toBe('vk-legacy-key');
    expect(headers['Authorization']).toBeUndefined();
  });

  it('sets only User-Agent header when endpoint has no virtual key', () => {
    const logger = makeLogger();
    const endpoint = makeEndpoint(); // no virtualKey

    registerMcpServersForEndpoints([endpoint], userAgent, logger);

    const headers = registerSpy.mock.calls[0][0].transport.headers;
    expect(headers['User-Agent']).toBe(userAgent);
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['x-bf-vk']).toBeUndefined();
  });

  it('does not throw when registerMcpServer throws; logs a warning; returns empty array', () => {
    const logger = makeLogger();
    registerSpy.mockImplementation(() => { throw new Error('API unavailable'); });

    const endpoint = makeEndpoint();
    const disposables = registerMcpServersForEndpoints([endpoint], userAgent, logger);

    expect(disposables).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('API unavailable'),
      'default',
    );
  });

  it('skips a failing endpoint but still registers the remaining ones', () => {
    const logger = makeLogger();
    const mockDisposable = { dispose: vi.fn() };
    registerSpy
      .mockImplementationOnce(() => { throw new Error('oops'); })
      .mockReturnValueOnce(mockDisposable);

    const endpoints = [
      makeEndpoint({ shortname: 'bad',  url: 'http://bad.example.com/openai/v1' }),
      makeEndpoint({ shortname: 'good', url: 'https://good.example.com/openai/v1' }),
    ];

    const disposables = registerMcpServersForEndpoints(endpoints, userAgent, logger);

    expect(disposables).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('returns an empty array for an empty endpoint list', () => {
    const logger = makeLogger();
    const disposables = registerMcpServersForEndpoints([], userAgent, logger);

    expect(registerSpy).not.toHaveBeenCalled();
    expect(disposables).toHaveLength(0);
  });
});
