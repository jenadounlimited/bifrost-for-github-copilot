// Constants for the extension

import type { BifrostAuthMode } from './types';

export type { BifrostAuthMode } from './types';

/**
 * Extension vendor ID
 */
export const VENDOR_ID = 'bifrost';

/**
 * SecretStorage key for endpoint configurations
 */
export const ENDPOINTS_SECRET_KEY = 'bifrost.endpoints';

/**
 * SecretStorage key for ephemeral data filter toggle
 */
export const EPHEMERAL_FILTER_SECRET_KEY = 'bifrost.filterEphemeralData';

/**
 * Default base URL for Bifrost API
 */
export const DEFAULT_BASE_URL = 'http://localhost:8080/openai/v1';

/**
 * Default endpoint shortname
 */
export const DEFAULT_SHORTNAME = 'default';

/**
 * Default max output tokens
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

/**
 * Default context length
 */
export const DEFAULT_CONTEXT_LENGTH = 128_000;

/**
 * Default auth mode
 */
export const DEFAULT_AUTH_MODE: BifrostAuthMode = 'auto';

/**
 * Listing fetch timeout in milliseconds (KD16)
 */
export const LIST_FETCH_TIMEOUT_MS = 10_000;

/**
 * Default chat request timeout in milliseconds (0 = no timeout, for Agent loops)
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 0;

/**
 * Minimum allowed request timeout in milliseconds (1 second)
 */
export const MIN_REQUEST_TIMEOUT_MS = 1_000;

/**
 * Maximum allowed request timeout in milliseconds (30 minutes)
 */
export const MAX_REQUEST_TIMEOUT_MS = 1_800_000;

/**
 * Models page size for pagination (KD11)
 */
export const MODELS_PAGE_SIZE = 200;

/**
 * Maximum pages to fetch for models
 */
export const MODELS_MAX_PAGES = 20;

/**
 * Maximum tools per request
 */
export const MAX_TOOLS_PER_REQUEST = 128;

/**
 * Set of loopback host addresses
 */
export const LOOPBACK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  'host.docker.internal',
  'gateway.docker.internal',
]);
