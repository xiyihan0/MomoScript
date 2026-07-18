import type { CancellationToken } from "vscode";
import type { BaseLanguageClient } from "vscode-languageclient";
import type {
  CompletionContext,
  CompletionItem,
  CompletionList,
  Diagnostic,
  Hover,
  SemanticTokens,
  SignatureHelp,
  SignatureHelpContext
} from "vscode-languageserver-protocol";

import type { TinymistCapabilityDescriptor, TinymistCapabilityView } from "./tinymistCapabilities";
import type { TinymistHostBackend, TypstProjectUpdate } from "./tinymistClient";
import {
  TinymistDispatchError,
  TinymistRequestDispatcher,
  type TinymistRequestDefinition,
  type TinymistRequestIdentity
} from "./tinymistRequestDispatcher";
import {
  TypstProviderQualificationRegistry,
  bindTypstProviderResolveMetadata,
  readTypstProviderResolveMetadata,
  typstProviderResolveIdentityIsCurrent,
  unwrapTypstProviderResolveItem,
  validateTypstProviderPositions,
  type TypstProviderCapabilityContract,
  type TypstProviderHost,
  type TypstProviderMethod,
  type TypstProviderPositionContext,
  type TypstProviderRegistrationContract,
  type TypstProviderRequests,
  type TypstProviderResolveMetadata
} from "./typstProviderDescriptors";
import {
  validateTypstProviderPayload,
  type TypstProviderPayloadValidationInput,
  type TypstProviderPayloadValidationResult
} from "./typstProviderPayload";
import type { LogicalSourceId } from "./runtimeIdentity";
import {
  SourceStaleTokenRegistry,
  type CanonicalTypstProjectIdentity
} from "./typstProtocol";
import {
  LineIndex,
  PositionConversionError,
  mmtClientPosition,
  parseProjectedPosition,
  parseProjectedRange,
  retainedBackendPosition,
  retainedBackendRange,
  validatePositionBearingPayload,
  wireBackendPosition,
  type PositionEncoding,
  type RetainedBackendPosition,
  type RetainedBackendRange,
  type WirePosition,
  type WireRange
} from "./typstPosition";

export type BaselineTypstMethod =
  | "textDocument/completion"
  | "textDocument/hover"
  | "textDocument/signatureHelp"
  | "textDocument/semanticTokens/full";

export interface BaselineTypstRequests {
  "textDocument/completion": TinymistRequestDefinition<unknown, CompletionItem[] | CompletionList | null>;
  "textDocument/hover": TinymistRequestDefinition<unknown, Hover | null>;
  "textDocument/signatureHelp": TinymistRequestDefinition<unknown, SignatureHelp | null>;
  "textDocument/semanticTokens/full": TinymistRequestDefinition<unknown, SemanticTokens | null>;
}

export type TypstRouterRequests = BaselineTypstRequests & TypstProviderRequests;

export interface TypstRouterDocument {
  readonly languageId: string;
  readonly uri: string;
  readonly version: number;
  readonly text: string;
}

export interface TypstCapabilityUnavailableState {
  readonly kind: "CapabilityUnavailable";
  readonly method: BaselineTypstMethod;
  readonly backendGeneration: number;
  readonly message: string;
}

export interface TypstProviderRegistration {
  readonly method: BaselineTypstMethod;
  readonly triggerCharacters: readonly string[];
  readonly retriggerCharacters: readonly string[];
  readonly resolveProvider: boolean;
}

export interface RoutedTypstDiagnostics {
  readonly uri: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly identity: TinymistRequestIdentity;
}

export interface TypstProviderResolveRequest<Item> {
  readonly item: Item;
  readonly identity: TinymistRequestIdentity;
  readonly metadata: TypstProviderResolveMetadata;
}

export interface RoutedStandaloneTypstProviderResult<Method extends TypstProviderMethod> {
  readonly method: Method;
  readonly value: TypstProviderRequests[Method]["result"];
  readonly identity: TinymistRequestIdentity;
  readonly positionContext: TypstProviderPositionContext;
  readonly capability: TypstProviderRegistrationContract;
}

export interface RoutedProjectedTypstProviderResult<Method extends TypstProviderMethod>
  extends RoutedStandaloneTypstProviderResult<Method> {
  readonly entryUri: string;
  readonly revision: number;
  readonly encoding: PositionEncoding;
}

interface GuardedBackendPosition extends RetainedBackendPosition {
  readonly identity: TinymistRequestIdentity;
}

interface GuardedBackendRange extends RetainedBackendRange {
  readonly identity: TinymistRequestIdentity;
}

interface StandaloneRoute {
  readonly entryUri: string;
  readonly index: LineIndex;
  readonly identity: TinymistRequestIdentity;
}

interface DiagnosticsParams {
  readonly uri: string;
  readonly version?: number | null;
  readonly diagnostics: Diagnostic[];
}

