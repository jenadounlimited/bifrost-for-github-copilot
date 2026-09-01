// Authentication header construction and URL normalization

import { LOOPBACK_HOSTS, LIST_FETCH_TIMEOUT_MS } from './constants';
import type { BifrostAuthMode, BifrostEndpoint } from './types';

export type { BifrostAuthMode };

/**
 * Resolve the effective auth mode for an endpoint
 * - KD5: If virtual key starts with `sk-bf-`, use "bearer"
 * - Otherwise use "x-bf-vk" (legacy keys)
 */
export function resolveAuthMode(endpoint: Pick<BifrostEndpoint, 'virtualKey' | 'authMode'>): BifrostAuthMode {
  const { authMode, virtualKey } = endpoint;

  // If explicit mode and not auto, use it
  if (authMode && authMode !== 'auto') {
    return authMode;
  }

  // No virtual key = no auth
  if (!virtualKey) {
    return 'auto';
  }

  // Modern keys start with sk-bf- -> bearer token
  if (virtualKey.startsWith('sk-bf-')) {
    return 'bearer';
  }

  // Legacy keys -> x-bf-vk header
  return 'x-bf-vk';
}

/**
 * Build request headers for an API call
 * - Always set User-Agent
 * - Omit auth if no virtual key (KD4)
 * - Apply Authorization: Bearer for "bearer" or "both"
 * - Apply x-bf-vk header for "x-bf-vk" or "both"
 */
export function buildRequestHeaders(
  endpoint: Pick<BifrostEndpoint, 'virtualKey' | 'authMode'>,
  userAgent: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': userAgent,
  };

  if (!endpoint.virtualKey) {
    return headers;
  }

  const mode = resolveAuthMode(endpoint);

  if (mode === 'bearer' || mode === 'both') {
    headers['Authorization'] = `Bearer ${endpoint.virtualKey}`;
  }

  if (mode === 'x-bf-vk' || mode === 'both') {
    headers['x-bf-vk'] = endpoint.virtualKey;
  }

  return headers;
}

/**
 * Normalize a base URL for Bifrost API calls
 * - Require http/https protocol
 * - Strip trailing slashes
 * - Remove /chat/completions and /models suffixes
 * - Append /openai/v1 to bare origins
 * - Convert /openai -> /openai/v1
 * - Keep /v1 and /openai/v1 as-is
 */
export function normalizeBaseUrl(baseUrl: string): string {
  if (!baseUrl) {
    throw new Error('Base URL is required');
  }

  let url = baseUrl.trim();

  // Require http/https
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error(`Invalid protocol in URL: ${url}. Must start with http:// or https://`);
  }

  // Strip trailing slashes (but keep the path)
  url = url.replace(/\/+$/, '');

  // Remove common suffixes
  url = url.replace(/\/chat\/completions$/, '');
  url = url.replace(/\/models$/, '');

  // Handle /openai -> /openai/v1
  if (url.endsWith('/openai')) {
    url = `${url}/v1`;
  }

  // Bare origin or bare /v1 -> append /openai/v1
  const urlObj = new URL(url);
  const pathname = urlObj.pathname;

  if (pathname === '/' || pathname === '/v1') {
    urlObj.pathname = '/openai/v1';
    return urlObj.href;
  }

  // Keep /openai/v1 as-is
  if (pathname === '/openai/v1') {
    return urlObj.href;
  }

  // Other paths: leave as-is (custom API base)
  return urlObj.href;
}

/**
 * Check if a URL is a loopback (localhost) address
 */
export function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

/**
 * Check if a URL is an insecure remote HTTP (not loopback)
 */
export function isInsecureRemoteHttp(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && !isLoopbackUrl(url);
  } catch {
    return false;
  }
}

/**
 * Fallback models base URL for KD12: /openai/v1 -> /v1
 */
export function fallbackV1ModelsBase(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  let pathname = parsed.pathname;

  if (pathname === '/openai/v1') {
    pathname = '/v1';
  }

  parsed.pathname = pathname;
  return parsed.href;
}

/**
 * Extract dashboard URL (origin) from a base API URL
 */
export function dashboardUrl(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return baseUrl;
  }
}

/**
 * Create an AbortSignal with 10s timeout for listing requests (KD16)
 */
export function listingAbortSignal(): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('Listing request timed out')), LIST_FETCH_TIMEOUT_MS);
  return controller.signal;
}

