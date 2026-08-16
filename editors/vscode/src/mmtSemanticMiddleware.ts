import * as vscode from "vscode";
import type { BaseLanguageClient, LanguageClientOptions } from "vscode-languageclient";
import type {
  Definition,
  Location,
  LocationLink,
  PrepareRenameParams,
  PrepareRenameResult,
  ReferenceParams,
  RenameParams,
  WorkspaceEdit,
} from "vscode-languageserver-protocol";

import {
  CapabilityUnavailableMultiDocumentEditApplier,
  LanguageClientProjectedEditValidator,
  ProjectedEditAdapter,
  TinymistProjectedEditDocumentResolver,
} from "./projectedEdits.ts";
import {
  mapNavigationLocations,
  parseProjectedReadLocations,
  type ProjectedReadMethod,
} from "./projectedReads.ts";
import type { RetainedVirtualDocumentStore } from "./retainedVirtualDocuments.ts";
import { canonicalTypstUri, type TinymistHostBackend } from "./tinymistClient.ts";
import {
  TypstFeatureRouter,
  type RoutedProjectedTypstProviderResult,
  type TypstRouterDocument,
} from "./typstFeatureRouter.ts";
import type { TypstProviderHost } from "./typstProviderDescriptors.ts";

export type MmtSemanticRoute = "native" | "projected" | "none";

