import * as vscode from "vscode";
import {
  galleryAvatarUrl,
  galleryDisplayLabel,
  GalleryImageCache,
  type GalleryEntity,
  type GalleryPack,
  type GalleryStickerSet,
  type GalleryVariant
} from "./galleryPack";

const ENTITY_PAGE_SIZE = 48;
const ZOOM_STORAGE_KEY = "mmt-gallery-zoom";
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.1;

export interface CharacterGalleryViewOptions {
  readonly getPacks: () => readonly GalleryPack[];
  readonly onDidChangePacks: (listener: () => void) => vscode.Disposable;
}

let pendingEntityKey: string | undefined;
const galleryRevealed = new vscode.EventEmitter<string>();

export function registerCharacterGalleryCommands(getPacks: () => readonly GalleryPack[]): vscode.Disposable {
  const subscriptions: vscode.Disposable[] = [];
  subscriptions.push(vscode.commands.registerCommand("mmt.gallery.insertSticker", async (entityName?: string, ordinal?: number, setId?: string) => {
    if (typeof entityName !== "string" || typeof ordinal !== "number") return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "mmtfs" || editor.document.languageId !== "mmt") {
      void vscode.window.showWarningMessage("请先打开一个 MMT 文档，再插入人物差分");
      return;
    }
    const selector = typeof setId === "string" && setId.length > 0 ? `${setId}/#${ordinal}` : `#${ordinal}`;
    const text = `[:${entityName},${selector}:]`;
    await editor.edit((edit) => {
      for (const selection of editor.selections) {
        if (selection.isEmpty) edit.insert(selection.active, text);
        else edit.replace(selection, text);
      }
    });
    await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
  }));
  subscriptions.push(vscode.commands.registerCommand("mmt.gallery.insertStickerAtCursor", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "mmtfs" || editor.document.languageId !== "mmt") {
      void vscode.window.showWarningMessage("请先打开一个 MMT 文档，再插入人物差分");
      return;
    }
    const entityKey = resolveSpeakerEntityKey(editor.document, editor.selection.active, getPacks());
    pendingEntityKey = entityKey ?? "";
    galleryRevealed.fire(pendingEntityKey);
    await vscode.commands.executeCommand("momoscript.characterGallery.focus");
  }));
  return { dispose: () => vscode.Disposable.from(...subscriptions).dispose() };
}

const MESSAGE_SPEAKER_PATTERN = /^\s*[<>]\s*([^\s:<>][^:<>]*?)\s*[:：]/;
const ACTOR_PRESET_PATTERN = /@actor\s+([^\s]+)[\s\S]*?preset:\s*[^\s:]+::([^\s]+)[\s\S]*?@end/g;

function resolveSpeakerEntityKey(
  document: vscode.TextDocument,
  position: vscode.Position,
  packs: readonly GalleryPack[]
): string | undefined {
  const speaker = MESSAGE_SPEAKER_PATTERN.exec(document.lineAt(position.line).text)?.[1]?.trim();
  if (!speaker) return undefined;
  const direct = findEntityKey(packs, (entity) => entity.key === speaker || entity.names.includes(speaker));
  if (direct) return direct;
  const text = document.getText();
  ACTOR_PRESET_PATTERN.lastIndex = 0;
  for (let match = ACTOR_PRESET_PATTERN.exec(text); match; match = ACTOR_PRESET_PATTERN.exec(text)) {
    if (match[1] === speaker) {
      const resolved = findEntityKey(packs, (entity) => entity.key === match[2]);
      if (resolved) return resolved;
    }
  }
  return undefined;
}

function findEntityKey(packs: readonly GalleryPack[], predicate: (entity: GalleryEntity) => boolean): string | undefined {
  for (const pack of packs) {
    const entity = pack.entities.find(predicate);
    if (entity) return entity.key;
  }
  return undefined;
}

