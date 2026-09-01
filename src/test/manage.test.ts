// Management UI tests

import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import {
  addEndpoint,
  editEndpoint,
  removeEndpoint,
  testConnection,
  openDashboard,
  toggleEphemeralFilter,
  loadEndpoints,
  upsertEndpoint,
  promptRequestTimeout,
  promptMaxOutputTokens,
  promptShortname,
  promptUrl,
} from '../manage';
import type { BifrostEndpoint } from '../types';

// ─── Mocks ────────────────────────────────────────────────────────────────────

function makeSecrets(initial: Record<string, string> = {}): vscode.SecretStorage {
  const store = { ...initial };
  return {
    get: (k: string) => Promise.resolve(store[k]),
    store: (k: string, v: string) => { store[k] = v; return Promise.resolve(); },
    delete: (k: string) => { delete store[k]; return Promise.resolve(); },
    keys: () => Promise.resolve(Object.keys(store)),
    onDidChange: { event: () => ({ dispose: () => {} }) } as never,
  };
}

function makeProvider() {
  return { setEphemeralFilter: vi.fn() };
}

function makeNoopChange() {
  return vi.fn().mockResolvedValue(undefined);
}

/** Replace vscode.window stubs for a single test */
function mockWindow(overrides: Partial<typeof vscode.window>) {
  Object.assign(vscode.window, overrides);
}

const sampleEndpoint: BifrostEndpoint = {
  shortname: 'local',
  url: 'http://localhost:8080/openai/v1',
};

beforeEach(() => {
  vi.restoreAllMocks();
});

// ─── loadEndpoints ────────────────────────────────────────────────────────────

describe('loadEndpoints', () => {
  it('returns empty array when nothing stored', async () => {
    const secrets = makeSecrets();
    expect(await loadEndpoints(secrets)).toEqual([]);
  });

  it('returns parsed endpoints', async () => {
    const secrets = makeSecrets({ 'bifrost.endpoints': JSON.stringify([sampleEndpoint]) });
    expect(await loadEndpoints(secrets)).toHaveLength(1);
    expect((await loadEndpoints(secrets))[0].shortname).toBe('local');
  });

  it('returns empty array on malformed JSON', async () => {
    const secrets = makeSecrets({ 'bifrost.endpoints': 'NOT JSON' });
    expect(await loadEndpoints(secrets)).toEqual([]);
  });
});

// ─── upsertEndpoint ───────────────────────────────────────────────────────────

describe('upsertEndpoint', () => {
  it('adds a new endpoint', async () => {
    const secrets = makeSecrets();
    const updated = await upsertEndpoint(secrets, sampleEndpoint);
    expect(updated).toHaveLength(1);
    expect(updated[0].shortname).toBe('local');
  });

  it('replaces an existing endpoint by shortname', async () => {
    const secrets = makeSecrets({ 'bifrost.endpoints': JSON.stringify([sampleEndpoint]) });
    const updated = await upsertEndpoint(secrets, { ...sampleEndpoint, url: 'http://localhost:9090/openai/v1' });
    expect(updated).toHaveLength(1);
    expect(updated[0].url).toBe('http://localhost:9090/openai/v1');
  });

  it('preserves other endpoints when upserting', async () => {
    const other: BifrostEndpoint = { shortname: 'remote', url: 'https://api.example.com/openai/v1' };
    const secrets = makeSecrets({ 'bifrost.endpoints': JSON.stringify([sampleEndpoint, other]) });
    const updated = await upsertEndpoint(secrets, { ...sampleEndpoint, url: 'http://localhost:9999/openai/v1' });
    expect(updated).toHaveLength(2);
    expect(updated.find(e => e.shortname === 'remote')).toBeDefined();
  });
});

// ─── addEndpoint ──────────────────────────────────────────────────────────────

