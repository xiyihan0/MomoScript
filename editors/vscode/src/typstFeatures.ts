import * as vscode from "vscode";
import type { LanguageClientOptions } from "vscode-languageclient";
import type { BaseLanguageClient } from "vscode-languageclient";
import type {
  CompletionItem as ProtocolCompletionItem,
  CompletionList as ProtocolCompletionList,
  Diagnostic as ProtocolDiagnostic,
  Hover as ProtocolHover,
  SignatureHelp as ProtocolSignatureHelp
} from "vscode-languageserver-protocol";

import {
  diagnosticVersionMatchesProjection,
  type TinymistHostBackend,
  type TypstProjectUpdate
} from "./tinymistClient";
import {
  SourceStaleTokenRegistry,
  captureTypstRequestIdentity,
  typstRequestIdentityIsCurrent,
  type CanonicalTypstProjectIdentity,
  type TypstRequestIdentity
} from "./typstProtocol";
import {
  LineIndex,
  PositionConversionError,
  mmtClientPosition,
  parseProjectedPosition,
  retainedBackendPosition,
  validatePositionBearingPayload,
  wireBackendPosition,
  type RetainedBackendPosition
} from "./typstPosition";

const TINYMIST_POSITION_ENCODING = "utf-16" as const;

function standaloneBackendPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
  activeClient: BaseLanguageClient
): { line: number; character: number } {
  const client = mmtClientPosition(
    activeClient.code2ProtocolConverter.asPosition(position),
    "utf-16"
  );
  return wireBackendPosition(
    new LineIndex(document.getText()).convertClient(client, TINYMIST_POSITION_ENCODING)
  );
}


interface GuardedBackendPosition extends RetainedBackendPosition {
  readonly identity: TypstRequestIdentity;
}

const guardsByBackend = new WeakMap<TinymistHostBackend, TypstPublicationGuard>();

class TypstPublicationGuard {
  private readonly sourceIndexes = new Map<string, { version: number; index: LineIndex }>();
  readonly staleTokens = new SourceStaleTokenRegistry();

  retainSource(document: vscode.TextDocument): void {
    this.sourceIndexes.set(document.uri.toString(), {
      version: document.version,
      index: new LineIndex(document.getText())
    });
  }

  releaseSource(uri: string): void {
    this.sourceIndexes.delete(uri);
  }

  sourceIndex(identity: TypstRequestIdentity): LineIndex {
    const retained = this.sourceIndexes.get(identity.staleToken.hostUri);
    if (!retained || retained.version !== identity.staleToken.documentVersion) {
      throw new PositionConversionError("StaleProjection");
    }
    return retained.index;
  }

  constructor(private readonly backend: TinymistHostBackend) {}

  capture(
    project: TypstProjectUpdate | undefined,
    hostUri: string,
    documentVersion: number
  ): TypstRequestIdentity | undefined {
    const staleToken = this.staleTokens.current(hostUri);
    if (
      !staleToken
      || staleToken.documentVersion !== documentVersion
      || project?.sourceVersion !== documentVersion
      || !hasCanonicalProjectIdentity(project)
    ) {
      return undefined;
    }
    return captureTypstRequestIdentity(
      project,
      staleToken,
      this.backend.backendGeneration()
    );
  }

  isCurrent(identity: TypstRequestIdentity): boolean {
    const project = this.backend.projectForEntry(identity.entryUri);
    return typstRequestIdentityIsCurrent(identity, {
      project: hasCanonicalProjectIdentity(project) ? project : undefined,
      staleToken: this.staleTokens.current(identity.staleToken.hostUri),
      backendGeneration: this.backend.backendGeneration()
    });
  }
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

async function projectedBackendPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
  token: vscode.CancellationToken,
  activeClient: BaseLanguageClient,
  backend: TinymistHostBackend,
  guard: TypstPublicationGuard
): Promise<GuardedBackendPosition | null> {
  const client = mmtClientPosition(
    activeClient.code2ProtocolConverter.asPosition(position),
    "utf-16"
  );
  const value = await activeClient.sendRequest<unknown>(
    "mmt/typstPosition",
    {
      textDocument: { uri: document.uri.toString() },
      position: client.value,
      backendEncoding: TINYMIST_POSITION_ENCODING
    },
    token
  );
  if (value === null) return null;
  const projected = parseProjectedPosition(value);
  const project = backend.projectForEntry(projected.entryUri);
  const retained = retainedBackendPosition(projected, project);
  const identity = guard.capture(project, document.uri.toString(), document.version);
  return identity ? { ...retained, identity } : null;
}

