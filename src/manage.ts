// Endpoint management UI and commands

import * as vscode from 'vscode';
import {
  dashboardUrl,
  buildRequestHeaders,
  isInsecureRemoteHttp,
  listingAbortSignal,
  normalizeBaseUrl,
} from './auth';
import {
  DEFAULT_SHORTNAME,
  DEFAULT_BASE_URL,
  ENDPOINTS_SECRET_KEY,
  EPHEMERAL_FILTER_SECRET_KEY,
  MAX_REQUEST_TIMEOUT_MS,
  MIN_REQUEST_TIMEOUT_MS,
} from './constants';
import { resolveChatTokenLimits } from './models';
import type { BifrostEndpoint, BifrostModel, ModelTokenLimits } from './types';

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
      { label: '$(add) Add Gateway', id: 'add' },
      { label: '$(edit) Edit Gateway', id: 'edit' },
      { label: '$(trash) Remove Gateway', id: 'remove' },
      { label: '$(pulse) Test Connection', id: 'test' },
      { label: '$(browser) Open Dashboard', id: 'dashboard' },
      { label: '$(eye) Toggle Ephemeral Filter', id: 'toggle' },
      { label: '$(pencil) Manage Model Limits', id: 'model-limits' },
      { label: '$(sync) Refresh Model Limits', id: 'refresh-limits' },
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
    case 'model-limits':
      await manageModelLimits(secrets, onEndpointsChanged);
      break;
    case 'refresh-limits':
      await refreshModelLimits(secrets, onEndpointsChanged);
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
  if (url === undefined) {
    return;
  }

  const shortname = await promptShortname();
  if (shortname === undefined) {
    return;
  }

  const virtualKey = await promptVirtualKey(url);
  if (virtualKey === null) {
    return;
  }

  const requestTimeoutMs = await promptRequestTimeout();
  if (requestTimeoutMs === null) {
    return;
  }

  const maxOutputTokens = await promptMaxOutputTokens();
  if (maxOutputTokens === null) {
    return;
  }

  const passthroughHyperparameters = await promptPassthroughHyperparameters();
  if (passthroughHyperparameters === null) {
    return;
  }

  let upstreamModelsUrl: string | undefined;
  if (passthroughHyperparameters) {
    const entered = await promptUpstreamModelsUrl();
    if (entered === null) {
      return;
    }
    upstreamModelsUrl = entered || undefined;
  }

  const endpoint: BifrostEndpoint = {
    shortname,
    url,
    virtualKey: virtualKey || undefined,
    requestTimeoutMs: requestTimeoutMs ?? undefined,
    maxOutputTokens: maxOutputTokens ?? undefined,
    passthroughHyperparameters: passthroughHyperparameters,
    upstreamModelsUrl,
    modelTokenLimits: [],
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
  if (!selected) {
    return;
  }

  const url = await promptUrl(selected.url);
  if (url === undefined) {
    return;
  }

  const shortname = await promptShortname(selected.shortname);
  if (shortname === undefined) {
    return;
  }

  const virtualKey = await promptVirtualKey(url, selected.virtualKey);
  if (virtualKey === null) {
    return;
  }

  const requestTimeoutMs = await promptRequestTimeout(selected.requestTimeoutMs);
  if (requestTimeoutMs === null) {
    return;
  }

  const maxOutputTokens = await promptMaxOutputTokens(selected.maxOutputTokens);
  if (maxOutputTokens === null) {
    return;
  }

  const passthroughHyperparameters = await promptPassthroughHyperparameters(
    selected.passthroughHyperparameters,
  );
  if (passthroughHyperparameters === null) {
    return;
  }

  let upstreamModelsUrl = selected.upstreamModelsUrl;
  if (passthroughHyperparameters) {
    const entered = await promptUpstreamModelsUrl(selected.upstreamModelsUrl);
    if (entered === null) {
      return;
    }
    upstreamModelsUrl = entered || undefined;
  }

  // Remove old entry (by old shortname), add updated one
  const filtered = endpoints.filter(e => e.shortname !== selected.shortname);
  const updatedEndpoint: BifrostEndpoint = {
    shortname,
    url,
    virtualKey: virtualKey || undefined,
    requestTimeoutMs: requestTimeoutMs ?? undefined,
    maxOutputTokens: maxOutputTokens ?? undefined,
    passthroughHyperparameters: passthroughHyperparameters,
    upstreamModelsUrl,
    modelTokenLimits: selected.modelTokenLimits ?? [],
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
  if (!selected) {
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Remove gateway '${selected.shortname}' (${selected.url})?`,
    { modal: true },
    'Remove',
  );
  if (confirm !== 'Remove') {
    return;
  }

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
  if (!selected) {
    return;
  }

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
  if (!selected) {
    return;
  }

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
  if (raw === undefined) {
    return undefined;
  }

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
      if (v === '' || v === undefined) {
        return undefined;
      } // blank = no timeout
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
  if (result === undefined) {
    return null;
  } // cancelled
  if (result === '') {
    return undefined;
  } // blank → no timeout (use default)
  return Number(result);
}

/**
 * Prompt for an optional per-endpoint max output tokens override.
 * Returns the number, or `undefined` (blank = use model default), or `null` if cancelled.
 */
export async function promptMaxOutputTokens(existing?: number): Promise<number | undefined | null> {
  const result = await vscode.window.showInputBox({
    title: 'Max Output Tokens (optional)',
    prompt:
      'Override max tokens for completions from this gateway. Leave blank to use the model default.',
    value: existing !== undefined ? String(existing) : '',
    validateInput: v => {
      if (v === '' || v === undefined) {
        return undefined;
      }
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) {
        return 'Must be a positive integer';
      }
      return undefined;
    },
  });
  if (result === undefined) {
    return null;
  } // cancelled
  if (result === '') {
    return undefined;
  } // blank → use model default
  return Number(result);
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

/**
 * Load endpoints from SecretStorage. Returns empty array if none or on parse error.
 */
export async function loadEndpoints(secrets: vscode.SecretStorage): Promise<BifrostEndpoint[]> {
  const raw = await secrets.get(ENDPOINTS_SECRET_KEY);
  if (!raw) {
    return [];
  }
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
      e.maxOutputTokens !== undefined ? `max out: ${e.maxOutputTokens}` : null,
      e.passthroughHyperparameters ? 'passthrough: enabled' : 'passthrough: disabled',
      e.modelTokenLimits && e.modelTokenLimits.length > 0
        ? `${e.modelTokenLimits.length} model limit(s)`
        : 'no limits',
    ]
      .filter(Boolean)
      .join(' · '),
    endpoint: e,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: 'Select a gateway',
  });

  return selected?.endpoint;
}

/**
 * Refresh model limits from the catalog for all configured endpoints.
 */
export async function refreshModelLimits(
  secrets: vscode.SecretStorage,
  onEndpointsChanged: (endpoints: BifrostEndpoint[]) => Promise<void>,
): Promise<void> {
  const endpoints = await loadEndpoints(secrets);
  if (endpoints.length === 0) {
    vscode.window.showWarningMessage('No gateways configured. Add one first.');
    return;
  }

  // Show endpoints to choose from, or refresh all
  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(globe) Refresh All Endpoints', description: 'Update limits for all gateways' },
      { label: '$(pin) Refresh Single Endpoint', description: 'Update limits for one gateway' },
    ],
    { title: 'Refresh Model Limits', placeHolder: 'Choose scope' },
  );

  if (!choice) {
    return;
  }

  let endpointsToRefresh: BifrostEndpoint[] = [];

  if (choice.label.includes('All')) {
    endpointsToRefresh = endpoints;
  } else {
    const selected = await pickEndpoint(endpoints, 'Select endpoint to refresh');
    if (!selected) {
      return;
    }
    endpointsToRefresh = [selected];
  }

  // Confirm refresh
  const confirm = await vscode.window.showWarningMessage(
    `Refresh model limits for ${endpointsToRefresh.length} endpoint(s)? This will overwrite any manual edits with current catalog values.`,
    { modal: true },
    'Refresh',
  );
  if (confirm !== 'Refresh') {
    return;
  }

  let refreshedCount = 0;
  let failedCount = 0;

  for (const endpoint of endpointsToRefresh) {
    const base = normalizeBaseUrl(endpoint.url);
    const modelsUrl = `${base}/models?page=1&size=50`;
    const headers = buildRequestHeaders(endpoint, 'bifrost-vscode/refresh-limits');
    const signal = listingAbortSignal();

    try {
      const response = await fetch(modelsUrl, { headers, signal });

      if (!response.ok) {
        failedCount++;
        continue;
      }

      const data = (await response.json()) as Record<string, unknown>;
      const models = data.data as BifrostModel[];

      if (Array.isArray(models) && models.length > 0) {
        const updatedLimits = populateModelLimitsFromCatalog(models);

        const updatedEndpoints = endpoints.map(e =>
          e.shortname === endpoint.shortname ? { ...e, modelTokenLimits: updatedLimits } : e,
        );
        await secrets.store(ENDPOINTS_SECRET_KEY, JSON.stringify(updatedEndpoints));
        refreshedCount++;
      } else {
        failedCount++;
      }
    } catch {
      failedCount++;
    }
  }

  await onEndpointsChanged(endpoints);

  if (refreshedCount > 0) {
    vscode.window.showInformationMessage(
      `Refreshed model limits for ${refreshedCount} endpoint(s). ${failedCount > 0 ? `${failedCount} failed` : ''}`,
    );
  } else {
    vscode.window.showErrorMessage('Failed to refresh model limits for all selected endpoints.');
  }
}

/**
 * Show UI for managing model-specific token limits for all configured endpoints.
 * If modelId is provided, directly edit that model's limits.
 * Otherwise, show endpoint selection first.
 */
export async function manageModelLimits(
  secrets: vscode.SecretStorage,
  onEndpointsChanged: (endpoints: BifrostEndpoint[]) => Promise<void>,
  modelId?: string,
): Promise<void> {
  const endpoints = await loadEndpoints(secrets);
  if (endpoints.length === 0) {
    vscode.window.showWarningMessage('No gateways configured. Add one first.');
    return;
  }

  // If modelId is provided, directly edit that model
  if (modelId) {
    await editModelByName(secrets, modelId, onEndpointsChanged);
    return;
  }

  const selected = await pickEndpoint(endpoints, 'Select a gateway to manage model limits');
  if (!selected) {
    return;
  }

  const choice = await vscode.window.showQuickPick(
    [
      {
        label: '$(add) Auto-populate from Catalog',
        description: 'Fetch current limits from Bifrost API',
      },
      { label: '$(search) Edit Single Model', description: 'Search and edit one model by name' },
      { label: '$(gear) Edit All Limits', description: 'Modify existing model limits' },
      { label: '$(trash) Clear All Limits', description: 'Remove all model-specific limits' },
    ],
    { title: 'Manage Model Limits', placeHolder: 'Choose an action' },
  );

  if (!choice) {
    return;
  }

  let updatedLimits: ModelTokenLimits[] = selected.modelTokenLimits ?? [];

  if (choice.label.includes('Auto-populate')) {
    // Fetch models from this endpoint to get current catalog values
    const base = normalizeBaseUrl(selected.url);
    const testUrl = `${base}/models?page=1&size=50`;
    const headers = buildRequestHeaders(selected, 'bifrost-vscode/model-limits');
    const signal = listingAbortSignal();

    let response: Response;
    try {
      response = await fetch(testUrl, { headers, signal });
    } catch (e) {
      vscode.window.showErrorMessage(
        `Failed to fetch models: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      vscode.window.showErrorMessage(`Failed to fetch models (HTTP ${response.status}): ${body}`);
      return;
    }

    try {
      const data = (await response.json()) as Record<string, unknown>;
      const models = data.data as BifrostModel[];
      if (Array.isArray(models)) {
        updatedLimits = populateModelLimitsFromCatalog(models);
        vscode.window.showInformationMessage(
          `Auto-populated ${updatedLimits.length} model limit(s) from catalog.`,
        );
      }
    } catch {
      vscode.window.showErrorMessage('Failed to parse models response');
      return;
    }
  } else if (choice.label.includes('Clear All')) {
    updatedLimits = [];
    vscode.window.showInformationMessage('All model limits cleared.');
  } else if (choice.label.includes('Edit All')) {
    if (updatedLimits.length === 0) {
      vscode.window.showInformationMessage('No model limits configured.');
      return;
    }

    // Edit each limit
    const newLimits: ModelTokenLimits[] = [];
    for (const limit of updatedLimits) {
      const maxInput = await vscode.window.showInputBox({
        title: `Max Input Tokens for ${limit.modelId}`,
        prompt: 'Leave blank to use catalog default',
        value: limit.maxInputTokens?.toString(),
        placeHolder: '128000',
      });

      const maxOutput = await vscode.window.showInputBox({
        title: `Max Output Tokens for ${limit.modelId}`,
        prompt: 'Leave blank to use catalog default',
        value: limit.maxOutputTokens?.toString(),
        placeHolder: '16000',
      });

      newLimits.push({
        modelId: limit.modelId,
        maxInputTokens: maxInput ? parseInt(maxInput, 10) : undefined,
        maxOutputTokens: maxOutput ? parseInt(maxOutput, 10) : undefined,
        source: 'manual',
      });
    }

    updatedLimits = newLimits;
    vscode.window.showInformationMessage(`Updated ${updatedLimits.length} model limit(s).`);
  } else if (choice.label.includes('Edit Single Model')) {
    await editModelWithSearch(secrets, onEndpointsChanged);
    return;
  }

  // Update endpoint with new limits
  const updatedEndpoints = endpoints.map(e =>
    e.shortname === selected.shortname ? { ...e, modelTokenLimits: updatedLimits } : e,
  );
  await secrets.store(ENDPOINTS_SECRET_KEY, JSON.stringify(updatedEndpoints));
  await onEndpointsChanged(updatedEndpoints);
}

