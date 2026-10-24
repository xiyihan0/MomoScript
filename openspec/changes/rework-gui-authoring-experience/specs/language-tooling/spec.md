## MODIFIED Requirements

### Requirement: Web preview and workspace expose authored structure

The Web editor SHALL render Typst SVG with user-controlled zoom in output/layout presentation and fixed logical-unit scale in temporary chat presentation. It SHALL represent its `mmtfs://workspace/` authority as the workspace root without creating a duplicate `/workspace` child path. Chat SHALL NOT rewrite author settings or expose paper zoom/fit/page chrome; source and layout SHALL retain the existing output controls.

#### Scenario: Existing browser workspace starts

- GIVEN IndexedDB contains the historical empty `/workspace` directory entry
- WHEN the editor starts
- THEN it MUST remove that empty compatibility entry
- AND `story.mmt` MUST remain at `/story.mmt`
- AND output/layout preview controls MUST support zoom in、zoom out、actual size and fit width without rasterizing the SVG

#### Scenario: Fitting preserves the current reading point

- GIVEN an author has scrolled into a long output/layout SVG preview or GUI canvas using a fit mode
- WHEN Fit width、Fit page or a resize in the current fit mode changes scale
- THEN the current viewport-center document point MUST remain anchored, subject to the natural scroll bounds
- AND the final compensated viewport MUST be reported rather than the old scroll-pixel offset
- AND an earlier caret or selected message MUST NOT replace the current reading point

#### Scenario: A saved viewport is restored

- GIVEN a document and presentation have a saved compatible page point and fit mode
- WHEN the shared preview binds that document/presentation
- THEN the saved point MUST take precedence over the previous document's viewport center
- AND fitting MUST NOT introduce an intermediate center restoration that cancels the explicit saved target
- AND viewport reports MUST carry the required render key of their displayed artifact
- AND only a report matching the currently bound artifact MAY update its workspace/URI/presentation viewport; an in-flight or retired frame MUST NOT overwrite another document's or presentation's reading point

#### Scenario: Author resizes editor and preview panes

- GIVEN the Web workbench shows editor and preview side by side
- WHEN the author drags the accessible separator or uses its keyboard controls
- THEN the editor and preview widths MUST update without overlapping either pane
- AND double-click or the reset key MUST restore the equal split

#### Scenario: Author collapses auxiliary panes

- GIVEN the file explorer and preview are visible
- WHEN the author activates either accessible collapse control
- THEN that pane MUST be removed from the workbench layout and the editor MUST use the released width
- AND the control MUST remain available to restore the pane
- AND the preview control MUST NOT overlap zoom or fit controls

#### Scenario: Plain body hashes are not default color literals

- GIVEN an MMT text body contains `#123` or another hash-prefixed fragment
- WHEN the editor's default color detector scans the document
- THEN MMT language defaults MUST suppress that detector
- AND dedicated Typst color providers MAY still operate on projected Typst regions

#### Scenario: Statement patches use Typst argument scopes

- GIVEN a statement patch and a Typst façade call contain equivalent named arguments
- WHEN TextMate tokenization highlights both forms
- THEN parameter names、colons、units、nested calls、strings and operators in the patch MUST use the corresponding Typst scopes

#### Scenario: Multi-page SVG remains vector and visually separated

- GIVEN an output/layout render emits more than one `.typst-page` group
- WHEN the Web preview imports the SVG
- THEN consecutive page groups MUST have a visible gap
- AND zoom、actual size and fit width MUST continue to transform the SVG without rasterization

#### Scenario: Browser SVG text can be selected and copied safely

- GIVEN typst.ts emits `.tsel` XHTML inside SVG `foreignObject` nodes
- WHEN the Web preview sanitizes and imports that renderer output
- THEN validated text-only `div` / `span` selection nodes MUST remain selectable and copyable
- AND prefixed XHTML parser artifacts MUST be normalized to real XHTML elements
- AND unexpected selection-subtree elements、attributes or styles MUST be rejected
- AND active SVG content、event handlers and external resource references MUST be removed before import

### Requirement: Activity Bar controls auxiliary panes

In source/advanced-workspace mode, the standalone Web workbench SHALL expose persistent Activity Bar controls that collapse and restore the corresponding auxiliary panes with accurate accessible state. Chat/layout MAY temporarily hide native Parts through their visibility APIs, without overwriting persistent preferences; returning to source SHALL restore the prior native visibility state.