async function requestWithIdentity<T>(
  backend: TinymistHostBackend,
  guard: TypstPublicationGuard,
  identity: TypstRequestIdentity,
  method: string,
  params: unknown,
  token: vscode.CancellationToken
): Promise<T | undefined> {
  const controller = new AbortController();
  const subscription = token.onCancellationRequested(() => controller.abort());
  try {
    const response = await backend.request<T>(method, params, controller.signal);
    return guard.isCurrent(identity) ? response : undefined;
  } finally {
    subscription.dispose();
  }
}

export function installTypstMiddleware(
  options: LanguageClientOptions,
  backend: TinymistHostBackend,
  client: () => BaseLanguageClient
): void {
  const guard = new TypstPublicationGuard(backend);
  guardsByBackend.set(backend, guard);
  options.middleware = {
    didOpen: async (document, next) => {
      guard.retainSource(document);
      guard.staleTokens.open(document.uri.toString(), document.version);
      if (document.languageId !== "typst") await next(document);
    },
    didChange: async (event, next) => {
      guard.retainSource(event.document);
      guard.staleTokens.advance(event.document.uri.toString(), event.document.version);
      if (event.document.languageId !== "typst") await next(event);
    },
    didClose: async (document, next) => {
      guard.releaseSource(document.uri.toString());
      guard.staleTokens.close(document.uri.toString());
      if (document.languageId !== "typst") await next(document);
    },
    provideCompletionItem: async (document, position, completionContext, token, next) => {
      if (document.languageId === "typst") {
        const activeClient = client();
        const identity = guard.capture(
          backend.projectForEntry(document.uri.toString()),
          document.uri.toString(),
          document.version
        );
        if (!identity) return undefined;
        const index = retainedProjectIndex(backend.projectForEntry(identity.entryUri)!, identity.entryUri);
        const result = await requestWithIdentity<ProtocolCompletionItem[] | ProtocolCompletionList | null>(backend, guard, identity, "textDocument/completion", {
          textDocument: { uri: document.uri.toString() },
          position: standaloneBackendPosition(document, position, activeClient),
          context: { triggerKind: completionContext.triggerKind, triggerCharacter: completionContext.triggerCharacter }
        }, token);
        if (result === undefined) return undefined;
        validatePositionBearingPayload("completion", result, index, TINYMIST_POSITION_ENCODING);
        return activeClient.protocol2CodeConverter.asCompletionResult(result, undefined, token);
      }
      const mmt = await next(document, position, completionContext, token);
      if (Array.isArray(mmt) ? mmt.length > 0 : Boolean(mmt?.items.length)) return mmt;
      const activeClient = client();
      try {
        const route = await projectedBackendPosition(
          document,
          position,
          token,
          activeClient,
          backend,
          guard
        );
        if (!route) return mmt;
        const result = await requestWithIdentity<
          ProtocolCompletionItem[] | ProtocolCompletionList | null
        >(backend, guard, route.identity, "textDocument/completion", {
          textDocument: { uri: route.entryUri },
          position: wireBackendPosition(route.position),
          context: {
            triggerKind: completionContext.triggerKind,
            triggerCharacter: completionContext.triggerCharacter
          }
        }, token);
        if (result === undefined) return mmt;
        validatePositionBearingPayload("completion", result, route.index, route.position.encoding);
        const items = Array.isArray(result) ? result : (result?.items ?? []);
        const mapped = await activeClient.sendRequest<ProtocolCompletionItem[] | null>(
          "mmt/mapTypstCompletion",
          {
            sourceUri: document.uri.toString(),
            revision: route.revision,
            entryUri: route.entryUri,
            backendEncoding: route.position.encoding,
            sourceContent: route.sourceContent,
            projectDigest: route.projectDigest,
            projectionKey: route.projectionKey,
            items
          },
          token
        );
        if (!guard.isCurrent(route.identity)) return mmt;
        if (mapped) {
          validatePositionBearingPayload(
            "completion",
            mapped,
            guard.sourceIndex(route.identity),
            "utf-16"
          );
        }
        return activeClient.protocol2CodeConverter.asCompletionResult(mapped, undefined, token);
      } catch (error) {
        console.error("embedded Typst completion failed", error);
        return mmt;
      }
    },
    provideHover: async (document, position, token, next) => {
      if (document.languageId === "typst") {
        const activeClient = client();
        const identity = guard.capture(
          backend.projectForEntry(document.uri.toString()),
          document.uri.toString(),
          document.version
        );
        if (!identity) return undefined;
        const index = retainedProjectIndex(backend.projectForEntry(identity.entryUri)!, identity.entryUri);
        const hover = await requestWithIdentity<ProtocolHover | null>(backend, guard, identity, "textDocument/hover", {
          textDocument: { uri: document.uri.toString() },
          position: standaloneBackendPosition(document, position, activeClient)
        }, token);
        if (!hover) return undefined;
        validatePositionBearingPayload("hover", hover, index, TINYMIST_POSITION_ENCODING);
        return activeClient.protocol2CodeConverter.asHover(hover);
      }
      const mmt = await next(document, position, token);
      if (mmt) return mmt;
      const activeClient = client();
      try {
        const route = await projectedBackendPosition(
          document,
          position,
          token,
          activeClient,
          backend,
          guard
        );
        if (!route) return mmt;
        const hover = await requestWithIdentity<ProtocolHover | null>(backend, guard, route.identity, "textDocument/hover", {
          textDocument: { uri: route.entryUri },
          position: wireBackendPosition(route.position)
        }, token);
        validatePositionBearingPayload("hover", hover, route.index, route.position.encoding);
        if (!hover) return undefined;
        const mapped = await activeClient.sendRequest<ProtocolHover | null>(
          "mmt/mapTypstHover",
          {
            sourceUri: document.uri.toString(),
            revision: route.revision,
            entryUri: route.entryUri,
            backendEncoding: route.position.encoding,
            sourceContent: route.sourceContent,
            projectDigest: route.projectDigest,
            projectionKey: route.projectionKey,
            hover
          },
          token
        );
        if (!guard.isCurrent(route.identity)) return mmt;
        if (mapped) {
          validatePositionBearingPayload("hover", mapped, guard.sourceIndex(route.identity), "utf-16");
        }
        return activeClient.protocol2CodeConverter.asHover(mapped);
      } catch (error) {
        console.error("embedded Typst hover failed", error);
        return mmt;
      }
    },
    provideSignatureHelp: async (document, position, signatureContext, token, next) => {
      if (document.languageId === "typst") {
        const activeClient = client();
        const identity = guard.capture(
          backend.projectForEntry(document.uri.toString()),
          document.uri.toString(),
          document.version
        );
        if (!identity) return undefined;
        const signature = await requestWithIdentity<ProtocolSignatureHelp | null>(backend, guard, identity, "textDocument/signatureHelp", {
          textDocument: { uri: document.uri.toString() },
          position: standaloneBackendPosition(document, position, activeClient),
          context: { triggerKind: signatureContext.triggerKind, triggerCharacter: signatureContext.triggerCharacter, isRetrigger: signatureContext.isRetrigger }
        }, token);
        return signature ? activeClient.protocol2CodeConverter.asSignatureHelp(signature, token) : undefined;
      }
      const mmt = await next(document, position, signatureContext, token);
      if (mmt) return mmt;
      const activeClient = client();
      try {
        const route = await projectedBackendPosition(
          document,
          position,
          token,
          activeClient,
          backend,
          guard
        );
        if (!route) return mmt;
        const signature = await requestWithIdentity<ProtocolSignatureHelp | null>(
          backend,
          guard,
          route.identity,
          "textDocument/signatureHelp",
          {
            textDocument: { uri: route.entryUri },
            // Tinymist 0.15.2 advances the supplied offset by one before
            // classifying the argument context, so point it at the trigger.
            position: wireBackendPosition(route.index.previousScalar(route.position)),
            context: {
              triggerKind: signatureContext.triggerKind,
              triggerCharacter: signatureContext.triggerCharacter,
              isRetrigger: signatureContext.isRetrigger
            }
          },
          token
        );
        if (!signature) return undefined;
        const current = await projectedBackendPosition(
          document,
          position,
          token,
          activeClient,
          backend,
          guard
        );
        if (!current || current.projectionKey !== route.projectionKey) return undefined;
        if (!guard.isCurrent(route.identity)) return undefined;
        return activeClient.protocol2CodeConverter.asSignatureHelp(signature, token);
      } catch (error) {
        console.error("embedded Typst signature help failed", error);
        return mmt;
      }
    }
  };
}

