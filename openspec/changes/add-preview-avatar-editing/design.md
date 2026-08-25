## Context

Rust v2 已将 avatar 建模为 `ActorRevision.state.avatar`，并通过 `resolve_actor_avatars`、PackRegistry 与 materializer 绑定到 `(ActorId, revision)`。完整 selector 可以引用当前人物、其他 script actor、全局 pack entity 或显式 contribution：

```mmt
@actor 小雪
avatar: ba::佳代子/ba::avatar/default
@end
```

该写法只改变小雪的头像资源；speaker identity、display-name 与 preset 不变。头像 identity 参与 emitter 的 automatic continuation key，因此从目标 statement 起换头像通常会开始一个新的可见消息组。

现有 Preview Composer 已提供 current statement target、相邻 actor block 最小更新、候选源码完整重分析、严格 WorkspaceEdit 与 transient context UI。现有 Character Gallery 只保留 avatar default 图片，sticker variants 与插入命令不能表达 avatar revision。

## Decisions

### 1. Avatar selection is a structured resource identity

Transport SHALL NOT accept an arbitrary selector string. The new command uses a closed union:

```ts
type ComposerAvatarChoice = {
  kind: "packAvatar";
  entityId: string;
  contributionNamespace: string;
  variantId: string;
};

interface SetActorAvatarFromStatement {
  kind: "setActorAvatarFromStatement";
  avatar: ComposerAvatarChoice;
}
```

Each identity component is 1–1024 UTF-8 bytes and contains no Unicode whitespace/control、`/` or `\\`. `entityId` contains exactly one `::` with non-empty namespace/id; `contributionNamespace` cannot contain `::`. Unknown keys and alternate spellings reject at TypeScript/native/WASM boundaries. `entityId` is canonical; `contributionNamespace` identifies the manifest contributing the avatar slot; `variantId` is the canonical item id.

Rust resolves this triple through the current read-only PackRegistry and serializes one explicit selector. It MUST NOT trust a URL、storage id、path、display label or client-generated DSL fragment. Absence of PackRegistry、missing/ambiguous/mismatched identity and a direct same-as-current request return `avatarUnavailable` with no edit. The first GUI slice emits pack avatars only; `asset::` remains valid authored DSL but outside the picker command.

Cross-character selection is intentional. `choice.entityId` MAY differ from the target actor's `presetId`. Candidate acceptance proves the target ActorId、preset、names and display-name are unchanged while the resolved avatar identity equals the selected triple.

### 2. Target descriptor exposes product identity, not mutable actor identity

For one uniquely resolved non-builtin statement target, `mmt/previewComposerTarget` adds:

```ts
interface ComposerActorAvatarDescriptor {
  scope: "fromStatement";
  actorPresetId: string;
  current:
    | ComposerAvatarChoice
    | { kind: "asset"; assetName: string }
    | null;
}
```

`actorPresetId` is stable Pack entity identity used only to place current-character choices first. It is not ActorId and does not authorize mutation. `current` is derived from the exact `(ActorId, revision)` resource plan: Pack avatars expose only the structured triple; both resolved `ScriptAsset` and `PackAsset` collapse to `{ kind: "asset", assetName: <resolved logical name> }`; a genuinely avatar-less resolved revision is null. If actor、resource or PackRegistry evidence is ambiguous/errorful, the whole avatar property is unavailable. The response never exposes ActorId、URL、storage/path、selector or Pack source fields.

The statement range + TextDocument version remains the ephemeral command target. Every edit re-resolves ActorId、revision、Pack identity and selected avatar.

### 3. Source edits reuse actor revision rules

`setActorAvatarFromStatement` follows the existing display-name edit boundary:

1. Resolve the exact current statement ordinal and unique actor.
2. If an immediately adjacent `@actor` block for the same ActorId governs its first renderable node at the target, update the unique `avatar:` scalar or insert it before `@end`.
3. Otherwise insert immediately before the target:

```mmt
@actor <server-selected-round-trippable-name>
avatar: <server-serialized-explicit-selector>
@end
```

4. Preserve newline convention、surrounding blank lines、field order outside the insertion、comments、statement bytes and unrelated actor fields.
5. Reject duplicate/malformed avatar fields、non-serializable actor names、builtin/unresolved/ambiguous actors and stale statement ranges.

Selecting the current actor's default avatar writes an explicit selected identity; it does not try to “remove” an inherited field, because a missing avatar field inherits the preceding revision and cannot express reset reliably.

### 4. Candidate reanalysis allows exactly the avatar revision effect

Candidate source is analyzed with the same CharacterPresetCatalog and read-only PackRegistry. The unconditional common semantics gate is command-specific: continued/display-name retain exact avatar resource equality; avatar edits reuse every common check except that equality and delegate the full allowed transition to an avatar-specific gate.

Acceptance requires:

- no syntax、semantic、Typst projection or resource resolution Error;
- the same statement count、markers、bodies、patches、inline/sticker resources and unrelated failures;
- every statement before the target retains ActorId、display-name and resolved avatar identity;
- target ActorId、preset、names and display-name remain, while its resolved avatar equals the selected triple;
- shifted revision numbers and later statements follow ordinary inheritance until the next explicit avatar revision;
- every non-target actor revision and every other avatar resource remain equivalent;
- no fetch、decode、materialize or renderer I/O occurs during the request.

