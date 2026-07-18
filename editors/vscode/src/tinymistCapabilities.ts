import type { JsonRpcMessage } from "./tinymistTransport";
import { TYPST_PACKAGE_REQUEST_METHOD } from "./typstPackageProtocol";

export type TinymistPackageRequestHandler = (
  params: unknown,
  generation: number,
  signal: AbortSignal
) => Promise<unknown>;

export interface TinymistDynamicRegistration {
  readonly id: string;
  readonly method: string;
  readonly registerOptions?: unknown;
}

export interface TinymistDynamicUnregistration {
  readonly id: string;
  readonly method: string;
}

export interface TinymistCapabilityDescriptor {
  readonly method: string;
  readonly initializeOptions: unknown | undefined;
  readonly dynamicRegistrations: readonly TinymistDynamicRegistration[];
}

export interface TinymistCapabilityView {
  readonly generation: number;
  has(method: string): boolean;
  get(method: string): TinymistCapabilityDescriptor | undefined;
  list(): readonly TinymistCapabilityDescriptor[];
}

const INITIALIZE_PROVIDER_BY_METHOD: Readonly<Record<string, string>> = Object.freeze({
  "textDocument/completion": "completionProvider",
  "textDocument/hover": "hoverProvider",
  "textDocument/signatureHelp": "signatureHelpProvider",
  "textDocument/definition": "definitionProvider",
  "textDocument/typeDefinition": "typeDefinitionProvider",
  "textDocument/implementation": "implementationProvider",
  "textDocument/references": "referencesProvider",
  "textDocument/rename": "renameProvider",
  "textDocument/formatting": "documentFormattingProvider",
  "textDocument/rangeFormatting": "documentRangeFormattingProvider",
  "textDocument/documentSymbol": "documentSymbolProvider",
  "workspace/symbol": "workspaceSymbolProvider",
  "textDocument/documentHighlight": "documentHighlightProvider",
  "textDocument/selectionRange": "selectionRangeProvider",
  "textDocument/documentLink": "documentLinkProvider",
  "textDocument/documentColor": "colorProvider",
  "textDocument/colorPresentation": "colorProvider",
  "textDocument/codeAction": "codeActionProvider",
  "textDocument/inlayHint": "inlayHintProvider",
  "textDocument/codeLens": "codeLensProvider",
  "workspace/executeCommand": "executeCommandProvider"
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAdvertised(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

function addInitializeCapabilities(target: Map<string, unknown>, initializeResult: unknown): void {
  if (!isRecord(initializeResult) || !isRecord(initializeResult.capabilities)) return;
  const capabilities = initializeResult.capabilities;
  for (const [method, provider] of Object.entries(INITIALIZE_PROVIDER_BY_METHOD)) {
    const options = capabilities[provider];
    if (isAdvertised(options)) target.set(method, options);
  }

  const completion = capabilities.completionProvider;
  if (isRecord(completion) && completion.resolveProvider === true) {
    target.set("completionItem/resolve", completion);
  }
  const rename = capabilities.renameProvider;
  if (isRecord(rename) && rename.prepareProvider === true) {
    target.set("textDocument/prepareRename", rename);
  }
  const documentLink = capabilities.documentLinkProvider;
  if (isRecord(documentLink) && documentLink.resolveProvider === true) {
    target.set("documentLink/resolve", documentLink);
  }
  const codeAction = capabilities.codeActionProvider;
  if (isRecord(codeAction) && codeAction.resolveProvider === true) {
    target.set("codeAction/resolve", codeAction);
  }
  const inlayHint = capabilities.inlayHintProvider;
  if (isRecord(inlayHint) && inlayHint.resolveProvider === true) {
    target.set("inlayHint/resolve", inlayHint);
  }
  const codeLens = capabilities.codeLensProvider;
  if (isRecord(codeLens) && codeLens.resolveProvider === true) {
    target.set("codeLens/resolve", codeLens);
  }
  const workspaceSymbol = capabilities.workspaceSymbolProvider;
  if (isRecord(workspaceSymbol) && workspaceSymbol.resolveProvider === true) {
    target.set("workspaceSymbol/resolve", workspaceSymbol);
  }

  const semanticTokens = capabilities.semanticTokensProvider;
  if (isAdvertised(semanticTokens)) {
    target.set("textDocument/semanticTokens", semanticTokens);
    if (isRecord(semanticTokens)) {
      if (isAdvertised(semanticTokens.full)) {
        target.set("textDocument/semanticTokens/full", semanticTokens);
        if (isRecord(semanticTokens.full) && semanticTokens.full.delta === true) {
          target.set("textDocument/semanticTokens/full/delta", semanticTokens);
        }
      }
      if (isAdvertised(semanticTokens.range)) {
        target.set("textDocument/semanticTokens/range", semanticTokens);
      }
    }
  }
}

function dynamicRegistrationMethods(registration: TinymistDynamicRegistration): readonly string[] {
  const methods = [registration.method];
  if (!isRecord(registration.registerOptions)) return methods;
  if (registration.method === "textDocument/semanticTokens") {
    if (isAdvertised(registration.registerOptions.full)) {
      methods.push("textDocument/semanticTokens/full");
      if (isRecord(registration.registerOptions.full) && registration.registerOptions.full.delta === true) {
        methods.push("textDocument/semanticTokens/full/delta");
      }
    }
    if (isAdvertised(registration.registerOptions.range)) {
      methods.push("textDocument/semanticTokens/range");
    }
    return methods;
  }
  if (registration.method === "textDocument/completion" && registration.registerOptions.resolveProvider === true) {
    methods.push("completionItem/resolve");
  } else if (registration.method === "textDocument/rename" && registration.registerOptions.prepareProvider === true) {
    methods.push("textDocument/prepareRename");
  } else if (registration.method === "textDocument/documentLink" && registration.registerOptions.resolveProvider === true) {
    methods.push("documentLink/resolve");
  } else if (registration.method === "textDocument/codeAction" && registration.registerOptions.resolveProvider === true) {
    methods.push("codeAction/resolve");
  } else if (registration.method === "textDocument/inlayHint" && registration.registerOptions.resolveProvider === true) {
    methods.push("inlayHint/resolve");
  } else if (registration.method === "textDocument/codeLens" && registration.registerOptions.resolveProvider === true) {
    methods.push("codeLens/resolve");
  } else if (registration.method === "workspace/symbol" && registration.registerOptions.resolveProvider === true) {
    methods.push("workspaceSymbol/resolve");
  }
  return methods;
}

export class TinymistCapabilityRegistry implements TinymistCapabilityView {
  private currentGeneration = 0;
  private readonly initialize = new Map<string, unknown>();
  private readonly registrationsById = new Map<string, TinymistDynamicRegistration>();
  private readonly registrationsByMethod = new Map<string, Map<string, TinymistDynamicRegistration>>();
  private descriptors = new Map<string, TinymistCapabilityDescriptor>();
  private orderedDescriptors: readonly TinymistCapabilityDescriptor[] = Object.freeze([]);

  constructor(private readonly changed?: (view: TinymistCapabilityView) => void) {}

  get generation(): number {
    return this.currentGeneration;
  }

  install(generation: number, initializeResult: unknown): void {
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new Error(`Invalid Tinymist capability generation: ${generation}`);
    }
    this.currentGeneration = generation;
    this.initialize.clear();
    this.registrationsById.clear();
    this.registrationsByMethod.clear();
    addInitializeCapabilities(this.initialize, initializeResult);
    this.rebuild();
  }

  clear(generation?: number): boolean {
    if (generation !== undefined && generation !== this.currentGeneration) return false;
    if (this.currentGeneration === 0 && this.initialize.size === 0 && this.registrationsById.size === 0) {
      return false;
    }
    this.currentGeneration = 0;
    this.initialize.clear();
    this.registrationsById.clear();
    this.registrationsByMethod.clear();
    this.rebuild();
    return true;
  }

  register(generation: number, registrations: readonly TinymistDynamicRegistration[]): boolean {
    if (generation !== this.currentGeneration || generation === 0) return false;
    let changed = false;
    for (const registration of registrations) {
      const previous = this.registrationsById.get(registration.id);
      if (previous) this.removeRegistration(previous);
      const frozen = Object.freeze({ ...registration });
      this.registrationsById.set(frozen.id, frozen);
      for (const method of dynamicRegistrationMethods(frozen)) {
        const methodRegistrations = this.registrationsByMethod.get(method) ?? new Map();
        methodRegistrations.set(frozen.id, frozen);
        this.registrationsByMethod.set(method, methodRegistrations);
      }
      changed = true;
    }
    if (changed) this.rebuild();
    return changed;
  }

  unregister(generation: number, unregistrations: readonly TinymistDynamicUnregistration[]): boolean {
    if (generation !== this.currentGeneration || generation === 0) return false;
    let changed = false;
    for (const unregistration of unregistrations) {
      const registration = this.registrationsById.get(unregistration.id);
      if (!registration || registration.method !== unregistration.method) continue;
      this.removeRegistration(registration);
      changed = true;
    }
    if (changed) this.rebuild();
    return changed;
  }

  has(method: string): boolean {
    return this.descriptors.has(method);
  }

  get(method: string): TinymistCapabilityDescriptor | undefined {
    return this.descriptors.get(method);
  }

  list(): readonly TinymistCapabilityDescriptor[] {
    return this.orderedDescriptors;
  }

  private removeRegistration(registration: TinymistDynamicRegistration): void {
    this.registrationsById.delete(registration.id);
    for (const method of dynamicRegistrationMethods(registration)) {
      const methodRegistrations = this.registrationsByMethod.get(method);
      methodRegistrations?.delete(registration.id);
      if (methodRegistrations?.size === 0) this.registrationsByMethod.delete(method);
    }
  }

  private rebuild(): void {
    const methods = new Set([...this.initialize.keys(), ...this.registrationsByMethod.keys()]);
    const descriptors = new Map<string, TinymistCapabilityDescriptor>();
    for (const method of [...methods].sort()) {
      const dynamicRegistrations = Object.freeze([
        ...(this.registrationsByMethod.get(method)?.values() ?? [])
      ]);
      descriptors.set(method, Object.freeze({
        method,
        initializeOptions: this.initialize.get(method),
        dynamicRegistrations
      }));
    }
    this.descriptors = descriptors;
    this.orderedDescriptors = Object.freeze([...descriptors.values()]);
    this.changed?.(this);
  }
}

export class TinymistServerRequestDispatcher {
  constructor(
    private readonly capabilities?: TinymistCapabilityRegistry,
    private readonly packageRequest?: TinymistPackageRequestHandler
  ) {}

  dispatch(message: JsonRpcMessage, generation: number, signal: AbortSignal = new AbortController().signal): JsonRpcMessage | Promise<JsonRpcMessage> {
    const id = message.id ?? null;
    switch (message.method) {
      case "workspace/configuration": {
        const items = isRecord(message.params) && Array.isArray(message.params.items)
          ? message.params.items
          : [];
        return { jsonrpc: "2.0", id, result: items.map(() => null) };
      }
      case "window/workDoneProgress/create":
        return { jsonrpc: "2.0", id, result: null };
      case "client/registerCapability": {
        const registrations = parseRegistrations(message.params);
        if (!registrations) return invalidParams(id, message.method);
        this.capabilities?.register(generation, registrations);
        return { jsonrpc: "2.0", id, result: null };
      }
      case "client/unregisterCapability": {
        const unregistrations = parseUnregistrations(message.params);
        if (!unregistrations) return invalidParams(id, message.method);
        this.capabilities?.unregister(generation, unregistrations);
        return { jsonrpc: "2.0", id, result: null };
      }
      case TYPST_PACKAGE_REQUEST_METHOD:
        if (!this.packageRequest) return methodNotFound(id, message.method);
        return this.packageRequest(message.params, generation, signal).then((result) => ({ jsonrpc: "2.0", id, result }));
      default:
        return methodNotFound(id, message.method);
    }
  }
}

function methodNotFound(id: JsonRpcMessage["id"], method: string | undefined): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code: -32601,
      message: `Unsupported Tinymist server request: ${method ?? "unknown"}`
    }
  }
}

