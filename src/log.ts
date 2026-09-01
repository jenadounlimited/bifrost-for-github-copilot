// Logger helper with output channel, timestamps, and redaction

import * as vscode from 'vscode';

/**
 * Redact sensitive values from a log string.
 * Ensures virtual keys, bearer tokens, and x-bf-vk header values are never logged.
 */
export function redact(value: string): string {
  if (!value) {
    return value;
  }

  // Bifrost virtual keys: sk-bf-*
  let out = value.replace(/sk-bf-[a-zA-Z0-9_-]+/gi, '<REDACTED_VK>');

  // Authorization: Bearer <token>
  out = out.replace(/Authorization:\s*Bearer\s+[a-zA-Z0-9_.-]+/gi, 'Authorization: Bearer <REDACTED>');

  // x-bf-vk header value (32+ hex/alnum chars)
  out = out.replace(/(x-bf-vk:\s*)([a-zA-Z0-9]{32,})/gi, '$1<REDACTED>');

  return out;
}

/**
 * Format a Date as `HH:MM:SS.mmm`.
 */
function formatTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

/**
 * Logger class — writes to a VS Code output channel with timestamps and redaction.
 * Never logs prompts, completions, or virtual keys.
 */
export class Logger {
  private _outputChannel: vscode.OutputChannel;

  constructor(name: string) {
    this._outputChannel = vscode.window.createOutputChannel(name);
  }

  /** Log an informational message. */
  public info(message: string, endpointShortname?: string): void {
    this._write('INFO', message, endpointShortname);
  }

  /** Log a warning message. */
  public warn(message: string, endpointShortname?: string): void {
    this._write('WARN', message, endpointShortname);
  }

  /** Log an error message. */
  public error(message: string, endpointShortname?: string): void {
    this._write('ERROR', message, endpointShortname);
  }

  /** Show the output channel in the UI. */
  public show(): void {
    this._outputChannel.show();
  }

  /** Clear the output channel. */
  public clear(): void {
    this._outputChannel.clear();
  }

  /** Dispose the output channel. */
  public dispose(): void {
    this._outputChannel.dispose();
  }

  private _write(level: string, message: string, endpointShortname?: string): void {
    const ts = formatTime(new Date());
    const endpoint = endpointShortname ? ` [${endpointShortname}]` : '';
    this._outputChannel.appendLine(`${ts}${endpoint} [${level}] ${redact(message)}`);
  }
}
