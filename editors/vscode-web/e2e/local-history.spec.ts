import { expect, previewReadiness, test, type Page } from "./fixtures";

test("editor context menu reveals the current file in local history", { tag: "@local-history" }, async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");

  await page.getByRole("treeitem", { name: /story\.mmt/ }).click();
  const editor = page.locator(".workbench-editor .monaco-editor").first();
  await expect(editor).toBeVisible();
  await editor.locator(".view-lines .view-line").first().click({ button: "right" });
  const historyItem = page.getByRole("menuitem", { name: "显示文件历史记录" });
  await expect(historyItem).toBeVisible();
  // 第二项（第一项是“插入角色表情差分”）
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  const scope = page.getByRole("combobox", { name: "本地历史范围" });
  await expect(scope).toBeVisible();
  await expect(scope).toHaveValue("file");
  await expect.poll(() => scope.evaluate((element) => (element as HTMLSelectElement).selectedOptions[0]?.textContent)).toBe("story.mmt");
  await expect(page.getByRole("tree", { name: "本地历史版本" })).toContainText("story.mmt");
});

test("local history opens a single-file edit diff and restores it across reload", { tag: "@local-history" }, async ({ page }) => {
  const baseline = "#set page(width: 420pt, height: 260pt)\n= HISTORY BASELINE\n";
  const current = "#set page(width: 420pt, height: 260pt)\n= HISTORY CURRENT\n";

  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  await expect.poll(() => activeDocument(page)).toMatchObject({ name: "intro.typ", languageId: "typst" });
  await page.getByRole("button", { name: "Typst 预览" }).click();

  await page.evaluate(({ name, text }) => (
    Reflect.get(globalThis, "__mmtReplaceWorkspaceDocument") as Function
  )(name, text), { name: "intro.typ", text: baseline });
  await expect.poll(() => persistedWorkspaceText(page, "/intro.typ")).toBe(baseline);
  await waitForPreviewText(page, "HISTORY BASELINE");

  await page.getByRole("tab", { name: "本地历史", exact: true }).click();
  await page.getByRole("button", { name: "创建 Checkpoint" }).click();
  const checkpointInput = page.getByRole("textbox", { name: /创建 Checkpoint/ });
  await checkpointInput.evaluate((element, name) => {
    const input = element as HTMLInputElement;
    input.value = name;
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  }, "历史恢复基线");
  await checkpointInput.press("Enter");
  await expect(page.getByRole("dialog", { name: /已创建 Checkpoint：历史恢复基线/ })).toBeVisible();

  await page.evaluate(({ name, text }) => (
    Reflect.get(globalThis, "__mmtReplaceWorkspaceDocument") as Function
  )(name, text), { name: "intro.typ", text: current });
  await expect.poll(() => persistedWorkspaceText(page, "/intro.typ")).toBe(current);
  await waitForPreviewText(page, "HISTORY CURRENT");

  const editRecords = page.locator(".mms-history-revision-direct", { hasText: "编辑 intro.typ" });
  await expect(editRecords).toHaveCount(2);
  const baselineEdit = editRecords.nth(1);
  await baselineEdit.locator("summary").click();
  const diffTab = page.getByRole("tab", { name: /intro\.typ.*↔ 当前/ });
  await expect(diffTab).toBeVisible();
  await diffTab.getByRole("button", { name: /^关闭/ }).click();

  let restorePrompt = "";
  page.once("dialog", (dialog) => {
    restorePrompt = dialog.message();
    void dialog.accept();
  });
  const restoreBaseline = page.locator(".mms-history-revision-direct", { hasText: "编辑 intro.typ" })
    .nth(1)
    .getByRole("button", { name: "恢复 intro.typ 到此版本" });
  await restoreBaseline.click();
  expect(restorePrompt).toBe("恢复 intro.typ？当前内容会先保存为安全 Checkpoint。");
  await expect.poll(() => persistedWorkspaceText(page, "/intro.typ")).toBe(baseline);
  await waitForPreviewText(page, "HISTORY BASELINE");

  await page.evaluate(({ name, text }) => (
    Reflect.get(globalThis, "__mmtReplaceWorkspaceDocument") as Function
  )(name, text), { name: "intro.typ", text: current });
  await expect.poll(() => persistedWorkspaceText(page, "/intro.typ")).toBe(current);
  await waitForPreviewText(page, "HISTORY CURRENT");

  let workspaceRestorePrompt = "";
  page.once("dialog", (dialog) => {
    workspaceRestorePrompt = dialog.message();
    void dialog.accept();
  });
  const checkpoint = page.locator(".mms-history-revision", { hasText: "历史恢复基线" }).first();
  await checkpoint.getByRole("button", { name: "恢复整个工作区到此版本" }).click();
  expect(workspaceRestorePrompt).toContain("恢复整个工作区到“历史恢复基线”？");
  const restoredNotification = page.getByRole("dialog", { name: /工作区已恢复；操作前状态已保存为 Checkpoint/ });
  await expect(restoredNotification).toBeVisible();
  await page.getByRole("tab", { name: /^资源管理器/ }).click();
  await restoredNotification.getByRole("button", { name: "打开本地历史" }).click();
  await expect(page.getByRole("tab", { name: "本地历史", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => persistedWorkspaceText(page, "/intro.typ")).toBe(baseline);
  await waitForPreviewText(page, "HISTORY BASELINE");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  await expect.poll(() => persistedWorkspaceText(page, "/intro.typ")).toBe(baseline);
  await expect.poll(() => activeDocument(page)).toMatchObject({ name: "intro.typ", languageId: "typst" });
  if (!(await page.getByRole("tab", { name: /^intro\.typ（预览）/ }).isVisible())) {
    await page.getByRole("button", { name: "Typst 预览" }).click();
  }
  await waitForPreviewText(page, "HISTORY BASELINE");
});

test("local history enforces retention and manages paged Checkpoints", { tag: "@local-history" }, async ({ page }) => {
  const retained = "#set page(width: 420pt, height: 260pt)\n= RETAINED AFTER GC\n";
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");

  await page.evaluate(({ name, text }) => (
    Reflect.get(globalThis, "__mmtReplaceWorkspaceDocument") as Function
  )(name, text), { name: "intro.typ", text: retained });
  await expect.poll(() => persistedWorkspaceText(page, "/intro.typ")).toBe(retained);
  const agedRevision = await ageLatestHistoryEdit(page);
  expect(agedRevision).toBeTruthy();
  await page.evaluate(async () => {
    await (Reflect.get(globalThis, "__mmtWriteWorkspaceFile") as Function)("gc-trigger.bin", btoa("gc"));
  });
  await expect.poll(() => historyRevisionExists(page, agedRevision!)).toBe(false);
  await expect.poll(() => persistedWorkspaceText(page, "/intro.typ")).toBe(retained);

  await page.evaluate(async (count) => {
    const create = Reflect.get(globalThis, "__mmtCreateCheckpoint") as Function;
    for (let index = 0; index < count; index += 1) await create(`分页 Checkpoint ${index}`);
  }, 52);
  await page.getByRole("tab", { name: "本地历史", exact: true }).click();
  await page.getByRole("combobox", { name: "本地历史范围" }).selectOption("workspace");
  await page.getByRole("button", { name: "刷新本地历史" }).click();
  await expect(page.getByText(/\/ 50\.0 MB · 保留 30 天 · \d+ 个 Checkpoint/)).toBeVisible();
  await expect(page.locator(".mms-history-revision")).toHaveCount(50);
  const loadMore = page.getByRole("button", { name: "加载更早记录" });
  await expect(loadMore).toBeVisible();
  await loadMore.click();
  await expect.poll(() => page.locator(".mms-history-revision").count()).toBeGreaterThan(50);

  const original = page.locator(".mms-history-revision", { hasText: "分页 Checkpoint 51" }).first();
  await original.locator("summary").click();
  await original.getByRole("button", { name: "重命名 Checkpoint 分页 Checkpoint 51" }).click();
  const renameInput = page.getByRole("textbox", { name: /重命名 Checkpoint/ });
  await renameInput.evaluate((element, name) => {
    const input = element as HTMLInputElement;
    input.value = name;
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  }, "分页 Checkpoint 已重命名");
  await renameInput.press("Enter");
  await expect(page.locator(".mms-history-revision", { hasText: "分页 Checkpoint 已重命名" })).toBeVisible();

  const renamed = page.locator(".mms-history-revision", { hasText: "分页 Checkpoint 已重命名" }).first();
  await renamed.locator("summary").click();
  let deletePrompt = "";
  page.once("dialog", (dialog) => {
    deletePrompt = dialog.message();
    void dialog.accept();
  });
  await renamed.getByRole("button", { name: "删除 Checkpoint 分页 Checkpoint 已重命名" }).click();
  expect(deletePrompt).toContain("将不再受历史清理保护");
  await expect(page.getByText("分页 Checkpoint 已重命名", { exact: true })).toHaveCount(0);

  await page.evaluate(({ name, text }) => (
    Reflect.get(globalThis, "__mmtReplaceWorkspaceDocument") as Function
  )(name, text), { name: "intro.typ", text: `${retained}= CLEANUP CANDIDATE\n` });
  await expect.poll(() => historyEditCountForPath(page, "/intro.typ"), { timeout: 10_000 }).toBeGreaterThan(0);
  await page.evaluate(() => (Reflect.get(globalThis, "__mmtCreateCheckpoint") as Function)("清理保护点"));
  await page.getByRole("button", { name: "刷新本地历史" }).click();
  await page.getByRole("combobox", { name: "本地历史类型" }).selectOption("edit");
  await expect(page.getByRole("treeitem", { name: /编辑 intro\.typ/ })).toBeVisible();
  let cleanupPrompt = "";
  page.once("dialog", (dialog) => {
    cleanupPrompt = dialog.message();
    void dialog.accept();
  });
  await page.getByRole("button", { name: "清理普通历史" }).click();
  await expect.poll(() => cleanupPrompt).toContain("Checkpoint");
  await expect(page.getByText("暂无符合条件的历史记录")).toBeVisible();
});

test("local history elides an edit group that returns to its original content", { tag: "@local-history" }, async ({ page }) => {
  const original = "#set page(width: 320pt, height: 180pt)\n= ORIGINAL\n";
  const transient = "#set page(width: 320pt, height: 180pt)\n= TRANSIENT\n";
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  await page.evaluate(({ name, text }) => (
    Reflect.get(globalThis, "__mmtOpenWorkspaceDocument") as Function
  )(name, text), { name: "history-noop.typ", text: original });
  await page.evaluate(({ name, text }) => (
    Reflect.get(globalThis, "__mmtWriteWorkspaceFile") as Function
  )(name, btoa(text)), { name: "history-noop.typ", text: transient });
  await expect.poll(() => persistedWorkspaceText(page, "/history-noop.typ")).toBe(transient);
  await page.evaluate(({ name, text }) => (
    Reflect.get(globalThis, "__mmtWriteWorkspaceFile") as Function
  )(name, btoa(text)), { name: "history-noop.typ", text: original });
  await expect.poll(() => persistedWorkspaceText(page, "/history-noop.typ")).toBe(original);
  await expect.poll(() => historyEditCountForPath(page, "/history-noop.typ")).toBe(0);
});

test("local history distinguishes deleted files and reports binary metadata", { tag: "@local-history" }, async ({ page }) => {
  const deletedText = "#set page(width: 320pt, height: 180pt)\n= DELETE ME\n";
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  await page.evaluate(async (text) => {
    const write = Reflect.get(globalThis, "__mmtWriteWorkspaceFile") as Function;
    await write("asset.bin", btoa(String.fromCharCode(0, 1, 2, 3)));
    await write("deleted.typ", btoa(text));
    await (Reflect.get(globalThis, "__mmtDeleteWorkspaceFile") as Function)("deleted.typ");
  }, deletedText);

  await page.getByRole("tab", { name: "本地历史", exact: true }).click();
  await page.getByRole("combobox", { name: "本地历史范围" }).selectOption("workspace");
  const binaryRevision = page.locator(".mms-history-revision", { hasText: "asset.bin" }).first();
  await binaryRevision.locator("summary").click();
  const binaryChange = binaryRevision.locator(".mms-history-change", { hasText: "asset.bin" });
  await expect(binaryChange).toContainText("二进制 · 4 B · SHA-256");
  await binaryChange.getByRole("button", { name: "asset.bin", exact: true }).click();
  await expect(page.getByRole("dialog", { name: /asset\.bin 是 二进制 文件（4 B）/ })).toBeVisible();
  await page.keyboard.press("Escape");

  const deletedRevision = page.locator(".mms-history-revision", { hasText: "deleted.typ" }).filter({ hasText: "删除" }).first();
  await deletedRevision.locator("summary").click();
  const deletedChange = deletedRevision.locator(".mms-history-change", { hasText: "deleted.typ" });
  await deletedChange.getByRole("button", { name: "deleted.typ", exact: true }).click();
  const deletionNotice = page.getByRole("dialog", { name: /deleted\.typ 在此记录中被删除/ });
  await expect(deletionNotice).toBeVisible();
  await deletionNotice.getByRole("button", { name: "查看删除前内容" }).click();
  const deletionDiff = page.getByRole("tab", { name: /deleted\.typ.*删除前.*删除后/ });
  await expect(deletionDiff).toBeVisible();
  await deletionDiff.getByRole("button", { name: /^关闭/ }).click();
  await deletedRevision.locator("summary").click();

  let restorePrompt = "";
  page.once("dialog", (dialog) => {
    restorePrompt = dialog.message();
    void dialog.accept();
  });
  await deletedChange.getByRole("button", { name: "恢复被删除文件 deleted.typ" }).click();
  expect(restorePrompt).toContain("恢复被删除文件 deleted.typ");
  await expect.poll(() => persistedWorkspaceText(page, "/deleted.typ")).toBe(deletedText);
});

async function activeDocument(page: Page): Promise<{ name: string; languageId: string; text: string } | null> {
  return page.evaluate(() => (Reflect.get(globalThis, "__mmtActiveDocument") as Function)());
}

async function persistedWorkspaceText(page: Page, path: string): Promise<string | undefined> {
  return page.evaluate(async (entryPath) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("momoscript-workspace-v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const entry = await new Promise<{ data?: Uint8Array } | undefined>((resolve, reject) => {
        const request = database.transaction("files").objectStore("files").get(entryPath);
        request.onsuccess = () => resolve(request.result as { data?: Uint8Array } | undefined);
        request.onerror = () => reject(request.error);
      });
      return entry?.data ? new TextDecoder().decode(entry.data) : undefined;
    } finally {
      database.close();
    }
  }, path);
}

