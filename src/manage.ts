// Endpoint management UI and commands

import * as vscode from 'vscode';
import { dashboardUrl, buildRequestHeaders, isInsecureRemoteHttp, listingAbortSignal, normalizeBaseUrl } from './auth';
import {
  DEFAULT_SHORTNAME,
  DEFAULT_BASE_URL,
  ENDPOINTS_SECRET_KEY,
  EPHEMERAL_FILTER_SECRET_KEY,
  MAX_REQUEST_TIMEOUT_MS,
  MIN_REQUEST_TIMEOUT_MS,
} from './constants';
import type { BifrostEndpoint } from './types';

// ─── Public entry points ───────────────────────────────────────────────────────

/**
 * Show the main endpoint management quick-pick menu.
 * Handles Add / Edit / Remove / Test / Dashboard / Toggle Ephemeral Filter.
 */
export async function showManageEndpointsUI(
  secrets: vscode.SecretStorage,
  provider: { setEphemeralFilter: (enabled: boolean) => void },
  onEndpointsChanged: (endpoints: BifrostEndpoint[]) => Promise<void>,
): Promise<void> {
  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(add) Add Gateway',             id: 'add' },
      { label: '$(edit) Edit Gateway',           id: 'edit' },
      { label: '$(trash) Remove Gateway',        id: 'remove' },
      { label: '$(pulse) Test Connection',       id: 'test' },
      { label: '$(browser) Open Dashboard',      id: 'dashboard' },
      { label: '$(eye) Toggle Ephemeral Filter', id: 'toggle' },
    ],
    { title: 'Bifrost: Manage Gateways', placeHolder: 'Choose an action' },
  );

  if (!choice) {
    return;
  }

  switch (choice.id) {
    case 'add':
      await addEndpoint(secrets, onEndpointsChanged);
      break;
    case 'edit':
      await editEndpoint(secrets, onEndpointsChanged);
      break;
    case 'remove':
      await removeEndpoint(secrets, onEndpointsChanged);
      break;
    case 'test':
      await testConnection(secrets);
      break;
    case 'dashboard':
      await openDashboard(secrets);
      break;
    case 'toggle':
      await toggleEphemeralFilter(secrets, provider);
      break;
  }
}

/**
 * Toggle the ephemeral cache_control filter and apply it to the live provider.
 * Called directly from `extension.ts` for the `bifrost.toggleEphemeralFilter` command.
 */
export async function toggleEphemeralFilter(
  secrets: vscode.SecretStorage,
  provider: { setEphemeralFilter: (enabled: boolean) => void },
): Promise<void> {
  const current = await secrets.get(EPHEMERAL_FILTER_SECRET_KEY);
  const wasEnabled = current !== 'false'; // default is true
  const newEnabled = !wasEnabled;

  await secrets.store(EPHEMERAL_FILTER_SECRET_KEY, newEnabled ? 'true' : 'false');
  provider.setEphemeralFilter(newEnabled);

  vscode.window.showInformationMessage(`Ephemeral filter: ${newEnabled ? 'ON' : 'OFF'}`);
}

// ─── CRUD operations ───────────────────────────────────────────────────────────

/**
 * Interactive flow to add a new endpoint.
 */
export async function addEndpoint(
  secrets: vscode.SecretStorage,
  onEndpointsChanged: (endpoints: BifrostEndpoint[]) => Promise<void>,
): Promise<void> {
  const url = await promptUrl();
  if (url === undefined) { return; }

  const shortname = await promptShortname();
  if (shortname === undefined) { return; }

  const virtualKey = await promptVirtualKey(url);
  if (virtualKey === null) { return; }

  const requestTimeoutMs = await promptRequestTimeout();
  if (requestTimeoutMs === null) { return; }

  const maxOutputTokens = await promptMaxOutputTokens();
  if (maxOutputTokens === null) { return; }

  const endpoint: BifrostEndpoint = {
    shortname,
    url,
    virtualKey: virtualKey || undefined,
    requestTimeoutMs: requestTimeoutMs ?? undefined,
    maxOutputTokens: maxOutputTokens ?? undefined,
  };

  const updated = await upsertEndpoint(secrets, endpoint);
  await onEndpointsChanged(updated);
  vscode.window.showInformationMessage(`Gateway '${shortname}' added successfully.`);
}