/**
 * Populate model token limits from Bifrost model catalog
 * Uses catalog values with 'catalog' source marker
 */
function populateModelLimitsFromCatalog(models: BifrostModel[]): ModelTokenLimits[] {
  const limits: ModelTokenLimits[] = [];

  for (const model of models) {
    const resolved = resolveChatTokenLimits(model);
    limits.push({
      modelId: model.id,
      maxInputTokens: resolved.maxInputTokens,
      maxOutputTokens: resolved.maxOutputTokens,
      source: 'catalog',
    });
  }

  return limits;
}

/**
 * Prompt for the upstream catalog base (Lemonade `/v1`, or a URL that already
 * ends in `/models`). Blank clears it. `null` means the user cancelled.
 */
async function promptUpstreamModelsUrl(existing?: string): Promise<string | null> {
  const result = await vscode.window.showInputBox({
    title: 'Upstream model catalog',
    prompt:
      'Base URL of the upstream model list (Lemonade). Leave blank to use only the context fields Bifrost forwards.',
    placeHolder: 'http://host:13305/v1',
    value: existing ?? '',
    ignoreFocusOut: true,
    validateInput: value => {
      const trimmed = value.trim();
      if (!trimmed) {
        return undefined;
      }
      if (!/^https?:\/\//i.test(trimmed)) {
        return 'URL must start with http:// or https://';
      }
      return undefined;
    },
  });
  if (result === undefined) {
    return null;
  }
  return result.trim();
}

