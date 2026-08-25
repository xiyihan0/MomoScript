import type { ComposerAvatarChoice, ComposerAvatarCurrent } from "./composerEdit.ts";
import type { AvatarCatalogItem } from "./galleryPack.ts";

export type AvatarPickerCurrentStatus = "available" | "custom" | "none" | "unavailable";

export interface AvatarPickerActorGroup {
  readonly entityId: string;
  readonly label: string;
  readonly items: readonly AvatarCatalogItem[];
}

export interface AvatarPickerSnapshot {
  readonly query: string;
  readonly busy: boolean;
  readonly current: ComposerAvatarCurrent | null;
  readonly currentStatus: AvatarPickerCurrentStatus;
  readonly currentActorItems: readonly AvatarCatalogItem[];
  readonly otherActors: readonly AvatarPickerActorGroup[];
  readonly currentActorLabel: string;
}

export interface AvatarPickerController {
  snapshot(): AvatarPickerSnapshot;
  setQuery(query: string): void;
  subscribe(listener: (snapshot: AvatarPickerSnapshot) => void): () => void;
  select(item: AvatarCatalogItem): Promise<boolean>;
  dispose(): void;
}

export interface CreateAvatarPickerControllerOptions {
  readonly actorPresetId: string;
  readonly actorLabel: string;
  readonly current: ComposerAvatarCurrent | null;
  readonly items: readonly AvatarCatalogItem[];
  readonly choose: (choice: ComposerAvatarChoice) => void | Promise<void>;
}

export function createAvatarPickerController(
  options: CreateAvatarPickerControllerOptions,
): AvatarPickerController {
  const catalog = [...options.items];
  const listeners = new Set<(snapshot: AvatarPickerSnapshot) => void>();
  let query = "";
  let busy = false;
  let attempted = false;
  let disposed = false;

  const buildSnapshot = (): AvatarPickerSnapshot => {
    const currentActorItems = catalog.filter((item) => item.variant.entityId === options.actorPresetId);
    const groups = groupOtherActors(catalog, options.actorPresetId, query);
    const currentItem = options.current?.kind === "packAvatar"
      ? catalog.find((item) => avatarItemMatchesCurrent(item, options.current))
      : undefined;
    const currentStatus: AvatarPickerCurrentStatus = options.current === null
      ? "none"
      : options.current.kind === "asset"
        ? "custom"
        : currentItem?.selectable === true
          ? "available"
          : "unavailable";
    return {
      query,
      busy,
      current: options.current,
      currentStatus,
      currentActorItems,
      currentActorLabel: options.actorLabel,
      otherActors: groups,
    };
  };

  const emit = (): void => {
    if (disposed) return;
    const snapshot = buildSnapshot();
    for (const listener of listeners) listener(snapshot);
  };

  return {
    snapshot: buildSnapshot,
    setQuery(nextQuery): void {
      if (disposed || attempted || nextQuery === query) return;
      query = nextQuery;
      emit();
    },
    subscribe(listener): () => void {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async select(item): Promise<boolean> {
      if (
        disposed
        || attempted
        || busy
        || !catalog.includes(item)
        || !item.selectable
        || avatarItemMatchesCurrent(item, options.current)
      ) {
        return false;
      }
      attempted = true;
      busy = true;
      emit();
      try {
        await options.choose({
          kind: "packAvatar",
          entityId: item.variant.entityId,
          contributionNamespace: item.variant.contributionNamespace,
          variantId: item.variant.variantId,
        });
      } finally {
        busy = false;
        emit();
      }
      return true;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      listeners.clear();
    },
  };
}

export function avatarItemMatchesCurrent(
  item: AvatarCatalogItem,
  current: ComposerAvatarCurrent | null,
): boolean {
  return current?.kind === "packAvatar"
    && item.variant.entityId === current.entityId
    && item.variant.contributionNamespace === current.contributionNamespace
    && item.variant.variantId === current.variantId;
}

function groupOtherActors(
  items: readonly AvatarCatalogItem[],
  actorPresetId: string,
  query: string,
): readonly AvatarPickerActorGroup[] {
  const normalizedQuery = normalizeSearch(query);
  const groups = new Map<string, AvatarCatalogItem[]>();
  for (const item of items) {
    if (item.variant.entityId === actorPresetId) continue;
    const group = groups.get(item.variant.entityId) ?? [];
    group.push(item);
    groups.set(item.variant.entityId, group);
  }
  const output: AvatarPickerActorGroup[] = [];
  for (const [entityId, group] of groups) {
    const label = group[0]?.variant.entityDisplayName ?? entityId;
    const entityMatches = matchesSearch([entityId, label], normalizedQuery);
    const filtered = normalizedQuery.length === 0 || entityMatches
      ? group
      : group.filter((item) => matchesSearch(item.searchTerms, normalizedQuery));
    if (filtered.length === 0) continue;
    output.push({ entityId, label, items: filtered });
  }
  return output;
}

function matchesSearch(values: readonly string[], query: string): boolean {
  return query.length === 0 || values.some((value) => normalizeSearch(value).includes(query));
}

function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase("zh-Hans-CN");
}
