import type { PackManifestSource } from "../../vscode/src/packSync";
import { decodeAvifSequence, type ImageSequenceResource } from "./avifSequence.ts";
import type {
  GalleryCatalogProvenance,
  GalleryCatalogTaxonomyTerm,
  GalleryEntityCatalog
} from "./galleryEntityCatalog";

export interface GalleryVariant {
  readonly id: string;
  readonly ordinal: number;
  readonly frame: number;
}

export interface GalleryStickerSet {
  readonly key: string;
  readonly displayName: string;
  readonly storageKey: string;
  readonly variants: readonly GalleryVariant[];
}

export interface GalleryEntity {
  readonly key: string;
  readonly displayName: string;
  readonly names: readonly string[];
  readonly catalogDisplayName?: string;
  readonly searchTerms: readonly string[];
  readonly school?: GalleryCatalogTaxonomyTerm;
  readonly mainRelation?: GalleryCatalogTaxonomyTerm;
  readonly relations: readonly GalleryCatalogTaxonomyTerm[];
  readonly alternateSkinKeys: readonly string[];
  readonly totalVariants: number;
  readonly avatar?: { readonly storageKey: string; readonly path: string };
  readonly stickerDefault?: string;
  readonly stickerSets: readonly GalleryStickerSet[];
}

export interface GalleryAvatarVariant {
  readonly entityId: string;
  readonly entityDisplayName: string;
  readonly contributionNamespace: string;
  readonly variantId: string;
  readonly handles: readonly string[];
  readonly storageKey: string;
  readonly path?: string;
  readonly frame?: number;
  readonly isEntityDefault: boolean;
  readonly isSourceDefault: boolean;
}

export interface AvatarCatalogItem {
  readonly variant: GalleryAvatarVariant;
  readonly thumbnailUrl?: string;
  readonly selectable: boolean;
  readonly searchTerms: readonly string[];
}

export type GalleryStorageBackend =
  | { readonly kind: "image-dir"; readonly base: string }
  | {
      readonly kind: "image-sequence";
      readonly path: string;
      readonly container: string;
      readonly codec: string;
      readonly frameCount: number;
      readonly size: [number, number];
      readonly alpha: boolean;
      readonly sha256: string;
      readonly profile: unknown;
    };

export interface GalleryPack {
  readonly namespace: string;
  readonly name: string;
  readonly manifestUrl: string;
  readonly baseUrl: string;
  readonly entities: readonly GalleryEntity[];
  readonly avatarVariants: readonly GalleryAvatarVariant[];
  readonly storage: ReadonlyMap<string, GalleryStorageBackend>;
  readonly schools: readonly GalleryCatalogTaxonomyTerm[];
  readonly relations: readonly GalleryCatalogTaxonomyTerm[];
  readonly provenance?: GalleryCatalogProvenance;
}

export function projectGalleryPack(
  source: PackManifestSource,
  catalog?: GalleryEntityCatalog
): GalleryPack {
  const manifest = JSON.parse(source.json) as {
    pack?: { namespace?: unknown; name?: unknown };
    entities?: Record<string, unknown>;
    contributions?: unknown[];
    storage?: Record<string, unknown>;
  };
  const namespace = manifest.pack?.namespace;
  if (typeof namespace !== "string" || namespace.length === 0) {
    throw new Error(`Pack manifest has no namespace: ${source.manifestUrl}`);
  }
  const metadata = catalog?.namespace === namespace ? catalog : undefined;
  const storage = new Map<string, GalleryStorageBackend>();
  for (const [key, value] of Object.entries(manifest.storage ?? {})) {
    const backend = parseStorageBackend(value);
    if (backend) storage.set(key, backend);
  }
  const entities: GalleryEntity[] = [];
  const avatarVariants: GalleryAvatarVariant[] = [];
  for (const [key, value] of Object.entries(manifest.entities ?? {})) {
    const entity = parseEntity(key, value, metadata);
    if (!entity) continue;
    entities.push(entity);
    const record = value as Record<string, unknown>;
    const slots = typeof record.slots === "object" && record.slots !== null
      ? record.slots as Record<string, unknown>
      : {};
    avatarVariants.push(...parseAvatarVariants(
      slots.avatar,
      canonicalEntityId(namespace, key),
      galleryDisplayLabel(entity),
      namespace,
      true,
    ));
  }
  for (const value of manifest.contributions ?? []) {
    if (typeof value !== "object" || value === null) continue;
    const contribution = value as Record<string, unknown>;
    if (typeof contribution.target !== "string" || !contribution.target.includes("::")) continue;
    const slots = typeof contribution.slots === "object" && contribution.slots !== null
      ? contribution.slots as Record<string, unknown>
      : {};
    avatarVariants.push(...parseAvatarVariants(
      slots.avatar,
      contribution.target,
      contribution.target,
      namespace,
      false,
    ));
  }
  entities.sort((left, right) => (
    galleryDisplayLabel(left).localeCompare(galleryDisplayLabel(right), "zh-Hans-CN")
    || left.key.localeCompare(right.key)
  ));
  return {
    namespace,
    name: typeof manifest.pack?.name === "string" && manifest.pack.name.length > 0
      ? manifest.pack.name
      : namespace,
    manifestUrl: source.manifestUrl,
    baseUrl: source.baseUrl,
    entities,
    avatarVariants,
    storage,
    schools: sortTaxonomy(metadata?.schools),
    relations: sortTaxonomy(metadata?.relations),
    provenance: metadata?.provenance
  };
}