export async function promptPassthroughHyperparameters(
  existing?: boolean,
): Promise<boolean | null> {
  const result = await vscode.window.showQuickPick(
    [
      {
        label: '$(check) Enabled',
        value: true,
        description: 'Use the loaded upstream context window and skip the endpoint output cap',
      },
      {
        label: '$(circle-slash) Disabled',
        value: false,
        description: 'Use endpoint/model defaults',
      },
    ],
    {
      title: 'Passthrough Hyperparameters',
      prompt: 'Allow target models to set their own token limits and hyperparameters',
      placeHolder:
        existing !== undefined ? (existing ? 'Enabled' : 'Disabled') : 'Select an option',
    },
  );
  if (result === undefined) {
    return null;
  }
  return result.value;
}

/**
 * Prompt for model-specific token limits configuration.
 * Returns array of ModelTokenLimits, or `null` if cancelled.
 */
export async function promptModelTokenLimits(
  existing?: ModelTokenLimits[],
): Promise<ModelTokenLimits[] | null> {
  const choice = await vscode.window.showQuickPick(
    [
      {
        label: '$(add) Add Model Limit',
        description: 'Set custom token limits for a specific model',
      },
      { label: '$(gear) Edit All Limits', description: 'Modify all configured model limits' },
      { label: '$(trash) Clear All Limits', description: 'Remove all model-specific limits' },
    ],
    {
      title: 'Model Token Limits',
      placeHolder: 'Choose an action',
    },
  );

  if (!choice) {
    return null;
  }

  const currentLimits = existing ?? [];

  if (choice.label.includes('Clear All')) {
    return [];
  }

  if (choice.label.includes('Edit All')) {
    return await editAllModelLimits(currentLimits);
  }

  // Add new model limit
  return await addModelLimit(currentLimits);
}

