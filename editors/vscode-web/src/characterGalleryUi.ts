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
import { showMomoScriptMessage } from "./notifications";

const ENTITY_PAGE_SIZE = 48;
const ZOOM_STORAGE_KEY = "mmt-gallery-zoom";
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.1;

export interface CharacterGalleryViewOptions {
  readonly getPacks: () => readonly GalleryPack[];
  readonly onDidChangePacks: (listener: () => void) => vscode.Disposable;
}

interface SelectedEntityId {
  readonly namespace: string;
  readonly entityKey: string;
}

interface GalleryEntry {
  readonly pack: GalleryPack;
  readonly entity: GalleryEntity;
}

interface InsertionTarget {
  readonly enabled: boolean;
  readonly label: string;
}

let pendingEntityKey: string | undefined;
const galleryRevealed = new vscode.EventEmitter<string>();

export function registerCharacterGalleryCommands(getPacks: () => readonly GalleryPack[]): vscode.Disposable {
  const subscriptions: vscode.Disposable[] = [];
  subscriptions.push(vscode.commands.registerCommand("mmt.gallery.insertSticker", async (entityName?: string, ordinal?: number, setId?: string) => {
    if (typeof entityName !== "string" || typeof ordinal !== "number") return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "mmtfs" || editor.document.languageId !== "mmt") {
      void showMomoScriptMessage("warning", "请先打开一个 MMT 文档，再插入人物差分");
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
      void showMomoScriptMessage("warning", "请先打开一个 MMT 文档，再插入人物差分");
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
  const controls = document.createElement("div");
  controls.className = "mms-gallery-controls";
  const search = document.createElement("input");
  search.className = "mms-gallery-search";
  search.type = "search";
  search.placeholder = "搜索姓名或多语言别名…";
  search.setAttribute("aria-label", "搜索姓名或多语言别名");
  const filterDetails = document.createElement("details");
  filterDetails.className = "mms-gallery-filter-disclosure";
  const filterSummary = document.createElement("summary");
  filterSummary.textContent = "筛选";
  const filterBar = document.createElement("div");
  filterBar.className = "mms-gallery-filters";
  filterDetails.append(filterSummary, filterBar);
  const listSummary = document.createElement("div");
  listSummary.className = "mms-gallery-list-summary";
  const zoomControls = document.createElement("div");
  zoomControls.className = "mms-gallery-zoom-controls";
  const zoomOut = iconButton("−", "缩小图鉴");
  const zoomValue = document.createElement("output");
  zoomValue.className = "mms-gallery-zoom-value";
  zoomValue.setAttribute("aria-live", "polite");
  const zoomIn = iconButton("+", "放大图鉴");
  zoomControls.append(zoomOut, zoomValue, zoomIn);
  const controlFooter = document.createElement("div");
  controlFooter.className = "mms-gallery-control-footer";
  controlFooter.append(listSummary, zoomControls);
  controls.append(search, filterDetails, controlFooter);
  const body = document.createElement("div");
  body.className = "mms-gallery-body";
  container.append(controls, body);

  let zoom = readStoredZoom();
  const applyZoom = () => {
    container.style.setProperty("--mms-gallery-zoom", String(zoom));
    zoomValue.value = `${Math.round(zoom * 100)}%`;
    zoomValue.textContent = zoomValue.value;
    zoomOut.disabled = zoom <= ZOOM_MIN;
    zoomIn.disabled = zoom >= ZOOM_MAX;
  };
  const setZoom = (value: number) => {
    zoom = normalizeZoom(value);
    applyZoom();
    try {
      globalThis.localStorage?.setItem(ZOOM_STORAGE_KEY, String(zoom));
    } catch {
      // 存储不可用时缩放仅保留在会话内
    }
  };
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    setZoom(zoom + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
  };
  const onZoomOut = () => setZoom(zoom - ZOOM_STEP);
  const onZoomIn = () => setZoom(zoom + ZOOM_STEP);
  container.addEventListener("wheel", onWheel, { passive: false });
  zoomOut.addEventListener("click", onZoomOut);
  zoomIn.addEventListener("click", onZoomIn);
  applyZoom();

  const images = new GalleryImageCache();
  const disposables: vscode.Disposable[] = [];
  const variantButtons = new Set<HTMLButtonElement>();
  let disposed = false;
  let generation = 0;
  let abortDetail: AbortController | undefined;
  let observer: IntersectionObserver | undefined;
  let selectedEntityId: SelectedEntityId | undefined;
  let selectedSetKey: string | undefined;
  let selectedPack = "";
  let selectedSchool = "";
  let selectedRelation = "";
  let selectedForm = "";
  let selectedVariantCount = "";
  let insertionStatus: HTMLElement | undefined;

  const abortOngoing = () => {
    abortDetail?.abort();
    abortDetail = undefined;
    observer?.disconnect();
    observer = undefined;
    variantButtons.clear();
  };

  const insertionTarget = (): InsertionTarget => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "mmtfs" || editor.document.languageId !== "mmt") {
      return { enabled: false, label: "仅浏览：请先打开 MMT 文档" };
    }
    const path = vscode.workspace.asRelativePath(editor.document.uri, false);
    const position = editor.selection.active;
    return {
      enabled: true,
      label: `插入到 ${path} · ${position.line + 1}:${position.character + 1}`
    };
  };

  const refreshInsertionState = () => {
    const target = insertionTarget();
    if (insertionStatus) {
      insertionStatus.textContent = target.label;
      insertionStatus.classList.toggle("mms-gallery-insertion-disabled", !target.enabled);
    }
    for (const button of variantButtons) {
      button.disabled = !target.enabled;
      button.title = target.enabled
        ? button.dataset.selectorTitle ?? "插入差分"
        : "请先打开一个 MMT 文档，再插入人物差分";
    }
  };

  const visiblePacks = (): readonly GalleryPack[] => {
    const packs = options.getPacks();
    return selectedPack ? packs.filter((pack) => pack.namespace === selectedPack) : packs;
  };

  const allEntities = (): GalleryEntry[] => {
    const query = normalizeSearchText(search.value);
    const output: GalleryEntry[] = [];
    for (const pack of visiblePacks()) {
      for (const entity of pack.entities) {
        if (selectedForm === "base" && isAlternateEntity(entity)) continue;
        if (selectedForm === "alternate" && !isAlternateEntity(entity)) continue;
        if (!matchesVariantCount(entity.totalVariants, selectedVariantCount)) continue;
        if (selectedSchool && taxonomyFilterValue(pack, entity.school?.id) !== selectedSchool) continue;
        if (selectedRelation) {
          const relationValues = [entity.mainRelation, ...entity.relations]
            .map((term) => taxonomyFilterValue(pack, term?.id));
          if (!relationValues.includes(selectedRelation)) continue;
        }
        if (query && !entity.searchTerms.some((term) => normalizeSearchText(term).includes(query))) continue;
        output.push({ pack, entity });
      }
    }
    return output;
  };

  const renderFilterBar = (packs: readonly GalleryPack[]) => {
    if (selectedPack && !packs.some((pack) => pack.namespace === selectedPack)) selectedPack = "";
    filterBar.replaceChildren();

    const formSelect = selectControl("角色形态筛选", "全部形态", [
      { value: "base", label: "基础角色" },
      { value: "alternate", label: "换装角色" }
    ], selectedForm);
    formSelect.addEventListener("change", () => {
      selectedForm = formSelect.value;
      renderEntityList();
    });
    const variantSelect = selectControl("差分数量筛选", "全部差分", [
      { value: "none", label: "无差分" },
      { value: "few", label: "1–9 个" },
      { value: "many", label: "10–29 个" },
      { value: "large", label: "30 个以上" }
    ], selectedVariantCount);
    variantSelect.addEventListener("change", () => {
      selectedVariantCount = variantSelect.value;
      renderEntityList();
    });
    filterBar.append(formSelect, variantSelect);

    if (packs.length > 1) {
      const packSelect = selectControl("资源包筛选", "全部资源包", packs.map((pack) => ({
        value: pack.namespace,
        label: pack.name
      })), selectedPack);
      packSelect.addEventListener("change", () => {
        selectedPack = packSelect.value;
        selectedSchool = "";
        selectedRelation = "";
        renderEntityList();
      });
      filterBar.append(packSelect);
    } else if (packs.length === 1) {
      selectedPack = "";
    }

    const scopedPacks = visiblePacks();
    const schools = taxonomyOptions(scopedPacks, "school");
    if (schools.length > 0) {
      if (!schools.some((option) => option.value === selectedSchool)) selectedSchool = "";
      const schoolSelect = selectControl("学校筛选", "全部学校", schools, selectedSchool);
      schoolSelect.addEventListener("change", () => {
        selectedSchool = schoolSelect.value;
        renderEntityList();
      });
      filterBar.append(schoolSelect);
    } else {
      selectedSchool = "";
    }

    const relations = taxonomyOptions(scopedPacks, "relation");
    if (relations.length > 0) {
      if (!relations.some((option) => option.value === selectedRelation)) selectedRelation = "";
      const relationSelect = selectControl("关系筛选", "全部关系", relations, selectedRelation);
      relationSelect.addEventListener("change", () => {
        selectedRelation = relationSelect.value;
        renderEntityList();
      });
      filterBar.append(relationSelect);
    } else {
      selectedRelation = "";
    }

    const activeFilters = [selectedPack, selectedSchool, selectedRelation, selectedForm, selectedVariantCount]
      .filter(Boolean).length;
    filterSummary.textContent = activeFilters > 0 ? `筛选 · ${activeFilters}` : "筛选";
    if (search.value || activeFilters > 0) {
      const clear = iconButton("清除筛选", "清除角色图鉴筛选");
      clear.className = "mms-gallery-clear-filters";
      clear.addEventListener("click", () => {
        search.value = "";
        selectedPack = "";
        selectedSchool = "";
        selectedRelation = "";
        selectedForm = "";
        selectedVariantCount = "";
        renderEntityList();
      });
      filterBar.append(clear);
    }
  };

  const showListControls = (packs: readonly GalleryPack[], count: number) => {
    search.hidden = false;
    filterDetails.hidden = packs.length === 0;
    listSummary.hidden = false;
    renderFilterBar(packs);
    listSummary.textContent = `${count} 个角色`;
  };

  const showDetailControls = () => {
    search.hidden = true;
    filterDetails.hidden = true;
    listSummary.hidden = true;
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
    insertionStatus = undefined;
    body.replaceChildren();
    const packs = options.getPacks();
    renderFilterBar(packs);
    const entities = allEntities();
    showListControls(packs, entities.length);
    if (packs.length === 0) {
      const empty = message("尚未加载资源包。请配置资源包清单地址。");
      const configure = document.createElement("button");
      configure.type = "button";
      configure.className = "mms-gallery-primary-action";
      configure.textContent = "配置资源包";
      configure.addEventListener("click", () => {
        void vscode.commands.executeCommand("workbench.action.openSettings", "mmt.resourcePacks.manifestUrls");
      });
      empty.append(configure);
      body.append(empty);
      return;
    }
    if (entities.length === 0) {
      body.append(message(search.value.trim() || selectedSchool || selectedRelation ? "没有匹配的人物" : "资源包中没有可浏览的人物"));
      appendProvenance(body, visiblePacks());
      return;
    }

    const list = document.createElement("ul");
    list.className = "mms-gallery-entity-list";
    body.append(list);
    let rendered = 0;
    const sentinel = document.createElement("li");
    sentinel.className = "mms-gallery-sentinel";
    sentinel.setAttribute("aria-hidden", "true");
    const renderPage = () => {
      if (disposed || current !== generation) return;
      const slice = entities.slice(rendered, rendered + ENTITY_PAGE_SIZE);
      for (const entry of slice) list.append(entityRow(entry.pack, entry.entity));
      rendered += slice.length;
      sentinel.remove();
      if (rendered < entities.length) list.append(sentinel);
    };
    observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) renderPage();
    }, { root: body });
    observer.observe(sentinel);
    renderPage();
    appendProvenance(body, visiblePacks());
  };

  const entityRow = (pack: GalleryPack, entity: GalleryEntity): HTMLLIElement => {
    const item = document.createElement("li");
    item.className = "mms-gallery-entity-item";
    const row = document.createElement("button");
    row.type = "button";
    row.className = "mms-gallery-entity-row";
    const label = galleryDisplayLabel(entity);
    row.title = entity.searchTerms.join(" / ");
    row.setAttribute("aria-label", entityAriaLabel(entity));

    const media = document.createElement("span");
    media.className = "mms-gallery-entity-media";
    const avatarUrl = safeAvatarUrl(pack, entity);
    if (avatarUrl) {
      const image = document.createElement("img");
      image.className = "mms-gallery-avatar";
      image.loading = "lazy";
      image.alt = `${label} 头像`;
      image.src = avatarUrl;
      image.addEventListener("error", () => {
        image.replaceWith(avatarFallback(label));
      }, { once: true });
      media.append(image);
    } else {
      media.append(avatarFallback(label));
    }

    const text = document.createElement("span");
    text.className = "mms-gallery-entity-text";
    const name = document.createElement("span");
    name.className = "mms-gallery-name";
    name.textContent = label;
    const affiliation = [entity.school?.displayName, entity.mainRelation?.displayName].filter(Boolean).join(" · ");
    const metadataText = affiliation || (options.getPacks().length > 1 ? pack.name : "");
    const count = document.createElement("span");
    count.className = "mms-gallery-variant-count";
    count.textContent = entityVariantSummary(entity);
    text.append(name);
    if (metadataText) {
      const metadata = document.createElement("span");
      metadata.className = "mms-gallery-entity-metadata";
      metadata.textContent = metadataText;
      text.append(metadata);
    }
    text.append(count);
    row.append(media, text);
    row.addEventListener("click", () => {
      selectedEntityId = { namespace: pack.namespace, entityKey: entity.key };
      selectedSetKey = undefined;
      renderDetail();
    });
    item.append(row);
    return item;
  };

  const revealTarget = (target: string) => {
    if (target !== "") {
      for (const pack of options.getPacks()) {
        if (pack.entities.some((candidate) => candidate.key === target)) {
          selectedEntityId = { namespace: pack.namespace, entityKey: target };
          selectedSetKey = undefined;
          renderDetail();
          return;
        }
      }
    }
    selectedEntityId = undefined;
    renderEntityList();
  };

  const resolveSelectedEntity = (): GalleryEntry | undefined => {
    if (!selectedEntityId) return undefined;
    const pack = options.getPacks().find((candidate) => candidate.namespace === selectedEntityId!.namespace);
    const entity = pack?.entities.find((candidate) => candidate.key === selectedEntityId!.entityKey);
    return pack && entity ? { pack, entity } : undefined;
  };

  const renderDetail = () => {
    const current = ++generation;
    abortOngoing();
    body.replaceChildren();
    showDetailControls();
    const selected = resolveSelectedEntity();
    if (!selected) {
      selectedEntityId = undefined;
      renderEntityList();
      return;
    }
    const { pack, entity } = selected;
    const controller = new AbortController();
    abortDetail = controller;

    const header = document.createElement("section");
    header.className = "mms-gallery-detail-header";
    const headingRow = document.createElement("div");
    headingRow.className = "mms-gallery-detail-heading";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "mms-gallery-back";
    back.textContent = "‹ 返回";
    back.addEventListener("click", () => {
      selectedEntityId = undefined;
      renderEntityList();
    });
    const title = document.createElement("h3");
    title.className = "mms-gallery-detail-title";
    title.textContent = galleryDisplayLabel(entity);
    headingRow.append(back, title);
    header.append(headingRow);

    const affiliation = [entity.school?.displayName, entity.mainRelation?.displayName].filter(Boolean);
    if (affiliation.length > 0) {
      const metadata = document.createElement("div");
      metadata.className = "mms-gallery-detail-metadata";
      metadata.textContent = affiliation.join(" · ");
      header.append(metadata);
    }

    if (entity.alternateSkinKeys.length > 0) {
      const related = document.createElement("div");
      related.className = "mms-gallery-related-skins";
      const relatedLabel = document.createElement("span");
      relatedLabel.textContent = "其他装扮";
      related.append(relatedLabel);
      for (const key of entity.alternateSkinKeys) {
        const target = pack.entities.find((candidate) => candidate.key === key);
        if (!target) continue;
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = galleryDisplayLabel(target);
        button.addEventListener("click", () => {
          selectedEntityId = { namespace: pack.namespace, entityKey: target.key };
          selectedSetKey = undefined;
          renderDetail();
        });
        related.append(button);
      }
      if (related.childElementCount > 1) header.append(related);
    }

    if (entity.stickerSets.length > 0) {
      if (selectedSetKey === undefined || !entity.stickerSets.some((set) => set.key === selectedSetKey)) {
        selectedSetKey = entity.stickerSets[0]!.key;
      }
      if (entity.stickerSets.length > 1) {
        const setRow = document.createElement("label");
        setRow.className = "mms-gallery-set-row";
        const setLabel = document.createElement("span");
        setLabel.textContent = "差分套组";
        const setSelector = document.createElement("select");
        setSelector.className = "mms-gallery-set";
        setSelector.setAttribute("aria-label", "差分套组");
        for (const set of entity.stickerSets) {
          setSelector.append(new Option(set.displayName, set.key, false, set.key === selectedSetKey));
        }
        setSelector.addEventListener("change", () => {
          selectedSetKey = setSelector.value;
          renderDetail();
        });
        setRow.append(setLabel, setSelector);
        header.append(setRow);
      }
    }

    insertionStatus = document.createElement("div");
    insertionStatus.className = "mms-gallery-insertion-status";
    header.append(insertionStatus);
    body.append(header);

    if (entity.stickerSets.length === 0) {
      body.append(message("该人物没有差分资源"));
      refreshInsertionState();
      appendProvenance(body, [pack]);
      return;
    }

    const grid = document.createElement("ul");
    grid.className = "mms-gallery-variant-grid";
    body.append(grid);
    const set = entity.stickerSets.find((candidate) => candidate.key === selectedSetKey)!;
    for (const variant of set.variants) {
      grid.append(variantCard(pack, entity, set, variant, controller.signal, () => current === generation));
    }
    appendProvenance(body, [pack]);
    refreshInsertionState();
  };

  const variantCard = (
    pack: GalleryPack,
    entity: GalleryEntity,
    set: GalleryStickerSet,
    variant: GalleryVariant,
    signal: AbortSignal,
    isCurrent: () => boolean
  ): HTMLLIElement => {
    const item = document.createElement("li");
    item.className = "mms-gallery-variant-item";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mms-gallery-variant";
    const setId = set.key === entity.stickerDefault ? undefined : set.key;
    const selectorTitle = `插入 [:${entity.key},${setId ? `${setId}/` : ""}#${variant.ordinal}:]`;
    button.dataset.selectorTitle = selectorTitle;
    button.setAttribute("aria-label", `${galleryDisplayLabel(entity)} 差分 #${variant.ordinal}`);
    const frame = document.createElement("span");
    frame.className = "mms-gallery-frame";
    frame.textContent = "加载中…";
    const ordinal = document.createElement("span");
    ordinal.className = "mms-gallery-ordinal";
    ordinal.textContent = `#${variant.ordinal}`;
    button.append(frame, ordinal);
    variantButtons.add(button);

    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "mms-gallery-retry";
    retry.textContent = "重试加载";
    retry.hidden = true;
    const load = () => {
      retry.hidden = true;
      item.classList.remove("mms-gallery-failed");
      frame.textContent = "加载中…";
      void images.thumbnail(pack, entity, set, variant, signal).then((url) => {
        if (!isCurrent() || signal.aborted) return;
        const image = document.createElement("img");
        image.className = "mms-gallery-thumb";
        image.alt = `${galleryDisplayLabel(entity)} #${variant.ordinal}`;
        image.src = url;
        frame.replaceChildren(image);
      }).catch(() => {
        if (!isCurrent() || signal.aborted) return;
        frame.textContent = "加载失败";
        item.classList.add("mms-gallery-failed");
        retry.hidden = false;
      });
    };
    retry.addEventListener("click", load);
    load();
    button.addEventListener("click", () => {
      void vscode.commands.executeCommand("mmt.gallery.insertSticker", entity.key, variant.ordinal, setId);
    });
    item.append(button, retry);
    return item;
  };

  const onSearch = () => {
    selectedEntityId = undefined;
    renderEntityList();
  };
  search.addEventListener("input", onSearch);
  disposables.push(galleryRevealed.event((target) => {
    if (pendingEntityKey !== undefined) pendingEntityKey = undefined;
    revealTarget(target);
  }));
  disposables.push(options.onDidChangePacks(() => {
    if (selectedEntityId && !resolveSelectedEntity()) selectedEntityId = undefined;
    if (selectedEntityId) renderDetail();
    else renderEntityList();
  }));
  disposables.push(vscode.window.onDidChangeActiveTextEditor(refreshInsertionState));
  disposables.push(vscode.window.onDidChangeTextEditorSelection(refreshInsertionState));

  renderEntityList();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      container.removeEventListener("wheel", onWheel);
      zoomOut.removeEventListener("click", onZoomOut);
      zoomIn.removeEventListener("click", onZoomIn);
      search.removeEventListener("input", onSearch);
      abortOngoing();
      images.dispose();
      for (const disposable of disposables) disposable.dispose();
    }
  };
}

