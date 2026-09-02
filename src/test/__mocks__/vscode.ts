// Mock for the 'vscode' module used in Vitest tests
// Only the symbols actually used in tested files are mocked here.

export enum LanguageModelChatMessageRole {
  User = 1,
  Assistant = 2,
}

export enum LanguageModelChatToolMode {
  Auto = 1,
  Required = 2,
}

export class LanguageModelTextPart {
  constructor(public value: string) {}
}

export class LanguageModelToolCallPart {
  constructor(
    public callId: string,
    public name: string,
    public input: object,
  ) {}
}

export class LanguageModelToolResultPart {
  constructor(
    public callId: string,
    public content: unknown[],
  ) {}
}

export class LanguageModelDataPart {
  constructor(
    public mimeType: string,
    public data: Uint8Array,
  ) {}

  static image(data: Uint8Array, mime: string): LanguageModelDataPart {
    return new LanguageModelDataPart(mime, data);
  }
  static json(value: unknown, mime = 'application/json'): LanguageModelDataPart {
    return new LanguageModelDataPart(mime, new TextEncoder().encode(JSON.stringify(value)));
  }
  static text(value: string, mime = 'text/plain'): LanguageModelDataPart {
    return new LanguageModelDataPart(mime, new TextEncoder().encode(value));
  }
}

export class OutputChannel {
  appendLine(_: string) {}
  show() {}
  clear() {}
  dispose() {}
}

export const window = {
  createOutputChannel: () => new OutputChannel(),
  showInformationMessage: (..._args: unknown[]) => Promise.resolve(undefined),
  showWarningMessage: (..._args: unknown[]) => Promise.resolve(undefined),
  showErrorMessage: (..._args: unknown[]) => Promise.resolve(undefined),
  showQuickPick: (_items: unknown[], _opts?: unknown) => Promise.resolve(undefined),
  showInputBox: (_opts?: unknown) => Promise.resolve(undefined),
};

export const env = {
  openExternal: (_uri: unknown) => Promise.resolve(true),
};

export class Uri {
  static parse(value: string) { return { toString: () => value, fsPath: value }; }
}

export const lm = {
  registerLanguageModelChatProvider: () => ({ dispose: () => {} }),
  registerMcpServer: (_definition: unknown) => ({ dispose: () => {} }),
};

export const commands = {
  registerCommand: (_cmd: string, _cb: () => void) => ({ dispose: () => {} }),
};

export const extensions = {
  getExtension: () => undefined,
};

export const version = '1.104.0';
