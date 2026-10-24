import { readFile } from "node:fs/promises";
import { expect, invokeMmtE2E, test, waitForPreviewFrame, type Page } from "./fixtures";
import { PACK_BASE_URL, PACK_MANIFEST_URL as MANIFEST_URL } from "../src/runtimeArtifacts.ts";

const LIFECYCLE_STORAGE_KEY = "mmt-e2e-worker-lifecycle-v1";
const manifest = await readFile(new URL("./fixtures/manifest.json", import.meta.url));

type LanguageWorkerKind = "mmt" | "tinymist";
type LifecycleEvent = {
  generation: number;
  sequence: number;
  kind: string;
  workerId?: number;
  workerKind?: LanguageWorkerKind | "other";
  url?: string;
  name?: string;
};
type LifecycleState = {
  generation: number;
  documentGeneration: number;
  nextWorkerId: number;
  sequence: number;
  events: LifecycleEvent[];
};
type ExactExportFixtureState = {
  availability: string;
  phase: string;
  displayedRenderKey?: string;
  requestedRenderKey?: string;
  completedRenderKey?: string;
};
type ExactExportFixtureRequest = {
  action: "install" | "state";
  marker?: string;
};

test("a real missing-asset compile failure keeps startup ready, requested modes open and Source/new-work recovery usable", async ({ page }) => {
  await installWorkerLifecycleObserver(page);
  await routeStartupResources(page);
  const missingAvatar = new URL("assets/avatar/佳代子.png", PACK_BASE_URL).href;
  const blockedAssets: string[] = [];
  page.on("requestfailed", (request) => {
    if (request.url() === missingAvatar) blockedAssets.push(request.url());
  });

  // The ordinary fresh entry renders story.mmt against the real language
  // projection and compiler. Only its existing remote assets are unavailable.
  await page.goto("/");
  await waitForRuntimeGeneration(page, 1);
  await assertLiveLanguageWorkers(page, 1, "startup with an unavailable preview asset");
  const sourceUri = "mmtfs://workspace/story.mmt";
  await expect.poll(() => invokeMmtE2E(page, "preview", "readiness", sourceUri)).toMatchObject({
    stage: "failed",
    runtimeRecoveryState: "ready",
    runtimeLastFailure: null,
    buildStatus: "failed",
    fixtureActive: false,
    panelOpen: true,
    displayedRenderKey: null,
  });
  expect(blockedAssets).toContain(missingAvatar);
  const failed = await invokeMmtE2E(page, "preview", "readiness", sourceUri);
  expect(failed.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ phase: "layout", severity: "error", message: expect.any(String) }),
  ]));
  const surface = page.getByRole("region", { name: "MomoScript GUI 创作" });
  await expect(surface).toBeVisible();
  await expect(surface.getByRole("button", { name: "切换模式 · 当前为聊天创作", exact: true })).toBeEnabled();
  const original = await invokeMmtE2E(page, "workspace", "canonicalText", "story.mmt");
  const failedPreview = page.frameLocator("iframe").frameLocator("iframe");
  const captured = "Retain this attempted edit while the preview is failed.";
  // Pending input may stay enabled to retain keystrokes. Without an accepted
  // picture it has no authorized target and must not modify canonical source.
  await failedPreview.getByRole("textbox", { name: "编辑消息正文", exact: true }).focus();
  await page.keyboard.insertText(captured);
  await expectCopyableCanvasRecovery(page, captured);
  expect(await invokeMmtE2E(page, "workspace", "canonicalText", "story.mmt")).toBe(original);
  const unsent = "Keep this unsent draft while the real preview is failed.";
  await surface.getByRole("textbox", { name: "新消息正文", exact: true }).fill(unsent);

  await selectAuthoringMode(page, "layout");
  await expect.poll(() => invokeMmtE2E(page, "preview", "readiness", sourceUri)).toMatchObject({
    stage: "failed", buildStatus: "failed", runtimeRecoveryState: "ready", fixtureActive: false, panelOpen: true,
  });
  expect((await exactExportFixture(page, { action: "state" })).availability).toBe("failed");
  await selectAuthoringMode(page, "chat");
  await expect(surface.getByRole("textbox", { name: "新消息正文", exact: true })).toHaveValue(unsent);
  expect(await invokeMmtE2E(page, "workspace", "canonicalText", "story.mmt")).toBe(original);
  await expect(surface.getByLabel("未提交文字恢复", { exact: true })).toContainText("未提交文字已保留");

  await selectAuthoringMode(page, "source");
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", "story.mmt")).toMatchObject({
    sourceVisible: true, guiVisible: false, textDocumentCount: 1, modelCount: 1,
  });
  const editor = page.locator(".workbench-editor .monaco-editor").first();
  await editor.click();
  await page.keyboard.press("Control+End");
  const sourceEdit = "\n// Source recovery remains editable with a failed preview.\n";
  await page.evaluate((text) => navigator.clipboard.writeText(text), sourceEdit);
  await page.keyboard.press("Control+v");
  await expect.poll(() => invokeMmtE2E(page, "workspace", "canonicalText", "story.mmt")).toBe(original + sourceEdit);
  await page.keyboard.press("Control+z");
  await expect.poll(() => invokeMmtE2E(page, "workspace", "canonicalText", "story.mmt")).toBe(original);
  await page.keyboard.press("Control+Shift+p");
  const command = page.locator(".quick-input-widget input").first();
  await expect(command).toBeVisible();
  await command.fill(">打开 GUI 创作");
  await page.keyboard.press("Enter");
  await expect(surface.getByRole("button", { name: "切换模式 · 当前为聊天创作", exact: true })).toBeEnabled();
  await expect.poll(() => invokeMmtE2E(page, "preview", "readiness", sourceUri)).toMatchObject({
    stage: "failed", runtimeRecoveryState: "ready", fixtureActive: false, panelOpen: true,
  });
  await expect(surface.getByRole("textbox", { name: "新消息正文", exact: true })).toHaveValue(unsent);
  await expectCopyableCanvasRecovery(page, captured);

  // Recovery is a reachable product action, not an injected ready artifact or
  // replacement startup fixture. The new work must send through Rust and render.
  await surface.getByRole("button", { name: "story · 作品菜单", exact: true }).click();
  await surface.getByRole("dialog", { name: "作品菜单", exact: true })
    .getByRole("button", { name: "新建作品", exact: true }).click();
  const prompt = page.locator(".quick-input-widget");
  await expect(prompt).toContainText("输入作品名");
  await prompt.locator("input").first().fill("Recovered work");
  await prompt.locator("input").first().press("Enter");
  await expect(prompt).toBeHidden();
  const recoveredName = "Recovered work.mmt";
  const recoveredUri = "mmtfs://workspace/Recovered%20work.mmt";
  await expect(surface.getByRole("button", { name: "Recovered work · 作品菜单", exact: true })).toBeVisible();
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", recoveredName)).toMatchObject({
    guiVisible: true, sourceVisible: false, textDocumentCount: 1, modelCount: 1,
  });
  await expect(surface.getByRole("heading", { name: "开始第一段对话", exact: true })).toBeVisible();
  await surface.getByRole("textbox", { name: "新消息正文", exact: true }).fill("A new work still uses the live language service.");
  await surface.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => invokeMmtE2E(page, "workspace", "canonicalText", recoveredName))
    .toContain("A new work still uses the live language service.");
  await waitForPreviewFrame(page, recoveredUri);
  await expect.poll(() => invokeMmtE2E(page, "preview", "readiness", recoveredUri)).toMatchObject({
    stage: "ready", buildStatus: "ready", runtimeRecoveryState: "ready", fixtureActive: false,
  });
  expect(await invokeMmtE2E(page, "workspace", "canonicalText", "story.mmt")).toBe(original);
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  await assertLiveLanguageWorkers(page, 1, "recovery after the actual preview compile failure");
});