#### Scenario: Activity Bar controls auxiliary panes

- GIVEN the standalone Web workbench is in source/advanced-workspace mode
- WHEN the author uses the Explorer Activity Bar item or the preview collapse control
- THEN the corresponding pane MUST collapse and restore through the same persistent control
- AND the control's accessible name and expanded state MUST describe the next action and current state

## ADDED Requirements

### Requirement: Render preset is an exact native and WASM project contract

`mmt/getTypstRenderProject` SHALL accept optional `renderPreset` equal to exactly `{kind:"output"}` or `{kind:"chat",widthPt:number}`. Omission SHALL mean output. Rust SHALL model Output or Chat with width_pt:u32, and the public render response SHALL return renderPreset with the same DTO for presentation isolation. All native/WASM/extension/Workbench consumers SHALL migrate together.

#### Scenario: A valid preset is requested

- GIVEN one current TextDocument snapshot and acknowledged registry
- WHEN output, omitted preset, or chat with integer width240–720 is requested
- THEN explicit and omitted output MUST retain the same output semantics
- AND chat MUST affect only the render projection, not authored bytes, document version or language projection
- AND response renderPreset MUST identify the actual project presentation

#### Scenario: A preset is malformed

- GIVEN an unknown kind, extra key, output width, missing chat width, noninteger/nonfinite/nonnumber width or width outside240–720
- WHEN native stdio or WASM decodes it
- THEN it MUST fail explicitly as invalid params before rendering
- AND no transport/client MUST coerce, default, clamp or ignore malformed fields

### Requirement: Presentation participates in the complete render identity chain

EmitOptions, render ProjectionProfile, render-project generation, options digest and render/projection cache SHALL include preset, chat width and presentation version. sourceDigest SHALL remain a digest of canonical authored source only. The deterministic language projection SHALL remain independent of temporary render presentation.

#### Scenario: One source is rendered in different presentations

- GIVEN identical URI, source bytes/version, registry and other render inputs
- WHEN output, chat width320 and chat width390 projects are built
- THEN sourceDigest MUST remain identical
- AND generated Typst/source map, projectDigest, projectionKey and renderKey MUST belong to their own presentation identities
- AND exact mapping in each project MUST return the same relevant authored range without using another project's map
- AND returning to a cached presentation MUST retain its own identity rather than borrow another preset's base

#### Scenario: Presentation changes during incremental rendering

- GIVEN an existing committed output or chat render
- WHEN preset or chat width changes
- THEN synchronization MUST use the existing complete/full path before accepting new interaction
- AND another preset's incremental base MUST NOT be reused
- AND old session/generation/render keys MUST NOT authorize new presentation input
- AND no extra retry or fabricated digest MAY bypass existing rejection

### Requirement: Message insertion atomically accepts an optional avatar choice

New-message payloads SHALL include `avatar: ComposerAvatarChoice | null` with corresponding Rust Option; all repository callers SHALL migrate in one cutover. The current builtin speaker identity and right-side constraints SHALL remain authoritative. Rust SHALL own any required actor-avatar revision and statement serialization.

#### Scenario: A message is sent with an expression

- GIVEN a legal boundary, current speaker and verified avatar identity
- WHEN insertStatement executes
- THEN Rust MUST re-resolve the current entity/contribution namespace/variant identity
- AND when required it MUST serialize an avatar revision from that statement together with the new message in one versioned single-document WorkspaceEdit and one native undo stop
- AND it MUST NOT change another speaker or earlier actor/avatar state
- AND the candidate MUST preserve later explicit revision boundaries and every unrelated byte/semantic state
- AND TS MUST NOT send @actor source or apply a separate preliminary edit

#### Scenario: Avatar or builtin insertion is unavailable

- GIVEN an unknown/stale/ambiguous avatar, invalid speaker capability or a teacher-left request
- WHEN the command is parsed or reanalyzed
- THEN the ordinary explicit malformed/stale/resource/candidate rejection MUST return no partial edit
- AND neither transport MUST silently choose a different role, side, contribution or default expression

### Requirement: Side changes are Rust-authorized structure edits

`mmt/composerEdit` SHALL add `setStatementSide` with side to the strict structure-command union, backed by core SetStatementSide. ComposerMessageCapabilities.setSide SHALL expose the allowed side values rather than a boolean. Only current authorized nodes SHALL be writable.

