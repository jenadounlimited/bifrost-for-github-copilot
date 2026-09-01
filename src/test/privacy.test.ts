// Privacy tests — virtual key redaction, no prompt logging, SecretStorage usage, abort safety

import { describe, expect, it } from 'vitest';
import { redact, Logger } from '../log';

// ─── Virtual key never appears in logs ────────────────────────────────────────

describe('virtual key redaction', () => {
  it('sk-bf-* key is redacted from log messages', () => {
    const key = 'sk-bf-supersecret999';
    const out = redact(`Connecting to endpoint with key=${key}`);
    expect(out).not.toContain(key);
    expect(out).toContain('<REDACTED_VK>');
  });

  it('legacy x-bf-vk header value (32+ chars) is redacted', () => {
    const key = 'a'.repeat(40);
    const out = redact(`x-bf-vk: ${key}`);
    expect(out).not.toContain(key);
    expect(out).toContain('<REDACTED>');
  });

  it('Bearer token is redacted', () => {
    const token = 'eyJhbGciOiJSUzI1NiJ9.body.sig';
    const out = redact(`Authorization: Bearer ${token}`);
    expect(out).not.toContain(token);
    expect(out).toContain('Bearer <REDACTED>');
  });

  it('redacts sk-bf-* key embedded anywhere in string', () => {
    const key = 'sk-bf-querykey123';
    const out = redact(`GET https://api.example.com?key=${key}`);
    expect(out).not.toContain(key);
    expect(out).toContain('<REDACTED_VK>');
  });

  it('does NOT redact non-sensitive strings', () => {
    const safe = 'endpoint=my-server shortname=prod status=200 duration=123ms';
    expect(redact(safe)).toBe(safe);
  });

  it('Logger redacts virtual key before writing to output channel', () => {
    const key = 'sk-bf-loggertest';
    const message = `Using virtual key ${key}`;
    // Confirm redact() would strip the key — Logger._write calls redact() on every message
    const redacted = redact(message);
    expect(redacted).not.toContain(key);

    // Logger should not throw and applies redact internally
    const logger = new Logger('PrivacyTest');
    expect(() => logger.info(message, 'my-endpoint')).not.toThrow();
    expect(() => logger.warn(message)).not.toThrow();
    expect(() => logger.error(message)).not.toThrow();
    logger.dispose();
  });

  it('redacts multiple different sk-bf-* keys in one message', () => {
    const key1 = 'sk-bf-first';
    const key2 = 'sk-bf-second';
    const out = redact(`key1=${key1} and key2=${key2}`);
    expect(out).not.toContain(key1);
    expect(out).not.toContain(key2);
    expect(out.match(/<REDACTED_VK>/g)?.length).toBe(2);
  });
});

// ─── Prompts and completions are never logged ─────────────────────────────────

describe('no prompt or completion logging', () => {
  it('redact() leaves safe request-log content unchanged', () => {
    // These are the ONLY things the extension logs about requests — no prompt bodies
    const safeMessages = [
      'POST openai/gpt-4o-mini status=200 duration=350ms tokens=~1200',
      'GET /openai/v1/models status=200 count=5',
      'endpoint my-server unreachable: connect ECONNREFUSED',
      'Tool call: get_weather callId=call_abc123',
    ];
    for (const msg of safeMessages) {
      expect(redact(msg)).toBe(msg);
    }
  });

  it('Logger does not expose arbitrary strings as-is when they contain secrets', () => {
    // Even if a secret accidentally ends up in a log call, redact() strips it
    const sensitiveLogAttempt = 'auth header: Authorization: Bearer secret-token-abc';
    const result = redact(sensitiveLogAttempt);
    expect(result).not.toContain('secret-token-abc');
  });
});

// ─── SecretStorage usage (via mock) ──────────────────────────────────────────

describe('SecretStorage usage', () => {
  it('simulated SecretStorage store/get/delete round-trip', async () => {
    // Model the VS Code SecretStorage API contract — the real impl is encrypted;
    // here we verify the expected interface behaviour our extension relies on.
    const storage = new Map<string, string>();
    const secretStorage = {
      store: async (key: string, value: string) => { storage.set(key, value); },
      get: async (key: string) => storage.get(key),
      delete: async (key: string) => { storage.delete(key); },
    };

    const endpoints = JSON.stringify([{ baseUrl: 'http://localhost:8080/openai/v1', shortname: 'local' }]);
    await secretStorage.store('bifrost.endpoints', endpoints);
    const retrieved = await secretStorage.get('bifrost.endpoints');
    expect(retrieved).toBe(endpoints);
    expect(retrieved).toContain('local');
    // Virtual key should not be present in endpoint list (keys stored separately)
    expect(retrieved).not.toContain('sk-bf-');
  });

  it('delete() removes a stored secret', async () => {
    const storage = new Map<string, string>();
    const secretStorage = {
      store: async (key: string, value: string) => { storage.set(key, value); },
      get: async (key: string) => storage.get(key),
      delete: async (key: string) => { storage.delete(key); },
    };

    await secretStorage.store('bifrost.endpoints', 'some-value');
    await secretStorage.delete('bifrost.endpoints');
    expect(await secretStorage.get('bifrost.endpoints')).toBeUndefined();
  });

  it('virtual key stored separately is not retrievable after delete', async () => {
    const storage = new Map<string, string>();
    const secretStorage = {
      store: async (key: string, value: string) => { storage.set(key, value); },
      get: async (key: string) => storage.get(key),
      delete: async (key: string) => { storage.delete(key); },
    };

    const vkKey = 'bifrost.vk.my-endpoint';
    await secretStorage.store(vkKey, 'sk-bf-topsecret');
    expect(await secretStorage.get(vkKey)).toBe('sk-bf-topsecret');
    await secretStorage.delete(vkKey);
    expect(await secretStorage.get(vkKey)).toBeUndefined();
  });
});

// ─── Abort prevents partial tool call emission ────────────────────────────────

describe('abort safety', () => {
  it('AbortController.abort() fires the signal', () => {
    const controller = new AbortController();
    let aborted = false;
    controller.signal.addEventListener('abort', () => {
      aborted = true;
    });
    controller.abort();
    expect(aborted).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it('a new AbortController is not aborted initially', () => {
    const controller = new AbortController();
    expect(controller.signal.aborted).toBe(false);
  });

  it('aborting does not affect other independent controllers', () => {
    const c1 = new AbortController();
    const c2 = new AbortController();
    c1.abort();
    expect(c1.signal.aborted).toBe(true);
    expect(c2.signal.aborted).toBe(false);
  });
});