A changed avatar may change `auto-continued` and visible avatar/name grouping after preview rerender. This is an expected renderer consequence, not an unrelated semantic change.

### 5. Gallery projection becomes a complete read-only avatar catalog

The Web product model adds immutable projection/catalog types while preserving the existing entity-card API:

```ts
interface GalleryAvatarVariant {
  entityId: string;
  entityDisplayName: string;
  contributionNamespace: string;
  variantId: string;
  handles: readonly string[];
  storageKey: string;
  path?: string;
  frame?: number;
  isEntityDefault: boolean;
  isSourceDefault: boolean;
}

interface AvatarCatalogItem {
  variant: GalleryAvatarVariant;
  thumbnailUrl?: string;
  selectable: boolean;
  searchTerms: readonly string[];
}
```

Projection reads every base and contribution avatar item. Base local ids canonicalize with the manifest namespace; contribution targets are already canonical and retain the contributor namespace. Pathless/image-sequence items remain projected but are unavailable in the first picker; only safe image-dir items with a non-empty path are selectable.

Cross-source aggregation has one owner and one signature:

```ts
buildAvatarCatalog(packs: readonly GalleryPack[]): readonly AvatarCatalogItem[]
```

`projectGalleryPack(source, catalog)` remains source-local: it projects that manifest's entities and flat avatar variants, including contribution variants whose canonical target entity is absent from that manifest. After every active source has been projected, `buildAvatarCatalog` constructs one canonical entity index from the complete `GalleryPack[]`, joins each contribution variant to target display/search metadata when available, and exclusively owns cross-source conflict removal、selectability、URL derivation and total ordering. `main.ts` stores the complete projected array and supplies picker snapshots only through `buildAvatarCatalog(galleryPacks)`; no per-Pack projection may attach、drop or independently aggregate another Pack's contribution.

Ordering is total: actor entity promotion belongs to the picker; catalog order uses entity display label/canonical id, base before contributions, contribution namespace, source default first and variant id. Exact identity duplicates dedupe only when metadata matches; every copy of a conflicting identity is excluded rather than last-write-wins.

Thumbnail URLs continue through `packResourceUrl`: HTTPS、same origin、pack-root prefix and supported image type are mandatory. URL/path/storage stays in `AvatarCatalogItem` and never enters the Composer command.

Existing `GalleryEntity.avatar` default-card behavior remains unchanged. Sticker parsing、AVIFS caches and `mmt.gallery.insertSticker` remain unchanged.

### 6. The picker is transient and statement-bound

The native menu adds **“从本条起更换人物头像…”** only when the target exposes `actorAvatar` and the active catalog contains selectable pack avatars.

The desktop picker is a Workbench context view anchored from the original pointer. It contains:

- current actor choices first;
- a searchable “其他人物” section;
- lazy avatar thumbnails and entity/variant/source labels;
- a disabled current Pack item, or “当前：自定义资源 <name>” / “当前：无头像” status;
- “当前头像暂不支持预览” for a current Pack item without a selectable thumbnail;
- explicit cross-character text, e.g. “小雪将从本条起使用「佳代子 / default」头像”.

Clicking a non-current selectable thumbnail applies immediately once; there is no confirmation step. Opening retains the same Composer operation and captured document/artifact/catalog identity. Document version、preview artifact、runtime owner or the actual `galleryPacksChanged` event closes it and cancels work. False apply、version drift or rejection reports one native MomoScript notification and never retries.

The picker does not use the sidebar Gallery as mutable handoff state. It may reuse immutable catalog/search/URL utilities, but target、DOM and cancellation belong exclusively to the current EditorRuntimeController operation.

### 7. Mobile reuse stops at the product controller boundary

Avatar query/filter/current-selection state and `choose(choice)` command are independent of pointer coordinates and Workbench context-view APIs. The desktop adapter provides pointer anchoring; a future mobile change may provide a bottom sheet over the same controller and Composer command.

This change does not create a second mobile document model、Pack cache、gallery store or apply path. Mobile-specific gestures、safe areas、keyboard behavior and layout qualification remain a separate OpenSpec change.

## Risks and Mitigations

- **Cross-character choice appears to switch speaker**: keep actor label visible and require explicit “uses X avatar” copy; command never changes ActorId.
- **Pack contribution ambiguity**: payload includes contribution namespace and Rust resolves the exact triple.
- **Stale picker applies after pack/document changes**: picker is owned by the Composer operation and cancelled on every relevant identity advance.
- **Gallery model and Rust resolver drift**: shared manifest fixtures cover base/contribution/default identities; Rust remains final authority and rejects drift.
- **Avatar change unexpectedly breaks continuation**: UI copy states “from this message”; E2E verifies the expected avatar/name regrouping.
- **Large catalogs overload the context view**: bounded visible grid、search-first other-character section、lazy images and existing URL/cache constraints.

## Rollout

1. Add Rust core command and source/candidate contracts.
2. Add strict native/WASM wire types and target descriptor.
3. Project complete avatar variants from active manifests.
4. Add a product-level avatar picker controller and desktop context-view adapter.
5. Integrate the Composer menu/action and lifecycle cancellation.
6. Browser-qualify current-character、cross-character、stale and grouping behavior before considering a mobile surface.
