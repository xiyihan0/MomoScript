import * as vscode from "vscode";
import type { BaseLanguageClient, LanguageClientOptions } from "vscode-languageclient";
import type {
  CompletionItem as ProtocolCompletionItem,
  CompletionList as ProtocolCompletionList,
  CompletionTriggerKind as ProtocolCompletionTriggerKind,
  Diagnostic as ProtocolDiagnostic,
  Hover as ProtocolHover,
  SemanticTokens as ProtocolSemanticTokens,
  SignatureHelp as ProtocolSignatureHelp,
  SignatureHelpTriggerKind as ProtocolSignatureHelpTriggerKind
} from "vscode-languageserver-protocol";

import type { TinymistHostBackend, TypstProjectUpdate } from "./tinymistClient";
import {
  TypstFeatureRouter,
  type TypstCapabilityUnavailableState,
  type BaselineTypstMethod,
  type TypstProviderRegistration,
  type TypstRouterDocument
} from "./typstFeatureRouter";
import { TypstNavigationProviders } from "./typstNavigationProviders";
import type { TypstProviderHost } from "./typstProviderDescriptors";
import {
  RetainedVirtualDocumentStore,
  registerVirtualTypstContentProviders
} from "./retainedVirtualDocuments";

const routersByBackend = new WeakMap<TinymistHostBackend, TypstFeatureRouter>();
const retainedDocumentsByBackend = new WeakMap<TinymistHostBackend, RetainedVirtualDocumentStore>();

interface PublishedTypstDiagnostics {
  readonly uri: string;
  readonly version?: number | null;
  readonly diagnostics: ProtocolDiagnostic[];
}

export function installTypstMiddleware(
  options: LanguageClientOptions,
  backend: TinymistHostBackend,
  client: () => BaseLanguageClient
): void {
  const unavailableMethods = new Set<string>();
  const router = new TypstFeatureRouter(backend, client, {
    unavailable: (state) => showCapabilityUnavailable(state, unavailableMethods)
  });
  routersByBackend.set(backend, router);
  if (Array.isArray(options.documentSelector)) {
    options.documentSelector = options.documentSelector.filter((selector) =>
      typeof selector === "string" ? selector !== "typst" : selector.language !== "typst"
    );
  }

  options.middleware = {
    didOpen: async (document, next) => {
      router.open(routerDocument(document));
      if (document.languageId !== "typst") await next(document);
    },
    didChange: async (event, next) => {
      router.change(routerDocument(event.document));
      if (event.document.languageId !== "typst") await next(event);
    },
    didClose: async (document, next) => {
      router.close(document.uri.toString());
      if (document.languageId !== "typst") await next(document);
    },
    provideCompletionItem: async (document, position, completionContext, token, next) => {
      const mmt = document.languageId === "typst"
        ? undefined
        : await next(document, position, completionContext, token);
      if (Array.isArray(mmt) ? mmt.length > 0 : Boolean(mmt?.items.length)) return mmt;
      try {
        const activeClient = client();
        const result = await router.completion(
          routerDocument(document),
          activeClient.code2ProtocolConverter.asPosition(position),
          {
            triggerKind: completionContext.triggerKind as ProtocolCompletionTriggerKind,
            ...(completionContext.triggerCharacter === undefined
              ? {}
              : { triggerCharacter: completionContext.triggerCharacter })
          },
          token
        );
        return result === undefined
          ? mmt
          : activeClient.protocol2CodeConverter.asCompletionResult(
              result as ProtocolCompletionItem[] | ProtocolCompletionList | null,
              undefined,
              token
            );
      } catch (error) {
        console.error(`${document.languageId === "typst" ? "standalone" : "embedded"} Typst completion failed`, error);
        return mmt;
      }
    },
    provideHover: async (document, position, token, next) => {
      const mmt = document.languageId === "typst"
        ? undefined
        : await next(document, position, token);
      if (mmt) return mmt;
      try {
        const activeClient = client();
        const result = await router.hover(
          routerDocument(document),
          activeClient.code2ProtocolConverter.asPosition(position),
          token
        );
        return result === undefined
          ? mmt
          : activeClient.protocol2CodeConverter.asHover(result as ProtocolHover | null);
      } catch (error) {
        console.error(`${document.languageId === "typst" ? "standalone" : "embedded"} Typst hover failed`, error);
        return mmt;
      }
    },
    provideSignatureHelp: async (document, position, signatureContext, token, next) => {
      const mmt = document.languageId === "typst"
        ? undefined
        : await next(document, position, signatureContext, token);
      if (mmt) return mmt;
      try {
        const activeClient = client();
        const result = await router.signatureHelp(
          routerDocument(document),
          activeClient.code2ProtocolConverter.asPosition(position),
          {
            triggerKind: signatureContext.triggerKind as ProtocolSignatureHelpTriggerKind,
            isRetrigger: signatureContext.isRetrigger,
            ...(signatureContext.triggerCharacter === undefined
              ? {}
              : { triggerCharacter: signatureContext.triggerCharacter })
          },
          token
        );
        return result === undefined
          ? mmt
          : activeClient.protocol2CodeConverter.asSignatureHelp(
              result as ProtocolSignatureHelp | null,
              token
            );
      } catch (error) {
        console.error(`${document.languageId === "typst" ? "standalone" : "embedded"} Typst signature help failed`, error);
        return mmt;
      }
    },
    provideDocumentSemanticTokens: async (document, token, next) => {
      if (document.languageId !== "typst") return await next(document, token);
      try {
        const activeClient = client();
        const result = await router.semanticTokens(routerDocument(document), token);
        return result === undefined
          ? undefined
          : await activeClient.protocol2CodeConverter.asSemanticTokens(
              result as ProtocolSemanticTokens | null,
              token
            );
      } catch (error) {
        console.error("standalone Typst semantic tokens failed", error);
        return undefined;
      }
    }
  };
}