export function renderCharacterGalleryView(container: HTMLElement, options: CharacterGalleryViewOptions): vscode.Disposable {
  container.classList.add("mms-gallery-root");
  let zoom = normalizeZoom(Number(globalThis.localStorage?.getItem(ZOOM_STORAGE_KEY)) || 1);
  const applyZoom = () => container.style.setProperty("--mms-gallery-zoom", String(zoom));
  applyZoom();
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    zoom = normalizeZoom(zoom + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
    applyZoom();
    try {
      globalThis.localStorage?.setItem(ZOOM_STORAGE_KEY, String(zoom));
    } catch {
      // 存储不可用时缩放仅保留在会话内
    }
  };
  container.addEventListener("wheel", onWheel, { passive: false });
  const search = document.createElement("input");
  search.className = "mms-gallery-search";
  search.type = "search";
  search.placeholder = "搜索人物…";
  search.setAttribute("aria-label", "搜索人物");
  const body = document.createElement("div");
  body.className = "mms-gallery-body";
  container.append(search, body);

  const images = new GalleryImageCache();
  const disposables: vscode.Disposable[] = [];
  let disposed = false;
  let generation = 0;
  let abortDetail: AbortController | undefined;
  let observer: IntersectionObserver | undefined;
  let selectedEntity: { readonly pack: GalleryPack; readonly entity: GalleryEntity } | undefined;
  let selectedSetKey: string | undefined;

  const abortOngoing = () => {
    abortDetail?.abort();
    abortDetail = undefined;
    observer?.disconnect();
    observer = undefined;
  };

  const allEntities = (): Array<{ pack: GalleryPack; entity: GalleryEntity }> => {
    const filter = search.value.trim().toLowerCase();
    const output: Array<{ pack: GalleryPack; entity: GalleryEntity }> = [];
    for (const pack of options.getPacks()) {
      for (const entity of pack.entities) {
        if (filter && !entity.names.some((name) => name.toLowerCase().includes(filter)) && !entity.displayName.toLowerCase().includes(filter)) continue;
        output.push({ pack, entity });
      }
    }
    return output;
  };

  const renderEntityList = () => {
    if (pendingEntityKey !== undefined && options.getPacks().length > 0) {
      const target = pendingEntityKey;
      pendingEntityKey = undefined;
      revealTarget(target);
      return;
    }
    const current = ++generation;
    abortOngoing();
    body.replaceChildren();
    const packs = options.getPacks();
    if (packs.length === 0) {
      body.append(message("尚未加载资源包。请先在 MomoScript 项目视图中配置资源包清单地址。"));
      return;
    }
    const entities = allEntities();
    if (entities.length === 0) {
      body.append(message(search.value.trim() ? "没有匹配的人物" : "资源包中没有可浏览的人物"));
      return;
    }
    const grid = document.createElement("div");
    grid.className = "mms-gallery-grid";
    grid.setAttribute("role", "list");
    body.append(grid);
    let rendered = 0;
    const renderPage = () => {
      if (disposed || current !== generation) return;
      const slice = entities.slice(rendered, rendered + ENTITY_PAGE_SIZE);
      for (const entry of slice) grid.append(entityTile(entry.pack, entry.entity));
      rendered += slice.length;
      sentinel.remove();
      if (rendered < entities.length) grid.append(sentinel);
    };
    const sentinel = document.createElement("div");
    sentinel.className = "mms-gallery-sentinel";
    observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) renderPage();
    }, { root: body });
    observer.observe(sentinel);
    renderPage();
  };

  const entityTile = (pack: GalleryPack, entity: GalleryEntity): HTMLElement => {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "mms-gallery-tile";
    tile.setAttribute("role", "listitem");
    tile.title = entity.names.join(" / ");
    const image = document.createElement("img");
    image.className = "mms-gallery-avatar";
    image.loading = "lazy";
    image.alt = "";
    const avatarUrl = (() => {
      try {
        return galleryAvatarUrl(pack, entity)?.href;
      } catch {
        return undefined;
      }
    })();
    if (avatarUrl) image.src = avatarUrl;
    else {
      image.hidden = true;
      const fallback = document.createElement("span");
      fallback.className = "mms-gallery-avatar-fallback";
      fallback.textContent = galleryDisplayLabel(entity).slice(0, 1);
      tile.append(fallback);
    }
    image.addEventListener("error", () => {
      image.hidden = true;
      if (!tile.querySelector(".mms-gallery-avatar-fallback")) {
        const fallback = document.createElement("span");
        fallback.className = "mms-gallery-avatar-fallback";
        fallback.textContent = galleryDisplayLabel(entity).slice(0, 1);
        tile.prepend(fallback);
      }
    }, { once: true });
    const name = document.createElement("span");
    name.className = "mms-gallery-name";
    name.textContent = galleryDisplayLabel(entity);
    tile.append(image, name);
    tile.addEventListener("click", () => {
      selectedEntity = { pack, entity };
      selectedSetKey = undefined;
      renderDetail();
    });
    return tile;
  };

  const revealTarget = (target: string) => {
    if (target !== "") {
      for (const pack of options.getPacks()) {
        const entity = pack.entities.find((candidate) => candidate.key === target);
        if (entity) {
          selectedEntity = { pack, entity };
          selectedSetKey = undefined;
          renderDetail();
          return;
        }
      }
    }
    selectedEntity = undefined;
    renderEntityList();
  };

  const renderDetail = () => {
    const current = ++generation;
    abortOngoing();
    body.replaceChildren();
    if (!selectedEntity) return;
    const { pack, entity } = selectedEntity;
    const controller = new AbortController();
    abortDetail = controller;

    const header = document.createElement("div");
    header.className = "mms-gallery-detail-header";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "mms-gallery-back";
    back.textContent = "‹ 返回";
    back.addEventListener("click", () => {
      selectedEntity = undefined;
      renderEntityList();
    });
    const title = document.createElement("span");
    title.className = "mms-gallery-detail-title";
    title.textContent = galleryDisplayLabel(entity);
    header.append(back, title);

    if (entity.stickerSets.length === 0) {
      body.append(header, message("该人物没有差分资源"));
      return;
    }
    if (selectedSetKey === undefined || !entity.stickerSets.some((set) => set.key === selectedSetKey)) {
      selectedSetKey = entity.stickerSets[0]!.key;
    }
    let setSelector: HTMLSelectElement | undefined;
    if (entity.stickerSets.length > 1) {
      setSelector = document.createElement("select");
      setSelector.className = "mms-gallery-set";
      setSelector.setAttribute("aria-label", "差分套组");
      for (const set of entity.stickerSets) {
        const option = new Option(set.displayName, set.key, false, set.key === selectedSetKey);
        setSelector.append(option);
      }
      setSelector.addEventListener("change", () => {
        selectedSetKey = setSelector!.value;
        renderDetail();
      });
      header.append(setSelector);
    }
    const grid = document.createElement("div");
    grid.className = "mms-gallery-grid mms-gallery-variants";
    grid.setAttribute("role", "list");
    body.append(header, grid);

    const set = entity.stickerSets.find((candidate) => candidate.key === selectedSetKey)!;
    for (const variant of set.variants) {
      grid.append(variantTile(pack, entity, set, variant, controller.signal, () => current === generation));
    }
  };

  const variantTile = (
    pack: GalleryPack,
    entity: GalleryEntity,
    set: GalleryStickerSet,
    variant: GalleryVariant,
    signal: AbortSignal,
    isCurrent: () => boolean
  ): HTMLElement => {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "mms-gallery-tile mms-gallery-variant";
    tile.setAttribute("role", "listitem");
    const setId = set.key === entity.stickerDefault ? undefined : set.key;
    tile.title = `插入 [:${entity.key},${setId ? `${setId}/` : ""}#${variant.ordinal}:]`;
    const frame = document.createElement("span");
    frame.className = "mms-gallery-frame";
    frame.textContent = "…";
    const ordinal = document.createElement("span");
    ordinal.className = "mms-gallery-ordinal";
    ordinal.textContent = `#${variant.ordinal}`;
    tile.append(frame, ordinal);

    const load = () => {
      frame.textContent = "…";
      void images.thumbnail(pack, entity, set, variant, signal).then((url) => {
        if (!isCurrent() || signal.aborted) return;
        frame.replaceChildren();
        const image = document.createElement("img");
        image.className = "mms-gallery-thumb";
        image.alt = `${galleryDisplayLabel(entity)} #${variant.ordinal}`;
        image.src = url;
        frame.append(image);
      }).catch((error: unknown) => {
        if (!isCurrent() || signal.aborted) return;
        frame.textContent = "加载失败，点击重试";
        tile.classList.add("mms-gallery-failed");
        tile.addEventListener("click", (event) => {
          event.stopPropagation();
          tile.classList.remove("mms-gallery-failed");
          load();
        }, { once: true });
        void error;
      });
    };
    load();
    tile.addEventListener("click", () => {
      void vscode.commands.executeCommand("mmt.gallery.insertSticker", entity.key, variant.ordinal, setId);
    });
    return tile;
  };

  search.addEventListener("input", () => {
    if (selectedEntity) {
      selectedEntity = undefined;
    }
    renderEntityList();
  });
  disposables.push(galleryRevealed.event((target) => {
    if (pendingEntityKey !== undefined) pendingEntityKey = undefined;
    revealTarget(target);
  }));
  disposables.push(options.onDidChangePacks(() => {
    if (selectedEntity) {
      const stillExists = options.getPacks().some((pack) => pack.namespace === selectedEntity!.pack.namespace
        && pack.entities.some((entity) => entity.key === selectedEntity!.entity.key));
      if (!stillExists) selectedEntity = undefined;
    }
    if (selectedEntity) renderDetail();
    else renderEntityList();
  }));

  renderEntityList();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      container.removeEventListener("wheel", onWheel);
      abortOngoing();
      images.dispose();
      for (const disposable of disposables) disposable.dispose();
    }
  };
}

function normalizeZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value)) * 10) / 10;
}

function message(text: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "mms-gallery-message";
  element.textContent = text;
  return element;
}