async function addModelLimit(
  currentLimits: ModelTokenLimits[],
): Promise<ModelTokenLimits[] | null> {
  const modelId = await vscode.window.showInputBox({
    title: 'Model ID',
    prompt: 'Enter the model ID (e.g., gpt-4o, claude-3-5-sonnet)',
    placeHolder: 'model-id',
  });

  if (modelId === undefined) {
    return null;
  }

  const maxInputTokensInput = await vscode.window.showInputBox({
    title: 'Max Input Tokens (optional)',
    prompt: 'Maximum input tokens for this model. Leave blank to use model default.',
    placeHolder: '128000',
  });

  const maxOutputTokensInput = await vscode.window.showInputBox({
    title: 'Max Output Tokens (optional)',
    prompt: 'Maximum output tokens for this model. Leave blank to use model default.',
    placeHolder: '16000',
  });

  const limit: ModelTokenLimits = {
    modelId,
    maxInputTokens: maxInputTokensInput ? parseInt(maxInputTokensInput, 10) : undefined,
    maxOutputTokens: maxOutputTokensInput ? parseInt(maxOutputTokensInput, 10) : undefined,
  };

  return [...currentLimits, limit];
}

async function editAllModelLimits(limits: ModelTokenLimits[]): Promise<ModelTokenLimits[] | null> {
  if (limits.length === 0) {
    vscode.window.showInformationMessage('No model limits configured. Add one first.');
    return limits;
  }

  const choices = limits.map(limit => ({
    label: limit.modelId,
    description: [
      limit.maxInputTokens ? `input: ${limit.maxInputTokens}` : null,
      limit.maxOutputTokens ? `output: ${limit.maxOutputTokens}` : null,
    ]
      .filter(Boolean)
      .join(', '),
    limit,
  }));

  const selected = await vscode.window.showQuickPick(choices, {
    title: 'Select Model to Edit',
    placeHolder: 'Choose a model',
  });

  if (!selected) {
    return null;
  }

  const maxInputTokensInput = await vscode.window.showInputBox({
    title: 'Max Input Tokens (optional)',
    prompt: 'Maximum input tokens for this model. Leave blank to use model default.',
    value: selected.limit.maxInputTokens?.toString(),
    placeHolder: '128000',
  });

  const maxOutputTokensInput = await vscode.window.showInputBox({
    title: 'Max Output Tokens (optional)',
    prompt: 'Maximum output tokens for this model. Leave blank to use model default.',
    value: selected.limit.maxOutputTokens?.toString(),
    placeHolder: '16000',
  });

  const updatedLimits = limits.map(limit =>
    limit.modelId === selected.limit.modelId
      ? {
          ...limit,
          maxInputTokens: maxInputTokensInput ? parseInt(maxInputTokensInput, 10) : undefined,
          maxOutputTokens: maxOutputTokensInput ? parseInt(maxOutputTokensInput, 10) : undefined,
        }
      : limit,
  );

  return updatedLimits;
}