export function connectTypstBackend(
  client: BaseLanguageClient,
  backend: TinymistHostBackend
): vscode.Disposable[] {
  const guard = guardsByBackend.get(backend);
  if (!guard) throw new Error("Typst middleware must own response guards before backend connection");
  let warnedAboutUnversionedDiagnostics = false;
  const diagnostics = vscode.languages.createDiagnosticCollection("mmt-typst");
  const projectUpdated = client.onNotification(
    "mmt/typstProjectUpdated",
    (update: TypstProjectUpdate) => {
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
      if (backend.closeProject(params.sourceUri, params.entryUri)) {
        diagnostics.delete(vscode.Uri.parse(params.sourceUri));
      }
    }
  );
  backend.on("textDocument/publishDiagnostics", (value) => {
    void (async () => {
      const params = value as {
        uri: string;
        version?: number | null;
        diagnostics: ProtocolDiagnostic[];
      };
      if (params.version == null && !warnedAboutUnversionedDiagnostics) {
        warnedAboutUnversionedDiagnostics = true;
        console.warn(
          "Tinymist sent unversioned diagnostics; using revision-scoped virtual entry URI isolation"
        );
      }
      const project = backend.projectForEntry(params.uri);
      if (!project || !diagnosticVersionMatchesProjection(project.revision, params.version)) return;
      const identity = guard.capture(project, project.sourceUri, project.sourceVersion);
      if (!identity) return;
      if (project.sourceUri === project.entryUri) {
        const projectIndex = retainedProjectIndex(project, project.entryUri);
        validatePositionBearingPayload(
          "diagnostics",
          params.diagnostics,
          projectIndex,
          TINYMIST_POSITION_ENCODING
        );
        const converted = await client.protocol2CodeConverter.asDiagnostics(params.diagnostics);
        if (!guard.isCurrent(identity)) return;
        diagnostics.set(vscode.Uri.parse(project.sourceUri), converted);
        return;
      }
      const mapped = await client.sendRequest<ProtocolDiagnostic[] | null>(
        "mmt/mapTypstDiagnostics",
        {
          sourceUri: project.sourceUri,
          revision: project.revision,
          entryUri: project.entryUri,
          backendEncoding: TINYMIST_POSITION_ENCODING,
          sourceContent: identity.sourceContent,
          projectDigest: identity.projectDigest,
          projectionKey: identity.projectionKey,
          diagnostics: params.diagnostics
        }
      );
      if (!mapped) return;
      validatePositionBearingPayload(
        "diagnostics",
        mapped,
        guard.sourceIndex(identity),
        "utf-16"
      );
      const converted = await client.protocol2CodeConverter.asDiagnostics(mapped);
      if (!guard.isCurrent(identity)) return;
      diagnostics.set(vscode.Uri.parse(project.sourceUri), converted);
    })().catch((error: unknown) => {
      console.error("embedded Typst diagnostics failed", error);
    });
  });
  return [diagnostics, projectUpdated, projectClosed];
}