export function connectTypstBackend(
  client: BaseLanguageClient,
  backend: TinymistHostBackend,
  host: TypstProviderHost
): vscode.Disposable[] {
  const router = routersByBackend.get(backend);
  if (!router) throw new Error("Typst middleware must own the feature router before backend connection");
  let warnedAboutUnversionedDiagnostics = false;
  const diagnostics = vscode.languages.createDiagnosticCollection("mmt-typst");
  const providers = new TypstHostProviderRegistrations(router, backend, client);
  const navigationProviders = new TypstNavigationProviders(router, client, host);
  let retainedDocuments = retainedDocumentsByBackend.get(backend);
  if (!retainedDocuments) {
    retainedDocuments = new RetainedVirtualDocumentStore();
    retainedDocumentsByBackend.set(backend, retainedDocuments);
  }
  const virtualContentProviders = registerVirtualTypstContentProviders(vscode.workspace, retainedDocuments);
  for (const document of vscode.workspace.textDocuments) {
    if (document.languageId === "typst") router.open(routerDocument(document));
  }
  const opened = vscode.workspace.onDidOpenTextDocument((document) => {
    if (document.languageId === "typst") router.open(routerDocument(document));
  });
  const changed = vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document.languageId === "typst") router.change(routerDocument(event.document));
  });
  const closed = vscode.workspace.onDidCloseTextDocument((document) => {
    if (document.languageId === "typst") router.close(document.uri.toString());
  });
  const projectUpdated = client.onNotification(
    "mmt/typstProjectUpdated",
    (update: TypstProjectUpdate) => {
      router.retire(update.sourceUri);
      retainedDocuments.retainProjection({
        sourceUri: update.sourceUri,
        revision: update.revision,
        projectionKey: update.projectionKey,
        files: update.files
      });
      backend.syncProject(update);
      const current = backend.projectForEntry(update.entryUri);
      if (current?.sourceUri === update.sourceUri && current.revision === update.revision) {
        diagnostics.delete(vscode.Uri.parse(update.sourceUri));
      }
    }
  );
  const projectClosed = client.onNotification(
    "mmt/typstProjectClosed",
    (params: { sourceUri: string; entryUri: string }) => {
      router.retire(params.sourceUri);
      if (backend.closeProject(params.sourceUri, params.entryUri)) {
        retainedDocuments.closeProjectionSource(params.sourceUri);
        diagnostics.delete(vscode.Uri.parse(params.sourceUri));
      }
    }
  );
  backend.on("tinymist/capabilitiesChanged", (value) => {
    if (value && typeof value === "object" && "generation" in value
      && typeof value.generation === "number") {
      router.retireBackendGenerationsExcept(value.generation);
    } else {
      router.retireAllRequests();
    }
    providers.reconcile();
    navigationProviders.reconcile();
  });
  backend.on("tinymist/clientRestarting", () => {
    router.retireAllRequests();
    providers.reconcile();
    navigationProviders.reconcile();
  });
  backend.on("textDocument/publishDiagnostics", (value) => {
    void (async () => {
      if (!isPublishedTypstDiagnostics(value)) {
        throw new Error("Tinymist published invalid diagnostics parameters");
      }
      const params = value;
      if (params.version == null && !warnedAboutUnversionedDiagnostics) {
        warnedAboutUnversionedDiagnostics = true;
        console.warn(
          "Tinymist sent unversioned diagnostics; using revision-scoped virtual entry URI isolation"
        );
      }
      const routed = await router.diagnostics(params);
      if (!routed) return;
      const converted = await client.protocol2CodeConverter.asDiagnostics(
        routed.diagnostics as ProtocolDiagnostic[]
      );
      if (!router.diagnosticsAreCurrent(routed)) return;
      diagnostics.set(vscode.Uri.parse(routed.uri), converted);
    })().catch((error: unknown) => {
      console.error("Typst diagnostics failed", error);
    });
  });
  providers.reconcile();
  navigationProviders.reconcile();
  return [
    diagnostics,
    providers,
    navigationProviders,
    ...virtualContentProviders,
    opened,
    changed,
    closed,
    projectUpdated,
    projectClosed
  ];
}