interface ProjectedSemanticDispatcher {
  definition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Definition | vscode.DefinitionLink[] | undefined>;
  references(document: vscode.TextDocument, position: vscode.Position, includeDeclaration: boolean, token: vscode.CancellationToken): Promise<vscode.Location[] | undefined>;
  prepareRename(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Range | { range: vscode.Range; placeholder: string } | undefined>;
  rename(document: vscode.TextDocument, position: vscode.Position, newName: string, token: vscode.CancellationToken): Promise<vscode.WorkspaceEdit | undefined>;
}

const projectedDispatchers = new WeakMap<TinymistHostBackend, ProjectedSemanticDispatcher>();

export function installMmtSemanticMiddleware(
  options: LanguageClientOptions,
  client: () => BaseLanguageClient,
  backend?: TinymistHostBackend,
): void {
  const route = async (
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<MmtSemanticRoute> => {
    if (document.languageId !== "mmt") return "none";
    const activeClient = client();
    const result = await activeClient.sendRequest<unknown>("mmt/semanticRoute", {
      textDocument: { uri: document.uri.toString() },
      position: activeClient.code2ProtocolConverter.asPosition(position),
      version: document.version,
      backendEncoding: "utf-16",
    }, token);
    if (result !== "native" && result !== "projected" && result !== "none") {
      throw new TypeError("mmt/semanticRoute returned an unknown route");
    }
    return result;
  };
  const projected = (): ProjectedSemanticDispatcher | undefined =>
    backend === undefined ? undefined : projectedDispatchers.get(backend);

  options.middleware = {
    ...options.middleware,
    provideDefinition: async (document, position, token, next) => {
      if (document.languageId !== "mmt") return undefined;
      const selected = await route(document, position, token);
      if (selected === "native") return await next(document, position, token);
      return selected === "projected"
        ? await projected()?.definition(document, position, token)
        : undefined;
    },
    provideReferences: async (document, position, context, token, next) => {
      if (document.languageId !== "mmt") return undefined;
      const selected = await route(document, position, token);
      if (selected === "native") return await next(document, position, context, token);
      return selected === "projected"
        ? await projected()?.references(document, position, context.includeDeclaration, token)
        : undefined;
    },
    prepareRename: async (document, position, token, next) => {
      if (document.languageId !== "mmt") return undefined;
      const selected = await route(document, position, token);
      if (selected === "native") return await next(document, position, token);
      return selected === "projected"
        ? await projected()?.prepareRename(document, position, token)
        : undefined;
    },
    provideRenameEdits: async (document, position, newName, token, next) => {
      if (document.languageId !== "mmt") return undefined;
      const selected = await route(document, position, token);
      if (selected === "native") return await next(document, position, newName, token);
      return selected === "projected"
        ? await projected()?.rename(document, position, newName, token)
        : undefined;
    },
  };
}

export function connectMmtProjectedSemanticDispatcher(
  backend: TinymistHostBackend,
  router: TypstFeatureRouter,
  client: BaseLanguageClient,
  host: TypstProviderHost,
  retainedDocuments: Pick<RetainedVirtualDocumentStore, "packageContent">,
): vscode.Disposable {
  const dispatcher = new TinymistProjectedSemanticDispatcher(
    router,
    backend,
    client,
    host,
    retainedDocuments,
  );
  projectedDispatchers.set(backend, dispatcher);
  return new vscode.Disposable(() => {
    if (projectedDispatchers.get(backend) === dispatcher) projectedDispatchers.delete(backend);
  });
}

class TinymistProjectedSemanticDispatcher implements ProjectedSemanticDispatcher {
  readonly #adapter: ProjectedEditAdapter;

  constructor(
    private readonly router: TypstFeatureRouter,
    backend: TinymistHostBackend,
    private readonly client: BaseLanguageClient,
    private readonly host: TypstProviderHost,
    private readonly retainedDocuments: Pick<RetainedVirtualDocumentStore, "packageContent">,
  ) {
    this.#adapter = new ProjectedEditAdapter(
      new LanguageClientProjectedEditValidator(client),
      vscode.workspace,
      new CapabilityUnavailableMultiDocumentEditApplier(),
      new TinymistProjectedEditDocumentResolver(backend, vscode.workspace),
    );
  }

  async definition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Definition | vscode.DefinitionLink[] | undefined> {
    const routed = await this.positionRequest(
      "textDocument/definition",
      document,
      position,
      {
        textDocument: { uri: document.uri.toString() },
        position: this.client.code2ProtocolConverter.asPosition(position),
      },
      token,
    );
    if (!routed || routed.value === null) return undefined;
    const locations = definitionLocations(routed.value as Definition);
    if (!locations) return undefined;
    const mapped = await this.mapLocations("definition", document, routed, locations, token);
    if (mapped === undefined) return undefined;
    const converted = await this.client.protocol2CodeConverter.asDefinitionResult(mapped, token);
    return this.router.providerIdentityIsCurrent(routed.identity) ? converted : undefined;
  }
  async references(
    document: vscode.TextDocument,
    position: vscode.Position,
    includeDeclaration: boolean,
    token: vscode.CancellationToken,
  ): Promise<vscode.Location[] | undefined> {
    const routed = await this.positionRequest(
      "textDocument/references",
      document,
      position,
      {
        textDocument: { uri: document.uri.toString() },
        position: this.client.code2ProtocolConverter.asPosition(position),
        context: { includeDeclaration },
      } satisfies ReferenceParams,
      token,
    );
    if (!routed || routed.value === null) return undefined;
    const mapped = await this.mapLocations(
      "references",
      document,
      routed,
      routed.value as Location[],
      token,
    );
    if (mapped === undefined) return undefined;
    const converted = await this.client.protocol2CodeConverter.asReferences(mapped, token);
    return this.router.providerIdentityIsCurrent(routed.identity) ? converted : undefined;
  }

  async prepareRename(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Range | { range: vscode.Range; placeholder: string } | undefined> {
    const routed = await this.positionRequest(
      "textDocument/prepareRename",
      document,
      position,
      {
        textDocument: { uri: document.uri.toString() },
        position: this.client.code2ProtocolConverter.asPosition(position),
      } satisfies PrepareRenameParams,
      token,
    );
    if (!routed || routed.value === null || token.isCancellationRequested) return undefined;
    const prepared = routed.value as PrepareRenameResult;
    if ("defaultBehavior" in prepared) return undefined;
    const backendRange = "start" in prepared ? prepared : prepared.range;
    const mapped = await this.#adapter.prepareTextEdits(
      routed,
      [{ range: backendRange, newText: "" }],
      token,
    );
    if (mapped.kind !== "Validated" || !this.router.providerIdentityIsCurrent(routed.identity)) {
      return undefined;
    }
    const range = mapped.textEdits[0]?.range;
    if (!range) return undefined;
    const placeholder = "start" in prepared ? document.getText(range) : prepared.placeholder;
    return placeholder.length > 0 && document.getText(range) === placeholder
      ? { range, placeholder }
      : undefined;
  }

  async rename(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string,
    token: vscode.CancellationToken,
  ): Promise<vscode.WorkspaceEdit | undefined> {
    const routed = await this.positionRequest(
      "textDocument/rename",
      document,
      position,
      {
        textDocument: { uri: document.uri.toString() },
        position: this.client.code2ProtocolConverter.asPosition(position),
        newName,
      } satisfies RenameParams,
      token,
    );
    if (!routed || routed.value === null || token.isCancellationRequested) return undefined;
    const mapped = await this.#adapter.prepareWorkspaceEdit(
      routed,
      routed.value as WorkspaceEdit,
      token,
    );
    return mapped.kind === "Validated" && this.router.providerIdentityIsCurrent(routed.identity)
      ? mapped.workspaceEdit
      : undefined;
  }