#### Scenario: An ordinary message changes side

- GIVEN a current Message with requested side in its setSide array
- WHEN setStatementSide executes
- THEN Rust MUST serialize through the existing structure path and fully parse/analyze the candidate
- AND body, continued, speaker, actor/resource state and neighboring statement meaning MUST remain unchanged except for the authorized side transition
- AND one current-version TextDocumentEdit MUST be returned without `WorkspaceEdit.changes`
- AND TS MUST NOT replace sigils or infer allowed sides

#### Scenario: The side change is unauthorized or stale

- GIVEN teacher is requested on the left, a missing capability, Opaque/nonmessage target, stale digest/version or malformed command
- WHEN the request executes
- THEN it MUST reject without source mutation, retargeting or partial edit
- AND builtin teacher MUST never gain left-side capability

### Requirement: Semantic media insertion validates resources in Rust

ComposerNewStatement SHALL add exactly `{kind:"media",side,speaker,avatar,continued,media}`. media SHALL be exactly `{kind:"asset",assetName}`, `{kind:"workspaceImage",relativePath}` or `{kind:"sticker",entityId,setId,ordinal}`. Existing textual message/narration variants and source-gallery use SHALL remain supported; no arbitrary URL, DSL or raw TextEdit SHALL be admitted.

#### Scenario: A declared asset or Pack sticker is inserted

- GIVEN a current authorized insertion boundary
- WHEN an asset/sticker intent is submitted
- THEN Rust MUST prove the logical asset is declared or the canonical entity/set/ordinal resolves in the current Pack registry
- AND Rust MUST generate the existing macro body and statement through its serializer
- AND it MUST preserve actual contribution/variant/ordinal references and unrelated bytes/semantics
- AND missing, stale or invalid choices MUST reject without fallback selection

#### Scenario: A workspace image is inserted

- GIVEN a relativePath for a newly persisted workspace image
- WHEN workspaceImage is resolved
- THEN it MUST use the existing sanitized LocalFile resolver extended from basenames to safe forward-slash-separated paths relative to the authored document directory, including `assets/<uuid>.png|jpg`
- AND each segment MUST be nonempty and MUST NOT be `.` or `..`; absolute paths, backslashes, control characters and colons MUST be rejected rather than normalized into acceptance
- AND valid existing basename inputs MUST remain accepted, while arbitrary filesystem and URL access MUST remain unavailable to workspaceImage
- AND semantic lowering, language/render projection, browser loading and native materialization MUST apply the same path grammar and source-relative base
- AND native canonical-path/root containment checks MUST remain enforced, including against symlink escape; a syntactically valid path MUST NOT itself grant filesystem access
- AND Rust MUST choose a nonconflicting logical asset name and serialize the @asset declaration plus media statement as one versioned WorkspaceEdit
- AND full candidate analysis MUST precede edit return
- AND failure MUST produce no declaration-only or statement-only partial edit

#### Scenario: A client needs media choices

- GIVEN semantic analysis resolved declared assets in the current source snapshot
- WHEN ComposerDocumentSnapshot is returned
- THEN it MUST expose read-only asset choices derived by Rust, not TS parsing
- AND descriptor presence MUST NOT authorize missing textEditing/caret capabilities on media
- AND native/WASM strict-key, boundary, digest/version and candidate gates MUST remain identical

### Requirement: Renderer diagnostics preserve authored Typst entry ownership

Renderer diagnostics SHALL route an entry whose exact URI is the authored source URI directly through that retained source generation. Generated MMT entry diagnostics SHALL continue requiring the matching Rust projection. Native Typst failure SHALL NOT depend on an MMT projection or be silently discarded as stale.

#### Scenario: A current authored Typst entry fails to compile

- GIVEN the current source version, project/projection identity, backend generation and requested output snapshot match
- WHEN the renderer returns compilation diagnostics for the authored entry
- THEN the complete batch MUST retain strict diagnostic decoding, source position validation and coordinate conversion
- AND current compilation failure MUST settle the build, artifact and export waiter as failed while retaining the last accepted picture
- AND an older accepted picture MUST NOT become an export fallback for a failed latest output
- AND correcting the source MUST allow a new successful output and export
- AND generated MMT diagnostics without their matching projection MUST remain unavailable rather than acquire direct-source authority