async function waitForPreviewText(page: Page, expected: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (true) {
    const readiness = await previewReadiness(page);
    if (readiness.stage === "failed" || readiness.stage === "runtime-failed") {
      throw new Error(`Preview failed while waiting for ${JSON.stringify(expected)}: ${JSON.stringify(readiness)}`);
    }
    const text = await visiblePreviewText(page);
    if (text.includes(expected)) return;
    if (Date.now() >= deadline) {
      throw new Error(`Preview text timed out for ${JSON.stringify(expected)}: ${JSON.stringify({ readiness, text })}`);
    }
    await page.waitForTimeout(250);
  }
}

async function visiblePreviewText(page: Page): Promise<string> {
  const frames = page.frames().filter((candidate) => candidate.url().includes("/fake-") && candidate.url().includes(".html"));
  for (const frame of frames.slice().reverse()) {
    try {
      const result = await frame.evaluate(() => {
        const pageElement = document.querySelector<HTMLElement>(".page[data-intrinsic-width]");
        return pageElement && pageElement.getBoundingClientRect().width > 0 ? pageElement.textContent ?? "" : "";
      });
      if (result) return result;
    } catch {
      // Preview webviews are replaced atomically; ignore frames detached during the swap.
    }
  }
  return "";
}

async function ageLatestHistoryEdit(page: Page): Promise<string | undefined> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("momoscript-workspace-v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const revisions = await new Promise<Array<{ id: string; reason: string; createdAt: number; updatedAt: number }>>((resolve, reject) => {
        const request = database.transaction("revisions").objectStore("revisions").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const revision = revisions.filter((candidate) => candidate.reason === "edit").sort((left, right) => right.updatedAt - left.updatedAt)[0];
      if (!revision) return undefined;
      const aged = Date.now() - 31 * 24 * 60 * 60_000;
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("revisions", "readwrite");
        transaction.objectStore("revisions").put({ ...revision, createdAt: aged, updatedAt: aged });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      return revision.id;
    } finally {
      database.close();
    }
  });
}

async function historyRevisionExists(page: Page, revision: string): Promise<boolean> {
  return page.evaluate(async (id) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("momoscript-workspace-v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const request = database.transaction("revisions").objectStore("revisions").getKey(id);
        request.onsuccess = () => resolve(request.result !== undefined);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  }, revision);
}

async function historyEditCountForPath(page: Page, path: string): Promise<number> {
  return page.evaluate(async (entryPath) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("momoscript-workspace-v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const transaction = database.transaction(["revisions", "changes"]);
      const [revisions, changes] = await Promise.all([
        new Promise<Array<{ id: string; reason: string }>>((resolve, reject) => {
          const request = transaction.objectStore("revisions").getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        }),
        new Promise<Array<{ revision: string; path: string }>>((resolve, reject) => {
          const request = transaction.objectStore("changes").getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        }),
      ]);
      const editRevisions = new Set(revisions.filter((revision) => revision.reason === "edit").map((revision) => revision.id));
      return changes.filter((change) => change.path === entryPath && editRevisions.has(change.revision)).length;
    } finally {
      database.close();
    }
  }, path);
}
