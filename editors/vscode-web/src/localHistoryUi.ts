import * as vscode from "vscode";
import type { MmtIndexedDbFileSystemProvider } from "./filesystem";
import type { WorkspaceHistoryChange, WorkspaceHistoryRevision } from "./indexedDbWorkspace";

const HISTORY_SCHEME = "mmt-history";
const FALLBACK_HISTORY_BUDGET = 50 * 1024 * 1024;
const textDecoder = new TextDecoder("utf-8", { fatal: true });

let pendingFileScope = false;

export function registerLocalHistoryCommands(provider: MmtIndexedDbFileSystemProvider): vscode.Disposable {
  const subscriptions: vscode.Disposable[] = [];
  subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(HISTORY_SCHEME, {
    async provideTextDocumentContent(uri) {
      const revision = new URLSearchParams(uri.query).get("revision");
      if (!revision) throw new Error("历史文档缺少 revision");
      const entry = await provider.snapshotEntry(revision, uri.path);
      if (!entry || entry.type !== vscode.FileType.File) return "";
      return decodeText(entry.data);
    }
  }));
  subscriptions.push(vscode.commands.registerCommand("mmt.history.compare", async (revision: string, path: string, timestamp?: number) => {
    const entry = await provider.snapshotEntry(revision, path);
    if (!entry) {
      void vscode.window.showWarningMessage(`历史版本中不存在 ${basename(path)}`);
      return;
    }
    if (!isText(entry.data)) {
      const action = await vscode.window.showInformationMessage(
        `${basename(path)} 是二进制文件（${formatBytes(entry.data.byteLength)}），只能导出或整文件恢复。`,
        "导出历史版本",
        "恢复此文件"
      );
      if (action === "导出历史版本") exportBytes(basename(path), entry.data);
      if (action === "恢复此文件") await confirmRestoreFile(provider, revision, path);
      return;
    }
    const status = provider.workspaceStatus();
    const historical = vscode.Uri.from({
      scheme: HISTORY_SCHEME,
      authority: status.workspaceId,
      path,
      query: new URLSearchParams({ revision }).toString()
    });
    const current = vscode.Uri.parse(`mmtfs://workspace${path}`);
    const label = timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : revision.slice(0, 8);
    await vscode.commands.executeCommand("vscode.diff", historical, current, `${basename(path)} — ${label} ↔ 当前`);
  }));
  subscriptions.push(vscode.commands.registerCommand("mmt.history.checkpoint", async () => {
    const name = await vscode.window.showInputBox({
      title: "创建 Checkpoint",
      prompt: "为当前工作区状态命名；Checkpoint 不受普通历史清理影响",
      placeHolder: "例如：初稿完成",
      validateInput: (value) => value.trim() ? undefined : "名称不能为空"
    });
    if (!name) return;
    await provider.createCheckpoint(name);
    void vscode.window.showInformationMessage(`已创建 Checkpoint：${name.trim()}`);
  }));
  subscriptions.push(vscode.commands.registerCommand("mmt.history.restoreFile", async (revision: string, path: string) => {
    await confirmRestoreFile(provider, revision, path);
  }));
  subscriptions.push(vscode.commands.registerCommand("mmt.history.restoreWorkspace", async (revision: string, label?: string, changeCount?: number) => {
    const answer = await vscode.window.showWarningMessage(
      `恢复整个工作区到“${label || revision.slice(0, 8)}”？${changeCount ? ` 将应用该时间点的工作区状态（所选记录包含 ${changeCount} 项变化）。` : ""} 当前状态会先保存为安全 Checkpoint。`,
      { modal: true },
      "恢复工作区"
    );
    if (answer !== "恢复工作区") return;
    await provider.restore(revision);
    void vscode.window.showInformationMessage("工作区已恢复；操作前状态已保存为 Checkpoint。", "打开本地历史");
  }));
  subscriptions.push(vscode.commands.registerCommand("mmt.history.exportFile", async (revision: string, path: string) => {
    const entry = await provider.snapshotEntry(revision, path);
    if (!entry || entry.type !== vscode.FileType.File) {
      void vscode.window.showWarningMessage(`历史版本中不存在 ${basename(path)}`);
      return;
    }
    exportBytes(basename(path), entry.data);
  }));
  subscriptions.push(vscode.commands.registerCommand("mmt.history.showFileHistory", async (resource?: vscode.Uri) => {
    const uri = resource?.scheme === "mmtfs" ? resource : vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== "mmtfs") {
      void vscode.window.showWarningMessage("没有可查看历史记录的工作区文件");
      return;
    }
    const stat = await vscode.workspace.fs.stat(uri).then((value) => value, () => undefined);
    if (!stat) {
      void vscode.window.showWarningMessage(`工作区中不存在 ${basename(uri.path)}`);
      return;
    }
    if (stat.type === vscode.FileType.Directory) {
      void vscode.window.showWarningMessage("历史记录按文件查看，请选择一个文件");
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false });
      pendingFileScope = true;
    } catch {
      // 无法以文本打开的文件保持工作区范围，仅聚焦历史视图
    }
    await vscode.commands.executeCommand("momoscript.localHistory.focus");
  }));
  subscriptions.push(vscode.commands.registerCommand("mmt.history.takeOverWriter", async () => {
    const answer = await vscode.window.showWarningMessage(
      "接管写入权会使另一个打开此工作区的标签页变为只读。",
      { modal: true },
      "接管写入权"
    );
    if (answer !== "接管写入权") return;
    await provider.takeOverWriter();
    void vscode.window.showInformationMessage("已接管工作区写入权。此后修改会继续记录到本地历史。 ");
  }));
  return { dispose: () => subscriptions.splice(0).reverse().forEach((subscription) => subscription.dispose()) };
}