export interface TypstFeatureRouterOptions {
  readonly backendEncoding?: PositionEncoding;
  readonly unavailable?: (state: TypstCapabilityUnavailableState) => void;
}

/**
 * One capability-gated route for the current Typst language surface. The router
 * owns request identity, cancellation, position conversion, projection lookup,
 * and response publication checks; transports retain JSON-RPC ownership.
 */
export class TypstFeatureRouter {
  readonly staleTokens = new SourceStaleTokenRegistry();

  private readonly sourceIndexes = new Map<string, { version: number; index: LineIndex }>();
  private readonly entryByHostUri = new Map<string, string>();
  private readonly reportedUnavailable = new Set<string>();
  private readonly backendEncoding: PositionEncoding;
  private readonly dispatcher: TinymistRequestDispatcher<TypstRouterRequests>;

  constructor(
    private readonly backend: TinymistHostBackend,
    private readonly client: () => BaseLanguageClient,
    private readonly options: TypstFeatureRouterOptions = {}
  ) {
    this.backendEncoding = options.backendEncoding ?? "utf-16";
    this.dispatcher = new TinymistRequestDispatcher<TypstRouterRequests>(
      (envelope, signal) => this.backend.request(envelope.method, envelope.params, signal),
      (captured) => this.currentIdentity(captured.sourceStaleToken.hostUri)
    );
  }

  retain(document: TypstRouterDocument): void {
    this.sourceIndexes.set(document.uri, { version: document.version, index: new LineIndex(document.text) });
  }

  open(document: TypstRouterDocument): void {
    this.dispatcher.retireHost(document.uri);
    this.retain(document);
    this.staleTokens.open(document.uri, document.version);
  }

  change(document: TypstRouterDocument): void {
    this.dispatcher.retireHost(document.uri);
    this.retain(document);
    this.staleTokens.advance(document.uri, document.version);
  }

  retire(uri: string): void {
    this.dispatcher.retireHost(uri);
  }

  close(uri: string): void {
    this.dispatcher.retireHost(uri);
    this.sourceIndexes.delete(uri);
    this.entryByHostUri.delete(uri);
    this.staleTokens.close(uri);
  }

  retireBackendGenerationsExcept(generation: number): void {
    this.dispatcher.retireGenerationsExcept(generation);
  }

  retireAllRequests(): void {
    this.dispatcher.retireAll();
  }

  capability(method: BaselineTypstMethod): TypstProviderRegistration | TypstCapabilityUnavailableState {
    const descriptor = this.backend.capabilities().get(method);
    if (!descriptor) return this.unavailable(method);
    return registrationFromDescriptor(method, descriptor);
  }

  registrations(): readonly TypstProviderRegistration[] {
    const methods: readonly BaselineTypstMethod[] = [
      "textDocument/completion",
      "textDocument/hover",
      "textDocument/signatureHelp",
      "textDocument/semanticTokens/full"
    ];
    const registrations: TypstProviderRegistration[] = [];
    for (const method of methods) {
      const descriptor = this.backend.capabilities().get(method);
      if (descriptor) registrations.push(registrationFromDescriptor(method, descriptor));
    }
    return registrations;
  }

  providerCapability(
    host: TypstProviderHost,
    method: TypstProviderMethod
  ): TypstProviderCapabilityContract {
    return new TypstProviderQualificationRegistry(this.backend.capabilities(), host).capability(method);
  }

  providerRegistrations(host: TypstProviderHost): readonly TypstProviderRegistrationContract[] {
    return new TypstProviderQualificationRegistry(this.backend.capabilities(), host).registrations();
  }

  validateProviderPositions<T>(
    method: TypstProviderMethod,
    value: T,
    context: TypstProviderPositionContext
  ): T {
    return validateTypstProviderPositions(method, value, context);
  }

  validateProviderPayload(
    host: TypstProviderHost,
    input: Omit<TypstProviderPayloadValidationInput, "capability">
  ): TypstProviderPayloadValidationResult {
    return validateTypstProviderPayload({
      ...input,
      capability: this.providerCapability(host, input.method)
    });
  }

  bindProviderResolveItem<Item>(
    requestMethod: TypstProviderMethod,
    item: Item,
    identity: TinymistRequestIdentity
  ): Item {
    return bindTypstProviderResolveMetadata(requestMethod, item, identity);
  }

  providerResolveRequest<Item>(
    resolveMethod: TypstProviderMethod,
    item: Item
  ): TypstProviderResolveRequest<Item> | undefined {
    const metadata = readTypstProviderResolveMetadata(resolveMethod, item);
    if (!metadata || !typstProviderResolveIdentityIsCurrent(
      metadata,
      this.currentIdentity(metadata.identity.sourceStaleToken.hostUri)
    )) return undefined;
    return Object.freeze({
      item: unwrapTypstProviderResolveItem(item, metadata),
      identity: metadata.identity,
      metadata
    });
  }

