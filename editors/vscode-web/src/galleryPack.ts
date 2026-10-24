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
  readonly contributionNamespace: string;
  readonly selectorId: string;
  readonly origin?: GalleryResourceOrigin;
  readonly displayName: string;
  readonly storageKey: string;
  readonly variants: readonly GalleryVariant[];
}

export interface GalleryStickerContribution {
  readonly entityId: string;
  readonly sets: readonly GalleryStickerSet[];
}

export interface GalleryEntity {
  readonly key: string;
  readonly displayName: string;
  readonly names: readonly string[];
  readonly catalogDisplayName?: string;
  readonly catalogDisplayNames: ReadonlyMap<string, string>;
  readonly characterId?: string;
  readonly givenNames: ReadonlyMap<string, string>;
  readonly skinNames: ReadonlyMap<string, string>;
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
  readonly origin?: GalleryResourceOrigin;
  readonly selectable: boolean;
  readonly searchTerms: readonly string[];
  readonly person?: {
    readonly key: string;
    readonly label: string;
    readonly formLabel: string;
    readonly formDisplayName: string;
  };
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
  readonly catalogScope?: string;
  readonly baseUrl: string;
  readonly entities: readonly GalleryEntity[];
  readonly avatarVariants: readonly GalleryAvatarVariant[];
  readonly stickerContributions: readonly GalleryStickerContribution[];
  readonly storage: ReadonlyMap<string, GalleryStorageBackend>;
  readonly schools: readonly GalleryCatalogTaxonomyTerm[];
  readonly relations: readonly GalleryCatalogTaxonomyTerm[];
  readonly provenance?: GalleryCatalogProvenance;
}

type GalleryResourceOrigin = Pick<GalleryPack, "namespace" | "manifestUrl" | "baseUrl" | "storage">;

export interface GalleryPersonForm {
  readonly entityId: string;
  readonly label: string;
  readonly displayName: string;
  readonly searchTerms: readonly string[];
  readonly pack: GalleryPack;
  readonly entity: GalleryEntity;
  readonly stickerSets: readonly GalleryStickerSet[];
}

