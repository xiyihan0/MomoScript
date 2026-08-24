export interface PwaUpdateLifecycleOptions {
  readonly serviceWorkerUrl?: string;
  readonly prepareForReload: () => Promise<void>;
  readonly promptForReload: (latestBuildVersion: string | undefined) => Promise<boolean>;
  readonly reload?: () => void;
  readonly report: (message: string, error?: unknown) => void;
}

export type PwaUpdateCheckResult = "updateFound" | "upToDate" | "unavailable" | "failed";

export interface PwaUpdateLifecycle {
  checkForUpdate(): Promise<PwaUpdateCheckResult>;
  dispose(): void;
}

const BUILD_VERSION_PATTERN = /^\d{12}-[0-9a-f]{7}$/;

function readWaitingBuildVersion(worker: ServiceWorker, timeoutMs = 2_000): Promise<string | undefined> {
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  const channel = new MessageChannel();
  let timer: number | undefined;
  let settled = false;
  const finish = (version: string | undefined) => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) window.clearTimeout(timer);
    channel.port1.close();
    resolve(version);
  };
  channel.port1.onmessage = (event: MessageEvent<unknown>) => {
    const data = event.data;
    const version = data && typeof data === "object"
      ? Reflect.get(data, "version")
      : undefined;
    finish(typeof version === "string" && BUILD_VERSION_PATTERN.test(version) ? version : undefined);
  };
  timer = window.setTimeout(() => finish(undefined), timeoutMs);
  try {
    worker.postMessage({ type: "GET_BUILD_VERSION" }, [channel.port2]);
  } catch {
    finish(undefined);
  }
  return promise;
}

/**
 * Owns registration and explicit activation for the production service worker.
 * A waiting worker never activates over live editor state until the user accepts
 * and the durable safe-restart boundary has completed.
 */
export function registerPwaUpdateLifecycle(
  options: PwaUpdateLifecycleOptions
): PwaUpdateLifecycle {
  if (!("serviceWorker" in navigator)) {
    return {
      async checkForUpdate() {
        return "unavailable";
      },
      dispose() {},
    };
  }

  let disposed = false;
  let registration: ServiceWorkerRegistration | undefined;
  let installing: ServiceWorker | undefined;
  let activating = false;
  let activationTimer: number | undefined;
  let registrationFailed = false;
  const prompted = new WeakSet<ServiceWorker>();

  const reportFailure = (message: string, error: unknown) => {
    if (!disposed) options.report(message, error);
  };
  const activate = async (worker: ServiceWorker) => {
    if (disposed || activating || worker.state !== "installed") return;
    prompted.add(worker);
    try {
      const latestBuildVersion = await readWaitingBuildVersion(worker);
      if (disposed) return;
      if (!(await options.promptForReload(latestBuildVersion)) || disposed) return;
      activating = true;
      await options.prepareForReload();
      if (disposed) return;
      const waiting = registration?.waiting;
      if (!waiting || waiting !== worker) {
        throw new Error("The prepared service worker update is no longer waiting");
      }
      waiting.postMessage({ type: "SKIP_WAITING" });
      activationTimer = window.setTimeout(() => {
        activationTimer = undefined;
        if (disposed || !activating) return;
        options.report("Service worker activation timed out; reloading the safely quiesced editor");
        (options.reload ?? (() => window.location.reload()))();
      }, 15_000);
    } catch (error) {
      activating = false;
      if (activationTimer !== undefined) window.clearTimeout(activationTimer);
      activationTimer = undefined;
      prompted.delete(worker);
      reportFailure("MomoScript update could not reach a safe reload boundary", error);
    }
  };
  const offer = (worker: ServiceWorker | null | undefined) => {
    if (!worker || !navigator.serviceWorker.controller || prompted.has(worker)) return;
    if (worker.state === "installed") void activate(worker);
  };
  const onInstallingStateChange = () => offer(installing);
  const bindInstalling = (worker: ServiceWorker | null | undefined) => {
    if (!worker || worker === installing) return;
    installing?.removeEventListener("statechange", onInstallingStateChange);
    installing = worker;
    installing.addEventListener("statechange", onInstallingStateChange);
    offer(installing);
  };
  const onUpdateFound = () => bindInstalling(registration?.installing);
  const onControllerChange = () => {
    if (!activating || disposed) return;
    activating = false;
    if (activationTimer !== undefined) window.clearTimeout(activationTimer);
    activationTimer = undefined;
    (options.reload ?? (() => window.location.reload()))();
  };
  const checkForUpdate = async (): Promise<PwaUpdateCheckResult> => {
    if (disposed) return "unavailable";
    const current = registration ?? await registrationReady;
    if (disposed) return "unavailable";
    if (!current) return registrationFailed ? "failed" : "unavailable";
    try {
      const updated = await current.update();
      if (disposed) return "unavailable";
      registration = updated;
      bindInstalling(updated.installing);
      offer(updated.waiting);
      return updated.waiting || updated.installing ? "updateFound" : "upToDate";
    } catch (error) {
      reportFailure("MomoScript update check failed", error);
      return "failed";
    }
  };
  const checkForUpdateInBackground = () => {
    void checkForUpdate();
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") checkForUpdateInBackground();
  };

  navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
  window.addEventListener("online", checkForUpdateInBackground);
  document.addEventListener("visibilitychange", onVisibilityChange);
  const registrationReady = navigator.serviceWorker.register(
    options.serviceWorkerUrl ?? "/sw.js",
    { scope: "/" },
  ).then((value) => {
    if (disposed) return;
    registration = value;
    registration.addEventListener("updatefound", onUpdateFound);
    bindInstalling(registration.installing);
    offer(registration.waiting);
    return value;
  }).catch((error: unknown) => {
    registrationFailed = true;
    reportFailure("MomoScript offline support could not be installed", error);
    return undefined;
  });

  return {
    checkForUpdate,
    dispose() {
      if (disposed) return;
      disposed = true;
      installing?.removeEventListener("statechange", onInstallingStateChange);
      registration?.removeEventListener("updatefound", onUpdateFound);
      if (activationTimer !== undefined) window.clearTimeout(activationTimer);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      window.removeEventListener("online", checkForUpdateInBackground);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };
}