  /** Routes a qualified standalone provider through the shared generation/snapshot dispatcher. */
  async standaloneProvider<Method extends TypstProviderMethod>(
    host: TypstProviderHost,
    method: Method,
    document: TypstRouterDocument,
    params: TypstProviderRequests[Method]["params"],
    token: CancellationToken
  ): Promise<RoutedStandaloneTypstProviderResult<Method> | undefined> {
    if (document.languageId !== "typst") return undefined;
    const capability = this.providerCapability(host, method);
    if (capability.kind !== "QualifiedProvider") return undefined;
    const route = this.standaloneRoute(document);
    if (!route) return undefined;
    const routedParams = routeStandaloneProviderParams(
      params,
      route.entryUri,
      route.index,
      this.backendEncoding
    ) as TypstProviderRequests[Method]["params"];
    const value = await this.request(method, routedParams, route.identity, token);
    if (value === undefined
      || !this.identityIsCurrent(route.identity)
      || !this.providerCapabilityIsCurrent(host, method, capability)) return undefined;
    const positionContext = this.providerPositionContext(route.identity, route.entryUri);
    validateTypstProviderPositions(method, value, positionContext);
    return Object.freeze({ method, value, identity: route.identity, positionContext, capability });
  }

  async projectedProviderAtPosition<Method extends "textDocument/prepareRename" | "textDocument/rename">(
    host: TypstProviderHost,
    method: Method,
    document: TypstRouterDocument,
    position: WirePosition,
    params: TypstProviderRequests[Method]["params"],
    token: CancellationToken
  ): Promise<RoutedProjectedTypstProviderResult<Method> | undefined> {
    if (document.languageId === "typst") return undefined;
    const capability = this.providerCapability(host, method);
    if (capability.kind !== "QualifiedProvider") return undefined;
    const route = await this.projectedRoute(document, position, token);
    if (!route) return undefined;
    const routedParams = {
      ...params,
      textDocument: { uri: route.entryUri },
      position: wireBackendPosition(route.position)
    } as TypstProviderRequests[Method]["params"];
    const value = await this.request(method, routedParams, route.identity, token);
    if (value === undefined
      || !this.identityIsCurrent(route.identity)
      || !this.providerCapabilityIsCurrent(host, method, capability)) return undefined;
    const positionContext = this.providerPositionContext(route.identity, route.entryUri);
    validateTypstProviderPositions(method, value, positionContext);
    return Object.freeze({
      method,
      value,
      identity: route.identity,
      positionContext,
      capability,
      entryUri: route.entryUri,
      revision: route.revision,
      encoding: route.position.encoding
    });
  }

  async projectedProviderAtRange<Method extends
    | "textDocument/rangeFormatting"
    | "textDocument/codeAction"
  >(
    host: TypstProviderHost,
    method: Method,
    document: TypstRouterDocument,
    range: WireRange,
    params: TypstProviderRequests[Method]["params"],
    token: CancellationToken
  ): Promise<RoutedProjectedTypstProviderResult<Method> | undefined> {
    if (document.languageId === "typst") return undefined;
    const capability = this.providerCapability(host, method);
    if (capability.kind !== "QualifiedProvider") return undefined;
    const route = await this.projectedRangeRoute(document, range, token);
    if (!route) return undefined;
    const routedParams = {
      ...params,
      textDocument: { uri: route.entryUri },
      range: route.range
    } as TypstProviderRequests[Method]["params"];
    const value = await this.request(method, routedParams, route.identity, token);
    if (value === undefined
      || !this.identityIsCurrent(route.identity)
      || !this.providerCapabilityIsCurrent(host, method, capability)) return undefined;
    const positionContext = this.providerPositionContext(route.identity, route.entryUri);
    validateTypstProviderPositions(method, value, positionContext);
    return Object.freeze({
      method,
      value,
      identity: route.identity,
      positionContext,
      capability,
      entryUri: route.entryUri,
      revision: route.revision,
      encoding: route.encoding
    });
  }

  async projectedProviderResolve(
    host: TypstProviderHost,
    method: "codeAction/resolve",
    item: TypstProviderRequests["codeAction/resolve"]["params"],
    token: CancellationToken
  ): Promise<RoutedProjectedTypstProviderResult<"codeAction/resolve"> | undefined> {
    const capability = this.providerCapability(host, method);
    if (capability.kind !== "QualifiedProvider") return undefined;
    const resolve = this.providerResolveRequest(method, item);
    if (!resolve) return undefined;
    const entryUri = this.entryByHostUri.get(resolve.identity.sourceStaleToken.hostUri);
    const project = entryUri ? this.backend.projectForEntry(entryUri) : undefined;
    if (!entryUri || !project || project.sourceUri === project.entryUri) return undefined;
    const value = await this.request(
      method,
      resolve.item as TypstProviderRequests["codeAction/resolve"]["params"],
      resolve.identity,
      token
    );
    if (value === undefined
      || !this.identityIsCurrent(resolve.identity)
      || !this.providerCapabilityIsCurrent(host, method, capability)) return undefined;
    const positionContext = this.providerPositionContext(resolve.identity, entryUri);
    validateTypstProviderPositions(method, value, positionContext);
    return Object.freeze({
      method,
      value,
      identity: resolve.identity,
      positionContext,
      capability,
      entryUri,
      revision: project.revision,
      encoding: this.backendEncoding
    });
  }

