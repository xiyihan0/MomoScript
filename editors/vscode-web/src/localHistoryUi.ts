import * as vscode from "vscode";
import type { MmtIndexedDbFileSystemProvider } from "./filesystem";
import type { WorkspaceHistoryChange, WorkspaceHistoryRevision } from "./indexedDbWorkspace";
import { showMomoScriptMessage } from "./notifications";

const HISTORY_SCHEME = "mmt-history";
const textDecoder = new TextDecoder("utf-8", { fatal: true });

let pendingFileScope = false;

export function registerLocalHistoryCommands(provider: MmtIndexedDbFileSystemProvider): vscode.Disposable {
  const subscriptions: vscode.Disposable[] = [];
  subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(HISTORY_SCHEME, {
    async provideTextDocumentContent(uri) {
      const parameters = new URLSearchParams(uri.query);
      const revision = parameters.get("revision");
      if (!revision) throw new Error("历史文档缺少 revision");
      const side = parameters.get("side");
      const entry = side === "before" || side === "after"
        ? await provider.historyChangeEntry(revision, uri.path, side)
        : await provider.snapshotEntry(revision, uri.path);
      if (!entry || entry.type !== vscode.FileType.File) return "";
      return decodeText(entry.data);
    }
  }));
  subscriptions.push(vscode.commands.registerCommand("mmt.history.compare", async (revision: string, path: string, timestamp?: number) => {
    const entry = await provider.snapshotEntry(revision, path);
    if (!entry) {
      void showMomoScriptMessage("warning", `历史版本中不存在 ${basename(path)}`);
      return;
    }
    if (!isText(entry.data)) {
      const action = await showMomoScriptMessage(
        "info",
        `${basename(path)} 是 ${mediaLabel(path)} 文件（${formatBytes(entry.data.byteLength)}），只能导出或整文件恢复。`,
        ["导出历史版本", "恢复此文件"],
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
  subscriptions.push(vscode.commands.registerCommand("mmt.history.inspectDeletion", async (revision: string, path: string, timestamp?: number) => {
    await inspectDeletedChange(provider, revision, path, timestamp);
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
    void showMomoScriptMessage("info", `已创建 Checkpoint：${name.trim()}`);
  }));
  subscriptions.push(vscode.commands.registerCommand("mmt.history.renameCheckpoint", async (revision: string, current: string) => {
    const name = await vscode.window.showInputBox({
      title: "重命名 Checkpoint",
      value: current,
      validateInput: (value) => value.trim() ? undefined : "名称不能为空"
    });
    if (!name || name.trim() === current) return;
    await provider.renameCheckpoint(revision, name);
    void showMomoScriptMessage("info", `Checkpoint 已重命名为：${name.trim()}`);
  }));
  subscriptions.push(vscode.commands.registerCommand("mmt.history.deleteCheckpoint", async (revision: string, current: string) => {
    const answer = await vscode.window.showWarningMessage(
      `删除 Checkpoint“${current}”？对应状态将不再受历史清理保护。`,
      { modal: true },
      "删除 Checkpoint"
    );
    if (answer !== "删除 Checkpoint") return;
    await provider.deleteCheckpoint(revision);
    void showMomoScriptMessage("info", `已删除 Checkpoint：${current}`);
  }));
  subscriptions.push(vscode.commands.registerCommand("mmt.history.clearUnprotected", async () => {
    const usage = await provider.historyUsage();
    const answer = await vscode.window.showWarningMessage(
      `清理普通编辑历史？${usage.checkpointCount} 个 Checkpoint（${formatBytes(usage.checkpointBytes)}）和当前/结构恢复点会保留。`,
      { modal: true },
      "清理普通历史"
    );
    if (answer !== "清理普通历史") return;
    const next = await provider.clearUnprotectedHistory();
    void showMomoScriptMessage("info", `普通历史已清理；当前占用 ${formatBytes(next.totalBytes)}。`);
  }));
  subscriptions.push(vscode.commands.registerCommand("mmt.history.restoreFile", async (revision: string, path: string) => {
    await confirmRestoreFile(provider, revision, path);
  }));
  subscriptions.push(vscode.commands.registerCommand("mmt.history.restoreDeletedFile", async (revision: string, path: string) => {
    await confirmRestoreDeletedFile(provider, revision, path);
  }));
  subscriptions.push(vscode.commands.registerCommand("mmt.history.restoreWorkspace", async (revision: string, label?: string, changeCount?: number) => {
    const answer = await vscode.window.showWarningMessage(
      `恢复整个工作区到“${label || revision.slice(0, 8)}”？${changeCount ? ` 将应用该时间点的工作区状态（所选记录包含 ${changeCount} 项变化）。` : ""} 当前状态会先保存为安全 Checkpoint。`,
      { modal: true },
      "恢复工作区"
    );
    if (answer !== "恢复工作区") return;
    await provider.restore(revision);
    await synchronizeOpenDocuments(provider);
    const action = await showMomoScriptMessage("info", "工作区已恢复；操作前状态已保存为 Checkpoint。", ["打开本地历史"]);
    if (action === "打开本地历史") await vscode.commands.executeCommand("momoscript.localHistory.focus");
  }));
  subscriptions.push(vscode.commands.registerCommand("mmt.history.exportFile", async (revision: string, path: string) => {
    const entry = await provider.snapshotEntry(revision, path);
    if (!entry || entry.type !== vscode.FileType.File) {
      void showMomoScriptMessage("warning", `历史版本中不存在 ${basename(path)}`);
      return;
    }
    exportBytes(basename(path), entry.data);
  }));
  subscriptions.push(vscode.commands.registerCommand("mmt.history.showFileHistory", async (resource?: vscode.Uri) => {
    const uri = resource?.scheme === "mmtfs" ? resource : vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== "mmtfs") {
      void showMomoScriptMessage("warning", "没有可查看历史记录的工作区文件");
      return;
    }
    const stat = await vscode.workspace.fs.stat(uri).then((value) => value, () => undefined);
    if (!stat) {
      void showMomoScriptMessage("warning", `工作区中不存在 ${basename(uri.path)}`);
      return;
    }
    if (stat.type === vscode.FileType.Directory) {
      void showMomoScriptMessage("warning", "历史记录按文件查看，请选择一个文件");
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
    void showMomoScriptMessage("info", "已接管工作区写入权；修改将继续保存到本地历史。");
  }));
  subscriptions.push(registerWorkspaceLeaseAttention(provider));
  return { dispose: () => subscriptions.splice(0).reverse().forEach((subscription) => subscription.dispose()) };
}

function registerWorkspaceLeaseAttention(provider: MmtIndexedDbFileSystemProvider): vscode.Disposable {
  const subscriptions: vscode.Disposable[] = [];
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.name = "MomoScript 工作区写入状态";
  status.text = "$(lock) 工作区只读";
  status.tooltip = "另一标签页持有工作区写入权；点击以接管";
  status.command = "mmt.history.takeOverWriter";
  status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  subscriptions.push(status);

  let previousLease: string | undefined;
  const refresh = () => {
    const lease = provider.coordinator.state.lease;
    if (lease === "readonly") status.show();
    else status.hide();
    if (lease === "readonly" && previousLease !== "readonly") {
      void showMomoScriptMessage(
        "warning",
        "此标签页的工作区为只读；写入权由另一标签页持有，修改不会保存。",
        ["接管写入权"],
        { id: "workspace-readonly" },
      ).then((action) => {
        if (action === "接管写入权") void vscode.commands.executeCommand("mmt.history.takeOverWriter");
      });
    }
    previousLease = lease;
  };
  subscriptions.push(new vscode.Disposable(provider.coordinator.onDidChange(refresh)));
  refresh();
  return new vscode.Disposable(() => subscriptions.splice(0).reverse().forEach((subscription) => subscription.dispose()));
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
  const cleanup = iconButton("⌫", "清理普通历史");
  const refreshButton = iconButton("↻", "刷新本地历史");
  toolbar.append(checkpoint, cleanup, refreshButton);
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
  const loadMore = document.createElement("button");
  loadMore.type = "button";
  loadMore.className = "mms-history-load-more";
  loadMore.textContent = "加载更早记录";
  const footer = document.createElement("div");
  footer.className = "mms-history-footer";
  history.append(heading, controls, alert, list, loadMore, footer);
  container.append(workspace, history);

  let disposed = false;
  let refreshGeneration = 0;
  let loaded: WorkspaceHistoryRevision[] = [];
  let nextCursor: { createdAt: number; id: string } | undefined;
  const renderLoaded = () => {
    const activePath = activeWorkspacePath();
    if (pendingFileScope) {
      pendingFileScope = false;
      if (activePath) scope.value = "file";
    }
    scope.querySelector<HTMLOptionElement>('option[value="file"]')!.textContent = activePath ? basename(activePath) : "当前文件不可用";
    scope.disabled = !activePath && scope.value === "file";
    if (!activePath && scope.value === "file") scope.value = "workspace";
    renderRevisionList(list, filterRevisions(loaded, scope.value, reason.value, activePath));
    loadMore.hidden = !nextCursor;
  };
  const refresh = async () => {
    const generation = ++refreshGeneration;
    const status = provider.workspaceStatus();
    const metadata = provider.coordinator.state.metadata;
    const [usage, page] = await Promise.all([provider.historyUsage(), provider.historyPage(50)]);
    if (disposed || generation !== refreshGeneration) return;
    loaded = [...page.revisions];
    nextCursor = page.nextCursor;
    workspaceIdentity.textContent = `${metadata.displayName} · ${shortId(status.workspaceId)}`;
    workspaceState.textContent = `${backendLabel(status.backend)} · ${leaseLabel(status.lease)} · ${formatBytes(usage.totalBytes)}`;
    takeOver.hidden = status.lease === "writer";
    checkpoint.disabled = status.lease === "readonly";
    cleanup.disabled = status.lease === "readonly";
    const problem = historyProblem(provider);
    alert.hidden = !problem;
    alert.textContent = problem ?? "";
    footer.textContent = `${formatBytes(usage.totalBytes)} / ${formatBytes(usage.budgetBytes)} · 保留 30 天 · ${usage.checkpointCount} 个 Checkpoint（保护 ${formatBytes(usage.checkpointBytes)}）`;
    footer.title = `恢复关键内容 ${formatBytes(usage.protectedBytes)}；历史文件内容按 SHA-256 去重，不包含索引元数据`;
    renderLoaded();
  };
  const scheduleRefresh = () => void refresh().catch((error: unknown) => {
    if (disposed) return;
    list.replaceChildren(messageElement(error instanceof Error ? error.message : String(error)));
  });
  checkpoint.addEventListener("click", () => void vscode.commands.executeCommand("mmt.history.checkpoint").then(scheduleRefresh));
  cleanup.addEventListener("click", () => void vscode.commands.executeCommand("mmt.history.clearUnprotected").then(scheduleRefresh));
  refreshButton.addEventListener("click", scheduleRefresh);
  loadMore.addEventListener("click", () => void (async () => {
    if (!nextCursor) return;
    loadMore.disabled = true;
    try {
      const page = await provider.historyPage(50, nextCursor);
      loaded.push(...page.revisions);
      nextCursor = page.nextCursor;
      renderLoaded();
    } finally {
      loadMore.disabled = false;
    }
  })());
  scope.addEventListener("change", renderLoaded);
  reason.addEventListener("change", renderLoaded);
  const fileChanges = provider.onDidChangeFile(scheduleRefresh);
  const activeEditorChanges = vscode.window.onDidChangeActiveTextEditor(renderLoaded);
  const coordinatorChanges = new vscode.Disposable(provider.coordinator.onDidChange(scheduleRefresh));
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
    const directChange = revision.reason === "edit" && revision.changes.length === 1
      ? revision.changes[0]
      : undefined;
    primary.textContent = revision.checkpoint
      || (directChange ? `编辑 ${displayPath(directChange.path)}` : reasonLabel(revision.reason));
    const secondary = document.createElement("span");
    secondary.className = "mms-history-secondary";
    secondary.textContent = directChange
      ? `${formatTime(revision.updatedAt)} · ${changeMetadata(directChange)}`
      : `${formatTime(revision.updatedAt)} · ${revision.changes.length} 项变化`;
    copy.append(primary, secondary);
    const restore = directChange
      ? iconButton("↶", `恢复 ${displayPath(directChange.path)} 到此版本`)
      : iconButton("↶", "恢复整个工作区到此版本");
    restore.className = "mms-history-row-action";
    restore.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const command = directChange
        ? vscode.commands.executeCommand("mmt.history.restoreFile", revision.id, directChange.path)
        : vscode.commands.executeCommand("mmt.history.restoreWorkspace", revision.id, revision.checkpoint || formatTime(revision.updatedAt), revision.changes.length);
      void command.then(scheduleRefresh);
    });
    summary.append(icon, copy, restore);
    details.append(summary);
    if (directChange) {
      details.classList.add("mms-history-revision-direct");
      details.setAttribute("aria-expanded", "false");
      summary.title = `打开 ${displayPath(directChange.path)} 的更改`;
      summary.addEventListener("click", (event) => {
        event.preventDefault();
        void vscode.commands.executeCommand("mmt.history.compare", revision.id, directChange.path, revision.updatedAt);
      });
      return details;
    }
    const updateExpanded = () => details.setAttribute("aria-expanded", String(details.open));
    details.addEventListener("toggle", updateExpanded);
    updateExpanded();
    const changes = document.createElement("div");
    changes.className = "mms-history-changes";
    if (revision.changes.length === 0) changes.append(messageElement(revision.checkpoint ? "受保护的工作区 Checkpoint" : "此记录没有文件变化"));
    else for (const change of revision.changes) changes.append(changeElement(revision, change));
    if (revision.checkpoint) {
      const manage = document.createElement("div");
      manage.className = "mms-history-checkpoint-actions";
      const rename = iconButton("重命名", `重命名 Checkpoint ${revision.checkpoint}`);
      const remove = iconButton("删除", `删除 Checkpoint ${revision.checkpoint}`);
      rename.addEventListener("click", () => void vscode.commands.executeCommand("mmt.history.renameCheckpoint", revision.id, revision.checkpoint).then(scheduleRefresh));
      remove.addEventListener("click", () => void vscode.commands.executeCommand("mmt.history.deleteCheckpoint", revision.id, revision.checkpoint).then(scheduleRefresh));
      manage.append(rename, remove);
      changes.append(manage);
    }
    details.append(changes);
    return details;
  }

  function changeElement(revision: WorkspaceHistoryRevision, change: WorkspaceHistoryChange): HTMLElement {
    const row = document.createElement("div");
    row.className = "mms-history-change";
    const deleted = Boolean(change.beforeEntry && !change.afterEntry);
    const status = document.createElement("span");
    status.className = "mms-history-change-kind";
    status.textContent = changeKind(change);
    const open = document.createElement("button");
    open.type = "button";
    open.className = "mms-history-change-path";
    open.textContent = basename(change.path);
    open.title = `${change.path} · ${changeMetadata(change, true)}`;
    open.addEventListener("click", () => void vscode.commands.executeCommand(
      deleted ? "mmt.history.inspectDeletion" : "mmt.history.compare",
      revision.id,
      change.path,
      revision.updatedAt
    ));
    const metadata = document.createElement("span");
    metadata.className = "mms-history-change-meta";
    metadata.textContent = changeMetadata(change);
    const restore = iconButton("↶", deleted ? `恢复被删除文件 ${basename(change.path)}` : `恢复 ${basename(change.path)}`);
    restore.className = "mms-history-change-action";
    restore.addEventListener("click", () => void vscode.commands.executeCommand(
      deleted ? "mmt.history.restoreDeletedFile" : "mmt.history.restoreFile",
      revision.id,
      change.path
    ).then(scheduleRefresh));
    row.append(status, open, metadata, restore);
    return row;
  }

  return {
    dispose() {
      disposed = true;
      fileChanges.dispose();
      activeEditorChanges.dispose();
      coordinatorChanges.dispose();
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
  await synchronizeOpenDocuments(provider, new Set([path]));
  void showMomoScriptMessage("info", `已恢复 ${basename(path)}；操作前状态已保存。`);
}

async function inspectDeletedChange(
  provider: MmtIndexedDbFileSystemProvider,
  revision: string,
  path: string,
  timestamp?: number
): Promise<void> {
  const entry = await provider.historyChangeEntry(revision, path, "before");
  if (!entry || entry.type !== vscode.FileType.File) {
    void showMomoScriptMessage("warning", `删除记录中没有 ${basename(path)} 的删除前文件内容`);
    return;
  }
  const actions = ["查看删除前内容", "恢复被删除文件", "恢复删除后的工作区"] as const;
  const action = await showMomoScriptMessage(
    "info",
    `${basename(path)} 在此记录中被删除。删除前文件为 ${mediaLabel(path)}，${formatBytes(entry.data.byteLength)}。`,
    isText(entry.data) ? actions : ["导出删除前文件", actions[1], actions[2]],
  );
  if (action === "恢复被删除文件") {
    await confirmRestoreDeletedFile(provider, revision, path);
    return;
  }
  if (action === "恢复删除后的工作区") {
    await vscode.commands.executeCommand("mmt.history.restoreWorkspace", revision, `删除 ${basename(path)} 后`, 1);
    return;
  }
  if (action === "导出删除前文件") {
    exportBytes(basename(path), entry.data);
    return;
  }
  if (action !== "查看删除前内容") return;
  const status = provider.workspaceStatus();
  const historical = (side: "before" | "after") => vscode.Uri.from({
    scheme: HISTORY_SCHEME,
    authority: status.workspaceId,
    path,
    query: new URLSearchParams({ revision, side }).toString()
  });
  const label = timestamp ? formatTime(timestamp) : revision.slice(0, 8);
  await vscode.commands.executeCommand("vscode.diff", historical("before"), historical("after"), `${basename(path)} — ${label} 删除前 ↔ 删除后`);
}

async function confirmRestoreDeletedFile(provider: MmtIndexedDbFileSystemProvider, revision: string, path: string): Promise<void> {
  const answer = await vscode.window.showWarningMessage(
    `恢复被删除文件 ${basename(path)}？如果同名文件已重新创建，当前内容会先保存为安全 Checkpoint。`,
    { modal: true },
    "恢复被删除文件"
  );
  if (answer !== "恢复被删除文件") return;
  await provider.restoreDeletedFile(revision, path);
  await synchronizeOpenDocuments(provider, new Set([path]));
  void showMomoScriptMessage("info", `已恢复被删除文件 ${basename(path)}。`);
}

async function synchronizeOpenDocuments(
  provider: MmtIndexedDbFileSystemProvider,
  paths?: ReadonlySet<string>
): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  let changed = false;
  for (const document of vscode.workspace.textDocuments) {
    if (document.uri.scheme !== "mmtfs" || document.uri.authority !== "workspace") continue;
    if (paths && !paths.has(document.uri.path)) continue;
    let text: string;
    try {
      text = decodeText(provider.readFile(document.uri));
    } catch {
      continue;
    }
    if (document.getText() === text) continue;
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
    changed = true;
  }
  if (changed && !await vscode.workspace.applyEdit(edit)) {
    throw new Error("历史内容已恢复，但无法同步已打开的编辑器");
  }
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
  if (!change.beforeEntry && change.afterEntry) return "新增";
  if (change.beforeEntry && !change.afterEntry) return "删除";
  return "修改";
}

function changeMetadata(change: WorkspaceHistoryChange, fullHash = false): string {
  const digest = change.after ?? change.before;
  const size = change.afterEntry ? change.afterSize : change.beforeSize;
  return [
    mediaLabel(change.path, change.mediaType),
    size === undefined ? undefined : formatBytes(size),
    digest ? `SHA-256 ${fullHash ? digest : digest.slice(0, 8)}` : undefined
  ].filter(Boolean).join(" · ");
}

function mediaLabel(path: string, mediaType?: string): string {
  const type = mediaType ?? ({
    avif: "image/avif", avifs: "image/avif-sequence", gif: "image/gif", jpeg: "image/jpeg", jpg: "image/jpeg",
    json: "application/json", mmt: "text/x-momoscript", pdf: "application/pdf", png: "image/png", svg: "image/svg+xml",
    toml: "application/toml", typ: "text/x-typst", txt: "text/plain", webp: "image/webp"
  } as Record<string, string>)[path.split(".").at(-1)?.toLowerCase() ?? ""] ?? "application/octet-stream";
  return ({
    "application/json": "JSON", "application/octet-stream": "二进制", "application/pdf": "PDF", "application/toml": "TOML",
    "image/avif": "AVIF", "image/avif-sequence": "AVIF 序列", "image/gif": "GIF", "image/jpeg": "JPEG",
    "image/png": "PNG", "image/svg+xml": "SVG", "image/webp": "WebP", "text/plain": "文本",
    "text/x-momoscript": "MomoScript", "text/x-typst": "Typst"
  } as Record<string, string>)[type] ?? type;
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
function displayPath(path: string): string { return path.replace(/^\/+/, "") || "/"; }
function backendLabel(kind: string): string { return kind === "indexeddb" ? "浏览器存储" : kind === "local-directory" ? "本地目录" : kind; }
function leaseLabel(lease: string): string { return lease === "writer" ? "可写" : lease === "readonly" ? "只读" : "不可用"; }