class TypstHostProviderRegistrations implements vscode.Disposable {
  private readonly active = new Map<
    BaselineTypstMethod,
    { readonly fingerprint: string; readonly disposable: vscode.Disposable }
  >();
  private disposed = false;

  constructor(
    private readonly router: TypstFeatureRouter,
    private readonly backend: TinymistHostBackend,
    private readonly client: BaseLanguageClient
  ) {}

  reconcile(): void {
    if (this.disposed) return;
    const desired = new Map(
      this.router.registrations().map((registration) => [registration.method, registration])
    );
    for (const [method, active] of this.active) {
      const registration = desired.get(method);
      const fingerprint = registration ? this.fingerprint(registration) : undefined;
      if (fingerprint === active.fingerprint) continue;
      active.disposable.dispose();
      this.active.delete(method);
    }
    for (const [method, registration] of desired) {
      if (this.active.has(method)) continue;
      const fingerprint = this.fingerprint(registration);
      if (fingerprint === undefined) continue;
      this.active.set(method, {
        fingerprint,
        disposable: this.register(registration)
      });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const active of this.active.values()) active.disposable.dispose();
    this.active.clear();
  }

  private fingerprint(registration: TypstProviderRegistration): string | undefined {
    if (registration.method !== "textDocument/semanticTokens/full") {
      return JSON.stringify(registration);
    }
    const legend = this.backend.semanticTokensLegend?.();
    return legend ? JSON.stringify({ registration, legend }) : undefined;
  }