  /** Resolves only host-authenticated items that still match the retained backend generation. */
  async standaloneProviderResolve<Method extends TypstProviderMethod>(
    host: TypstProviderHost,
    method: Method,
    item: TypstProviderRequests[Method]["params"],
    token: CancellationToken
  ): Promise<RoutedStandaloneTypstProviderResult<Method> | undefined> {
    const capability = this.providerCapability(host, method);
    if (capability.kind !== "QualifiedProvider") return undefined;
    const resolve = this.providerResolveRequest(method, item);
    if (!resolve) return undefined;
    const entryUri = this.entryByHostUri.get(resolve.identity.sourceStaleToken.hostUri);
    if (!entryUri) return undefined;
    const positionContext = this.providerPositionContext(resolve.identity, entryUri);
    const routedItem = routeProviderResolveParams(method, resolve.item, positionContext);
    const value = await this.request(
      method,
      routedItem as TypstProviderRequests[Method]["params"],
      resolve.identity,
      token
    );
    if (value === undefined
      || !this.identityIsCurrent(resolve.identity)
      || !this.providerCapabilityIsCurrent(host, method, capability)) return undefined;
    validateTypstProviderPositions(method, value, positionContext);
    return Object.freeze({ method, value, identity: resolve.identity, positionContext, capability });
  }

  providerIdentityIsCurrent(identity: TinymistRequestIdentity): boolean {
    return this.identityIsCurrent(identity);
  }

  async completion(
    document: TypstRouterDocument,
    position: WirePosition,
    context: CompletionContext,
    token: CancellationToken
  ): Promise<CompletionItem[] | CompletionList | null | undefined> {
    if (!this.requireCapability("textDocument/completion")) return undefined;
    if (document.languageId === "typst") {
      const route = this.standaloneRoute(document);
      if (!route) return undefined;
      const result = await this.request("textDocument/completion", {
        textDocument: { uri: route.entryUri },
        position: wireBackendPosition(this.standaloneBackendPosition(route.identity, position)),
        context: completionContext(context)
      }, route.identity, token);
      if (result === undefined) return undefined;
      validatePositionBearingPayload("completion", result, route.index, this.backendEncoding);
      return result;
    }

    const route = await this.projectedRoute(document, position, token);
    if (!route) return undefined;
    const result = await this.request("textDocument/completion", {
      textDocument: { uri: route.entryUri },
      position: wireBackendPosition(route.position),
      context: completionContext(context)
    }, route.identity, token);
    if (result === undefined || result === null) return result;
    validatePositionBearingPayload("completion", result, route.index, route.position.encoding);
    const list = Array.isArray(result) ? undefined : result;
    const items = Array.isArray(result) ? result : result.items;
    const defaults = list?.itemDefaults;
    const defaultEditRange = defaults?.editRange;
    let mappingItems = items;
    if (defaultEditRange !== undefined) {
      // validatePositionBearingPayload proved the protocol union before this narrowing.
      const validatedDefaultEditRange = defaultEditRange as NonNullable<
        NonNullable<CompletionList["itemDefaults"]>["editRange"]
      >;
      mappingItems = [...items, {
        label: "",
        textEdit: "insert" in validatedDefaultEditRange
          ? {
              newText: "",
              insert: validatedDefaultEditRange.insert,
              replace: validatedDefaultEditRange.replace
            }
          : { newText: "", range: validatedDefaultEditRange }
      }];
    }
    const mapped = await this.client().sendRequest<CompletionItem[] | null>(
      "mmt/mapTypstCompletion",
      mappingParams(document, route, { items: mappingItems }),
      token
    );
    if (!mapped || !this.identityIsCurrent(route.identity)) return undefined;
    if (defaultEditRange !== undefined && mapped.length !== mappingItems.length) return undefined;
    if (defaultEditRange === undefined) {
      validatePositionBearingPayload("completion", mapped, this.sourceIndex(route.identity), "utf-16");
      if (list === undefined) return mapped;
      const completedWithoutDefault: CompletionList = { ...list, items: mapped };
      return completedWithoutDefault;
    }
    const mappedTextEdit = mapped[mapped.length - 1]?.textEdit;
    const mappedEditRange = mappedTextEdit === undefined
      ? undefined
      : "range" in mappedTextEdit
        ? mappedTextEdit.range
        : { insert: mappedTextEdit.insert, replace: mappedTextEdit.replace };
    if (mappedEditRange === undefined || !list || !defaults) return undefined;
    const completed: CompletionList = {
      ...list,
      itemDefaults: { ...defaults, editRange: mappedEditRange },
      items: mapped.slice(0, -1)
    };
    validatePositionBearingPayload("completion", completed, this.sourceIndex(route.identity), "utf-16");
    return completed;
  }