describe('addEndpoint', () => {
  it('saves a new endpoint with all fields', async () => {
    const secrets = makeSecrets();
    const onChange = makeNoopChange();

    // Sequence: URL → shortname → virtual key → timeout → max tokens
    const inputs = ['http://localhost:8080/openai/v1', 'local', '', '5000', '8192'];
    let callIdx = 0;
    mockWindow({ showInputBox: vi.fn().mockImplementation(() => Promise.resolve(inputs[callIdx++])) });
    mockWindow({ showWarningMessage: vi.fn().mockResolvedValue(undefined) });
    mockWindow({ showInformationMessage: vi.fn().mockResolvedValue(undefined) });

    await addEndpoint(secrets, onChange);

    expect(onChange).toHaveBeenCalledOnce();
    const stored = await loadEndpoints(secrets);
    expect(stored).toHaveLength(1);
    expect(stored[0].shortname).toBe('local');
    expect(stored[0].requestTimeoutMs).toBe(5000);
    expect(stored[0].maxOutputTokens).toBe(8192);
  });

  it('does nothing when user cancels URL prompt', async () => {
    const secrets = makeSecrets();
    const onChange = makeNoopChange();

    mockWindow({ showInputBox: vi.fn().mockResolvedValue(undefined) }); // ESC on first prompt
    await addEndpoint(secrets, onChange);

    expect(onChange).not.toHaveBeenCalled();
  });

  it('stores endpoint without optional fields when left blank', async () => {
    const secrets = makeSecrets();
    const onChange = makeNoopChange();

    // blank = no timeout, no max tokens, no virtual key
    const inputs = ['http://localhost:8080/openai/v1', 'local', '', '', ''];
    let callIdx = 0;
    mockWindow({ showInputBox: vi.fn().mockImplementation(() => Promise.resolve(inputs[callIdx++])) });
    mockWindow({ showWarningMessage: vi.fn().mockResolvedValue(undefined) });
    mockWindow({ showInformationMessage: vi.fn().mockResolvedValue(undefined) });

    await addEndpoint(secrets, onChange);

    const stored = await loadEndpoints(secrets);
    expect(stored[0].requestTimeoutMs).toBeUndefined();
    expect(stored[0].maxOutputTokens).toBeUndefined();
    expect(stored[0].virtualKey).toBeUndefined();
  });
});

// ─── editEndpoint ─────────────────────────────────────────────────────────────

