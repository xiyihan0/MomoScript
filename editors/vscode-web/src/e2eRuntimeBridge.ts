import * as vscode from "vscode";
import type { WorkspaceHistoryUsage } from "./indexedDbWorkspace.ts";
import type { ExactExportUiState } from "./exactExportUi.ts";
import type { PreviewBuildDiagnostic } from "./previewDiagnostics.ts";
import type { PreviewTraceSample } from "./previewPerformance.ts";
import type { PreviewPagePoint, PreviewViewport } from "./previewWebviewProtocol.ts";
import type { RuntimeRecoveryState, RuntimeStatusSnapshot } from "./runtimeStatus.ts";
import type { PwaSafeRestartQuiesceAdapter } from "./pwaSafeRestart.ts";

export interface PreviewInteractionFixtureRequest {
  readonly action: "install-provider" | "install-immutable" | "position" | "position-live" | "editor-selection" | "reveal" | "overlay" | "navigate" | "restart-provider" | "resync-renderer" | "advance-source" | "state";
  readonly range?: { readonly start: { readonly line: number; readonly character: number }; readonly end: { readonly line: number; readonly character: number } };
  readonly point?: PreviewPagePoint;
}

export interface ExactExportFixtureRequest {
  readonly action: "install" | "advance" | "publish-latest" | "partial" | "failed" | "evicted" | "state" | "has-artifact";
  readonly marker?: string;
  readonly renderKey?: string;
}

export interface MmtE2EActiveDocument {
  readonly name?: string;
  readonly languageId: string;
  readonly text: string;
}

export interface MmtE2EWorkspaceEditResult {
  readonly text: string;
  readonly version: number;
}

export interface MmtE2ETypstBackendProject {
  readonly revision: number;
  readonly text: string | null;
}

export interface MmtE2ELanguageProjectionEntry {
  readonly sourceVersion: number;
  readonly text?: string;
}

export interface MmtE2ETypstSyncResult {
  readonly entryUri: string;
  readonly revision: number;
  readonly acceptedRevision: number | null;
}

export interface MmtE2EEditorSelection {
  readonly uri: string;
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
}

export interface MmtE2EPreviewInteractionState {
  readonly renderKey: string | null;
  readonly viewport: PreviewViewport;
  readonly status: string | null;
  readonly statusText: string;
  readonly indicatorCount: number;
  readonly cursorCount: number;
  readonly backendGeneration: number | null;
  readonly rendererSessionId: string | null;
  readonly rendererArtifactDigest: string | null;
  readonly rendererSourceDigest: string | null;
  readonly rendererByteLength: number | null;
  readonly pageGeometries: readonly unknown[];
  readonly pageCount: number;
  readonly visualKind: string | null;
  readonly rendererGeneration: number | null;
  readonly rendererFrameKind: string | null;
  readonly cursor: PreviewPagePoint | null;
}

export type MmtE2EPreviewInteractionResult = MmtE2EPreviewInteractionState | MmtE2EEditorSelection | boolean | null;

export interface MmtE2EPreviewReadiness {
  readonly stage: string;
  readonly sourceUri: string | null;
  readonly displayedSourceUri: string | null;
  readonly runtimeRecoveryState: RuntimeRecoveryState;
  readonly runtimeLastFailure: string | null;
  readonly buildStatus: string;
  readonly buildRevision: number | null;
  readonly fixtureActive: boolean;
  readonly containerReady: boolean;
  readonly containerRevision: string | null;
  readonly containerRenderKey: string | null;
  readonly displayedRenderKey: string | null;
  readonly panelOpen: boolean;
  readonly diagnostics: readonly {
    readonly phase: string;
    readonly severity: string;
    readonly message: string;
  }[];
}

export interface MmtE2EPreviewRetainedState {
  readonly timingSamples: number;
  readonly previewProjects: number;
  readonly latestProjects: number;
  readonly artifacts: number;
  readonly artifactBytes: number;
  readonly mappedShadows: number;
  readonly pendingMaterializations: number;
  readonly activeMaterializations: number;
}