  private register(registration: TypstProviderRegistration): vscode.Disposable {
    const selector: vscode.DocumentSelector = [{ language: "typst" }];
    switch (registration.method) {
      case "textDocument/completion":
        return vscode.languages.registerCompletionItemProvider(
          selector,
          {
            provideCompletionItems: async (document, position, token, context) => {
              try {
                const result = await this.router.completion(
                  routerDocument(document),
                  this.client.code2ProtocolConverter.asPosition(position),
                  {
                    triggerKind: context.triggerKind as ProtocolCompletionTriggerKind,
                    ...(context.triggerCharacter === undefined
                      ? {}
                      : { triggerCharacter: context.triggerCharacter })
                  },
                  token
                );
                return result === undefined
                  ? undefined
                  : this.client.protocol2CodeConverter.asCompletionResult(
                      result as ProtocolCompletionItem[] | ProtocolCompletionList | null,
                      undefined,
                      token
                    );
              } catch (error) {
                console.error("standalone Typst completion failed", error);
                return undefined;
              }
            }
          },
          ...registration.triggerCharacters
        );
      case "textDocument/hover":
        return vscode.languages.registerHoverProvider(selector, {
          provideHover: async (document, position, token) => {
            try {
              const result = await this.router.hover(
                routerDocument(document),
                this.client.code2ProtocolConverter.asPosition(position),
                token
              );
              return result === undefined
                ? undefined
                : this.client.protocol2CodeConverter.asHover(result as ProtocolHover | null);
            } catch (error) {
              console.error("standalone Typst hover failed", error);
              return undefined;
            }
          }
        });
      case "textDocument/signatureHelp":
        return vscode.languages.registerSignatureHelpProvider(
          selector,
          {
            provideSignatureHelp: async (document, position, token, context) => {
              try {
                const result = await this.router.signatureHelp(
                  routerDocument(document),
                  this.client.code2ProtocolConverter.asPosition(position),
                  {
                    triggerKind: context.triggerKind as ProtocolSignatureHelpTriggerKind,
                    isRetrigger: context.isRetrigger,
                    ...(context.triggerCharacter === undefined
                      ? {}
                      : { triggerCharacter: context.triggerCharacter })
                  },
                  token
                );
                return result === undefined
                  ? undefined
                  : this.client.protocol2CodeConverter.asSignatureHelp(
                      result as ProtocolSignatureHelp | null,
                      token
                    );
              } catch (error) {
                console.error("standalone Typst signature help failed", error);
                return undefined;
              }
            }
          },
          {
            triggerCharacters: [...registration.triggerCharacters],
            retriggerCharacters: [...registration.retriggerCharacters]
          }
        );
      case "textDocument/semanticTokens/full": {
        const legend = this.backend.semanticTokensLegend?.();
        if (!legend) throw new Error("Tinymist semantic token legend is unavailable");
        return vscode.languages.registerDocumentSemanticTokensProvider(
          selector,
          {
            provideDocumentSemanticTokens: async (document, token) => {
              try {
                const result = await this.router.semanticTokens(routerDocument(document), token);
                return result === undefined
                  ? undefined
                  : await this.client.protocol2CodeConverter.asSemanticTokens(
                      result as ProtocolSemanticTokens | null,
                      token
                    );
              } catch (error) {
                console.error("standalone Typst semantic tokens failed", error);
                return undefined;
              }
            }
          },
          new vscode.SemanticTokensLegend([...legend.tokenTypes], [...legend.tokenModifiers])
        );
      }
    }
  }
}

function isPublishedTypstDiagnostics(value: unknown): value is PublishedTypstDiagnostics {
  if (!value || typeof value !== "object"
    || !("uri" in value) || typeof value.uri !== "string"
    || !("diagnostics" in value) || !Array.isArray(value.diagnostics)) {
    return false;
  }
  return !("version" in value)
    || value.version === undefined
    || value.version === null
    || typeof value.version === "number";
}

function routerDocument(document: vscode.TextDocument): TypstRouterDocument {
  return {
    languageId: document.languageId,
    uri: document.uri.toString(),
    version: document.version,
    text: document.getText()
  };
}

function showCapabilityUnavailable(
  state: TypstCapabilityUnavailableState,
  reported: Set<string>
): void {
  const key = `${state.backendGeneration}\0${state.method}`;
  if (reported.has(key)) return;
  reported.add(key);
  const label = state.method.slice(state.method.lastIndexOf("/") + 1);
  vscode.window?.setStatusBarMessage?.(
    `Typst ${label} unavailable for the active backend`,
    5_000
  );
}
