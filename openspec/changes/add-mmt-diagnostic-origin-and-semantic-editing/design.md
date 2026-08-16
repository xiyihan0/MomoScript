## Context

The MMT language projection and preview build already carry source version, projection revision, source content, project digest, projection key, snapshot token, and renderer generation. `ProjectionIndex` safely maps only complete ranges inside one Identity segment. `EmittedTypst` additionally records origin chunks with generated-parent links, but projection diagnostic mapping currently inspects range starts and has separate patch overlap exceptions. These are insufficient for a renderer range crossing multiple generated chunks.

Tinymist's fixed renderer currently emits a staged artifact only for a successful document. When `artifact.doc.is_none()`, structured `SourceDiagnostic` values are formatted into a JSON-RPC internal-error string. The Workbench therefore cannot distinguish ordinary compile failure from renderer infrastructure failure, cannot publish target ranges, and cannot preserve a structured warning set from a successful build.

Actor and asset resolution already happens during lowering. Reconstructing semantic identities later with LSP text search would diverge from aliases, history markers, Pack/headless identities, and resource selector resolution. The immutable analysis snapshot is the only acceptable semantic source.

## Decisions

### Diagnostic origin precision

`EmittedTypst` exposes one authored-parent convergence query. For a non-empty diagnostic range it examines every overlapping source-map chunk. Each chunk follows `Origin::Generated.parent` until it reaches an `Origin::MmtRange` or terminates. Mapping succeeds only if every covered chunk reaches the same authored range. A point diagnostic uses the containing chunk with the established boundary rule. Different parents, missing parents, invalid boundaries, or cycles are unmapped.

`ProjectionDocument::map_diagnostic` first uses the existing Identity exact mapper for the complete range, then the convergence query for a coarse authored range. No statement/resource patch overlap exception remains. Related information uses the same per-location algorithm. A related location outside the entry URI retains its URI and range.

`emit_text_source` parents a generated `#text(...)` wrapper to the corresponding `TextBody` range rather than the whole statement. This improves diagnostic placement without changing projection segment classification.

Exact and coarse diagnostic results do not change edit authorization. `ProjectionIndex::typst_to_mmt`, `map_text_edit`, `mmt/validateProjectedEdit`, formatting, code actions, and rename continue to require a complete current Identity segment.

### Nullable item mapping

`mmt/mapTypstDiagnostics` returns an array with the same length and order as its input. Each slot is a mapped `Diagnostic` or `null`. Decode or mapping failure is isolated to that slot. The TypeScript consumer validates an explicit nullable diagnostic allowlist before use.

Batch publication remains atomic at the higher revision boundary: malformed outer identity or a stale response rejects the whole renderer batch. Nullable per-item results are not a license to combine identities.

### Renderer response state machine

The fixed renderer uses Tinymist's existing `tinymist_query::convert_diagnostics` with its negotiated `position_encoding`. It never parses `print_diagnostics_to_string` output. Converted `lsp_types::Diagnostic` values are keyed by canonical URI and flattened as `{ uri, diagnostic }` records sorted by URI, range, severity, and message.

A successful `ready` response contains `diagnostics`, including warnings and information, in addition to the staged preview payload. A compile failure returns a result rather than a JSON-RPC error:

- `status: "compileFailed"`
- `protocolVersion`, `sessionId`, `snapshotToken`, `sourceDigest`, `compilerRevision`
- `diagnostics`

It contains no `generation`, creates no staged artifact, and does not advance the committed or next generation. The next valid request uses the prior committed generation as its base. Session, digest, frame, transport, converter, and infrastructure faults remain JSON-RPC errors.

Native process and WASM Worker expose the same JSON shape and ordering. The shared TypeScript decoder strictly validates the discriminant, identity fields, URI, LSP positions/ranges, severity, code, data, tags, and related information; unknown or malformed structures fail closed.

### Workbench publication and stale rules

`PreviewRendererSessionOwner` validates a compile-failed identity before exposing it. It maps each synthetic mounted URI through the request's immutable `originalUris` table. Unknown, duplicate, or non-canonical mount identities reject the batch. It throws a typed `PreviewRendererCompilationError` carrying synchronized project identity and mapped records, and sets `preserveCommitted = true`. A successful response maps warnings through the same function before commit.

The editor-level mapper divides records by URI:

- Entry URI records call nullable `mmt/mapTypstDiagnostics` and use exact/coarse authored results.
- Non-entry records preserve their workspace, package, or generated project URI and original range.
- Records without source spans contribute only to preview status.

After mapping returns, the mapper rechecks source version, revision, source content, project digest, projection key, snapshot token, and backend generation. Any stale identity or malformed batch publishes nothing.

`UnifiedTypstProblemsPublisher` owns preview diagnostics by MMT source URI but groups replacement and clearing by actual target URI. Exact/coarse diagnostics target authored `.mmt`; dependency and generated diagnostics target retained read-only `mmt-package:` or `mmt-projection:` documents. For an otherwise identical target/range/severity/message, preview/build diagnostics shadow language diagnostics. Clearing preview diagnostics reveals the current language item again.

Compile failure is a Layout-phase build result. It preserves the last committed SVG and marks it stale. A corrected render clears layout diagnostics and commits the next generation. Range-less Renderer failure is reserved for transport, digest, SVG frame, protocol, or infrastructure faults.

### Semantic identities and occurrences

Lowering produces a snapshot-local index; LSP does not search source text.

Navigation key:

- `SemanticSymbolKey::Actor(ActorId)`
- `SemanticSymbolKey::Asset(AssetId)`

