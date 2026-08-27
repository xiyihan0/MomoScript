import type { RuntimeArtifactProgress } from "./runtimeArtifactDecoder";

export type StartupStageId = "workbench" | "filesystem" | "tinymist" | "mmt";
export type StartupStageState = "pending" | "active" | "complete" | "failed";

export interface StartupStageSnapshot {
  readonly id: StartupStageId;
  readonly state: StartupStageState;
  readonly detail: string;
  readonly receivedBytes?: number;
  readonly totalBytes?: number;
  readonly percent?: number;
}

export interface StartupProgressSnapshot {
  readonly stages: readonly StartupStageSnapshot[];
  readonly ready: boolean;
  readonly hasFailure: boolean;
}

export type StartupProgressEvent =
  | { readonly kind: "stage"; readonly id: StartupStageId; readonly state: StartupStageState; readonly detail: string }
  | { readonly kind: "tinymist-artifact"; readonly progress: RuntimeArtifactProgress }
  | { readonly kind: "ready" };

export interface StartupProgressController {
  stage(id: StartupStageId, state: StartupStageState, detail: string): void;
  tinymistArtifact(progress: RuntimeArtifactProgress): void;
  ready(): void;
  fatal(error: unknown): void;
}

const STAGE_LABELS: Readonly<Record<StartupStageId, string>> = Object.freeze({
  workbench: "Workbench API",
  filesystem: "文件系统",
  tinymist: "Tinymist 固定 WASM",
  mmt: "MMT 语言服务",
});

const INITIAL_STAGES: readonly StartupStageSnapshot[] = Object.freeze([
  Object.freeze({ id: "workbench", state: "active", detail: "正在载入界面 API" }),
  Object.freeze({ id: "filesystem", state: "pending", detail: "等待初始化" }),
  Object.freeze({ id: "tinymist", state: "pending", detail: "等待下载" }),
  Object.freeze({ id: "mmt", state: "pending", detail: "等待启动" }),
]);

const EXIT_REMOVAL_FALLBACK_MS = 240;

export function createInitialStartupProgress(): StartupProgressSnapshot {
  return Object.freeze({ stages: INITIAL_STAGES, ready: false, hasFailure: false });
}

export function reduceStartupProgress(
  snapshot: StartupProgressSnapshot,
  event: StartupProgressEvent,
): StartupProgressSnapshot {
  if (event.kind === "ready") {
    return Object.freeze({ ...snapshot, ready: true });
  }

  const stages = snapshot.stages.map((stage): StartupStageSnapshot => {
    if (stage.id !== (event.kind === "stage" ? event.id : "tinymist")) return stage;
    if (event.kind === "stage") {
      const quantitative = event.state === "complete"
        ? { receivedBytes: stage.totalBytes, totalBytes: stage.totalBytes, percent: 100 }
        : event.state === "failed"
          ? failureQuantitativeState(stage)
          : {};
      return Object.freeze({ id: stage.id, state: event.state, detail: event.detail, ...quantitative });
    }
    return tinymistArtifactStage(stage, event.progress);
  });
  return Object.freeze({
    stages: Object.freeze(stages),
    ready: snapshot.ready,
    hasFailure: stages.some((stage) => stage.state === "failed"),
  });
}

function tinymistArtifactStage(
  stage: StartupStageSnapshot,
  progress: RuntimeArtifactProgress,
): StartupStageSnapshot {
  if (progress.phase === "download") {
    const receivedBytes = Math.min(progress.receivedBytes, progress.totalBytes);
    const percent = progress.state === "complete"
      ? 99
      : Math.min(99, Math.floor(receivedBytes / progress.totalBytes * 100));
    const detail = progress.state === "started" ? "正在请求固定资源" : "正在下载固定资源";
    return Object.freeze({
      id: stage.id,
      state: "active",
      detail,
      receivedBytes,
      totalBytes: progress.totalBytes,
      percent,
    });
  }
  if (progress.state === "started") {
    return Object.freeze({
      id: stage.id,
      state: "active",
      detail: "正在校验并解压",
      receivedBytes: progress.encodedBytes,
      totalBytes: progress.encodedBytes,
      percent: 99,
    });
  }
  return Object.freeze({
    id: stage.id,
    state: "complete",
    detail: "已校验并解压",
    receivedBytes: progress.encodedBytes,
    totalBytes: progress.encodedBytes,
    percent: 100,
  });
}