function taxonomyOptions(
  packs: readonly GalleryPack[],
  kind: "school" | "relation"
): Array<{ readonly value: string; readonly label: string }> {
  const multiple = packs.length > 1;
  const output: Array<{ value: string; label: string }> = [];
  for (const pack of packs) {
    const terms = kind === "school" ? pack.schools : pack.relations;
    for (const term of terms) {
      output.push({
        value: taxonomyFilterValue(pack, term.id),
        label: multiple ? `${term.displayName} · ${pack.namespace}` : term.displayName
      });
    }
  }
  return output.sort((left, right) => left.label.localeCompare(right.label, "zh-Hans-CN"));
}

function taxonomyFilterValue(pack: GalleryPack, id: string | undefined): string {
  return id === undefined ? "" : `${pack.namespace}:${id}`;
}

function selectControl(
  ariaLabel: string,
  allLabel: string,
  options: readonly { readonly value: string; readonly label: string }[],
  selected: string
): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "mms-gallery-filter";
  select.setAttribute("aria-label", ariaLabel);
  select.append(new Option(allLabel, "", false, selected === ""));
  for (const option of options) {
    select.append(new Option(option.label, option.value, false, option.value === selected));
  }
  return select;
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function isAlternateEntity(entity: GalleryEntity): boolean {
  return [entity.key, ...entity.names].some((name) => (
    /_[^_]+$/.test(name) || /[（(][^）)]+[）)]$/.test(name)
  ));
}

