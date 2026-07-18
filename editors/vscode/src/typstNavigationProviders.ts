import * as vscode from "vscode";
import type { BaseLanguageClient } from "vscode-languageclient";
import type {
  Definition,
  DocumentHighlight,
  DocumentSymbol,
  Location,
  SelectionRange,
  SymbolInformation,
  WorkspaceSymbol
} from "vscode-languageserver-protocol";

import {
  type RoutedStandaloneTypstProviderResult,
  TypstFeatureRouter,
  type TypstRouterDocument
} from "./typstFeatureRouter";
import {
  convertTypstNavigationProviderPositions,
  type TypstNavigationProviderMethod,
  type TypstProviderHost,
  type TypstProviderRegistrationContract
} from "./typstProviderDescriptors";

const NAVIGATION_METHODS: Readonly<Partial<Record<TypstNavigationProviderMethod, true>>> = Object.freeze({
  "textDocument/definition": true,
  "textDocument/typeDefinition": true,
  "textDocument/implementation": true,
  "textDocument/references": true,
  "textDocument/documentSymbol": true,
  "workspace/symbol": true,
  "textDocument/documentHighlight": true,
  "textDocument/selectionRange": true
});

/** Dynamic, capability-qualified registrations for standalone read-only navigation. */
export class TypstNavigationProviders implements vscode.Disposable {
  private readonly active = new Map<
    TypstNavigationProviderMethod,
    { readonly fingerprint: string; readonly disposable: vscode.Disposable }
  >();
  private disposed = false;

  constructor(
    private readonly router: TypstFeatureRouter,
    private readonly client: BaseLanguageClient,
    private readonly host: TypstProviderHost
  ) {}

  reconcile(): void {
    if (this.disposed) return;
    const desired = new Map<TypstNavigationProviderMethod, TypstProviderRegistrationContract>();
    for (const registration of this.router.providerRegistrations(this.host)) {
      const method = registration.descriptor.method as TypstNavigationProviderMethod;
      if (NAVIGATION_METHODS[method]) desired.set(method, registration);
    }
    for (const [method, active] of this.active) {
      const registration = desired.get(method);
      const fingerprint = registration ? JSON.stringify({
        method,
        generation: registration.runtime.dynamicRegistrations.map((item) => item.id),
        resolveProvider: registration.resolveProvider
      }) : undefined;
      if (fingerprint === active.fingerprint) continue;
      active.disposable.dispose();
      this.active.delete(method);
    }
    for (const [method, registration] of desired) {
      if (this.active.has(method)) continue;
      const fingerprint = JSON.stringify({
        method,
        generation: registration.runtime.dynamicRegistrations.map((item) => item.id),
        resolveProvider: registration.resolveProvider
      });
      this.active.set(method, { fingerprint, disposable: this.register(registration) });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const active of this.active.values()) active.disposable.dispose();
    this.active.clear();
  }