function parseStorageBackend(value: unknown): GalleryStorageBackend | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === "image-dir" && typeof record.base === "string") {
    return { kind: "image-dir", base: record.base };
  }
  if (
    record.kind === "image-sequence"
    && typeof record.path === "string"
    && typeof record.container === "string"
    && typeof record.codec === "string"
    && typeof record.frame_count === "number"
    && Array.isArray(record.size)
    && record.size.length === 2
    && record.size.every((entry) => typeof entry === "number")
    && typeof record.alpha === "boolean"
    && typeof record.sha256 === "string"
  ) {
    return {
      kind: "image-sequence",
      path: record.path,
      container: record.container,
      codec: record.codec,
      frameCount: record.frame_count,
      size: [record.size[0] as number, record.size[1] as number],
      alpha: record.alpha,
      sha256: record.sha256,
      profile: record.profile
    };
  }
  return undefined;
}

function parseEntity(
  key: string,
  value: unknown,
  catalog: GalleryEntityCatalog | undefined
): GalleryEntity | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const displayName = typeof record.display_name === "string" && record.display_name.length > 0 ? record.display_name : key;
  const names = Array.isArray(record.names) ? record.names.filter((name): name is string => typeof name === "string") : [displayName];
  const slots = typeof record.slots === "object" && record.slots !== null ? record.slots as Record<string, unknown> : {};
  const avatar = parseAvatar(slots.avatar);
  const sticker = typeof slots.sticker === "object" && slots.sticker !== null ? slots.sticker as Record<string, unknown> : undefined;
  const stickerSets = parseStickerSets(slots.sticker);
  const stickerDefault = typeof sticker?.default === "string" ? sticker.default : stickerSets[0]?.key;
  const metadata = catalog?.entities.get(key);
  const school = metadata?.schoolId === undefined ? undefined : catalog?.schools.get(metadata.schoolId);
  const mainRelation = metadata?.mainRelationId === undefined ? undefined : catalog?.relations.get(metadata.mainRelationId);
  const relations = metadata === undefined || catalog === undefined
    ? []
    : metadata.relationIds.flatMap((relationId) => {
        const term = catalog.relations.get(relationId);
        return term === undefined ? [] : [term];
      });
  const taxonomyTerms = [school, mainRelation, ...relations].filter(
    (term): term is GalleryCatalogTaxonomyTerm => term !== undefined
  );
  return {
    key,
    displayName,
    names,
    catalogDisplayName: metadata?.zhCnDisplayName,
    searchTerms: uniqueSearchTerms([
      key,
      displayName,
      ...names,
      ...(metadata?.localizedNames ?? []),
      ...(metadata?.aliases ?? []),
      ...taxonomyTerms.flatMap((term) => [term.displayName, ...term.aliases])
    ]),
    school,
    mainRelation,
    relations,
    alternateSkinKeys: metadata?.alternateSkinKeys ?? [],
    totalVariants: stickerSets.reduce((total, set) => total + set.variants.length, 0),
    avatar,
    stickerDefault,
    stickerSets
  };
}

function parseAvatar(value: unknown): GalleryEntity["avatar"] {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const items = typeof record.items === "object" && record.items !== null ? record.items as Record<string, unknown> : {};
  const defaultKey = typeof record.default === "string" ? record.default : Object.keys(items)[0];
  const item = defaultKey !== undefined ? items[defaultKey] : undefined;
  if (typeof item !== "object" || item === null) return undefined;
  const { storage, path } = item as Record<string, unknown>;
  if (typeof storage !== "string" || typeof path !== "string") return undefined;
  return { storageKey: storage, path };
}

function canonicalEntityId(namespace: string, key: string): string {
  return key.includes("::") ? key : `${namespace}::${key}`;
}