function matchesVariantCount(total: number, filter: string): boolean {
  if (filter === "none") return total === 0;
  if (filter === "few") return total >= 1 && total <= 9;
  if (filter === "many") return total >= 10 && total <= 29;
  if (filter === "large") return total >= 30;
  return true;
}

function appendProvenance(container: HTMLElement, packs: readonly GalleryPack[]): void {
  const sources = packs.filter((pack) => pack.provenance !== undefined);
  if (sources.length === 0) return;
  const details = document.createElement("details");
  details.className = "mms-gallery-provenance";
  const summary = document.createElement("summary");
  summary.textContent = "数据来源";
  details.append(summary);
  for (const pack of sources) {
    const provenance = pack.provenance!;
    const row = document.createElement("div");
    row.className = "mms-gallery-provenance-row";
    const text = document.createElement("span");
    text.textContent = `${pack.namespace} · ${provenance.sourceName} · ${provenance.licenseId} · ${provenance.retrievedAt.slice(0, 10)}`;
    row.append(text);
    if (provenance.sourceUrl) row.append(externalButton("来源", provenance.sourceUrl));
    if (provenance.licenseUrl) row.append(externalButton("许可", provenance.licenseUrl));
    details.append(row);
  }
  container.append(details);
}

function externalButton(label: string, href: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mms-gallery-link";
  button.textContent = label;
  button.addEventListener("click", () => {
    void vscode.env.openExternal(vscode.Uri.parse(href, true));
  });
  return button;
}