  private register(registration: TypstProviderRegistrationContract): vscode.Disposable {
    const method = registration.descriptor.method as TypstNavigationProviderMethod;
    const selector: vscode.DocumentSelector = [{ language: "typst" }];
    switch (method) {
      case "textDocument/definition":
        return vscode.languages.registerDefinitionProvider(selector, {
          provideDefinition: async (document, position, token) => {
            const routed = await this.positionRequest(method, document, position, token);
            return routed
              ? await this.client.protocol2CodeConverter.asDefinitionResult(
                  this.convert(routed) as Definition | null,
                  token
                )
              : undefined;
          }
        });
      case "textDocument/typeDefinition":
        return vscode.languages.registerTypeDefinitionProvider(selector, {
          provideTypeDefinition: async (document, position, token) => {
            const routed = await this.positionRequest(method, document, position, token);
            return routed
              ? await this.client.protocol2CodeConverter.asDefinitionResult(
                  this.convert(routed) as Definition | null,
                  token
                )
              : undefined;
          }
        });
      case "textDocument/implementation":
        return vscode.languages.registerImplementationProvider(selector, {
          provideImplementation: async (document, position, token) => {
            const routed = await this.positionRequest(method, document, position, token);
            return routed
              ? await this.client.protocol2CodeConverter.asDefinitionResult(
                  this.convert(routed) as Definition | null,
                  token
                )
              : undefined;
          }
        });
      case "textDocument/references":
        return vscode.languages.registerReferenceProvider(selector, {
          provideReferences: async (document, position, context, token) => {
            const routed = await this.router.standaloneProvider(
              this.host,
              method,
              routerDocument(document),
              {
                textDocument: { uri: document.uri.toString() },
                position: this.client.code2ProtocolConverter.asPosition(position),
                context: { includeDeclaration: context.includeDeclaration }
              },
              token
            );
            return routed
              ? await this.client.protocol2CodeConverter.asReferences(
                  this.convert(routed) as Location[] | null,
                  token
                )
              : undefined;
          }
        });
      case "textDocument/documentSymbol":
        return vscode.languages.registerDocumentSymbolProvider(selector, {
          provideDocumentSymbols: async (document, token) => {
            const routed = await this.router.standaloneProvider(
              this.host,
              method,
              routerDocument(document),
              { textDocument: { uri: document.uri.toString() } },
              token
            );
            if (!routed) return undefined;
            const result = this.convert(routed) as (DocumentSymbol | SymbolInformation)[] | null;
            if (!result || result.length === 0) return [];
            return isProtocolDocumentSymbol(result[0])
              ? await this.client.protocol2CodeConverter.asDocumentSymbols(result as DocumentSymbol[], token)
              : await this.client.protocol2CodeConverter.asSymbolInformations(result as SymbolInformation[], token);
          }
        });
      case "workspace/symbol": {
        const provider: vscode.WorkspaceSymbolProvider = {
          provideWorkspaceSymbols: async (query, token) => {
            const document = activeStandaloneDocument();
            if (!document) return undefined;
            const routed = await this.router.standaloneProvider(
              this.host,
              method,
              routerDocument(document),
              { query },
              token
            );
            if (!routed) return undefined;
            const result = (routed.value ?? []) as (WorkspaceSymbol | SymbolInformation)[];
            const bound = registration.resolveProvider
              ? result.map((item) => this.router.bindProviderResolveItem(method, item, routed.identity))
              : result;
            const converted = convertTypstNavigationProviderPositions(
              method,
              bound,
              routed.positionContext
            );
            if (!this.router.providerIdentityIsCurrent(routed.identity)) return undefined;
            return await this.client.protocol2CodeConverter.asSymbolInformations(converted, token);
          }
        };
        if (registration.resolveProvider) {
          provider.resolveWorkspaceSymbol = async (symbol, token) => {
            const routed = await this.router.standaloneProviderResolve(
              this.host,
              "workspaceSymbol/resolve",
              this.client.code2ProtocolConverter.asWorkspaceSymbol(symbol),
              token
            );
            if (!routed) return undefined;
            const converted = this.convert(routed) as WorkspaceSymbol;
            return this.client.protocol2CodeConverter.asSymbolInformation(converted);
          };
        }
        return vscode.languages.registerWorkspaceSymbolProvider(provider);
      }
      case "textDocument/documentHighlight":
        return vscode.languages.registerDocumentHighlightProvider(selector, {
          provideDocumentHighlights: async (document, position, token) => {
            const routed = await this.positionRequest(method, document, position, token);
            return routed
              ? await this.client.protocol2CodeConverter.asDocumentHighlights(
                  this.convert(routed) as DocumentHighlight[] | null,
                  token
                )
              : undefined;
          }
        });
      case "textDocument/selectionRange":
        return vscode.languages.registerSelectionRangeProvider(selector, {
          provideSelectionRanges: async (document, positions, token) => {
            const routed = await this.router.standaloneProvider(
              this.host,
              method,
              routerDocument(document),
              {
                textDocument: { uri: document.uri.toString() },
                positions: positions.map((position) =>
                  this.client.code2ProtocolConverter.asPosition(position)
                )
              },
              token
            );
            return routed
              ? await this.client.protocol2CodeConverter.asSelectionRanges(
                  this.convert(routed) as SelectionRange[] | null,
                  token
                )
              : undefined;
          }
        });
      default:
        throw new Error(`Unsupported navigation provider registration: ${method}`);
    }
  }

  private async positionRequest<Method extends
    | "textDocument/definition"
    | "textDocument/typeDefinition"
    | "textDocument/implementation"
    | "textDocument/documentHighlight"
  >(
    method: Method,
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<RoutedStandaloneTypstProviderResult<Method> | undefined> {
    return await this.router.standaloneProvider(
      this.host,
      method,
      routerDocument(document),
      {
        textDocument: { uri: document.uri.toString() },
        position: this.client.code2ProtocolConverter.asPosition(position)
      },
      token
    );
  }

  private convert<Method extends TypstNavigationProviderMethod>(
    routed: RoutedStandaloneTypstProviderResult<Method>
  ): RoutedStandaloneTypstProviderResult<Method>["value"] | undefined {
    const converted = convertTypstNavigationProviderPositions(
      routed.method,
      routed.value,
      routed.positionContext
    );
    return this.router.providerIdentityIsCurrent(routed.identity) ? converted : undefined;
  }
}

function routerDocument(document: vscode.TextDocument): TypstRouterDocument {
  return {
    languageId: document.languageId,
    uri: document.uri.toString(),
    version: document.version,
    text: document.getText()
  };
}

function activeStandaloneDocument(): vscode.TextDocument | undefined {
  const active = vscode.window.activeTextEditor?.document;
  if (active?.languageId === "typst") return active;
  return vscode.workspace.textDocuments.find((document) => document.languageId === "typst");
}

function isProtocolDocumentSymbol(
  value: DocumentSymbol | SymbolInformation
): value is DocumentSymbol {
  return "range" in value && "selectionRange" in value;
}