export function renderLocalHistoryView(container: HTMLElement, provider: MmtIndexedDbFileSystemProvider): vscode.Disposable {
  container.classList.add("mms-history-root");
  const workspace = document.createElement("section");
  workspace.className = "mms-history-workspace";
  const workspaceBody = document.createElement("div");
  workspaceBody.className = "mms-history-workspace-copy";
  const workspaceIdentity = document.createElement("div");
  workspaceIdentity.className = "mms-workspace-identity";
  const workspaceState = document.createElement("div");
  workspaceState.className = "mms-muted";
  const takeOver = iconButton("接管写入权", "接管写入权");
  takeOver.className = "mms-history-takeover";
  takeOver.addEventListener("click", () => void vscode.commands.executeCommand("mmt.history.takeOverWriter"));
  workspaceBody.append(workspaceIdentity, workspaceState);
  workspace.append(workspaceBody, takeOver);

  const history = document.createElement("section");
  history.className = "mms-history-view";
  const heading = document.createElement("div");
  heading.className = "mms-history-heading";
  const title = document.createElement("h3");
  title.textContent = "时间线";
  const toolbar = document.createElement("div");
  toolbar.className = "mms-history-toolbar";
  const checkpoint = iconButton("＋", "创建 Checkpoint");
  const refreshButton = iconButton("↻", "刷新本地历史");
  toolbar.append(checkpoint, refreshButton);
  heading.append(title, toolbar);
  const controls = document.createElement("div");
  controls.className = "mms-history-controls";
  const scope = document.createElement("select");
  scope.setAttribute("aria-label", "本地历史范围");
  scope.append(new Option("当前文件", "file"), new Option("整个工作区", "workspace"));
  const reason = document.createElement("select");
  reason.setAttribute("aria-label", "本地历史类型");
  reason.append(new Option("全部类型", "all"), new Option("Checkpoint", "checkpoint"), new Option("编辑", "edit"), new Option("结构变化", "structural"));
  controls.append(scope, reason);
  const alert = document.createElement("div");
  alert.className = "mms-history-alert";
  alert.hidden = true;
  const list = document.createElement("div");
  list.className = "mms-history-list";
  list.setAttribute("role", "tree");
  list.setAttribute("aria-label", "本地历史版本");
  const footer = document.createElement("button");
  footer.className = "mms-history-footer";
  footer.type = "button";
  history.append(heading, controls, alert, list, footer);
  container.append(workspace, history);

  let disposed = false;
  let refreshGeneration = 0;
  const refresh = async () => {
    const generation = ++refreshGeneration;
    const status = provider.workspaceStatus();
    const metadata = provider.coordinator.state.metadata;
    const bytes = await provider.historyBytes();
    const revisions = await provider.history(200);
    if (disposed || generation !== refreshGeneration) return;
    workspaceIdentity.textContent = `${metadata.displayName} · ${shortId(status.workspaceId)}`;
    workspaceState.textContent = `${backendLabel(status.backend)} · ${leaseLabel(status.lease)} · ${formatBytes(bytes)}`;
    takeOver.hidden = status.lease === "writer";
    const problem = historyProblem(provider);
    alert.hidden = !problem;
    alert.textContent = problem ?? "";
    footer.textContent = `${formatBytes(bytes)} / ${formatBytes(FALLBACK_HISTORY_BUDGET)} · 默认保留 30 天`;
    const activePath = activeWorkspacePath();
    if (pendingFileScope) {
      pendingFileScope = false;
      if (activePath) scope.value = "file";
    }
    scope.querySelector<HTMLOptionElement>('option[value="file"]')!.textContent = activePath ? basename(activePath) : "当前文件不可用";
    scope.disabled = !activePath && scope.value === "file";
    if (!activePath && scope.value === "file") scope.value = "workspace";
    renderRevisionList(list, filterRevisions(revisions, scope.value, reason.value, activePath));
  };
  const scheduleRefresh = () => void refresh().catch((error: unknown) => {
    if (disposed) return;
    list.replaceChildren(messageElement(error instanceof Error ? error.message : String(error)));
  });
  checkpoint.addEventListener("click", () => void vscode.commands.executeCommand("mmt.history.checkpoint").then(scheduleRefresh));
  refreshButton.addEventListener("click", scheduleRefresh);
  scope.addEventListener("change", scheduleRefresh);
  reason.addEventListener("change", scheduleRefresh);
  footer.addEventListener("click", () => void vscode.window.showInformationMessage(
    `本地历史当前占用 ${footer.textContent?.split(" · ")[0] ?? "未知"}。容量治理与清理入口将在历史存储接入 origin-wide budget 后启用。`
  ));
  const fileChanges = provider.onDidChangeFile(scheduleRefresh);
  const activeEditorChanges = vscode.window.onDidChangeActiveTextEditor(scheduleRefresh);
  scheduleRefresh();

  function renderRevisionList(target: HTMLElement, revisions: readonly WorkspaceHistoryRevision[]): void {
    target.replaceChildren();
    if (revisions.length === 0) {
      target.append(messageElement("暂无符合条件的历史记录"));
      return;
    }
    let previousGroup = "";
    for (const revision of revisions) {
      const group = dateGroup(revision.updatedAt);
      if (group !== previousGroup) {
        const groupHeading = document.createElement("div");
        groupHeading.className = "mms-history-date";
        groupHeading.textContent = group;
        groupHeading.setAttribute("role", "presentation");
        target.append(groupHeading);
        previousGroup = group;
      }
      target.append(revisionElement(revision));
    }
  }

  function revisionElement(revision: WorkspaceHistoryRevision): HTMLElement {
    const details = document.createElement("details");
    details.className = "mms-history-revision";
    details.setAttribute("role", "treeitem");
    const summary = document.createElement("summary");
    const icon = document.createElement("span");
    icon.className = "mms-history-icon";
    icon.textContent = reasonIcon(revision);
    const copy = document.createElement("span");
    copy.className = "mms-history-copy";
    const primary = document.createElement("span");
    primary.className = "mms-history-primary";
    primary.textContent = revision.checkpoint || reasonLabel(revision.reason);
    const secondary = document.createElement("span");
    secondary.className = "mms-history-secondary";
    secondary.textContent = `${formatTime(revision.updatedAt)} · ${revision.changes.length} 项变化`;
    copy.append(primary, secondary);
    const restore = iconButton("↶", "恢复整个工作区到此版本");
    restore.className = "mms-history-row-action";
    restore.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void vscode.commands.executeCommand("mmt.history.restoreWorkspace", revision.id, revision.checkpoint || formatTime(revision.updatedAt), revision.changes.length).then(scheduleRefresh);
    });
    summary.append(icon, copy, restore);
    details.append(summary);
    const changes = document.createElement("div");
    changes.className = "mms-history-changes";
    if (revision.changes.length === 0) {
      changes.append(messageElement("工作区 Checkpoint"));
    } else {
      for (const change of revision.changes) changes.append(changeElement(revision, change));
    }
    details.append(changes);
    return details;
  }

  function changeElement(revision: WorkspaceHistoryRevision, change: WorkspaceHistoryChange): HTMLElement {
    const row = document.createElement("div");
    row.className = "mms-history-change";
    const status = document.createElement("span");
    status.className = "mms-history-change-kind";
    status.textContent = changeKind(change);
    const open = document.createElement("button");
    open.type = "button";
    open.className = "mms-history-change-path";
    open.textContent = basename(change.path);
    open.title = change.path;
    open.addEventListener("click", () => void vscode.commands.executeCommand("mmt.history.compare", revision.id, change.path, revision.updatedAt));
    const restore = iconButton("↶", `恢复 ${basename(change.path)}`);
    restore.className = "mms-history-change-action";
    restore.addEventListener("click", () => void vscode.commands.executeCommand("mmt.history.restoreFile", revision.id, change.path).then(scheduleRefresh));
    row.append(status, open, restore);
    return row;
  }

  return {
    dispose() {
      disposed = true;
      fileChanges.dispose();
      activeEditorChanges.dispose();
      workspace.remove();
      history.remove();
    }
  };
}

