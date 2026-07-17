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

test("Vite HMR and production unload close their real language Workers", async ({ page }) => {
  await installWorkerLifecycleObserver(page);
  await routeStartupResources(page);

  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  await expect.poll(async () => (
    (await lifecycleState(page)).events.some((event) => event.kind === "runtime-ready")
  ), { message: "the initial runtime must reach the production ready registration path" }).toBe(true);
  const initialState = await lifecycleState(page);
  const initialGeneration = initialState.generation;
  const initialDocumentGeneration = initialState.documentGeneration;
  const replacementGeneration = initialGeneration + 1;
  const reloadGeneration = initialGeneration + 2;
  await assertLiveLanguageWorkers(page, initialGeneration, "initial runtime");

  const firstGenerationWorkers = page.workers().filter((worker) => /(?:browserWorker|tinymistWorker)/i.test(worker.url()));
  expect(firstGenerationWorkers, "the initial runtime must own real MMT and Tinymist browser Workers").toHaveLength(2);
  const firstGenerationClosed = firstGenerationWorkers.map((worker) => new Promise<void>((resolve) => worker.once("close", resolve)));

  await reloadMainThroughVite(page);
  await waitForRuntimeGeneration(page, replacementGeneration);
  await assertLiveLanguageWorkers(page, replacementGeneration, "runtime recreated after serialized Vite HMR disposal");
  await Promise.all(firstGenerationClosed);
  expect(
    (await lifecycleState(page)).documentGeneration,
    "Vite HMR must reload only after disposing the old runtime"
  ).toBe(initialDocumentGeneration + 1);

  let state = await lifecycleState(page);
  const firstEvents = state.events.filter((event) => event.generation === initialGeneration);
  expect(firstEvents.filter((event) => event.kind === "hmr"), "Vite must invoke the production callback registered with import.meta.hot.dispose").toHaveLength(1);
  expect(
    firstEvents.some((event) => event.kind === "dispose-complete")
      || firstEvents.some((event) => event.kind === "hmr-fallback"),
    "the real Vite HMR callback must complete graceful disposal or invoke its termination fallback"
  ).toBe(true);
  expect(
    languageKinds(firstEvents.filter((event) => event.kind === "worker-terminate")),
    "Vite HMR disposal must call terminate() on both old real language Workers"
  ).toEqual(["mmt", "tinymist"]);
  expect(firstEvents.filter((event) => event.kind === "unload"), "HMR must not invoke beforeunload").toHaveLength(0);


  const secondGenerationWorkers = page.workers().filter((worker) => /(?:browserWorker|tinymistWorker)/i.test(worker.url()));
  expect(secondGenerationWorkers, "the HMR replacement must own newly constructed real language Workers").toHaveLength(2);
  const secondGenerationClosed = secondGenerationWorkers.map((worker) => new Promise<void>((resolve) => worker.once("close", resolve)));

  await page.reload();
  await waitForRuntimeGeneration(page, reloadGeneration);
  expect(
    (await lifecycleState(page)).documentGeneration,
    "the explicit page reload must create exactly one additional document"
  ).toBe(initialDocumentGeneration + 2);
  await assertLiveLanguageWorkers(page, reloadGeneration, "runtime recreated after beforeunload");
  await Promise.all(secondGenerationClosed);

  state = await lifecycleState(page);
  const refreshedFirstEvents = state.events.filter((event) => event.generation === initialGeneration);
  expect(
    refreshedFirstEvents.filter((event) => event.kind === "unload"),
    "HMR disposal must remove the old generation's owned beforeunload listener"
  ).toHaveLength(0);
  const secondEvents = state.events.filter((event) => event.generation === replacementGeneration);
  expect(
    secondEvents.filter((event) => event.kind === "unload"),
    "the production beforeunload registration must invoke exactly once for the live old generation"
  ).toHaveLength(1);
  expect(
    languageKinds(secondEvents.filter((event) => event.kind === "worker-terminate")),
    "beforeunload must explicitly call terminate() on both old real language Workers before navigation"
  ).toEqual(["mmt", "tinymist"]);
  const unloadSequence = secondEvents.find((event) => event.kind === "unload")?.sequence ?? Number.MAX_SAFE_INTEGER;
  for (const event of secondEvents.filter((candidate) => candidate.kind === "worker-terminate")) {
    expect(event.sequence, `${event.workerKind} terminate() must be requested by the beforeunload invocation`).toBeGreaterThan(unloadSequence);
  }

  const thirdEvents = state.events.filter((event) => event.generation === reloadGeneration);
  expect(thirdEvents.filter((event) => event.kind === "runtime-ready"), "the new generation must initialize exactly once").toHaveLength(1);
  expect(
    languageKinds(thirdEvents.filter((event) => event.kind === "worker-construct")),
    "the new generation must construct fresh MMT and Tinymist Workers"
  ).toEqual(["mmt", "tinymist"]);
  expect(
    thirdEvents.filter((event) => event.kind === "worker-terminate"),
    "the live new generation must not inherit stale termination state"
  ).toHaveLength(0);
  expect(languageWorkerUrls(page), "only the new generation's two language Workers may remain live").toHaveLength(2);
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