test("repeated Vite HMR and unload sequences evict retained runtime generations", async ({ page }) => {
  await installWorkerLifecycleObserver(page);
  await routeStartupResources(page);

  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  await expect.poll(async () => (
    (await lifecycleState(page)).events.some((event) => event.kind === "runtime-ready")
  ), { message: "the initial runtime must reach the production ready registration path" }).toBe(true);
  const initialState = await lifecycleState(page);
  expect(initialState.documentGeneration, "cold startup must not reload the document while discovering runtime dependencies").toBe(1);
  let generation = initialState.generation;
  let documentGeneration = initialState.documentGeneration;
  await assertLiveLanguageWorkers(page, generation, "initial runtime");

  const transitions = ["hmr", "hmr", "unload", "unload"] as const;
  for (const [index, transition] of transitions.entries()) {
    const oldGeneration = generation;
    // Exercise the native fixture explicitly; ordinary startup now opens chat.
    await invokeMmtE2E(page, "workspace", "showDocument", "intro.typ");
    const installed = await exactExportFixture(page, { action: "install", marker: `${transition}-${index}` });
    expect(installed.availability).toBe("ready");
    expect(installed.phase).toBe("idle");
    expect(installed.displayedRenderKey).toBeTruthy();
    const retainedRenderKey = installed.displayedRenderKey!;
    expect(await exactExportArtifactRetained(page, retainedRenderKey)).toBe(true);

    const oldWorkers = page.workers().filter((worker) => /(?:browserWorker|tinymistWorker)/i.test(worker.url()));
    expect(oldWorkers, `runtime ${oldGeneration} must own exactly two live language Workers`).toHaveLength(2);
    const oldWorkersClosed = oldWorkers.map((worker) => new Promise<void>((resolve) => worker.once("close", () => resolve())));

    if (transition === "unload" && index === 2) {
      await page.evaluate(() => localStorage.removeItem("momoscript.active-workspace-document.v1"));
    }
    if (transition === "hmr") await reloadMainThroughVite(page);
    else await page.reload();
    generation += 1;
    documentGeneration += 1;
    await waitForRuntimeGeneration(page, generation);
    await Promise.all(oldWorkersClosed);
    await assertLiveLanguageWorkers(page, generation, `runtime ${generation} after ${transition} transition ${index + 1}`);

    const state = await lifecycleState(page);
    expect(state.documentGeneration, `${transition} transition ${index + 1} must create exactly one document`).toBe(documentGeneration);
    const oldEvents = state.events.filter((event) => event.generation === oldGeneration);
    if (transition === "hmr") {
      expect(oldEvents.filter((event) => event.kind === "hmr"), "Vite must invoke exactly one production HMR callback").toHaveLength(1);
      expect(oldEvents.filter((event) => event.kind === "unload"), "HMR must not invoke beforeunload").toHaveLength(0);
      expect(
        oldEvents.some((event) => event.kind === "dispose-complete")
          || oldEvents.some((event) => event.kind === "hmr-fallback"),
        "HMR must complete graceful disposal or invoke its bounded termination fallback"
      ).toBe(true);
      expect(
        oldEvents.filter((event) => event.kind === "retained-artifacts-cleared"),
        "HMR disposal must clear the old generation's retained preview artifact store"
      ).toHaveLength(1);
    } else {
      expect(oldEvents.filter((event) => event.kind === "hmr"), "explicit reload must not invoke HMR disposal").toHaveLength(0);
      expect(oldEvents.filter((event) => event.kind === "unload"), "beforeunload must run exactly once").toHaveLength(1);
      const unloadSequence = oldEvents.find((event) => event.kind === "unload")!.sequence;
      for (const event of oldEvents.filter((candidate) =>
        candidate.kind === "worker-terminate"
        && (candidate.workerKind === "mmt" || candidate.workerKind === "tinymist")
      )) {
        expect(event.sequence, `${event.workerKind} terminate() must follow beforeunload`).toBeGreaterThan(unloadSequence);
      }
    }
    expect(
      languageKinds(oldEvents.filter((event) => event.kind === "worker-terminate")),
      `${transition} must terminate both old real language Workers`
    ).toEqual(["mmt", "tinymist"]);

    const replacementExport = await exactExportFixture(page, { action: "state" });
    // Native preview panes may restore their document and request a fresh render.
    // They must never revive the disposed generation's fixture artifact.
    expect(replacementExport.displayedRenderKey).not.toBe(retainedRenderKey);
    expect(replacementExport.requestedRenderKey).not.toBe(retainedRenderKey);
    expect(replacementExport.completedRenderKey).toBeUndefined();
    expect(
      await exactExportArtifactRetained(page, retainedRenderKey),
      `runtime ${generation} must not retain generation ${oldGeneration}'s preview artifact`
    ).toBe(false);
  }

  const finalState = await lifecycleState(page);
  const finalEvents = finalState.events.filter((event) => event.generation === generation);
  expect(finalEvents.filter((event) => event.kind === "runtime-ready"), "the final runtime must initialize exactly once").toHaveLength(1);
  expect(
    languageKinds(finalEvents.filter((event) => event.kind === "worker-construct")),
    "the final runtime must construct fresh MMT and Tinymist Workers"
  ).toEqual(["mmt", "tinymist"]);
  expect(
    languageKinds(finalEvents.filter((event) => event.kind === "worker-terminate")),
    "the live final runtime must not inherit stale language Worker termination state"
  ).toHaveLength(0);
  expect(languageWorkerUrls(page), "only the final generation's two language Workers may remain live").toHaveLength(2);
});