async function confirmRestoreFile(provider: MmtIndexedDbFileSystemProvider, revision: string, path: string): Promise<void> {
  const answer = await vscode.window.showWarningMessage(
    `恢复 ${basename(path)}？当前内容会先保存为安全 Checkpoint。`,
    { modal: true },
    "恢复此文件"
  );
  if (answer !== "恢复此文件") return;
  await provider.restoreFile(revision, path);
  void vscode.window.showInformationMessage(`已恢复 ${basename(path)}；操作前状态已保存。`);
}

function filterRevisions(
  revisions: readonly WorkspaceHistoryRevision[],
  scope: string,
  reason: string,
  activePath: string | undefined
): readonly WorkspaceHistoryRevision[] {
  return revisions.filter((revision) => {
    if (scope === "file" && activePath && !revision.checkpoint && !revision.changes.some((change) => change.path === activePath)) return false;
    if (reason === "checkpoint") return Boolean(revision.checkpoint);
    if (reason === "edit") return revision.reason === "edit";
    if (reason === "structural") return ["create", "delete", "rename", "restore", "import"].includes(revision.reason);
    return true;
  });
}

function activeWorkspacePath(): string | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri?.scheme === "mmtfs" ? uri.path : undefined;
}

function historyProblem(provider: MmtIndexedDbFileSystemProvider): string | undefined {
  const state = provider.coordinator.state;
  if (state.metadata.migration.state === "migration-failed") return `工作区升级失败：${state.metadata.migration.error}`;
  if (state.metadata.storage.quotaBlocked) return "历史空间不足；为避免无历史写入，工作区已阻塞。";
  if (state.metadata.storage.historyDegraded || state.metadata.storage.unreconciled) return "部分文件变化尚未完整写入本地历史。";
  if (state.blocked) return "工作区因未完成的原子写入而被阻塞。";
  if (state.lease === "readonly") return "只读模式：另一标签页持有工作区写入权。";
  return undefined;
}