function parseAvatarVariants(
  value: unknown,
  entityId: string,
  entityDisplayName: string,
  contributionNamespace: string,
  baseEntitySource: boolean,
): readonly GalleryAvatarVariant[] {
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const items = typeof record.items === "object" && record.items !== null
    ? record.items as Record<string, unknown>
    : {};
  const defaultVariant = typeof record.default === "string" ? record.default : undefined;
  const output: GalleryAvatarVariant[] = [];
  for (const [variantId, value] of Object.entries(items)) {
    if (typeof value !== "object" || value === null) continue;
    const item = value as Record<string, unknown>;
    if (typeof item.storage !== "string" || item.storage.length === 0) continue;
    const handles = Array.isArray(item.handles)
      ? item.handles.filter((handle): handle is string => typeof handle === "string" && handle.length > 0)
      : [];
    output.push({
      entityId,
      entityDisplayName,
      contributionNamespace,
      variantId,
      handles,
      storageKey: item.storage,
      ...(typeof item.path === "string" ? { path: item.path } : {}),
      ...(typeof item.frame === "number" && Number.isInteger(item.frame) && item.frame >= 0
        ? { frame: item.frame }
        : {}),
      isEntityDefault: baseEntitySource && variantId === defaultVariant,
      isSourceDefault: variantId === defaultVariant,
    });
  }
  return output;
}

function parseStickerSets(value: unknown): readonly GalleryStickerSet[] {
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const sets = typeof record.sets === "object" && record.sets !== null ? record.sets as Record<string, unknown> : {};
  const output: GalleryStickerSet[] = [];
  for (const [key, setValue] of Object.entries(sets)) {
    if (typeof setValue !== "object" || setValue === null) continue;
    const setRecord = setValue as Record<string, unknown>;
    if (typeof setRecord.storage !== "string" || !Array.isArray(setRecord.variants)) continue;
    const variants = setRecord.variants.flatMap((candidate): GalleryVariant[] => {
      if (typeof candidate !== "object" || candidate === null) return [];
      const { id, ordinal, frame } = candidate as Record<string, unknown>;
      if (typeof id !== "string" || typeof ordinal !== "number" || typeof frame !== "number") return [];
      return [{ id, ordinal, frame }];
    });
    if (variants.length === 0) continue;
    variants.sort((left, right) => left.ordinal - right.ordinal);
    output.push({
      key,
      displayName: typeof setRecord.display_name === "string" && setRecord.display_name.length > 0 ? setRecord.display_name : key,
      storageKey: setRecord.storage,
      variants
    });
  }
  return output;
}