async function expectCopyableCanvasRecovery(page: Page, text: string): Promise<void> {
  const surface = page.getByRole("region", { name: "MomoScript GUI 创作" });
  const recovery = surface.getByLabel("未提交文字恢复", { exact: true });
  await expect(recovery).toContainText("未提交文字已保留");
  await expect(recovery.getByRole("button", { name: "确认目标后重试", exact: true })).toBeDisabled();
  await recovery.getByRole("button", { name: "查看 / 复制", exact: true }).click();
  const panel = surface.getByRole("dialog", { name: "未提交文字", exact: true });
  await expect(panel.getByRole("textbox")).toHaveValue(text);
  await expect(panel.getByRole("textbox")).toHaveJSProperty("readOnly", true);
  await panel.getByRole("button", { name: "复制这段文字", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(text);
  await panel.getByRole("button", { name: "返回画布选择目标", exact: true }).click();
  await expect(panel).toBeHidden();
}

async function selectAuthoringMode(page: Page, mode: "chat" | "layout" | "source"): Promise<void> {
  const surface = page.getByRole("region", { name: "MomoScript GUI 创作" });
  const labels = { chat: "聊天创作", layout: "排版预览", source: "源码" } as const;
  await surface.getByRole("button", { name: /^切换模式 · /u }).click();
  const dialog = surface.getByRole("dialog", { name: "切换模式", exact: true });
  await dialog.getByRole("button", { name: new RegExp(`^${labels[mode]}(?:\\s|$)`, "u") }).click();
  if (mode !== "source") {
    await expect(surface.getByRole("button", { name: `切换模式 · 当前为${labels[mode]}`, exact: true })).toBeEnabled();
  }
}

async function installWorkerLifecycleObserver(page: Page): Promise<void> {
  await page.addInitScript((storageKey) => {
    if (window !== window.top || Reflect.get(globalThis, "__mmtWorkerLifecycleInstalled")) return;
    Reflect.set(globalThis, "__mmtWorkerLifecycleInstalled", true);
    const previous = (() => {
      try {
        return JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as LifecycleState | null;
      } catch {
        return null;
      }
    })();
    const state: LifecycleState = {
      documentGeneration: (previous?.documentGeneration ?? 0) + 1,
      generation: previous?.generation ?? 0,
      nextWorkerId: previous?.nextWorkerId ?? 1,
      sequence: previous?.sequence ?? 0,
      events: previous?.events ?? []
    };
    const persist = () => sessionStorage.setItem(storageKey, JSON.stringify(state));
    const append = (event: Omit<LifecycleEvent, "generation" | "sequence">, generation = state.generation) => {
      state.sequence += 1;
      state.events.push({ generation, sequence: state.sequence, ...event });
      persist();
    };
    persist();
    Reflect.set(globalThis, "__mmtBeginLifecycleGeneration", () => {
      state.generation += 1;
      persist();
      return state.generation;
    });
    Reflect.set(globalThis, "__mmtRecordLifecycle", (kind: string, generation: number) => append({ kind }, generation));

    const NativeWorker = window.Worker;
    const identities = new WeakMap<Worker, { generation: number; workerId: number; workerKind: LanguageWorkerKind | "other"; terminated: boolean }>();
    class ObservedWorker extends NativeWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        const generation = state.generation;
        const workerId = state.nextWorkerId++;
        const url = String(scriptURL);
        const workerKind = options?.name === "Tinymist LS"
          ? "tinymist"
          : (/browserWorker/i.test(url) ? "mmt" : "other");
        identities.set(this, { generation, workerId, workerKind, terminated: false });
        append({
          kind: "worker-construct",
          workerId,
          workerKind,
          url,
          name: options?.name ?? ""
        }, generation);
      }

      override terminate(): void {
        const identity = identities.get(this);
        if (identity && !identity.terminated) {
          identity.terminated = true;
          append({ kind: "worker-terminate", workerId: identity.workerId, workerKind: identity.workerKind }, identity.generation);
        }
        super.terminate();
      }
    }
    Object.defineProperty(window, "Worker", {
      configurable: true,
      writable: true,
      value: ObservedWorker
    });
  }, LIFECYCLE_STORAGE_KEY);
}