function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try { textDecoder.decode(bytes); return true; } catch { return false; }
}

function decodeText(bytes: Uint8Array): string {
  try { return textDecoder.decode(bytes); } catch { throw new Error("该历史版本不是 UTF-8 文本，请使用导出或整文件恢复"); }
}

function exportBytes(name: string, bytes: Uint8Array): void {
  const blob = new Blob([bytes.slice().buffer]);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  queueMicrotask(() => URL.revokeObjectURL(url));
}

function iconButton(text: string, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.title = label;
  button.setAttribute("aria-label", label);
  return button;
}

function messageElement(message: string): HTMLDivElement {
  const element = document.createElement("div");
  element.className = "mms-history-message";
  element.textContent = message;
  return element;
}

function reasonIcon(revision: WorkspaceHistoryRevision): string {
  if (revision.checkpoint) return "★";
  return ({ edit: "✎", create: "+", delete: "−", rename: "↔", restore: "↶", import: "⇣", "external-change": "⟳", "webdav-pull": "⇣", checkpoint: "★", "backend-migration": "◇" } as Record<string, string>)[revision.reason] ?? "•";
}

function reasonLabel(reason: string): string {
  return ({ edit: "编辑", create: "创建", delete: "删除", rename: "重命名", restore: "恢复", import: "导入", "external-change": "外部修改", "webdav-pull": "远端同步", checkpoint: "Checkpoint", "backend-migration": "存储迁移" } as Record<string, string>)[reason] ?? reason;
}

function changeKind(change: WorkspaceHistoryChange): string {
  if (!change.beforeEntry && change.afterEntry) return "A";
  if (change.beforeEntry && !change.afterEntry) return "D";
  return "M";
}

function dateGroup(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (startDate === startToday) return "今天";
  if (startDate === startToday - 86_400_000) return "昨天";
  return date.toLocaleDateString();
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function shortId(value: string): string { return value.split("-").join("").slice(0, 6); }
function basename(path: string): string { return path.split("/").filter(Boolean).at(-1) ?? path; }
function backendLabel(kind: string): string { return kind === "indexeddb" ? "浏览器存储" : kind === "local-directory" ? "本地目录" : kind; }
function leaseLabel(lease: string): string { return lease === "writer" ? "可写" : lease === "readonly" ? "只读" : "不可用"; }
