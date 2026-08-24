import assert from "node:assert/strict";
import { registerPwaUpdateLifecycle } from "../src/pwaUpdate.ts";

class FakeWorker extends EventTarget {
  state = "installed";
  messages = [];
  constructor(version = "202608121200-abcdef0") {
    super();
    this.version = version;
  }
  postMessage(message, transfer = []) {
    this.messages.push(message);
    if (message?.type === "GET_BUILD_VERSION") {
      transfer[0]?.postMessage({ type: "BUILD_VERSION", version: this.version });
    }
  }
}
class FakeRegistration extends EventTarget {
  constructor(worker) {
    super();
    this.waiting = worker;
    this.installing = null;
    this.updateCalls = 0;
  }
  update() {
    this.updateCalls += 1;
    return Promise.resolve(this);
  }
}
class FakeServiceWorkerContainer extends EventTarget {
  controller = {};
  constructor(registration) {
    super();
    this.registration = registration;
  }
  register() { return Promise.resolve(this.registration); }
}

const originalNavigator = globalThis.navigator;
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const installEnvironment = (registration) => {
  const serviceWorker = new FakeServiceWorkerContainer(registration);
  Object.defineProperty(globalThis, "navigator", {
    value: { serviceWorker }, configurable: true
  });
  Object.defineProperty(globalThis, "window", {
    value: new EventTarget(), configurable: true
  });
  globalThis.window.setTimeout = setTimeout;
  globalThis.window.clearTimeout = clearTimeout;
  globalThis.window.location = { reload() {} };
  const documentTarget = new EventTarget();
  documentTarget.visibilityState = "visible";
  Object.defineProperty(globalThis, "document", {
    value: documentTarget, configurable: true
  });
  return serviceWorker;
};

try {
  {
    const worker = new FakeWorker();
    const serviceWorker = installEnvironment(new FakeRegistration(worker));
    let prepared = 0;
    const lifecycle = registerPwaUpdateLifecycle({
      prepareForReload: async () => { prepared += 1; },
      promptForReload: async (latestBuildVersion) => {
        assert.equal(latestBuildVersion, worker.version);
        return false;
      },
      report() {},
    });
    await flush();
    await flush();
    assert.equal(prepared, 0, "declined updates must not quiesce the editor");
    assert.deepEqual(worker.messages, [{ type: "GET_BUILD_VERSION" }], "declined updates must remain waiting");
    lifecycle.dispose();
    assert.equal(serviceWorker.listenerCount, undefined);
  }

  {
    const worker = new FakeWorker();
    const registration = new FakeRegistration(worker);
    const serviceWorker = installEnvironment(registration);
    const prepared = Promise.withResolvers();
    let prepareCalls = 0;
    let reloads = 0;
    const lifecycle = registerPwaUpdateLifecycle({
      prepareForReload: async () => {
        prepareCalls += 1;
        await prepared.promise;
      },
      promptForReload: async (latestBuildVersion) => {
        assert.equal(latestBuildVersion, worker.version);
        return true;
      },
      reload: () => { reloads += 1; },
      report(message, error) { if (error) throw error; assert.ok(message); },
    });
    await flush();
    await flush();
    assert.equal(prepareCalls, 1);
    assert.deepEqual(worker.messages, [{ type: "GET_BUILD_VERSION" }], "waiting worker activated before durable quiescence");
    prepared.resolve();
    await flush();
    assert.deepEqual(worker.messages, [{ type: "GET_BUILD_VERSION" }, { type: "SKIP_WAITING" }]);
    serviceWorker.dispatchEvent(new Event("controllerchange"));
    assert.equal(reloads, 1, "accepted update did not reload after controller activation");
    lifecycle.dispose();
  }

  {
    const registration = new FakeRegistration(null);
    installEnvironment(registration);
    const lifecycle = registerPwaUpdateLifecycle({
      prepareForReload: async () => {},
      promptForReload: async () => false,
      report() {},
    });
    assert.equal(await lifecycle.checkForUpdate(), "upToDate");
    assert.equal(registration.updateCalls, 1, "manual checks must call the live Service Worker registration");
    lifecycle.dispose();
    assert.equal(await lifecycle.checkForUpdate(), "unavailable", "disposed lifecycle must not check again");
  }

  {
    const worker = new FakeWorker();
    installEnvironment(new FakeRegistration(worker));
    const reports = [];
    const lifecycle = registerPwaUpdateLifecycle({
      prepareForReload: async () => {},
      promptForReload: async () => { throw new Error("prompt unavailable"); },
      report(message, error) { reports.push({ message, error }); },
    });
    await flush();
    await flush();
    assert.equal(reports.length, 1, "prompt rejection was not contained and reported");
    assert.match(String(reports[0].error), /prompt unavailable/);
    lifecycle.dispose();
  }
} finally {
  Object.defineProperty(globalThis, "navigator", { value: originalNavigator, configurable: true });
  Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true });
  Object.defineProperty(globalThis, "document", { value: originalDocument, configurable: true });
}

console.log(JSON.stringify({ declinedUpdateWaits: true, safeActivationOrdering: true, controllerReload: true, manualCheck: true, promptFailureContained: true }));
