// MCP server definition provider tests

import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { BifrostMcpProvider, registerMcpProvider } from '../mcp';
import type { Logger } from '../log';
import type { BifrostEndpoint } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEndpoint(overrides: Partial<BifrostEndpoint> = {}): BifrostEndpoint {
  return {
    shortname: 'default',
    url: 'http://localhost:8080/openai/v1',
    ...overrides,
  };
}

// Cast a plain object to Logger — private members (_outputChannel, _write)
// are not needed for unit tests; all test assertions go through the public API.
function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    show: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
  } as unknown as Logger;
}

const FAKE_TOKEN = {} as vscode.CancellationToken;

// ─── BifrostMcpProvider ───────────────────────────────────────────────────────

describe('BifrostMcpProvider', () => {
  const userAgent = 'test-ua/1';

  it('provideMcpServerDefinitions returns one definition per endpoint', () => {
    const logger = makeLogger();
    const provider = new BifrostMcpProvider(userAgent, logger);
    provider.refresh([makeEndpoint(), makeEndpoint({ shortname: 'beta', url: 'https://beta.example.com/openai/v1' })]);

    const defs = provider.provideMcpServerDefinitions(FAKE_TOKEN) as vscode.McpHttpServerDefinition[];

    expect(defs).toHaveLength(2);
  });

  it('derives label as "Bifrost (<shortname>)"', () => {
    const logger = makeLogger();
    const provider = new BifrostMcpProvider(userAgent, logger);
    provider.refresh([makeEndpoint({ shortname: 'default' })]);

    const [def] = provider.provideMcpServerDefinitions(FAKE_TOKEN) as vscode.McpHttpServerDefinition[];

    expect(def.label).toBe('Bifrost (default)');
  });

  it('derives URI as origin/mcp — strips /openai/v1 path', () => {
    const logger = makeLogger();
    const provider = new BifrostMcpProvider(userAgent, logger);
    provider.refresh([makeEndpoint({ url: 'http://localhost:8080/openai/v1' })]);

    const [def] = provider.provideMcpServerDefinitions(FAKE_TOKEN) as vscode.McpHttpServerDefinition[];

    expect(def.uri.toString()).toBe('http://localhost:8080/mcp');
  });

  it('gives each definition a distinct label and URI for multiple endpoints', () => {
    const logger = makeLogger();
    const provider = new BifrostMcpProvider(userAgent, logger);
    provider.refresh([
      makeEndpoint({ shortname: 'alpha', url: 'http://alpha.example.com/openai/v1' }),
      makeEndpoint({ shortname: 'beta',  url: 'https://beta.example.com/openai/v1' }),
    ]);

    const defs = provider.provideMcpServerDefinitions(FAKE_TOKEN) as vscode.McpHttpServerDefinition[];

    expect(defs.map(d => d.label)).toEqual(['Bifrost (alpha)', 'Bifrost (beta)']);
    expect(defs.map(d => d.uri.toString())).toEqual([
      'http://alpha.example.com/mcp',
      'https://beta.example.com/mcp',
    ]);
  });

  it('sets Authorization: Bearer header for sk-bf-* key', () => {
    const logger = makeLogger();
    const provider = new BifrostMcpProvider(userAgent, logger);
    provider.refresh([makeEndpoint({ virtualKey: 'sk-bf-abc123' })]);

    const [def] = provider.provideMcpServerDefinitions(FAKE_TOKEN) as vscode.McpHttpServerDefinition[];

    expect(def.headers?.['Authorization']).toBe('Bearer sk-bf-abc123');
    expect(def.headers?.['x-bf-vk']).toBeUndefined();
  });

  it('sets x-bf-vk header for a legacy key', () => {
    const logger = makeLogger();
    const provider = new BifrostMcpProvider(userAgent, logger);
    provider.refresh([makeEndpoint({ virtualKey: 'vk-legacy-key' })]);

    const [def] = provider.provideMcpServerDefinitions(FAKE_TOKEN) as vscode.McpHttpServerDefinition[];

    expect(def.headers?.['x-bf-vk']).toBe('vk-legacy-key');
    expect(def.headers?.['Authorization']).toBeUndefined();
  });

  it('sets only User-Agent when endpoint has no virtual key', () => {
    const logger = makeLogger();
    const provider = new BifrostMcpProvider(userAgent, logger);
    provider.refresh([makeEndpoint()]);

    const [def] = provider.provideMcpServerDefinitions(FAKE_TOKEN) as vscode.McpHttpServerDefinition[];

    expect(def.headers?.['User-Agent']).toBe(userAgent);
    expect(def.headers?.['Authorization']).toBeUndefined();
    expect(def.headers?.['x-bf-vk']).toBeUndefined();
  });

  it('returns empty array when no endpoints are set', () => {
    const logger = makeLogger();
    const provider = new BifrostMcpProvider(userAgent, logger);

    const defs = provider.provideMcpServerDefinitions(FAKE_TOKEN) as vscode.McpHttpServerDefinition[];

    expect(defs).toHaveLength(0);
  });

  it('fires onDidChangeMcpServerDefinitions when refresh() is called', () => {
    const logger = makeLogger();
    const provider = new BifrostMcpProvider(userAgent, logger);
    const listener = vi.fn();
    provider.onDidChangeMcpServerDefinitions(listener);

    provider.refresh([makeEndpoint()]);

    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ─── registerMcpProvider ─────────────────────────────────────────────────────

describe('registerMcpProvider', () => {
  const userAgent = 'test-ua/1';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls registerMcpServerDefinitionProvider and returns provider + disposable', () => {
    const spy = vi.spyOn(vscode.lm, 'registerMcpServerDefinitionProvider');
    const logger = makeLogger();

    const { provider, disposable } = registerMcpProvider(userAgent, logger);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(provider).toBeInstanceOf(BifrostMcpProvider);
    expect(disposable).toHaveProperty('dispose');
  });

  it('does not throw when registerMcpServerDefinitionProvider throws; logs warning', () => {
    vi.spyOn(vscode.lm, 'registerMcpServerDefinitionProvider').mockImplementation(() => {
      throw new Error('API unavailable');
    });
    const logger = makeLogger();

    const { provider, disposable } = registerMcpProvider(userAgent, logger);

    expect(provider).toBeInstanceOf(BifrostMcpProvider);
    expect(disposable).toHaveProperty('dispose');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('API unavailable'));
  });
});