function entityAriaLabel(entity: GalleryEntity): string {
  const metadata = [entity.school?.displayName, entity.mainRelation?.displayName].filter(Boolean).join("，");
  return [galleryDisplayLabel(entity), metadata, entityVariantSummary(entity)].filter(Boolean).join("，");
}

function entityVariantSummary(entity: GalleryEntity): string {
  const variants = `${entity.totalVariants} 个差分`;
  return entity.stickerSets.length > 1
    ? `${variants} · ${entity.stickerSets.length} 个套组`
    : variants;
}

function safeAvatarUrl(pack: GalleryPack, entity: GalleryEntity): string | undefined {
  try {
    return galleryAvatarUrl(pack, entity)?.href;
  } catch {
    return undefined;
  }
}

function avatarFallback(label: string): HTMLSpanElement {
  const fallback = document.createElement("span");
  fallback.className = "mms-gallery-avatar-fallback";
  fallback.textContent = label.slice(0, 1);
  fallback.setAttribute("aria-hidden", "true");
  return fallback;
}

function iconButton(text: string, ariaLabel: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.setAttribute("aria-label", ariaLabel);
  return button;
}

function readStoredZoom(): number {
  try {
    return normalizeZoom(Number(globalThis.localStorage?.getItem(ZOOM_STORAGE_KEY)) || 1);
  } catch {
    return 1;
  }
}

function normalizeZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value)) * 10) / 10;
}

function message(text: string): HTMLDivElement {
  const element = document.createElement("div");
  element.className = "mms-gallery-message";
  const content = document.createElement("span");
  content.textContent = text;
  element.append(content);
  return element;
}