Rename binding key:

- `RenameBindingKey::ActorName { actor, name }`
- `RenameBindingKey::Asset(AssetId)`

Each `SemanticOccurrence` stores an exact UTF-8 `TextRange`, `Definition | Reference`, optional rename binding, and syntax kind: declaration literal, raw explicit speaker, history marker, or resource macro argument. `symbol_at` selects the smallest containing exact range and returns none for tied ambiguity.

Actor occurrences are recorded only after semantic identity is known: the first successful primary/`also-as` binding, later `@actor name` reopen tokens, explicit speakers, `_`/`~` history markers, and explicit resource subjects. Omitted speakers have no token and no occurrence. Aliases share ActorId navigation identity; explicit alias Definition targets that alias binding; history Definition targets the primary authored binding. A Pack/headless actor reference may be navigable but has no authored definition or rename binding. Builtin speakers are excluded.

Asset lowering retains exact `name_range`. Resource lowering records a script asset only after selector resolution proves it. Pack assets remain read-only and are not rename bindings.

References aggregate by navigation key and honor `includeDeclaration`. Rename aggregates only the selected binding key. Therefore one alias rename does not modify another alias or history marker.

### Native semantic operations

The language service reads only `DocumentSnapshot.analysis.semantic_index` and converts ranges using the negotiated UTF-8/UTF-16 position encoding.

`prepareRename` returns the exact occurrence range and logical placeholder only when the selected occurrence has an editable binding and the snapshot has no Error diagnostic. Unresolved, ambiguous, Pack, builtin, positional, history, omitted, and incompletely serializable identities return null.

Actor-name rename reuses declaration literal parsing/encoding and requires every raw speaker replacement to parse back as the same Explicit marker. Asset names satisfy `valid_asset_name`; resource arguments retain their original selector form. Collisions, alias collapse, or one unroundtrippable occurrence reject the whole operation.

Candidate edits are applied in memory and full pure analysis is rerun. Acceptance requires:

- zero Error diagnostics;
- target definition/reference counts and roles unchanged;
- actor speaker/history/resource ActorId resolution unchanged;
- asset source/selector resolution changes only to the expected renamed AssetId;
- unrelated semantic keys unchanged.

The result is one `TextDocumentEdit` with the current `OptionalVersionedTextDocumentIdentifier.version`. No private apply notification and no projected-edit validator participates.

### One semantic provider route

`mmt/semanticRoute` returns `native`, `projected`, or `none` for the current snapshot and position. Syntax plus semantic-index token zones select native, including unresolved actor/asset/speaker/resource tokens so errors cannot fall through. Otherwise only a current `AuthoredIdentity` position in `ProjectionStore` selects projected. Synthetic, Escaped, MacroExpansion, stale, and ambiguous positions select none.

One `installMmtSemanticMiddleware` is installed unconditionally in Desktop, Web extension host, and standalone Workbench, and is composed with rather than replacing existing Typst middleware. Definition, References, prepareRename, and rename middleware use the route:

- native: call MMT `next()` only; null/error never falls back;
- projected: call the late-bound Tinymist dispatcher; reads reuse `mmt/mapTypstReadLocations` plus navigation mapping, rename reuses `ProjectedEditAdapter` plus `mmt/validateProjectedEdit`;
- none: return undefined.

`.typ` documents never call MMT `next()` and remain owned by standalone Typst providers when a backend exists. Removing the independent `{ language: "mmt" }` projected rename registration prevents provider-order races. Range formatting and code action registrations remain. Dispatcher install/clear follows backend connection lifecycle; without Tinymist, native operations continue and projected operations fail closed.

## Rejected Alternatives

- Mapping a diagnostic by range start: hides cross-parent ambiguity.
- Treating any overlapping authored chunk as coarse: can blame the wrong statement.
- Reusing diagnostic fallback for edits: violates the existing projection safety boundary.
- Parsing formatted renderer errors: discards machine-readable URI/range/severity and drifts from Tinymist.
- Assigning generation to compile failures: creates holes and breaks committed-base recovery.
- LSP-side source text search: cannot reproduce lowering identity or selector semantics.
- Renaming all names for one ActorId: incorrectly merges independent authored aliases.
- Registering native and projected providers independently: provider precedence becomes host-order dependent.
- Returning partial rename edits: violates atomic single-document semantic rename.

## Risks and Mitigations

- Tinymist converter API may not directly accept the pinned artifact graph. Add only a thin graph adapter and parity-test it against the upstream notification converter; do not add another Span converter.
- Position encodings can drift across native/WASM boundaries. Transcript fixtures compare UTF-8 and UTF-16 with CJK and astral text.
- Retained dependency documents may outlive a build. Ownership is revision-checked and grouped by source owner so cleanup cannot clear another current build.
- Reanalysis could accidentally permit unrelated semantic changes. Structural semantic-index comparison is an acceptance gate, not only a diagnostic check.
- Middleware APIs differ across language-client versions. Use the installed client types and one shared implementation exercised in Desktop and Web Extension Hosts.

## Artifact Procedure

Modify the pinned Tinymist checkout, recapture the renderer patch with `capture-tinymist-patch.mjs "$TINYMIST_SRC" renderer`, update the patch digest, run patch `verify`, then `build-promote`. Run native and Worker protocol parity/transcript tests before `repin`. Only `repin` may update artifact sizes/SHA, vendored Web package, native fixture, and `third_party/tinymist/SHA256SUMS`; vendored binaries are never edited manually.
