import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const LIFECYCLE_STORAGE_KEY = "mmt-e2e-worker-lifecycle-v1";
const PACK_ROOT = "https://mms-pack.xiyihan.cn/ba_kivo/";
const MANIFEST_URL = `${PACK_ROOT}manifest.json`;
const TINYMIST_WASM_URL = "https://mms-pack.xiyihan.cn/wasm/tinymist/0.15.2/d9b946a8aa1425eeda71e6fcb603fb85ce30cd79b2a676a5d557971f202af454/tinymist_bg.wasm?delivery=zstd-v1";
const TINYMIST_WASM_FALLBACK_URL = TINYMIST_WASM_URL.replace("?delivery=zstd-v1", "");
const manifest = await readFile(new URL("./fixtures/manifest.json", import.meta.url));
const tinymistWasm = await readFile(new URL("../../vscode/vendor/tinymist-0.15.2/tinymist_bg.wasm", import.meta.url));

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

test("repeated Vite HMR and unload sequences evict retained runtime generations", async ({ page }) => {
  await installWorkerLifecycleObserver(page);
  await routeStartupResources(page);

  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  await expect.poll(async () => (
    (await lifecycleState(page)).events.some((event) => event.kind === "runtime-ready")
  ), { message: "the initial runtime must reach the production ready registration path" }).toBe(true);
  const initialState = await lifecycleState(page);
  let generation = initialState.generation;
  let documentGeneration = initialState.documentGeneration;
  await assertLiveLanguageWorkers(page, generation, "initial runtime");

  const transitions = ["hmr", "hmr", "unload", "unload"] as const;
  for (const [index, transition] of transitions.entries()) {
    const oldGeneration = generation;
    const installed = await exactExportFixture(page, { action: "install", marker: `${transition}-${index}` });
    expect(installed.availability).toBe("ready");
    expect(installed.phase).toBe("idle");
    expect(installed.displayedRenderKey).toBeTruthy();
    const retainedRenderKey = installed.displayedRenderKey!;
    expect(await exactExportArtifactRetained(page, retainedRenderKey)).toBe(true);

    const oldWorkers = page.workers().filter((worker) => /(?:browserWorker|tinymistWorker)/i.test(worker.url()));
    expect(oldWorkers, `runtime ${oldGeneration} must own exactly two live language Workers`).toHaveLength(2);
    const oldWorkersClosed = oldWorkers.map((worker) => new Promise<void>((resolve) => worker.once("close", resolve)));

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
      for (const event of oldEvents.filter((candidate) => candidate.kind === "worker-terminate")) {
        expect(event.sequence, `${event.workerKind} terminate() must follow beforeunload`).toBeGreaterThan(unloadSequence);
      }
    }
    expect(
      languageKinds(oldEvents.filter((event) => event.kind === "worker-terminate")),
      `${transition} must terminate both old real language Workers`
    ).toEqual(["mmt", "tinymist"]);

    const replacementExport = await exactExportFixture(page, { action: "state" });
    expect(replacementExport).toMatchObject({
      availability: "no-document",
      phase: "idle"
    });
    expect(replacementExport.displayedRenderKey).toBeUndefined();
    expect(replacementExport.requestedRenderKey).toBeUndefined();
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
  expect(finalEvents.filter((event) => event.kind === "worker-terminate"), "the live final runtime must not inherit stale termination state").toHaveLength(0);
  expect(languageWorkerUrls(page), "only the final generation's two language Workers may remain live").toHaveLength(2);
});

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
    if (url === TINYMIST_WASM_URL) {
      await route.abort("connectionfailed");
      return;
    }
    if (url === TINYMIST_WASM_FALLBACK_URL) {
      await route.fulfill({
        status: 200,
        body: tinymistWasm,
        headers: {
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
          "content-type": "application/wasm"
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
  return await page.evaluate(async (value) => {
    const fixture = Reflect.get(globalThis, "__mmtExactExportFixture");
    if (typeof fixture !== "function") throw new Error("exact export fixture is unavailable");
    return await fixture(value) as ExactExportFixtureState;
  }, request);
}

async function exactExportArtifactRetained(page: Page, renderKey: string): Promise<boolean> {
  return await page.evaluate(async (key) => {
    const fixture = Reflect.get(globalThis, "__mmtExactExportFixture");
    if (typeof fixture !== "function") throw new Error("exact export fixture is unavailable");
    return await fixture({ action: "has-artifact", renderKey: key }) as boolean;
  }, renderKey);
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