describe('editEndpoint', () => {
  it('updates an existing endpoint', async () => {
    const secrets = makeSecrets({ 'bifrost.endpoints': JSON.stringify([sampleEndpoint]) });
    const onChange = makeNoopChange();

    // QuickPick selects the only endpoint; then all inputs use updated values
    const qp = vi.fn().mockResolvedValue({ label: 'local', description: sampleEndpoint.url, detail: '', endpoint: sampleEndpoint });
    const inputs = ['http://localhost:9090/openai/v1', 'local', '', '3000', '4096'];
    let callIdx = 0;
    mockWindow({
      showQuickPick: qp,
      showInputBox: vi.fn().mockImplementation(() => Promise.resolve(inputs[callIdx++])),
      showWarningMessage: vi.fn().mockResolvedValue(undefined),
      showInformationMessage: vi.fn().mockResolvedValue(undefined),
    });

    await editEndpoint(secrets, onChange);

    expect(onChange).toHaveBeenCalledOnce();
    const stored = await loadEndpoints(secrets);
    expect(stored[0].url).toContain('9090');
    expect(stored[0].requestTimeoutMs).toBe(3000);
    expect(stored[0].maxOutputTokens).toBe(4096);
  });

  it('shows warning and does nothing when no endpoints configured', async () => {
    const secrets = makeSecrets();
    const onChange = makeNoopChange();
    const warn = vi.fn().mockResolvedValue(undefined);
    mockWindow({ showWarningMessage: warn });

    await editEndpoint(secrets, onChange);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('No gateways'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ─── removeEndpoint ───────────────────────────────────────────────────────────

describe('removeEndpoint', () => {
  it('removes endpoint after confirmation', async () => {
    const secrets = makeSecrets({ 'bifrost.endpoints': JSON.stringify([sampleEndpoint]) });
    const onChange = makeNoopChange();

    mockWindow({
      showQuickPick: vi.fn().mockResolvedValue({ label: 'local', description: sampleEndpoint.url, detail: '', endpoint: sampleEndpoint }),
      showWarningMessage: vi.fn().mockResolvedValue('Remove'),
      showInformationMessage: vi.fn().mockResolvedValue(undefined),
    });

    await removeEndpoint(secrets, onChange);

    expect(onChange).toHaveBeenCalledOnce();
    expect(await loadEndpoints(secrets)).toHaveLength(0);
  });

  it('does nothing when user declines confirmation', async () => {
    const secrets = makeSecrets({ 'bifrost.endpoints': JSON.stringify([sampleEndpoint]) });
    const onChange = makeNoopChange();

    mockWindow({
      showQuickPick: vi.fn().mockResolvedValue({ label: 'local', description: sampleEndpoint.url, detail: '', endpoint: sampleEndpoint }),
      showWarningMessage: vi.fn().mockResolvedValue(undefined), // user dismissed
      showInformationMessage: vi.fn().mockResolvedValue(undefined),
    });

    await removeEndpoint(secrets, onChange);

    expect(onChange).not.toHaveBeenCalled();
    expect(await loadEndpoints(secrets)).toHaveLength(1);
  });
});

// ─── testConnection ───────────────────────────────────────────────────────────

describe('testConnection', () => {
  it('shows success message on HTTP 200', async () => {
    const secrets = makeSecrets({ 'bifrost.endpoints': JSON.stringify([sampleEndpoint]) });
    const info = vi.fn().mockResolvedValue(undefined);

    mockWindow({
      showQuickPick: vi.fn().mockResolvedValue({ label: 'local', description: sampleEndpoint.url, detail: '', endpoint: sampleEndpoint }),
      showInformationMessage: info,
      showWarningMessage: vi.fn().mockResolvedValue(undefined),
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'gpt-4o' }] }),
      text: async () => '',
    }));

    try {
      await testConnection(secrets);
      expect(info).toHaveBeenCalledWith(expect.stringContaining('Connected'));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shows error message on HTTP 401', async () => {
    const secrets = makeSecrets({ 'bifrost.endpoints': JSON.stringify([sampleEndpoint]) });
    const errFn = vi.fn().mockResolvedValue(undefined);

    mockWindow({
      showQuickPick: vi.fn().mockResolvedValue({ label: 'local', description: sampleEndpoint.url, detail: '', endpoint: sampleEndpoint }),
      showErrorMessage: errFn,
      showWarningMessage: vi.fn().mockResolvedValue(undefined),
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    }));

    try {
      await testConnection(secrets);
      expect(errFn).toHaveBeenCalledWith(expect.stringContaining('HTTP 401'));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shows error message on network failure', async () => {
    const secrets = makeSecrets({ 'bifrost.endpoints': JSON.stringify([sampleEndpoint]) });
    const errFn = vi.fn().mockResolvedValue(undefined);

    mockWindow({
      showQuickPick: vi.fn().mockResolvedValue({ label: 'local', description: sampleEndpoint.url, detail: '', endpoint: sampleEndpoint }),
      showErrorMessage: errFn,
      showWarningMessage: vi.fn().mockResolvedValue(undefined),
    });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    try {
      await testConnection(secrets);
      expect(errFn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ─── openDashboard ────────────────────────────────────────────────────────────

describe('openDashboard', () => {
  it('calls openExternal with the gateway origin URL', async () => {
    const secrets = makeSecrets({ 'bifrost.endpoints': JSON.stringify([sampleEndpoint]) });
    const openExternal = vi.fn().mockResolvedValue(true);

    mockWindow({
      showQuickPick: vi.fn().mockResolvedValue({ label: 'local', description: sampleEndpoint.url, detail: '', endpoint: sampleEndpoint }),
      showWarningMessage: vi.fn().mockResolvedValue(undefined),
    });
    Object.assign(vscode.env, { openExternal });

    await openDashboard(secrets);

    expect(openExternal).toHaveBeenCalledOnce();
    const arg = openExternal.mock.calls[0][0];
    // Uri.parse(origin) is called — arg should stringify to the origin
    expect(String(arg.toString())).toContain('localhost:8080');
  });
});

// ─── toggleEphemeralFilter ────────────────────────────────────────────────────

describe('toggleEphemeralFilter', () => {
  it('toggles from enabled (default) to disabled', async () => {
    const secrets = makeSecrets(); // no stored value → default is enabled
    const provider = makeProvider();
    const info = vi.fn().mockResolvedValue(undefined);
    mockWindow({ showInformationMessage: info });

    await toggleEphemeralFilter(secrets, provider);

    expect(provider.setEphemeralFilter).toHaveBeenCalledWith(false);
    expect(info).toHaveBeenCalledWith('Ephemeral filter: OFF');
    expect(await secrets.get('bifrost.filterEphemeralData')).toBe('false');
  });

  it('toggles from disabled to enabled', async () => {
    const secrets = makeSecrets({ 'bifrost.filterEphemeralData': 'false' });
    const provider = makeProvider();
    const info = vi.fn().mockResolvedValue(undefined);
    mockWindow({ showInformationMessage: info });

    await toggleEphemeralFilter(secrets, provider);

    expect(provider.setEphemeralFilter).toHaveBeenCalledWith(true);
    expect(info).toHaveBeenCalledWith('Ephemeral filter: ON');
    expect(await secrets.get('bifrost.filterEphemeralData')).toBe('true');
  });
});

// ─── Input prompt helpers ─────────────────────────────────────────────────────

describe('promptRequestTimeout', () => {
  it('returns undefined on blank input (no timeout)', async () => {
    mockWindow({ showInputBox: vi.fn().mockResolvedValue('') });
    expect(await promptRequestTimeout()).toBeUndefined();
  });

  it('returns null on cancel (ESC)', async () => {
    mockWindow({ showInputBox: vi.fn().mockResolvedValue(undefined) });
    expect(await promptRequestTimeout()).toBeNull();
  });

  it('returns number on valid input', async () => {
    mockWindow({ showInputBox: vi.fn().mockResolvedValue('5000') });
    expect(await promptRequestTimeout()).toBe(5000);
  });

  it('validates range via validateInput', async () => {
    // Call the validateInput function inline by spying on showInputBox and extracting opts
    let capturedOpts: { validateInput?: (v: string) => string | undefined } | undefined;
    mockWindow({
      showInputBox: vi.fn().mockImplementation((opts: { validateInput?: (v: string) => string | undefined }) => {
        capturedOpts = opts;
        return Promise.resolve('5000');
      }),
    });
    await promptRequestTimeout();

    expect(capturedOpts?.validateInput?.('500')).toMatch(/Minimum/);  // below 1000
    expect(capturedOpts?.validateInput?.('-1')).toMatch(/non-negative/);
    expect(capturedOpts?.validateInput?.('')).toBeUndefined();         // blank is valid
    expect(capturedOpts?.validateInput?.('5000')).toBeUndefined();     // valid
  });
});

describe('promptMaxOutputTokens', () => {
  it('returns undefined on blank input', async () => {
    mockWindow({ showInputBox: vi.fn().mockResolvedValue('') });
    expect(await promptMaxOutputTokens()).toBeUndefined();
  });

  it('returns null on cancel', async () => {
    mockWindow({ showInputBox: vi.fn().mockResolvedValue(undefined) });
    expect(await promptMaxOutputTokens()).toBeNull();
  });

  it('returns number on valid input', async () => {
    mockWindow({ showInputBox: vi.fn().mockResolvedValue('4096') });
    expect(await promptMaxOutputTokens()).toBe(4096);
  });

  it('rejects non-positive values via validateInput', async () => {
    let capturedOpts: { validateInput?: (v: string) => string | undefined } | undefined;
    mockWindow({
      showInputBox: vi.fn().mockImplementation((opts: { validateInput?: (v: string) => string | undefined }) => {
        capturedOpts = opts;
        return Promise.resolve('4096');
      }),
    });
    await promptMaxOutputTokens();

    expect(capturedOpts?.validateInput?.('0')).toMatch(/positive/);
    expect(capturedOpts?.validateInput?.('-1')).toMatch(/positive/);
    expect(capturedOpts?.validateInput?.('4096')).toBeUndefined();
  });
});

describe('promptShortname', () => {
  it('rejects invalid names and accepts valid names via validateInput', async () => {
    let capturedOpts: { validateInput?: (v: string) => string | undefined } | undefined;
    mockWindow({
      showInputBox: vi.fn().mockImplementation((opts: { validateInput?: (v: string) => string | undefined }) => {
        capturedOpts = opts;
        return Promise.resolve('valid');
      }),
    });
    await promptShortname();

    // names with slashes fail the regex — the error message mentions alphanumeric
    expect(capturedOpts?.validateInput?.('my/endpoint')).toMatch(/alphanumeric/);
    expect(capturedOpts?.validateInput?.('valid-name_1')).toBeUndefined();
    expect(capturedOpts?.validateInput?.('')).toMatch(/alphanumeric/);
    // names longer than 32 chars are rejected
    expect(capturedOpts?.validateInput?.('a'.repeat(33))).toMatch(/exceed/);
  });
});

describe('promptUrl', () => {
  it('rejects non-http URLs via validateInput', async () => {
    let capturedOpts: { validateInput?: (v: string) => string | undefined } | undefined;
    mockWindow({
      showInputBox: vi.fn().mockImplementation((opts: { validateInput?: (v: string) => string | undefined }) => {
        capturedOpts = opts;
        return Promise.resolve('http://localhost:8080/openai/v1');
      }),
      showWarningMessage: vi.fn().mockResolvedValue(undefined),
    });
    await promptUrl();

    expect(capturedOpts?.validateInput?.('ftp://bad')).toMatch(/http/);
    expect(capturedOpts?.validateInput?.('http://ok')).toBeUndefined();
    expect(capturedOpts?.validateInput?.('https://ok')).toBeUndefined();
  });

  it('returns undefined when user cancels', async () => {
    mockWindow({ showInputBox: vi.fn().mockResolvedValue(undefined) });
    expect(await promptUrl()).toBeUndefined();
  });
});