export function serverRequestResponse(message: JsonRpcMessage): JsonRpcMessage {
  const response = new TinymistServerRequestDispatcher().dispatch(message, 0);
  if (response instanceof Promise) throw new Error("Unexpected asynchronous server request response");
  return response;
}

function parseRegistrations(params: unknown): readonly TinymistDynamicRegistration[] | undefined {
  if (!isRecord(params) || !Array.isArray(params.registrations)) return undefined;
  const registrations: TinymistDynamicRegistration[] = [];
  for (const value of params.registrations) {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.method !== "string") {
      return undefined;
    }
    registrations.push({
      id: value.id,
      method: value.method,
      ...(value.registerOptions === undefined ? {} : { registerOptions: value.registerOptions })
    });
  }
  return registrations;
}

function parseUnregistrations(params: unknown): readonly TinymistDynamicUnregistration[] | undefined {
  if (!isRecord(params)) return undefined;
  const values = Array.isArray(params.unregisterations)
    ? params.unregisterations
    : Array.isArray(params.unregistrations)
      ? params.unregistrations
      : undefined;
  if (!values) return undefined;
  const unregistrations: TinymistDynamicUnregistration[] = [];
  for (const value of values) {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.method !== "string") {
      return undefined;
    }
    unregistrations.push({ id: value.id, method: value.method });
  }
  return unregistrations;
}

function invalidParams(id: JsonRpcMessage["id"], method: string): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code: -32602, message: `Invalid parameters for Tinymist server request: ${method}` }
  };
}