  async hover(
    document: TypstRouterDocument,
    position: WirePosition,
    token: CancellationToken
  ): Promise<Hover | null | undefined> {
    if (!this.requireCapability("textDocument/hover")) return undefined;
    if (document.languageId === "typst") {
      const route = this.standaloneRoute(document);
      if (!route) return undefined;
      const hover = await this.request("textDocument/hover", {
        textDocument: { uri: route.entryUri },
        position: wireBackendPosition(this.standaloneBackendPosition(route.identity, position))
      }, route.identity, token);
      if (!hover) return hover;
      validatePositionBearingPayload("hover", hover, route.index, this.backendEncoding);
      return hover;
    }

    const route = await this.projectedRoute(document, position, token);
    if (!route) return undefined;
    const hover = await this.request("textDocument/hover", {
      textDocument: { uri: route.entryUri },
      position: wireBackendPosition(route.position)
    }, route.identity, token);
    if (!hover) return hover;
    validatePositionBearingPayload("hover", hover, route.index, route.position.encoding);
    const mapped = await this.client().sendRequest<Hover | null>(
      "mmt/mapTypstHover",
      mappingParams(document, route, { hover }),
      token
    );
    if (!mapped || !this.identityIsCurrent(route.identity)) return mapped;
    validatePositionBearingPayload("hover", mapped, this.sourceIndex(route.identity), "utf-16");
    return mapped;
  }

  async signatureHelp(
    document: TypstRouterDocument,
    position: WirePosition,
    context: SignatureHelpContext,
    token: CancellationToken
  ): Promise<SignatureHelp | null | undefined> {
    if (!this.requireCapability("textDocument/signatureHelp")) return undefined;
    if (document.languageId === "typst") {
      const route = this.standaloneRoute(document);
      if (!route) return undefined;
      return await this.request("textDocument/signatureHelp", {
        textDocument: { uri: route.entryUri },
        position: wireBackendPosition(this.standaloneBackendPosition(route.identity, position)),
        context: signatureContext(context)
      }, route.identity, token);
    }

    const route = await this.projectedRoute(document, position, token);
    if (!route) return undefined;
    const signature = await this.request("textDocument/signatureHelp", {
      textDocument: { uri: route.entryUri },
      // Tinymist 0.15.2 advances the offset before classifying arguments.
      position: wireBackendPosition(route.index.previousScalar(route.position)),
      context: signatureContext(context)
    }, route.identity, token);
    if (!signature) return signature;
    const current = await this.projectedRoute(document, position, token);
    return current?.projectionKey === route.projectionKey && this.identityIsCurrent(route.identity)
      ? signature
      : undefined;
  }

  async semanticTokens(
    document: TypstRouterDocument,
    token: CancellationToken
  ): Promise<SemanticTokens | null | undefined> {
    if (document.languageId !== "typst") return undefined;
    if (!this.requireCapability("textDocument/semanticTokens/full")) return undefined;
    const route = this.standaloneRoute(document);
    if (!route) return undefined;
    const result = await this.request("textDocument/semanticTokens/full", {
      textDocument: { uri: route.entryUri }
    }, route.identity, token);
    if (!result) return result;
    validatePositionBearingPayload("semanticTokens", result, route.index, this.backendEncoding);
    return result;
  }

  async diagnostics(params: DiagnosticsParams): Promise<RoutedTypstDiagnostics | undefined> {
    const project = this.backend.projectForEntry(params.uri);
    if (!project || (params.version != null && params.version !== project.revision)) return undefined;
    const identity = this.capture(project, project.sourceUri, project.sourceVersion);
    if (!identity) return undefined;
    const projectIndex = retainedProjectIndex(project, project.entryUri);
    validatePositionBearingPayload("diagnostics", params.diagnostics, projectIndex, this.backendEncoding);
    if (project.sourceUri === project.entryUri) {
      return this.identityIsCurrent(identity)
        ? { uri: project.sourceUri, diagnostics: params.diagnostics, identity }
        : undefined;
    }
    const mapped = await this.client().sendRequest<Diagnostic[] | null>(
      "mmt/mapTypstDiagnostics",
      {
        sourceUri: project.sourceUri,
        revision: project.revision,
        entryUri: project.entryUri,
        backendEncoding: this.backendEncoding,
        sourceContent: identity.sourceContent,
        projectDigest: identity.projectSnapshot,
        projectionKey: identity.projectionKey,
        diagnostics: params.diagnostics
      }
    );
    if (!mapped || !this.identityIsCurrent(identity)) return undefined;
    validatePositionBearingPayload("diagnostics", mapped, this.sourceIndex(identity), "utf-16");
    return { uri: project.sourceUri, diagnostics: mapped, identity };
  }