async function routeStartupResources(page: Page): Promise<void> {
  await page.route("https://**/*", async (route) => {
    const url = route.request().url();
    if (url === MANIFEST_URL) {
      await route.fulfill({
        status: 200,
        body: manifest,
        headers: {
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
          "content-type": "application/json"
        }
      });
      return;
    }
    await route.abort("blockedbyclient");
  });
}

async function waitForRuntimeGeneration(page: Page, generation: number): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  await expect.poll(async () => {
    try {
      const state = await lifecycleState(page);
      return state.generation === generation
        && state.events.some((event) => event.generation === generation && event.kind === "runtime-ready");
    } catch (error) {
      if (error instanceof Error && /Execution context was destroyed|navigation/i.test(error.message)) return false;
      throw error;
    }
  }, { message: `runtime generation ${generation} must reach the production ready registration path` }).toBe(true);
}

async function assertLiveLanguageWorkers(page: Page, generation: number, phase: string): Promise<void> {
  await expect.poll(async () => {
    const state = await lifecycleState(page);
    const events = state.events.filter((event) => event.generation === generation);
    const constructed = languageKinds(events.filter((event) => event.kind === "worker-construct"));
    const terminated = languageKinds(events.filter((event) => event.kind === "worker-terminate"));
    return { constructed, terminated, liveWorkerCount: languageWorkerUrls(page).length };
  }, { message: `${phase} must have live real MMT and Tinymist Worker instances` }).toEqual({
    constructed: ["mmt", "tinymist"],
    terminated: [],
    liveWorkerCount: 2
  });
}

