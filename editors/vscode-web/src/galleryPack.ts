import type { PackManifestSource } from "../../vscode/src/packSync";
import { decodeAvifSequence, type ImageSequenceResource } from "./avifSequence";

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
  readonly avatar?: { readonly storageKey: string; readonly path: string };
  readonly stickerDefault?: string;
  readonly stickerSets: readonly GalleryStickerSet[];
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
  readonly manifestUrl: string;
  readonly baseUrl: string;
  readonly entities: readonly GalleryEntity[];
  readonly storage: ReadonlyMap<string, GalleryStorageBackend>;
}

export function projectGalleryPack(source: PackManifestSource): GalleryPack {
  const manifest = JSON.parse(source.json) as {
    pack?: { namespace?: unknown };
    entities?: Record<string, unknown>;
    storage?: Record<string, unknown>;
  };
  const namespace = manifest.pack?.namespace;
  if (typeof namespace !== "string" || namespace.length === 0) {
    throw new Error(`Pack manifest has no namespace: ${source.manifestUrl}`);
  }
  const storage = new Map<string, GalleryStorageBackend>();
  for (const [key, value] of Object.entries(manifest.storage ?? {})) {
    const backend = parseStorageBackend(value);
    if (backend) storage.set(key, backend);
  }
  const entities: GalleryEntity[] = [];
  for (const [key, value] of Object.entries(manifest.entities ?? {})) {
    const entity = parseEntity(key, value);
    if (entity) entities.push(entity);
  }
  entities.sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-Hans-CN"));
  return { namespace, manifestUrl: source.manifestUrl, baseUrl: source.baseUrl, entities, storage };
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

function parseEntity(key: string, value: unknown): GalleryEntity | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const displayName = typeof record.display_name === "string" && record.display_name.length > 0 ? record.display_name : key;
  const names = Array.isArray(record.names) ? record.names.filter((name): name is string => typeof name === "string") : [displayName];
  const slots = typeof record.slots === "object" && record.slots !== null ? record.slots as Record<string, unknown> : {};
  const avatar = parseAvatar(slots.avatar);
  const sticker = typeof slots.sticker === "object" && slots.sticker !== null ? slots.sticker as Record<string, unknown> : undefined;
  const stickerSets = parseStickerSets(slots.sticker);
  const stickerDefault = typeof sticker?.default === "string" ? sticker.default : stickerSets[0]?.key;
  return { key, displayName, names, avatar, stickerDefault, stickerSets };
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
  const paren = entity.names.find((name) => /（[^）]+）$/.test(name));
  if (paren) return paren;
  const underscored = entity.names.find((name) => /^[^_]+_.+$/.test(name));
  if (underscored) {
    const split = underscored.indexOf("_");
    return `${underscored.slice(0, split)}（${underscored.slice(split + 1).replaceAll("_", "/")}）`;
  }
  const exact = entity.names.find((name) => name === entity.displayName);
  if (exact) return exact;
  // display_name 可能是截断的名（如联动角色 初音未来 被写成 未来），回退到主名
  return entity.names[0] ?? entity.displayName;
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
  constructor(
    private readonly capacity: number,
    private readonly onEvict?: (key: K, value: V) => void
  ) {}

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