  diagnosticsAreCurrent(routed: RoutedTypstDiagnostics): boolean {
    return this.identityIsCurrent(routed.identity);
  }

  private standaloneRoute(document: TypstRouterDocument): StandaloneRoute | undefined {
    const project = this.backend.projectForEntry(document.uri);
    const identity = this.capture(project, document.uri, document.version);
    if (!project || !identity) return undefined;
    return {
      entryUri: project.entryUri,
      index: retainedProjectIndex(project, project.entryUri),
      identity
    };
  }

  private standaloneBackendPosition(identity: TinymistRequestIdentity, position: WirePosition) {
    const clientPosition = mmtClientPosition(position, "utf-16");
    return this.sourceIndex(identity).convertClient(clientPosition, this.backendEncoding);
  }

  private async projectedRoute(
    document: TypstRouterDocument,
    position: WirePosition,
    token: CancellationToken
  ): Promise<GuardedBackendPosition | undefined> {
    const value = await this.client().sendRequest<unknown>(
      "mmt/typstPosition",
      {
        textDocument: { uri: document.uri },
        position,
        backendEncoding: this.backendEncoding
      },
      token
    );
    if (value === null) return undefined;
    const projected = parseProjectedPosition(value);
    const project = this.backend.projectForEntry(projected.entryUri);
    const retained = retainedBackendPosition(projected, project);
    const identity = this.capture(project, document.uri, document.version);
    return identity ? { ...retained, identity } : undefined;
  }

  private async projectedRangeRoute(
    document: TypstRouterDocument,
    range: WireRange,
    token: CancellationToken
  ): Promise<GuardedBackendRange | undefined> {
    const value = await this.client().sendRequest<unknown>(
      "mmt/typstRange",
      {
        textDocument: { uri: document.uri },
        range,
        backendEncoding: this.backendEncoding
      },
      token
    );
    if (value === null) return undefined;
    const projected = parseProjectedRange(value);
    const project = this.backend.projectForEntry(projected.entryUri);
    const retained = retainedBackendRange(projected, project);
    const identity = this.capture(project, document.uri, document.version);
    return identity ? { ...retained, identity } : undefined;
  }

  private capture(
    project: TypstProjectUpdate | undefined,
    hostUri: string,
    documentVersion: number
  ): TinymistRequestIdentity | undefined {
    const staleToken = this.staleTokens.current(hostUri);
    if (
      !staleToken
      || staleToken.documentVersion !== documentVersion
      || project?.sourceVersion !== documentVersion
      || !hasCanonicalProjectIdentity(project)
    ) {
      return undefined;
    }
    this.entryByHostUri.set(hostUri, project.entryUri);
    return Object.freeze({
      backendGeneration: this.backend.backendGeneration(),
      // SourceContentKey is canonical and host-independent. The current wire
      // contract does not expose LogicalSourceId separately, so it scopes the
      // request without admitting a presentation URI into canonical metadata.
      logicalSource: project.sourceContent as unknown as LogicalSourceId,
      sourceContent: project.sourceContent,
      sourceStaleToken: staleToken,
      projectSnapshot: project.projectDigest,
      projectionKey: project.projectionKey
    });
  }

  private currentIdentity(hostUri: string): TinymistRequestIdentity | undefined {
    const entryUri = this.entryByHostUri.get(hostUri);
    const staleToken = this.staleTokens.current(hostUri);
    const project = entryUri ? this.backend.projectForEntry(entryUri) : undefined;
    if (!entryUri || !staleToken || !hasCanonicalProjectIdentity(project)) return undefined;
    return {
      backendGeneration: this.backend.backendGeneration(),
      logicalSource: project.sourceContent as unknown as LogicalSourceId,
      sourceContent: project.sourceContent,
      sourceStaleToken: staleToken,
      projectSnapshot: project.projectDigest,
      projectionKey: project.projectionKey
    };
  }

  private identityIsCurrent(identity: TinymistRequestIdentity): boolean {
    const current = this.currentIdentity(identity.sourceStaleToken.hostUri);
    return current !== undefined
      && current.backendGeneration === identity.backendGeneration
      && current.logicalSource === identity.logicalSource
      && current.sourceContent === identity.sourceContent
      && current.sourceStaleToken.documentIncarnation === identity.sourceStaleToken.documentIncarnation
      && current.sourceStaleToken.documentVersion === identity.sourceStaleToken.documentVersion
      && current.projectSnapshot === identity.projectSnapshot
      && current.projectionKey === identity.projectionKey;
  }