export interface GalleryPersonGroup {
  readonly key: string;
  readonly namespace: string;
  readonly label: string;
  readonly searchTerms: readonly string[];
  readonly forms: readonly GalleryPersonForm[];
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
  const origin: GalleryResourceOrigin = {
    namespace,
    manifestUrl: source.manifestUrl,
    baseUrl: source.baseUrl,
    storage,
  };
  const entities: GalleryEntity[] = [];
  const avatarVariants: GalleryAvatarVariant[] = [];
  const stickerContributions: GalleryStickerContribution[] = [];
  for (const [key, value] of Object.entries(manifest.entities ?? {})) {
    const entity = parseEntity(key, value, metadata, namespace);
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
    const sets = parseStickerSets(slots.sticker, namespace, origin);
    if (sets.length > 0) stickerContributions.push({ entityId: contribution.target, sets });
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
    catalogScope: metadata === undefined
      ? undefined
      : JSON.stringify([metadata.namespace, source.manifestUrl, metadata.version, metadata.manifestSha256]),
    baseUrl: source.baseUrl,
    entities,
    avatarVariants,
    stickerContributions,
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
  catalog: GalleryEntityCatalog | undefined,
  namespace: string,
): GalleryEntity | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const displayName = typeof record.display_name === "string" && record.display_name.length > 0 ? record.display_name : key;
  const names = Array.isArray(record.names) ? record.names.filter((name): name is string => typeof name === "string") : [displayName];
  const slots = typeof record.slots === "object" && record.slots !== null ? record.slots as Record<string, unknown> : {};
  const avatar = parseAvatar(slots.avatar);
  const sticker = typeof slots.sticker === "object" && slots.sticker !== null ? slots.sticker as Record<string, unknown> : undefined;
  const stickerSets = parseStickerSets(slots.sticker, namespace);
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
    catalogDisplayNames: metadata?.displayNames ?? new Map(),
    characterId: metadata?.characterId,
    givenNames: metadata?.givenNames ?? new Map(),
    skinNames: metadata?.skinNames ?? new Map(),
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

function parseStickerSets(
  value: unknown,
  contributionNamespace: string,
  origin?: GalleryResourceOrigin,
): readonly GalleryStickerSet[] {
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
      contributionNamespace,
      selectorId: `${contributionNamespace}::${key}`,
      ...(origin === undefined ? {} : { origin }),
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

export function buildGalleryPersonGroups(packs: readonly GalleryPack[]): readonly GalleryPersonGroup[] {
  type Entry = { readonly pack: GalleryPack; readonly entity: GalleryEntity; readonly entityId: string };
  const scopes = new Map<string, Map<string, Entry>>();
  const sortedPacks = [...packs].sort((left, right) => (
    left.namespace.localeCompare(right.namespace)
    || left.manifestUrl.localeCompare(right.manifestUrl)
    || left.baseUrl.localeCompare(right.baseUrl)
  ));
  type Contribution = { readonly pack: GalleryPack; readonly sets: GalleryStickerSet[] };
  const contributions = new Map<string, Contribution>();
  const declaredEntities = new Set<string>();
  for (const pack of sortedPacks) {
    for (const entity of pack.entities) declaredEntities.add(canonicalEntityId(pack.namespace, entity.key));
    for (const contribution of pack.stickerContributions) {
      const entry: Contribution = contributions.get(contribution.entityId) ?? { pack, sets: [] };
      entry.sets.push(...contribution.sets);
      contributions.set(contribution.entityId, entry);
    }
  }
  for (const pack of sortedPacks) {
    for (const entity of pack.entities) {
      const entityId = canonicalEntityId(pack.namespace, entity.key);
      const namespace = entityId.split("::", 1)[0]!;
      const scope = pack.catalogScope === undefined
        ? JSON.stringify(["manifest", namespace, pack.manifestUrl])
        : JSON.stringify(["catalog", namespace, pack.catalogScope]);
      const entries = scopes.get(scope) ?? new Map<string, Entry>();
      if (!entries.has(entityId)) entries.set(entityId, { pack, entity, entityId });
      scopes.set(scope, entries);
    }
  }

  const output: GalleryPersonGroup[] = [];
  for (const [scope, entries] of scopes) {
    const neighbors = new Map<string, Set<string>>();
    for (const entry of entries.values()) neighbors.set(entry.entityId, new Set());
    const characterAnchors = new Map<string, string>();
    for (const entry of entries.values()) {
      const characterId = entry.entity.characterId;
      if (characterId !== undefined) {
        const anchor = characterAnchors.get(characterId);
        if (anchor === undefined) characterAnchors.set(characterId, entry.entityId);
        else {
          neighbors.get(entry.entityId)!.add(anchor);
          neighbors.get(anchor)!.add(entry.entityId);
        }
      }
      for (const key of entry.entity.alternateSkinKeys) {
        const relatedId = canonicalEntityId(entry.pack.namespace, key);
        if (!entries.has(relatedId) || relatedId === entry.entityId) continue;
        neighbors.get(entry.entityId)!.add(relatedId);
        neighbors.get(relatedId)!.add(entry.entityId);
      }
    }

    const grouped = new Map<string, Entry[]>();
    const seen = new Set<string>();
    const sortedEntries = [...entries.values()].sort((left, right) => left.entityId.localeCompare(right.entityId));
    for (const entry of sortedEntries) {
      if (seen.has(entry.entityId)) continue;
      const component: Entry[] = [];
      const pending = [entry.entityId];
      seen.add(entry.entityId);
      while (pending.length > 0) {
        const entityId = pending.pop()!;
        component.push(entries.get(entityId)!);
        for (const relatedId of neighbors.get(entityId)!) {
          if (seen.has(relatedId)) continue;
          seen.add(relatedId);
          pending.push(relatedId);
        }
      }
      component.sort((left, right) => left.entityId.localeCompare(right.entityId));
      grouped.set(JSON.stringify([scope, "person", component.map((candidate) => candidate.entityId)]), component);
    }

    for (const [key, group] of grouped) {
      group.sort((left, right) => left.entityId.localeCompare(right.entityId));
      const forms: GalleryPersonForm[] = group.map(({ pack, entity, entityId }) => {
        const displayName = entity.catalogDisplayNames.get("zh-CN")
          ?? [...entity.catalogDisplayNames].sort(([left], [right]) => left.localeCompare(right))[0]?.[1]
          ?? entity.displayName;
        const skinName = entity.skinNames.get("zh-CN")
          ?? [...entity.skinNames].sort(([left], [right]) => left.localeCompare(right))[0]?.[1];
        const stickerSets = [...entity.stickerSets, ...(contributions.get(entityId)?.sets ?? [])];
        return {
          entityId,
          displayName,
          label: skinName ?? `形态未标注 · ${displayName}`,
          searchTerms: uniqueSearchTerms([
            entityId,
            ...entity.searchTerms,
            ...stickerSets.flatMap((set) => [set.contributionNamespace, set.key, set.displayName, ...set.variants.map((variant) => variant.id)]),
          ]),
          pack,
          entity,
          stickerSets,
        };
      });
      const label = group.length > 1
        ? commonGivenName(group.map((entry) => entry.entity)) ?? forms[0]!.displayName
        : forms[0]!.displayName;
      output.push({
        key,
        namespace: group[0]!.entityId.split("::", 1)[0]!,
        label,
        searchTerms: uniqueSearchTerms([label, ...forms.flatMap((form) => [form.label, ...form.searchTerms])]),
        forms,
      });
    }
  }
  for (const [entityId, { pack, sets }] of contributions) {
    if (declaredEntities.has(entityId)) continue;
    const entity = parseEntity(entityId, {}, undefined, pack.namespace)!;
    const label = `形态未标注 · ${entityId}`;
    const searchTerms = uniqueSearchTerms([
      entityId,
      ...sets.flatMap((set) => [set.contributionNamespace, set.key, set.displayName, ...set.variants.map((variant) => variant.id)]),
    ]);
    output.push({
      key: JSON.stringify(["contributionTarget", entityId]),
      namespace: entityId.split("::", 1)[0]!,
      label: entityId,
      searchTerms,
      forms: [{ entityId, label, displayName: entityId, searchTerms, pack, entity, stickerSets: sets }],
    });
  }
  const labelCounts = new Map<string, number>();
  for (const group of output) labelCounts.set(group.label, (labelCounts.get(group.label) ?? 0) + 1);
  return output.map((group): GalleryPersonGroup => {
    if (labelCounts.get(group.label) === 1) return group;
    const label = `${group.label} · ${group.forms[0]!.entityId}`;
    return { ...group, label, searchTerms: uniqueSearchTerms([label, ...group.searchTerms]) };
  }).sort((left, right) => (
    left.label.localeCompare(right.label, "zh-Hans-CN") || left.key.localeCompare(right.key)
  ));
}

function commonGivenName(entities: readonly GalleryEntity[]): string | undefined {
  const locales = [...entities[0]!.givenNames.keys()].sort((left, right) => (
    Number(right === "zh-CN") - Number(left === "zh-CN") || left.localeCompare(right)
  ));
  for (const locale of locales) {
    const name = entities[0]!.givenNames.get(locale)!;
    if (entities.every((entity) => entity.givenNames.get(locale) === name)) return name;
  }
  return undefined;
}

export function buildAvatarCatalog(packs: readonly GalleryPack[]): readonly AvatarCatalogItem[] {
  const entities = new Map<string, GalleryEntity>();
  const personCandidates = new Map<string, NonNullable<AvatarCatalogItem["person"]>[]>();
  for (const group of buildGalleryPersonGroups(packs)) {
    for (const form of group.forms) {
      if (!entities.has(form.entityId)) entities.set(form.entityId, form.entity);
      const candidates = personCandidates.get(form.entityId) ?? [];
      candidates.push({
        key: group.key,
        label: group.label,
        formLabel: form.label,
        formDisplayName: form.displayName,
      });
      personCandidates.set(form.entityId, candidates);
    }
  }
  const persons = new Map<string, NonNullable<AvatarCatalogItem["person"]>>();
  for (const [entityId, candidates] of personCandidates) {
    if (new Set(candidates.map((person) => person.key)).size === 1) persons.set(entityId, candidates[0]!);
  }

  type Candidate = {
    readonly item: AvatarCatalogItem;
    readonly signature: string;
    readonly sourceKey: string;
  };
  const candidates = new Map<string, Candidate[]>();
  for (const pack of packs) {
    const origin: GalleryResourceOrigin = {
      namespace: pack.namespace,
      manifestUrl: pack.manifestUrl,
      baseUrl: pack.baseUrl,
      storage: pack.storage,
    };
    for (const avatar of pack.avatarVariants) {
      const entity = entities.get(avatar.entityId);
      const person = persons.get(avatar.entityId);
      const variant: GalleryAvatarVariant = {
        ...avatar,
        entityDisplayName: entity === undefined ? avatar.entityDisplayName : galleryDisplayLabel(entity),
      };
      const backend = pack.storage.get(variant.storageKey);
      let thumbnailUrl: string | undefined;
      let selectable = false;
      if (backend?.kind === "image-dir" && variant.path !== undefined) {
        try {
          thumbnailUrl = packResourceUrl(pack.baseUrl, `${backend.base}/${variant.path}`, "image-dir").href;
          selectable = true;
        } catch {
          thumbnailUrl = undefined;
        }
      }
      if (
        backend?.kind === "image-sequence"
        && backend.container === "avifs"
        && backend.codec === "av1"
        && Number.isInteger(backend.frameCount)
        && variant.frame !== undefined
        && variant.frame < backend.frameCount
      ) {
        try {
          packResourceUrl(pack.baseUrl, backend.path, "image-sequence");
          selectable = true;
        } catch {
          selectable = false;
        }
      }
      const item: AvatarCatalogItem = {
        ...(person === undefined ? {} : { person }),
        variant,
        origin,
        ...(thumbnailUrl === undefined ? {} : { thumbnailUrl }),
        selectable,
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
  pack: GalleryResourceOrigin,
  backend: Extract<GalleryStorageBackend, { kind: "image-sequence" }>,
  variant: Pick<GalleryVariant, "frame">,
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

  async avatarThumbnail(item: AvatarCatalogItem, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const origin = item.origin;
    const variant = item.variant;
    if (origin === undefined) throw new Error("Avatar resource origin is unavailable");
    const backend = origin.storage.get(variant.storageKey);
    if (backend?.kind === "image-dir" && variant.path !== undefined) {
      return packResourceUrl(origin.baseUrl, `${backend.base}/${variant.path}`, "image-dir").href;
    }
    if (
      backend?.kind !== "image-sequence"
      || backend.container !== "avifs"
      || backend.codec !== "av1"
      || variant.frame === undefined
      || variant.frame >= backend.frameCount
    ) {
      throw new Error(`Avatar ${variant.entityId}/${variant.variantId} has no supported image resource`);
    }
    const key = `${origin.manifestUrl}#avatar/${avatarIdentity(variant)}/${variant.frame}`;
    const cached = this.#thumbnails.get(key);
    if (cached) return cached;
    const request = sequenceRequest(origin, backend, { frame: variant.frame }, stableRequestId(variant.storageKey, variant.frame));
    const bytes = await this.#sequence(origin, variant.storageKey, backend, signal);
    const png = await this.#queued(() => {
      signal.throwIfAborted();
      return decodeAvifSequence(bytes, request, signal);
    });
    signal.throwIfAborted();
    const url = URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" }));
    this.#thumbnails.set(key, url);
    return url;
  }

  async thumbnail(
    pack: GalleryPack,
    entity: GalleryEntity,
    set: GalleryStickerSet,
    variant: GalleryVariant,
    signal: AbortSignal
  ): Promise<string> {
    const origin = set.origin ?? pack;
    const key = `${origin.manifestUrl}#${canonicalEntityId(pack.namespace, entity.key)}/${set.selectorId}/${variant.ordinal}`;
    const cached = this.#thumbnails.get(key);
    if (cached) return cached;
    const url = await this.#decodeThumbnail(origin, set, variant, signal);
    this.#thumbnails.set(key, url);
    return url;
  }

  async #decodeThumbnail(
    pack: GalleryResourceOrigin,
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
    pack: GalleryResourceOrigin,
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