/**
 * Interactive flow to edit an existing endpoint.
 */
export async function editEndpoint(
  secrets: vscode.SecretStorage,
  onEndpointsChanged: (endpoints: BifrostEndpoint[]) => Promise<void>,
): Promise<void> {
  const endpoints = await loadEndpoints(secrets);
  if (endpoints.length === 0) {
    vscode.window.showWarningMessage('No gateways configured. Add one first.');
    return;
  }

  const selected = await pickEndpoint(endpoints, 'Select a gateway to edit');
  if (!selected) { return; }

  const url = await promptUrl(selected.url);
  if (url === undefined) { return; }

  const shortname = await promptShortname(selected.shortname);
  if (shortname === undefined) { return; }

  const virtualKey = await promptVirtualKey(url, selected.virtualKey);
  if (virtualKey === null) { return; }

  const requestTimeoutMs = await promptRequestTimeout(selected.requestTimeoutMs);
  if (requestTimeoutMs === null) { return; }

  const maxOutputTokens = await promptMaxOutputTokens(selected.maxOutputTokens);
  if (maxOutputTokens === null) { return; }

  // Remove old entry (by old shortname), add updated one
  const filtered = endpoints.filter(e => e.shortname !== selected.shortname);
  const updatedEndpoint: BifrostEndpoint = {
    shortname,
    url,
    virtualKey: virtualKey || undefined,
    requestTimeoutMs: requestTimeoutMs ?? undefined,
    maxOutputTokens: maxOutputTokens ?? undefined,
  };
  const updated = [...filtered, updatedEndpoint];
  await secrets.store(ENDPOINTS_SECRET_KEY, JSON.stringify(updated));
  await onEndpointsChanged(updated);
  vscode.window.showInformationMessage(`Gateway '${shortname}' updated successfully.`);
}

/**
 * Interactive flow to remove an endpoint.
 */
export async function removeEndpoint(
  secrets: vscode.SecretStorage,
  onEndpointsChanged: (endpoints: BifrostEndpoint[]) => Promise<void>,
): Promise<void> {
  const endpoints = await loadEndpoints(secrets);
  if (endpoints.length === 0) {
    vscode.window.showWarningMessage('No gateways configured.');
    return;
  }

  const selected = await pickEndpoint(endpoints, 'Select a gateway to remove');
  if (!selected) { return; }

  const confirm = await vscode.window.showWarningMessage(
    `Remove gateway '${selected.shortname}' (${selected.url})?`,
    { modal: true },
    'Remove',
  );
  if (confirm !== 'Remove') { return; }

  const updated = endpoints.filter(e => e.shortname !== selected.shortname);
  await secrets.store(ENDPOINTS_SECRET_KEY, JSON.stringify(updated));
  await onEndpointsChanged(updated);
  vscode.window.showInformationMessage(`Gateway '${selected.shortname}' removed.`);
}

// ─── Connection test & dashboard ──────────────────────────────────────────────

/**
 * Test connectivity to a selected endpoint by fetching /models?page_size=1.
 */