/**
 * Find the endpoint that contains a specific model by checking stored limits or fetching.
 */
export async function findEndpointForModel(
  secrets: vscode.SecretStorage,
  modelId: string,
): Promise<BifrostEndpoint | undefined> {
  const endpoints = await loadEndpoints(secrets);

  // First check if model is in stored limits
  for (const endpoint of endpoints) {
    if (endpoint.modelTokenLimits?.some(l => l.modelId === modelId)) {
      return endpoint;
    }
  }

  // If not found in stored limits, try fetching from each endpoint
  for (const endpoint of endpoints) {
    try {
      const base = normalizeBaseUrl(endpoint.url);
      const modelsUrl = `${base}/models?page=1&size=100`;
      const headers = buildRequestHeaders(endpoint, 'bifrost-vscode/find-model');
      const signal = listingAbortSignal();

      const response = await fetch(modelsUrl, { headers, signal });
      if (response.ok) {
        const data = (await response.json()) as Record<string, unknown>;
        const models = data.data as BifrostModel[];
        if (Array.isArray(models) && models.some(m => m.id === modelId)) {
          return endpoint;
        }
      }
    } catch {
      // Skip endpoints that fail
    }
  }

  return undefined;
}

/**
 * Edit limits for a single specific model.
 */
export async function editSingleModelLimit(
  secrets: vscode.SecretStorage,
  endpoint: BifrostEndpoint,
  modelId: string,
  onEndpointsChanged: (endpoints: BifrostEndpoint[]) => Promise<void>,
): Promise<void> {
  const currentLimits = endpoint.modelTokenLimits ?? [];
  const currentLimit = currentLimits.find(l => l.modelId === modelId);

  const maxInputTokensInput = await vscode.window.showInputBox({
    title: `Max Input Tokens for ${modelId}`,
    prompt: 'Leave blank to use catalog default',
    value: currentLimit?.maxInputTokens?.toString(),
    placeHolder: '128000',
  });

  const maxOutputTokensInput = await vscode.window.showInputBox({
    title: `Max Output Tokens for ${modelId}`,
    prompt: 'Leave blank to use catalog default',
    value: currentLimit?.maxOutputTokens?.toString(),
    placeHolder: '16000',
  });

  const newLimit: ModelTokenLimits = {
    modelId,
    maxInputTokens: maxInputTokensInput ? parseInt(maxInputTokensInput, 10) : undefined,
    maxOutputTokens: maxOutputTokensInput ? parseInt(maxOutputTokensInput, 10) : undefined,
    source: 'manual',
  };

  const currentEndpoints = await loadEndpoints(secrets);
  const updatedLimits = [...currentLimits.filter(l => l.modelId !== modelId), newLimit];
  const updatedEndpoints = currentEndpoints.map(e =>
    e.shortname === endpoint.shortname ? { ...e, modelTokenLimits: updatedLimits } : e,
  );

  await secrets.store(ENDPOINTS_SECRET_KEY, JSON.stringify(updatedEndpoints));
  await onEndpointsChanged(updatedEndpoints);

  const saved = updatedEndpoints.find(e => e.shortname === endpoint.shortname);
  const savedLimit = saved?.modelTokenLimits?.find(l => l.modelId === modelId);
  vscode.window.showInformationMessage(
    `Updated limits for ${modelId}: input=${savedLimit?.maxInputTokens}, output=${savedLimit?.maxOutputTokens}`,
  );
}