  private providerCapabilityIsCurrent(
    host: TypstProviderHost,
    method: TypstProviderMethod,
    captured: TypstProviderRegistrationContract
  ): boolean {
    const current = this.providerCapability(host, method);
    return current.kind === "QualifiedProvider"
      && current.runtime === captured.runtime
      && current.resolveProvider === captured.resolveProvider;
  }

  private sourceIndex(identity: TinymistRequestIdentity): LineIndex {
    const retained = this.sourceIndexes.get(identity.sourceStaleToken.hostUri);
    if (!retained || retained.version !== identity.sourceStaleToken.documentVersion) {
      throw new PositionConversionError("StaleProjection");
    }
    return retained.index;
  }

  private providerPositionContext(
    identity: TinymistRequestIdentity,
    entryUri: string
  ): TypstProviderPositionContext {
    const project = this.backend.projectForEntry(entryUri);
    if (!project) throw new PositionConversionError("AbsentGeneration");
    return Object.freeze({
      sourceUri: identity.sourceStaleToken.hostUri,
      sourceIndex: this.sourceIndex(identity),
      encoding: this.backendEncoding,
      retainedIndex: (uri: string) => {
        try {
          return retainedProjectIndex(project, uri);
        } catch (error) {
          if (error instanceof PositionConversionError) return undefined;
          throw error;
        }
      }
    });
  }

  private async request<Method extends keyof TypstRouterRequests & string>(
    method: Method,
    params: TypstRouterRequests[Method]["params"],
    identity: TinymistRequestIdentity,
    token: CancellationToken
  ): Promise<TypstRouterRequests[Method]["result"] | undefined> {
    const controller = new AbortController();
    if (token.isCancellationRequested) controller.abort(new Error("VS Code request cancelled"));
    const subscription = token.onCancellationRequested(() => controller.abort(new Error("VS Code request cancelled")));
    try {
      return await this.dispatcher.request(method, params as never, identity, controller.signal) as TypstRouterRequests[Method]["result"];
    } catch (error) {
      if (error instanceof TinymistDispatchError) return undefined;
      throw error;
    } finally {
      subscription.dispose();
    }
  }

  private requireCapability(method: BaselineTypstMethod): boolean {
    if (this.backend.capabilities().has(method)) return true;
    this.unavailable(method);
    return false;
  }

  private unavailable(method: BaselineTypstMethod): TypstCapabilityUnavailableState {
    const state = Object.freeze({
      kind: "CapabilityUnavailable" as const,
      method,
      backendGeneration: this.backend.capabilities().generation,
      message: `${method} is unavailable for the active Tinymist backend`
    });
    const key = `${state.backendGeneration}\0${method}`;
    if (!this.reportedUnavailable.has(key)) {
      this.reportedUnavailable.add(key);
      this.options.unavailable?.(state);
    }
    return state;
  }
}

function routeStandaloneProviderParams(
  params: unknown,
  entryUri: string,
  index: LineIndex,
  backendEncoding: PositionEncoding
): unknown {
  if (!isRecord(params)) return params;
  const routed: Record<string, unknown> = { ...params };
  if ("textDocument" in routed) routed.textDocument = { uri: entryUri };
  const convert = (value: unknown): WirePosition => {
    if (!isRecord(value)) throw new PositionConversionError("InvalidLine");
    return wireBackendPosition(index.convertClient(mmtClientPosition(
      { line: value.line as number, character: value.character as number },
      "utf-16"
    ), backendEncoding));
  };
  if (routed.position !== undefined) routed.position = convert(routed.position);
  if (routed.range !== undefined) {
    if (!isRecord(routed.range)) throw new PositionConversionError("InvalidLine");
    routed.range = { start: convert(routed.range.start), end: convert(routed.range.end) };
  }
  if (routed.positions !== undefined) {
    if (!Array.isArray(routed.positions)) throw new PositionConversionError("InvalidLine");
    routed.positions = routed.positions.map(convert);
  }
  return routed;
}

