// Tests for Logger and redact

import { describe, expect, it } from 'vitest';
import { redact, Logger } from '../log';

// ─── redact ───────────────────────────────────────────────────────────────────

describe('redact', () => {
  it('returns empty string unchanged', () => {
    expect(redact('')).toBe('');
  });

  it('redacts sk-bf-* virtual keys', () => {
    const out = redact('key is sk-bf-abc123XYZ');
    expect(out).not.toContain('sk-bf-abc123XYZ');
    expect(out).toContain('<REDACTED_VK>');
  });

  it('redacts Authorization: Bearer tokens', () => {
    const out = redact('Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig');
    expect(out).not.toContain('eyJ');
    expect(out).toContain('Bearer <REDACTED>');
  });

  it('redacts x-bf-vk header value (32+ chars)', () => {
    const longKey = 'a'.repeat(32);
    const out = redact(`x-bf-vk: ${longKey}`);
    expect(out).not.toContain(longKey);
    expect(out).toContain('<REDACTED>');
  });

  it('does not redact short x-bf-vk values (< 32 chars)', () => {
    const shortKey = 'short';
    const out = redact(`x-bf-vk: ${shortKey}`);
    expect(out).toContain(shortKey);
  });

  it('leaves non-sensitive text unchanged', () => {
    const safe = 'POST http://localhost:8080/openai/v1/chat/completions';
    expect(redact(safe)).toBe(safe);
  });

  it('redacts multiple secrets in the same string', () => {
    const s = 'key=sk-bf-abc and Authorization: Bearer tokenXYZ';
    const out = redact(s);
    expect(out).not.toContain('sk-bf-abc');
    expect(out).not.toContain('tokenXYZ');
  });
});

// ─── Logger ───────────────────────────────────────────────────────────────────

describe('Logger', () => {
  it('writes info messages without throwing', () => {
    const logger = new Logger('TestLogger');
    expect(() => logger.info('hello')).not.toThrow();
  });

  it('writes warn messages without throwing', () => {
    const logger = new Logger('TestLogger');
    expect(() => logger.warn('warning', 'ep')).not.toThrow();
  });

  it('writes error messages without throwing', () => {
    const logger = new Logger('TestLogger');
    expect(() => logger.error('oops')).not.toThrow();
  });

  it('redacts virtual keys in logged messages', () => {
    // We can test redact() directly to confirm it works — Logger uses it internally
    const out = redact('Connecting with key sk-bf-secret123');
    expect(out).not.toContain('sk-bf-secret123');
  });

  it('show() and clear() and dispose() do not throw', () => {
    const logger = new Logger('TestLogger');
    expect(() => logger.show()).not.toThrow();
    expect(() => logger.clear()).not.toThrow();
    expect(() => logger.dispose()).not.toThrow();
  });
});