/**
 * Edit limits for a single specific model by selecting from a filtered list.
 */
export async function editModelByName(
  secrets: vscode.SecretStorage,
  modelId: string,
  onEndpointsChanged: (endpoints: BifrostEndpoint[]) => Promise<void>,
): Promise<void> {
  const endpoint = await findEndpointForModel(secrets, modelId);

  if (!endpoint) {
    vscode.window.showWarningMessage(`Model '${modelId}' not found in any configured gateway.`);
    return;
  }

  await editSingleModelLimit(secrets, endpoint, modelId, onEndpointsChanged);
}

/**
 * Edit limits for a specific model by selecting from a filtered list.
 */
export async function editModelWithSearch(
  secrets: vscode.SecretStorage,
  onEndpointsChanged: (endpoints: BifrostEndpoint[]) => Promise<void>,
): Promise<void> {
  const endpoints = await loadEndpoints(secrets);
  if (endpoints.length === 0) {
    vscode.window.showWarningMessage('No gateways configured. Add one first.');
    return;
  }

  const selected = await pickEndpoint(endpoints, 'Select a gateway');
  if (!selected) {
    return;
  }

  const currentLimits = selected.modelTokenLimits ?? [];
  if (currentLimits.length === 0) {
    vscode.window.showInformationMessage('No model limits configured for this gateway.');
    return;
  }

  const modelIds = currentLimits.map(l => l.modelId);
  const selectedModelId = await vscode.window.showQuickPick(modelIds, {
    title: 'Select model to edit',
    placeHolder: 'Choose a model',
  });

  if (!selectedModelId) {
    return;
  }

  await editSingleModelLimit(secrets, selected, selectedModelId, onEndpointsChanged);
}