function routeProviderResolveParams(
  method: TypstProviderMethod,
  value: unknown,
  context: TypstProviderPositionContext
): unknown {
  if (!isRecord(value)) throw new PositionConversionError("InvalidLine");
  const routed: Record<string, unknown> = { ...value };
  const convertPosition = (position: unknown, uri = context.sourceUri): WirePosition => {
    if (!isRecord(position)) throw new PositionConversionError("InvalidLine");
    const index = uri === context.sourceUri ? context.sourceIndex : context.retainedIndex?.(uri);
    if (!index) throw new PositionConversionError("AbsentGeneration");
    return wireBackendPosition(index.convertClient(mmtClientPosition({
      line: position.line as number,
      character: position.character as number
    }, "utf-16"), context.encoding));
  };
  const convertRange = (range: unknown, uri = context.sourceUri): unknown => {
    if (!isRecord(range)) throw new PositionConversionError("InvalidLine");
    return { start: convertPosition(range.start, uri), end: convertPosition(range.end, uri) };
  };
  const convertTextEdits = (edits: unknown, uri = context.sourceUri): unknown => {
    if (!Array.isArray(edits)) throw new PositionConversionError("InvalidLine");
    return edits.map((edit) => {
      if (!isRecord(edit)) throw new PositionConversionError("InvalidLine");
      return { ...edit, range: convertRange(edit.range, uri) };
    });
  };
  if (method === "workspaceSymbol/resolve") {
    if (!isRecord(routed.location) || typeof routed.location.uri !== "string") {
      throw new PositionConversionError("AbsentGeneration");
    }
    if (routed.location.range !== undefined) {
      routed.location = {
        ...routed.location,
        range: convertRange(routed.location.range, routed.location.uri)
      };
    }
  } else if (method === "documentLink/resolve" || method === "codeLens/resolve") {
    routed.range = convertRange(routed.range);
  } else if (method === "inlayHint/resolve") {
    routed.position = convertPosition(routed.position);
    if (routed.textEdits !== undefined) routed.textEdits = convertTextEdits(routed.textEdits);
    if (Array.isArray(routed.label)) {
      routed.label = routed.label.map((part) => {
        if (!isRecord(part) || !isRecord(part.location) || typeof part.location.uri !== "string") return part;
        return {
          ...part,
          location: {
            ...part.location,
            range: convertRange(part.location.range, part.location.uri)
          }
        };
      });
    }
  } else if (method === "codeAction/resolve") {
    if (Array.isArray(routed.diagnostics)) {
      routed.diagnostics = routed.diagnostics.map((diagnostic) => {
        if (!isRecord(diagnostic)) throw new PositionConversionError("InvalidLine");
        return { ...diagnostic, range: convertRange(diagnostic.range) };
      });
    }
    if (isRecord(routed.edit) && Array.isArray(routed.edit.documentChanges)) {
      routed.edit = {
        ...routed.edit,
        documentChanges: routed.edit.documentChanges.map((change) => {
          if (!isRecord(change) || !isRecord(change.textDocument)
            || typeof change.textDocument.uri !== "string") {
            throw new PositionConversionError("AbsentGeneration");
          }
          return {
            ...change,
            edits: convertTextEdits(change.edits, change.textDocument.uri)
          };
        })
      };
    }
  }
  return routed;
}

function hasCanonicalProjectIdentity(
  project: TypstProjectUpdate | undefined
): project is TypstProjectUpdate & CanonicalTypstProjectIdentity {
  return project !== undefined
    && typeof project.sourceContent === "string"
    && typeof project.projectDigest === "string"
    && typeof project.projectionKey === "string";
}

function retainedProjectIndex(project: TypstProjectUpdate, uri: string): LineIndex {
  const file = project.files.find((candidate) => candidate.uri === uri);
  if (typeof file?.text !== "string") throw new PositionConversionError("AbsentGeneration");
  return new LineIndex(file.text);
}

function completionContext(context: CompletionContext): CompletionContext {
  return {
    triggerKind: context.triggerKind,
    ...(context.triggerCharacter === undefined ? {} : { triggerCharacter: context.triggerCharacter })
  };
}

function signatureContext(context: SignatureHelpContext): SignatureHelpContext {
  return {
    triggerKind: context.triggerKind,
    isRetrigger: context.isRetrigger,
    ...(context.triggerCharacter === undefined ? {} : { triggerCharacter: context.triggerCharacter }),
    ...(context.activeSignatureHelp === undefined ? {} : { activeSignatureHelp: context.activeSignatureHelp })
  };
}

function mappingParams(
  document: TypstRouterDocument,
  route: GuardedBackendPosition,
  payload: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return {
    sourceUri: document.uri,
    revision: route.revision,
    entryUri: route.entryUri,
    backendEncoding: route.position.encoding,
    sourceContent: route.sourceContent,
    projectDigest: route.projectDigest,
    projectionKey: route.projectionKey,
    ...payload
  };
}

function registrationFromDescriptor(
  method: BaselineTypstMethod,
  descriptor: TinymistCapabilityDescriptor
): TypstProviderRegistration {
  const options = [
    descriptor.initializeOptions,
    ...descriptor.dynamicRegistrations.map((registration) => registration.registerOptions)
  ];
  return Object.freeze({
    method,
    triggerCharacters: Object.freeze(uniqueOptionStrings(options, "triggerCharacters")),
    retriggerCharacters: Object.freeze(uniqueOptionStrings(options, "retriggerCharacters")),
    resolveProvider: options.some((value) => isRecord(value) && value.resolveProvider === true)
  });
}

function uniqueOptionStrings(options: readonly unknown[], field: string): string[] {
  const values = new Set<string>();
  for (const option of options) {
    if (!isRecord(option) || !Array.isArray(option[field])) continue;
    for (const value of option[field]) if (typeof value === "string") values.add(value);
  }
  return [...values];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