export interface MmtE2EApi {
  readonly workspace: {
    readonly activeDocument: () => MmtE2EActiveDocument | null;
    readonly colorDecorators: () => string | undefined;
    readonly defaultEol: () => string | undefined;
    readonly writeFile: (name: string, dataBase64: string) => Promise<void>;
    readonly openDocument: (name: string, text: string) => Promise<string>;
    readonly showDocument: (name: string) => Promise<string>;
    readonly readDocument: (name: string) => Promise<string>;
    readonly replaceDocument: (name: string, text: string) => Promise<string>;
    readonly editDocument: (name: string, offset: number, deleteCount: number, text: string) => Promise<MmtE2EWorkspaceEditResult>;
    readonly deleteFile: (name: string) => Promise<void>;
    readonly storyText: () => string | undefined;
  };
  readonly language: {
    readonly completionDocumentation: (line: number, character: number, label: string) => Promise<string | null>;
    readonly completionLabels: (line: number, character: number, triggerCharacter?: string, name?: string) => Promise<readonly string[]>;
    readonly hoverText: (line: number, character: number) => Promise<readonly string[]>;
    readonly typstHoverText: (name: string, line: number, character: number) => Promise<readonly string[]>;
    readonly typstSemanticTokens: (name: string) => Promise<readonly number[]>;
    readonly typstRawSemanticTokens: (name: string) => Promise<{ readonly data: number[] } | null>;
    readonly typstBackendProject: (name: string) => MmtE2ETypstBackendProject | null;
    readonly projectionEntry: (name: string) => MmtE2ELanguageProjectionEntry | null;
    readonly latestProjectionRevision: () => number | undefined;
    readonly syncWorkspaceTypst: (name: string) => Promise<MmtE2ETypstSyncResult | null>;
  };
  readonly preview: {
    readonly displayedSourceUri: () => string | undefined;
    readonly open: (sourceUri: string) => void;
    readonly buildDiagnostics: (sourceUri: string) => readonly PreviewBuildDiagnostic[];
    readonly interactionFixture: (request: PreviewInteractionFixtureRequest) => Promise<MmtE2EPreviewInteractionResult>;
    readonly readiness: (requestedSourceUri?: string) => MmtE2EPreviewReadiness;
    readonly retainedState: () => MmtE2EPreviewRetainedState;
    readonly timings: () => readonly PreviewTraceSample[];
    readonly resetTimings: () => void;
    readonly setRendererEnabled: (enabled: boolean) => boolean;
  };
  readonly runtime: {
    readonly status: () => RuntimeStatusSnapshot;
    readonly statusFixture: (recoveryState: RuntimeRecoveryState, lastFailure?: string) => void;
    readonly pwaSafeRestart: PwaSafeRestartQuiesceAdapter;
  };
  readonly history: {
    readonly createCheckpoint: (name: string) => Promise<string>;
    readonly usage: () => Promise<WorkspaceHistoryUsage>;
  };
  readonly exactExport: {
    readonly fixture: (request: ExactExportFixtureRequest) => Promise<ExactExportUiState | boolean | string>;
  };
  readonly security: {
    readonly sanitizeSvg: (svg: string) => string;
  };
}

declare global {
  var __mmtE2E: MmtE2EApi | undefined;
}

export interface MmtE2EWorkspacePorts {
  readonly workspaceUri: vscode.Uri;
  readonly storyUri: vscode.Uri;
  readonly encoder: TextEncoder;
  readonly deleteFile: MmtE2EApi["workspace"]["deleteFile"];
}

export interface MmtE2ELanguageBackend {
  request<T>(method: string, params: unknown): Promise<T>;
  projectForEntry(entryUri: string): {
    readonly revision: number;
    readonly files: readonly { readonly uri: string; readonly text?: string }[];
  } | undefined;
}