export function packResourceUrl(packBase: string, relativePath: string, kind: "image-dir" | "image-sequence"): URL {
  const root = new URL(packBase);
  if (root.protocol !== "https:") throw new Error("Pack resource base must use HTTPS");
  if (/[\\?#:]/.test(relativePath)) throw new Error("Pack resource path contains forbidden characters");
  const segments = relativePath.split("/");
  if (segments.length === 0 || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("Pack resource path must contain relative segments");
  }
  const fileName = segments.at(-1)!;
  const extension = kind === "image-dir" ? /\.(?:png|jpe?g|webp)$/i : /\.avifs$/i;
  if (!extension.test(fileName)) throw new Error(`Pack ${kind} resource has an unsupported extension`);
  const rootHref = root.href.endsWith("/") ? root.href : `${root.href}/`;
  const url = new URL(segments.map(encodeURIComponent).join("/"), rootHref);
  const rootPath = new URL(rootHref).pathname;
  if (url.protocol !== "https:" || url.origin !== root.origin || !url.pathname.startsWith(rootPath)) {
    throw new Error("Pack resource escaped its HTTPS pack root");
  }
  return url;
}

export function galleryDisplayLabel(entity: GalleryEntity): string {
  return entity.catalogDisplayName ?? manifestDisplayLabel(entity.displayName, entity.names);
}

function manifestDisplayLabel(displayName: string, names: readonly string[]): string {
  const paren = names.find((name) => /（[^）]+）$/.test(name));
  if (paren) return paren;
  const underscored = names.find((name) => /^[^_]+_.+$/.test(name));
  if (underscored) {
    const split = underscored.indexOf("_");
    return `${underscored.slice(0, split)}（${underscored.slice(split + 1).replaceAll("_", "/")}）`;
  }
  const exact = names.find((name) => name === displayName);
  if (exact) return exact;
  // display_name 可能是截断的名（如联动角色 初音未来 被写成 未来），回退到主名
  return names[0] ?? displayName;
}

function sortTaxonomy(
  taxonomy: ReadonlyMap<string, GalleryCatalogTaxonomyTerm> | undefined
): readonly GalleryCatalogTaxonomyTerm[] {
  if (taxonomy === undefined) return [];
  return [...taxonomy.values()].sort((left, right) => (
    left.displayName.localeCompare(right.displayName, "zh-Hans-CN")
    || left.id.localeCompare(right.id)
  ));
}

function uniqueSearchTerms(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

export function buildAvatarCatalog(packs: readonly GalleryPack[]): readonly AvatarCatalogItem[] {
  const entities = new Map<string, GalleryEntity>();
  for (const pack of packs) {
    for (const entity of pack.entities) {
      entities.set(canonicalEntityId(pack.namespace, entity.key), entity);
    }
  }

  type Candidate = {
    readonly item: AvatarCatalogItem;
    readonly signature: string;
    readonly sourceKey: string;
  };
  const candidates = new Map<string, Candidate[]>();
  for (const pack of packs) {
    for (const avatar of pack.avatarVariants) {
      const entity = entities.get(avatar.entityId);
      const variant: GalleryAvatarVariant = {
        ...avatar,
        entityDisplayName: entity === undefined ? avatar.entityDisplayName : galleryDisplayLabel(entity),
      };
      const backend = pack.storage.get(variant.storageKey);
      let thumbnailUrl: string | undefined;
      if (backend?.kind === "image-dir" && variant.path !== undefined) {
        try {
          thumbnailUrl = packResourceUrl(pack.baseUrl, `${backend.base}/${variant.path}`, "image-dir").href;
        } catch {
          thumbnailUrl = undefined;
        }
      }
      const item: AvatarCatalogItem = {
        variant,
        ...(thumbnailUrl === undefined ? {} : { thumbnailUrl }),
        selectable: thumbnailUrl !== undefined,
        searchTerms: uniqueSearchTerms([
          variant.entityId,
          variant.entityDisplayName,
          variant.contributionNamespace,
          variant.variantId,
          ...variant.handles,
          ...(entity?.searchTerms ?? []),
        ]),
      };
      const identity = avatarIdentity(variant);
      const group = candidates.get(identity) ?? [];
      group.push({
        item,
        signature: avatarMetadataSignature(variant),
        sourceKey: `${pack.manifestUrl}\u0000${pack.baseUrl}`,
      });
      candidates.set(identity, group);
    }
  }

  const output: AvatarCatalogItem[] = [];
  for (const group of candidates.values()) {
    if (new Set(group.map((candidate) => candidate.signature)).size !== 1) continue;
    group.sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
    output.push(group[0]!.item);
  }
  output.sort(compareAvatarCatalogItems);
  return output;
}

function avatarIdentity(variant: GalleryAvatarVariant): string {
  return `${variant.entityId}\u0000${variant.contributionNamespace}\u0000${variant.variantId}`;
}

function avatarMetadataSignature(variant: GalleryAvatarVariant): string {
  return JSON.stringify([
    variant.entityDisplayName,
    variant.handles,
    variant.storageKey,
    variant.path ?? null,
    variant.frame ?? null,
    variant.isEntityDefault,
    variant.isSourceDefault,
  ]);
}

function compareAvatarCatalogItems(left: AvatarCatalogItem, right: AvatarCatalogItem): number {
  const a = left.variant;
  const b = right.variant;
  return (
    a.entityDisplayName.localeCompare(b.entityDisplayName, "zh-Hans-CN")
    || a.entityId.localeCompare(b.entityId)
    || Number(isBaseAvatarSource(b)) - Number(isBaseAvatarSource(a))
    || a.contributionNamespace.localeCompare(b.contributionNamespace)
    || Number(b.isSourceDefault) - Number(a.isSourceDefault)
    || a.variantId.localeCompare(b.variantId)
  );
}

function isBaseAvatarSource(variant: GalleryAvatarVariant): boolean {
  return variant.entityId.split("::", 1)[0] === variant.contributionNamespace;
}

export function galleryAvatarUrl(pack: GalleryPack, entity: GalleryEntity): URL | undefined {
  if (!entity.avatar) return undefined;
  const backend = pack.storage.get(entity.avatar.storageKey);
  if (backend?.kind !== "image-dir") return undefined;
  return packResourceUrl(pack.baseUrl, `${backend.base}/${entity.avatar.path}`, "image-dir");
}

function sequenceRequest(
  pack: GalleryPack,
  backend: Extract<GalleryStorageBackend, { kind: "image-sequence" }>,
  variant: GalleryVariant,
  id: number
): ImageSequenceResource {
  const url = packResourceUrl(pack.baseUrl, backend.path, "image-sequence");
  return {
    kind: "image-sequence",
    id,
    uri: url.href,
    packNamespace: pack.namespace,
    path: backend.path,
    frame: variant.frame,
    sha256: backend.sha256,
    size: backend.size,
    frameCount: backend.frameCount,
    container: backend.container,
    codec: backend.codec,
    alpha: backend.alpha,
    profile: backend.profile,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
  };
}

class LruCache<K, V> {
  readonly #entries = new Map<K, V>();
  private readonly capacity: number;
  private readonly onEvict?: (key: K, value: V) => void;

  constructor(capacity: number, onEvict?: (key: K, value: V) => void) {
    this.capacity = capacity;
    this.onEvict = onEvict;
  }

  get(key: K): V | undefined {
    const value = this.#entries.get(key);
    if (value !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.#entries.has(key)) this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > this.capacity) {
      const oldest = this.#entries.entries().next().value as [K, V];
      this.#entries.delete(oldest[0]);
      this.onEvict?.(oldest[0], oldest[1]);
    }
  }

  delete(key: K, expected?: V): void {
    if (expected !== undefined && this.#entries.get(key) !== expected) return;
    const value = this.#entries.get(key);
    if (this.#entries.delete(key) && value !== undefined) this.onEvict?.(key, value);
  }

  clear(): void {
    for (const [key, value] of this.#entries) this.onEvict?.(key, value);
    this.#entries.clear();
  }
}

const SEQUENCE_CACHE_CAPACITY = 5;
const THUMBNAIL_CACHE_CAPACITY = 256;
const DECODE_CONCURRENCY = 2;

export class GalleryImageCache {
  readonly #sequences = new LruCache<string, Promise<Uint8Array>>(SEQUENCE_CACHE_CAPACITY);
  readonly #thumbnails = new LruCache<string, string>(THUMBNAIL_CACHE_CAPACITY, (_key, url) => URL.revokeObjectURL(url));
  #activeDecodes = 0;
  readonly #waitingDecodes: Array<() => void> = [];

  async thumbnail(
    pack: GalleryPack,
    entity: GalleryEntity,
    set: GalleryStickerSet,
    variant: GalleryVariant,
    signal: AbortSignal
  ): Promise<string> {
    const key = `${pack.manifestUrl}#${entity.key}/${set.key}/${variant.ordinal}`;
    const cached = this.#thumbnails.get(key);
    if (cached) return cached;
    const url = await this.#decodeThumbnail(pack, set, variant, signal);
    this.#thumbnails.set(key, url);
    return url;
  }

  async #decodeThumbnail(
    pack: GalleryPack,
    set: GalleryStickerSet,
    variant: GalleryVariant,
    signal: AbortSignal
  ): Promise<string> {
    const backend = pack.storage.get(set.storageKey);
    if (backend?.kind !== "image-sequence") throw new Error(`Sticker set ${set.key} has no image-sequence storage`);
    const request = sequenceRequest(pack, backend, variant, stableRequestId(set.storageKey, variant.ordinal));
    const bytes = await this.#sequence(pack, set.storageKey, backend, signal);
    const png = await this.#queued(() => decodeAvifSequence(bytes, request, signal));
    return URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" }));
  }

  #sequence(
    pack: GalleryPack,
    storageKey: string,
    backend: Extract<GalleryStorageBackend, { kind: "image-sequence" }>,
    signal: AbortSignal
  ): Promise<Uint8Array> {
    const key = `${pack.manifestUrl}#${storageKey}`;
    let request = this.#sequences.get(key);
    if (!request) {
      request = (async () => {
        const url = packResourceUrl(pack.baseUrl, backend.path, "image-sequence");
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`AVIFS 下载失败：HTTP ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      })();
      this.#sequences.set(key, request);
      request.catch(() => {
        this.#sequences.delete(key, request!);
      });
    }
    return request;
  }

  async #queued<T>(task: () => Promise<T>): Promise<T> {
    if (this.#activeDecodes >= DECODE_CONCURRENCY) {
      await new Promise<void>((resolve) => this.#waitingDecodes.push(resolve));
    }
    this.#activeDecodes += 1;
    try {
      return await task();
    } finally {
      this.#activeDecodes -= 1;
      this.#waitingDecodes.shift()?.();
    }
  }

  dispose(): void {
    this.#thumbnails.clear();
    this.#sequences.clear();
  }
}

function stableRequestId(storageKey: string, ordinal: number): number {
  let hash = 0;
  for (let index = 0; index < storageKey.length; index += 1) {
    hash = (hash * 31 + storageKey.charCodeAt(index)) | 0;
  }
  return (hash ^ ordinal) >>> 0;
}