function failureQuantitativeState(stage: StartupStageSnapshot): Pick<StartupStageSnapshot, "receivedBytes" | "totalBytes" | "percent"> {
  if (stage.totalBytes === undefined) return {};
  return {
    receivedBytes: stage.receivedBytes,
    totalBytes: stage.totalBytes,
    percent: Math.min(99, stage.percent ?? 0),
  };
}

export function createStartupProgress(document: Document): StartupProgressController {
  const overlay = document.querySelector<HTMLElement>("#mmt-startup");
  let snapshot = createInitialStartupProgress();
  let lastActive: StartupStageId = "workbench";
  let frame: number | undefined;

  const render = (announce = true): void => {
    if (!overlay) return;
    overlay.dataset.state = snapshot.hasFailure ? "failed" : snapshot.ready ? "ready" : "loading";
    overlay.setAttribute("aria-busy", snapshot.ready || snapshot.hasFailure ? "false" : "true");
    const completed = snapshot.stages.filter((stage) => stage.state === "complete").length;
    const overall = overlay.querySelector<HTMLProgressElement>("[data-mmt-startup-overall]");
    if (overall) overall.value = completed;
    const count = overlay.querySelector<HTMLElement>("[data-mmt-startup-count]");
    if (count) count.textContent = `已完成 ${completed} / ${snapshot.stages.length}`;

    for (const stage of snapshot.stages) renderStage(overlay, stage);
    if (announce) {
      const live = overlay.querySelector<HTMLElement>("[data-mmt-startup-live]");
      const active = snapshot.stages.find((stage) => stage.state === "failed")
        ?? snapshot.stages.find((stage) => stage.state === "active");
      if (live && active) {
        live.textContent = active.state === "failed"
          ? `${STAGE_LABELS[active.id]}启动失败：${active.detail}`
          : `正在准备 ${STAGE_LABELS[active.id]}`;
      }
    }
  };

  const scheduleArtifactRender = (): void => {
    if (!overlay || frame !== undefined) return;
    const view = document.defaultView;
    if (!view) {
      render(false);
      return;
    }
    frame = view.requestAnimationFrame(() => {
      frame = undefined;
      render(false);
    });
  };

  render(false);
  return {
    stage(id, state, detail) {
      if (state === "active") lastActive = id;
      snapshot = reduceStartupProgress(snapshot, {
        kind: "stage",
        id,
        state,
        detail: state === "failed" ? conciseError(detail) : detail,
      });
      render(true);
    },
    tinymistArtifact(progress) {
      lastActive = "tinymist";
      snapshot = reduceStartupProgress(snapshot, { kind: "tinymist-artifact", progress });
      scheduleArtifactRender();
    },
    ready() {
      snapshot = reduceStartupProgress(snapshot, { kind: "ready" });
      render(true);
      if (!overlay || snapshot.hasFailure) return;
      const view = document.defaultView;
      const remove = () => overlay.remove();
      if (!view || view.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        remove();
        return;
      }
      overlay.classList.add("mmt-startup-leaving");
      overlay.addEventListener("transitionend", remove, { once: true });
      view.setTimeout(remove, EXIT_REMOVAL_FALLBACK_MS);
    },
    fatal(error) {
      const detail = conciseError(error);
      snapshot = reduceStartupProgress(snapshot, {
        kind: "stage",
        id: lastActive,
        state: "failed",
        detail,
      });
      render(true);
    },
  };
}

function renderStage(overlay: HTMLElement, stage: StartupStageSnapshot): void {
  const row = overlay.querySelector<HTMLElement>(`[data-mmt-startup-stage="${stage.id}"]`);
  if (!row) return;
  row.dataset.state = stage.state;
  const detail = row.querySelector<HTMLElement>("[data-mmt-startup-detail]");
  if (detail) detail.textContent = stage.detail;
  const progress = row.querySelector<HTMLProgressElement>("[data-mmt-startup-resource-progress]");
  const bytes = row.querySelector<HTMLElement>("[data-mmt-startup-bytes]");
  if (progress) {
    if (stage.percent === undefined) {
      progress.removeAttribute("value");
      progress.hidden = stage.id !== "tinymist" || stage.state === "pending";
    } else {
      progress.value = stage.percent;
      progress.hidden = false;
    }
  }
  if (bytes) {
    bytes.textContent = stage.receivedBytes === undefined || stage.totalBytes === undefined
      ? ""
      : `${formatBytes(stage.receivedBytes)} / ${formatBytes(stage.totalBytes)}`;
  }
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MiB`;
}

function conciseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 160 ? `${message.slice(0, 157)}…` : message;
}