export interface MmtE2ELanguagePorts {
  readonly workspaceUri: vscode.Uri;
  readonly storyUri: vscode.Uri;
  readonly backend: () => MmtE2ELanguageBackend | undefined;
  readonly projectionEntry: MmtE2EApi["language"]["projectionEntry"];
  readonly latestProjectionRevision: MmtE2EApi["language"]["latestProjectionRevision"];
  readonly syncWorkspaceTypst: MmtE2EApi["language"]["syncWorkspaceTypst"];
}

const workspaceDocumentNamePattern = /^[^./\\][^/\\]*(?:\.mmt(?:\.txt)?|\.typ)$/;
const workspaceBasenamePattern = /^[^./\\][^/\\]*$/;

function workspaceDocumentUri(workspaceUri: vscode.Uri, name: string): vscode.Uri {
  if (!workspaceDocumentNamePattern.test(name)) throw new Error("invalid workspace document basename");
  return vscode.Uri.joinPath(workspaceUri, name);
}

async function showWorkspaceDocument(uri: vscode.Uri, name: string): Promise<string> {
  const opened = await vscode.workspace.openTextDocument(uri);
  const expectedLanguage = name.endsWith(".typ") ? "typst" : "mmt";
  const document = opened.languageId === expectedLanguage
    ? opened
    : await vscode.languages.setTextDocumentLanguage(opened, expectedLanguage);
  await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
  return uri.toString();
}

export function createMmtE2EWorkspaceApi(ports: MmtE2EWorkspacePorts): MmtE2EApi["workspace"] {
  return Object.freeze({
    activeDocument() {
      const active = vscode.window.activeTextEditor?.document;
      const workspaceDocument = active?.uri.scheme === "mmtfs"
        ? active
        : vscode.window.visibleTextEditors.find((editor) => editor.document.uri.scheme === "mmtfs")?.document;
      return workspaceDocument
        ? { name: workspaceDocument.uri.path.split("/").pop(), languageId: workspaceDocument.languageId, text: workspaceDocument.getText() }
        : null;
    },
    storyText() {
      return vscode.workspace.textDocuments.find((document) => document.uri.toString() === ports.storyUri.toString())?.getText();
    },
    colorDecorators() {
      return vscode.workspace
        .getConfiguration("editor", vscode.window.activeTextEditor?.document)
        .get<string>("defaultColorDecorators");
    },
    defaultEol() {
      return vscode.workspace.getConfiguration("files").get<string>("eol");
    },
    async writeFile(name: string, dataBase64: string) {
      if (!workspaceBasenamePattern.test(name) || name === "..") throw new Error("invalid workspace basename");
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(ports.workspaceUri, name),
        Uint8Array.from(atob(dataBase64), (character) => character.charCodeAt(0)),
      );
    },
    async openDocument(name: string, text: string) {
      const uri = workspaceDocumentUri(ports.workspaceUri, name);
      await vscode.workspace.fs.writeFile(uri, ports.encoder.encode(text));
      return showWorkspaceDocument(uri, name);
    },
    async showDocument(name: string) {
      const uri = workspaceDocumentUri(ports.workspaceUri, name);
      return showWorkspaceDocument(uri, name);
    },
    async readDocument(name: string) {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(workspaceDocumentUri(ports.workspaceUri, name)));
    },
    async replaceDocument(name: string, text: string) {
      const uri = workspaceDocumentUri(ports.workspaceUri, name);
      const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === uri.toString());
      if (!document) throw new Error("workspace document is not open");
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
      if (!await vscode.workspace.applyEdit(edit)) throw new Error("workspace edit was rejected");
      return document.getText();
    },
    async editDocument(name: string, offset: number, deleteCount: number, text: string) {
      const uri = workspaceDocumentUri(ports.workspaceUri, name);
      const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === uri.toString());
      if (!document) throw new Error("workspace document is not open");
      if (
        !Number.isSafeInteger(offset)
        || !Number.isSafeInteger(deleteCount)
        || offset < 0
        || deleteCount < 0
        || offset + deleteCount > document.getText().length
      ) throw new RangeError("workspace edit range is invalid");
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(document.positionAt(offset), document.positionAt(offset + deleteCount)), text);
      if (!await vscode.workspace.applyEdit(edit)) throw new Error("workspace edit was rejected");
      return { text: document.getText(), version: document.version };
    },
    deleteFile: ports.deleteFile,
  });
}