async function reloadMainThroughVite(page: Page): Promise<void> {
  const response = await page.request.post(`${new URL(page.url()).origin}/__mmt_e2e/reload-main`);
  expect(response.status(), `Vite E2E HMR endpoint failed: ${await response.text()}`).toBe(204);
}

async function exactExportFixture(
  page: Page,
  request: ExactExportFixtureRequest
): Promise<ExactExportFixtureState> {
  return await invokeMmtE2E(page, "exactExport", "fixture", request) as ExactExportFixtureState;
}

async function exactExportArtifactRetained(page: Page, renderKey: string): Promise<boolean> {
  return await invokeMmtE2E(page, "exactExport", "fixture", { action: "has-artifact", renderKey }) as boolean;
}


async function lifecycleState(page: Page): Promise<LifecycleState> {
  return page.evaluate((storageKey) => {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) throw new Error("missing Worker lifecycle evidence");
    return JSON.parse(raw) as LifecycleState;
  }, LIFECYCLE_STORAGE_KEY);
}


function languageKinds(events: LifecycleEvent[]): LanguageWorkerKind[] {
  return [...new Set(events.flatMap((event) => (
    event.workerKind === "mmt" || event.workerKind === "tinymist" ? [event.workerKind] : []
  )))].sort();
}

function languageWorkerUrls(page: Page): string[] {
  return page.workers().map((worker) => worker.url()).filter((url) => /(?:browserWorker|tinymistWorker)/i.test(url)).sort();
}
