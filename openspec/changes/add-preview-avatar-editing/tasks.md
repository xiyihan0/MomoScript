## 1. Rust avatar Composer core

- [x] 1.1 Add structured `PackAvatarChoice`、`ComposerActorAvatar` and `SetActorAvatarFromStatement`; expose no selector/ActorId/resource implementation fields
- [x] 1.2 Derive current Pack/ScriptAsset/PackAsset/null state from the exact actor revision resource plan; omit the capability for no-Pack、ambiguous or errorful evidence
- [x] 1.3 Pre-resolve exact canonical entity/contribution/variant through PackRegistry; reject no-registry、missing/ambiguous/mismatch and same-current as `AvatarUnavailable`
- [x] 1.4 Implement adjacent same-actor `avatar:` replace/insert and canonical actor revision insertion with newline/comment/quote/field preservation
- [x] 1.5 Serialize only `{entity}/{namespace}::avatar/{variant}` from `ResolvedAvatar`; preserve ActorId、speaker、display-name、preset and names for cross-character choices
- [x] 1.6 Parameterize the common candidate gate so only generic avatar equality is skipped for this command while all inline/sticker/failure checks remain
- [x] 1.7 Prove the exact transition by resolved identity: pre-target equality、shifted revisions、later explicit-avatar inheritance、non-target actor equality and no other avatar changes
- [x] 1.8 Extend Pack fixtures and reject duplicate/malformed fields、builtin/unresolved actors、stale ranges、candidate drift and handle/id mismatch

## 2. Native/WASM language-service contract

- [x] 2.1 Add strict `actorAvatar` descriptor、`setActorAvatarFromStatement` command and `avatarUnavailable` result with unknown-key rejection
- [x] 2.2 Enforce identical 1–1024-byte component allowlists in Rust/TypeScript: no whitespace/control/slash/backslash、canonical `namespace::id`、plain contribution namespace
- [x] 2.3 Carry actor preset/current avatar through Typst backend and route edits through the current revision-bound PackRegistry snapshot
- [x] 2.4 Keep native stdio/WASM parity、one current-version TextDocumentEdit、no `changes`、no server apply and no retry
- [x] 2.5 Add positive/negative transcripts for current/cross/contribution、ScriptAsset/PackAsset/null、no-registry、same-current、stale、unknown and overlong payloads
- [x] 2.6 Assert target serialization never leaks ActorId、selector、URL、storage/path or Pack source fields and omits ambiguous/errorful avatar capability

## 3. Complete avatar catalog projection

- [x] 3.1 Preserve `GalleryEntity.avatar` while adding flat `GalleryAvatarVariant`/`AvatarCatalogItem` projection with optional path/frame and entity/source default flags
- [x] 3.2 Parse every base and contribution avatar item with canonical entity、contributor、variant、handles、storage and default identity
- [x] 3.3 Build total entity/base/contribution/default/variant ordering and exact-identity dedupe; remove every conflicting copy instead of load-order overwrite
- [x] 3.4 Keep only safe image-dir/path items selectable; project pathless/image-sequence entries as unavailable and retain HTTPS/same-origin/pack-root URL checks
- [x] 3.5 Add projection fixtures/contracts for variants、contributions、canonical ids、conflicts、unsafe/pathless/sequence sources、defaults and cross-Pack ordering

## 4. Product-level avatar picker

- [x] 4.1 Add pointer-independent controller snapshots for current actor promotion、other-character search、current status、busy state and one-shot immediate choose
- [x] 4.2 Match display/names、handles、variant and contribution terms without sharing sidebar Gallery DOM、sticker commands、pointer state or document text
- [x] 4.3 Add pointer-anchored Workbench context view with bounded internal grid、lazy image cleanup and searchable “其他人物”
- [x] 4.4 Disable current Pack identity; show exact custom/null/unsupported-current status and explicit cross-character “uses avatar” copy
- [x] 4.5 Store picker as Composer transient UI and wire actual `galleryPacksChanged` invalidation under existing runtime ownership
- [x] 4.6 Close on document、PreviewArtifact、runtime or Pack change; suppress second click、retarget and retry

## 5. Preview Composer integration

- [x] 5.1 Add “从本条起更换人物头像…” only when target capability and a selectable non-current catalog item exist
- [x] 5.2 Reuse semantic bubble/avatar/display-name/text routing and original statement/version/artifact/pointer target without new DOM heuristics
- [x] 5.3 Send only structured avatar identity to `mmt/composerEdit`; keep URL/path/storage/MMT serialization out of TypeScript
- [x] 5.4 Apply once through existing version gate、WorkspaceEdit converter、Local History and preview rerender pipeline
- [x] 5.5 Map `avatarUnavailable`、stale、false apply and other rejection to one native MomoScript notification with no fallback

## 6. Verification

- [x] 6.1 Run `openspec validate add-preview-avatar-editing --strict`
- [x] 6.2 Run focused Rust tests for CRLF/UTF-8、adjacent/new block、canonical round-trip、current/default/cross/contribution and every rejection boundary
- [x] 6.3 Run full LSP/native/WASM tests including no-registry、data-leak negative、ambiguous-target omission and one versioned edit
- [x] 6.4 Run Gallery projection、URL、pathless/sequence、conflict/order and picker controller contracts
- [x] 6.5 Browser-drive current-character selection: one request/history edit、exact bytes、prior preview unchanged、target/later updated
- [x] 6.6 Browser-drive cross-character selection: explicit copy、speaker/display-name unchanged、selected image and identity updated
- [x] 6.7 Browser-drive automatic regrouping、explicit `continued: true`、disabled current and custom/null/unsupported current indicators
- [x] 6.8 Browser-drive document/artifact/runtime/actual Pack-event cancellation、missing choice、unsafe thumbnail、false apply and no retry
- [x] 6.9 Inspect 240–320 px pointer picker and prove controller imports no pointer/Workbench dependency for bottom-sheet reuse
- [x] 6.10 Run production build and focused Editor Runtime E2E before delivery