export function createMmtE2ELanguageApi(ports: MmtE2ELanguagePorts): MmtE2EApi["language"] {
  return Object.freeze({
    async completionLabels(line: number, character: number, triggerCharacter?: string, name = "story.mmt") {
      const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
        "vscode.executeCompletionItemProvider",
        vscode.Uri.joinPath(ports.workspaceUri, name),
        new vscode.Position(line, character),
        triggerCharacter,
      );
      return completions?.items.map((item) => typeof item.label === "string" ? item.label : item.label.label) ?? [];
    },
    async completionDocumentation(line: number, character: number, label: string) {
      const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
        "vscode.executeCompletionItemProvider",
        ports.storyUri,
        new vscode.Position(line, character),
      );
      const item = completions?.items.find((candidate) => candidate.label === label);
      return typeof item?.documentation === "string" ? item.documentation : item?.documentation?.value ?? null;
    },
    async hoverText(line: number, character: number) {
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        ports.storyUri,
        new vscode.Position(line, character),
      );
      return hovers?.flatMap((hover) => hover.contents.map((content) => typeof content === "string" ? content : content.value)) ?? [];
    },
    async typstHoverText(name: string, line: number, character: number) {
      const uri = vscode.Uri.joinPath(ports.workspaceUri, name);
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        uri,
        new vscode.Position(line, character),
      );
      return hovers?.flatMap((hover) => hover.contents.map((content) => typeof content === "string" ? content : content.value)) ?? [];
    },
    async typstSemanticTokens(name: string) {
      const uri = vscode.Uri.joinPath(ports.workspaceUri, name);
      const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>("vscode.provideDocumentSemanticTokens", uri);
      return tokens ? Array.from(tokens.data) : [];
    },
    async typstRawSemanticTokens(name: string) {
      const uri = vscode.Uri.joinPath(ports.workspaceUri, name).toString();
      return await ports.backend()?.request<{ data: number[] } | null>(
        "textDocument/semanticTokens/full",
        { textDocument: { uri } },
      ) ?? null;
    },
    typstBackendProject(name: string) {
      const uri = vscode.Uri.joinPath(ports.workspaceUri, name).toString();
      const project = ports.backend()?.projectForEntry(uri);
      return project
        ? { revision: project.revision, text: project.files.find((file) => file.uri === uri)?.text ?? null }
        : null;
    },
    projectionEntry: ports.projectionEntry,
    latestProjectionRevision: ports.latestProjectionRevision,
    syncWorkspaceTypst: ports.syncWorkspaceTypst,
  });
}

export function installMmtE2EBridge(api: MmtE2EApi): vscode.Disposable {
  if (import.meta.env.VITE_MMT_E2E !== "1") return Object.freeze({ dispose() {} });
  const installedValue: MmtE2EApi = Object.freeze({
    workspace: Object.freeze({ ...api.workspace }),
    language: Object.freeze({ ...api.language }),
    preview: Object.freeze({ ...api.preview }),
    runtime: Object.freeze({ ...api.runtime }),
    history: Object.freeze({ ...api.history }),
    exactExport: Object.freeze({ ...api.exactExport }),
    security: Object.freeze({ ...api.security }),
  });
  Reflect.set(globalThis, "__mmtE2E", installedValue);
  return Object.freeze({
    dispose() {
      if (Reflect.get(globalThis, "__mmtE2E") === installedValue) Reflect.deleteProperty(globalThis, "__mmtE2E");
    },
  });
}