  private async positionRequest<Method extends
    | "textDocument/definition"
    | "textDocument/references"
    | "textDocument/prepareRename"
    | "textDocument/rename"
  >(
    method: Method,
    document: vscode.TextDocument,
    position: vscode.Position,
    params: Parameters<TypstFeatureRouter["projectedProviderAtPosition"]>[4],
    token: vscode.CancellationToken,
  ): Promise<RoutedProjectedTypstProviderResult<Method> | undefined> {
    return await this.router.projectedProviderAtPosition(
      this.host,
      method,
      routerDocument(document),
      this.client.code2ProtocolConverter.asPosition(position),
      params as never,
      token,
    ) as RoutedProjectedTypstProviderResult<Method> | undefined;
  }

  private async mapLocations<Method extends "textDocument/definition" | "textDocument/references">(
    method: ProjectedReadMethod,
    document: vscode.TextDocument,
    routed: RoutedProjectedTypstProviderResult<Method>,
    locations: readonly Location[],
    token: vscode.CancellationToken,
  ): Promise<Location[] | undefined> {
    if (!routed.identity.projectionKey) return undefined;
    const canonicalLocations = locations.map((location) => ({
      ...location,
      uri: canonicalTypstUri(location.uri),
    }));
    const classified = await this.client.sendRequest<unknown>("mmt/mapTypstReadLocations", {
      sourceUri: document.uri.toString(),
      revision: routed.revision,
      entryUri: routed.entryUri,
      backendEncoding: routed.encoding,
      sourceContent: routed.identity.sourceContent,
      projectDigest: routed.identity.projectSnapshot,
      projectionKey: routed.identity.projectionKey,
      locations: canonicalLocations,
    }, token);
    const parsed = parseProjectedReadLocations(classified);
    if (parsed.length !== locations.length) {
      throw new TypeError("mmt/mapTypstReadLocations changed the location count");
    }
    const mapped = mapNavigationLocations(
      method,
      parsed,
      { packageVisible: (uri) => this.retainedDocuments.packageContent(uri) !== undefined },
    );
    if (mapped.kind !== "Mapped" || !this.router.providerIdentityIsCurrent(routed.identity)) {
      return undefined;
    }
    return [...mapped.items];
  }
}

function routerDocument(document: vscode.TextDocument): TypstRouterDocument {
  return {
    languageId: document.languageId,
    uri: document.uri.toString(),
    version: document.version,
    text: document.getText(),
  };
}

function definitionLocations(value: Definition): Location[] | undefined {
  const items = Array.isArray(value) ? value : [value];
  const locations: Location[] = [];
  for (const item of items) {
    if ("uri" in item) {
      locations.push(item);
      continue;
    }
    const link = item as LocationLink;
    if (typeof link.targetUri !== "string" || !link.targetRange) return undefined;
    locations.push({ uri: link.targetUri, range: link.targetRange });
  }
  return locations;
}