export async function testConnection(secrets: vscode.SecretStorage): Promise<void> {
  const endpoints = await loadEndpoints(secrets);
  if (endpoints.length === 0) {
    vscode.window.showWarningMessage('No gateways configured. Add one first.');
    return;
  }

  const selected = await pickEndpoint(endpoints, 'Select a gateway to test');
  if (!selected) { return; }

  const base = normalizeBaseUrl(selected.url);
  const testUrl = `${base}/models?page_size=1`;
  const headers = buildRequestHeaders(selected, 'bifrost-vscode/test');
  const signal = listingAbortSignal();

  let response: Response;
  try {
    response = await fetch(testUrl, { headers, signal });
  } catch (e) {
    vscode.window.showErrorMessage(
      `Connection failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    vscode.window.showErrorMessage(`Connection failed (HTTP ${response.status}): ${body}`);
    return;
  }

  let modelCount = 0;
  try {
    const data = (await response.json()) as Record<string, unknown>;
    const models = data.data as unknown[];
    if (Array.isArray(models)) {
      modelCount = models.length;
    }
  } catch {
    // ignore parse errors — connection itself succeeded
  }

  vscode.window.showInformationMessage(
    `Connected to '${selected.shortname}' — ${modelCount} model(s) available.`,
  );
}

/**
 * Open the dashboard (origin URL) for a selected endpoint in the default browser.
 */
export async function openDashboard(secrets: vscode.SecretStorage): Promise<void> {
  const endpoints = await loadEndpoints(secrets);
  if (endpoints.length === 0) {
    vscode.window.showWarningMessage('No gateways configured. Add one first.');
    return;
  }

  const selected = await pickEndpoint(endpoints, 'Select a gateway to open');
  if (!selected) { return; }

  const origin = dashboardUrl(selected.url);
  await vscode.env.openExternal(vscode.Uri.parse(origin));
}

// ─── Input prompt helpers ─────────────────────────────────────────────────────

/**
 * Prompt for a URL. Returns the normalized URL string, or `undefined` if cancelled.
 */
export async function promptUrl(existing?: string): Promise<string | undefined> {
  const raw = await vscode.window.showInputBox({
    title: 'Gateway URL',
    prompt: 'Enter the Bifrost gateway base URL',
    value: existing ?? DEFAULT_BASE_URL,
    validateInput: v => {
      if (!v.startsWith('http://') && !v.startsWith('https://')) {
        return 'URL must start with http:// or https://';
      }
      return undefined;
    },
  });
  if (raw === undefined) { return undefined; }

  let normalized: string;
  try {
    normalized = normalizeBaseUrl(raw);
  } catch {
    normalized = raw;
  }

  if (isInsecureRemoteHttp(normalized)) {
    vscode.window.showWarningMessage(
      'Warning: using HTTP (not HTTPS) for a remote host is insecure.',
    );
  }

  return normalized;
}

/**
 * Prompt for a shortname. Returns the value, or `undefined` if cancelled.
 */
export async function promptShortname(existing?: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: 'Gateway Shortname',
    prompt: 'Short identifier used in model IDs (letters, digits, _ -)',
    value: existing ?? DEFAULT_SHORTNAME,
    validateInput: v => {
      if (!v || !/^[a-zA-Z0-9_-]+$/.test(v)) {
        return 'Shortname must be 1–32 alphanumeric characters (letters, digits, _ -)';
      }
      if (v.length > 32) {
        return 'Shortname must not exceed 32 characters';
      }
      if (v.includes('/')) {
        return 'Shortname must not contain slashes';
      }
      return undefined;
    },
  });
}

/**
 * Prompt for an optional virtual key.
 * Returns the entered string (may be empty), or `null` if the user cancelled.
 */
export async function promptVirtualKey(url: string, existing?: string): Promise<string | null> {
  const result = await vscode.window.showInputBox({
    title: 'Virtual Key (optional)',
    prompt: isInsecureRemoteHttp(url)
      ? 'Virtual key (leave blank for unauthenticated) — WARNING: sending over HTTP'
      : 'Virtual key (leave blank for unauthenticated access)',
    value: existing ?? '',
    password: true,
  });
  // showInputBox returns undefined on ESC (cancel), empty string on blank
  return result === undefined ? null : result;
}

/**
 * Prompt for an optional per-endpoint request timeout.
 * Returns the timeout in ms, 0 for no timeout, or `null` if cancelled.
 * Blank input → `undefined` (use default, i.e. no timeout).
 */
export async function promptRequestTimeout(existing?: number): Promise<number | undefined | null> {
  const defaultDisplay = existing !== undefined ? String(existing) : '';
  const result = await vscode.window.showInputBox({
    title: 'Request Timeout (optional)',
    prompt: `Timeout in milliseconds for chat requests (${MIN_REQUEST_TIMEOUT_MS}–${MAX_REQUEST_TIMEOUT_MS}). Leave blank for no timeout.`,
    value: defaultDisplay,
    validateInput: v => {
      if (v === '' || v === undefined) { return undefined; } // blank = no timeout
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) {
        return 'Must be a non-negative integer (0 = no timeout)';
      }
      if (n > 0 && n < MIN_REQUEST_TIMEOUT_MS) {
        return `Minimum timeout is ${MIN_REQUEST_TIMEOUT_MS} ms (1 second)`;
      }
      if (n > MAX_REQUEST_TIMEOUT_MS) {
        return `Maximum timeout is ${MAX_REQUEST_TIMEOUT_MS} ms (30 minutes)`;
      }
      return undefined;
    },
  });
  if (result === undefined) { return null; }     // cancelled
  if (result === '') { return undefined; }        // blank → no timeout (use default)
  return Number(result);
}

/**
 * Prompt for an optional per-endpoint max output tokens override.
 * Returns the number, or `undefined` (blank = use model default), or `null` if cancelled.
 */
export async function promptMaxOutputTokens(existing?: number): Promise<number | undefined | null> {
  const result = await vscode.window.showInputBox({
    title: 'Max Output Tokens (optional)',
    prompt: 'Override max tokens for completions from this gateway. Leave blank to use the model default.',
    value: existing !== undefined ? String(existing) : '',
    validateInput: v => {
      if (v === '' || v === undefined) { return undefined; }
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) {
        return 'Must be a positive integer';
      }
      return undefined;
    },
  });
  if (result === undefined) { return null; }     // cancelled
  if (result === '') { return undefined; }        // blank → use model default
  return Number(result);
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

/**
 * Load endpoints from SecretStorage. Returns empty array if none or on parse error.
 */
export async function loadEndpoints(secrets: vscode.SecretStorage): Promise<BifrostEndpoint[]> {
  const raw = await secrets.get(ENDPOINTS_SECRET_KEY);
  if (!raw) { return []; }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as BifrostEndpoint[]) : [];
  } catch {
    return [];
  }
}

/**
 * Insert or replace an endpoint by shortname, persist, and return the updated array.
 */
export async function upsertEndpoint(
  secrets: vscode.SecretStorage,
  endpoint: BifrostEndpoint,
): Promise<BifrostEndpoint[]> {
  const existing = await loadEndpoints(secrets);
  const updated = [...existing.filter(e => e.shortname !== endpoint.shortname), endpoint];
  await secrets.store(ENDPOINTS_SECRET_KEY, JSON.stringify(updated));
  return updated;
}

// ─── QuickPick helper ─────────────────────────────────────────────────────────

/**
 * Show a QuickPick for selecting one endpoint from a list.
 */
async function pickEndpoint(
  endpoints: BifrostEndpoint[],
  title: string,
): Promise<BifrostEndpoint | undefined> {
  const items = endpoints.map(e => ({
    label: e.shortname,
    description: e.url,
    detail: [
      e.virtualKey ? 'authenticated' : 'unauthenticated',
      e.requestTimeoutMs !== undefined ? `timeout: ${e.requestTimeoutMs}ms` : null,
      e.maxOutputTokens !== undefined ? `max tokens: ${e.maxOutputTokens}` : null,
    ].filter(Boolean).join(' · '),
    endpoint: e,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: 'Select a gateway',
  });

  return selected?.endpoint;
}
