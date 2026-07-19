# web-workbench-shell 规格

## Purpose

定义 `editors/vscode-web` 嵌入式 VS Code Workbench shell 的稳定拓扑、状态所有者和生命周期边界。完整的语言、project、preview、export 与 PWA 行为继续由对应 capability spec 负责；本规格只约束这些能力怎样接入一个 shell，不重新定义各产品能力自身的合同。

## Requirements

### Requirement: The embedded shell has one stable topology

Web editor SHALL create one fixed topology: root contains body、Status Bar and product Preview hosts; body contains Activity Bar and primary; primary contains Sidebar and main; main contains Editor and Panel. The Monaco wrapper SHALL use `viewsConfig.$type = "ViewsService"`; inside its initialization callback the shell SHALL use Views Service `attachPart` for `ACTIVITYBAR_PART`、`SIDEBAR_PART`、`EDITOR_PART` and `PANEL_PART`, while the status-bar renderer SHALL attach the Status Bar. Every returned attachment or renderer disposable SHALL be registered with the product runtime owner.

The Sidebar/main boundary SHALL be one native horizontal VS Code `SplitView`, and the Editor/Panel boundary inside main SHALL be one native vertical `SplitView`. CSS MAY style or arrange the outer fixed regions, but CSS Grid tracks、handwritten drag handles and parallel sash implementations MUST NOT own Workbench geometry.

#### Scenario: The shell starts

- GIVEN the root Workbench container exists
- WHEN layout initialization runs
- THEN every fixed host MUST be created exactly once
- AND the horizontal and nested vertical `SplitView` instances MUST be the only resizable shell geometry owners
- AND each Workbench Part MUST attach to its designated host through Views Service

#### Scenario: A maintainer changes sash sizing

- GIVEN the current shell initializes SplitView sizes for each page lifetime
- WHEN a maintainer changes an initial、minimum or maximum size
- THEN the change MUST remain in the owning SplitView configuration
- AND MUST NOT be implemented with a CSS Grid column or row、a handwritten sash or a second width/height state
- AND documentation and verification MUST NOT claim that sash sizes persist across reload unless a future approved persistence owner implements and proves that behavior

### Requirement: Visibility and geometry have explicit owners

Views Service SHALL be the authority for Workbench Part existence、selected view container and Part visibility. The two shell SplitViews SHALL own host geometry and SHALL mirror the initial and subsequent Sidebar/Panel visibility reported by Views Service. CSS classes MAY expose state for styling or diagnostics, but MUST NOT be an authoritative visibility state.

#### Scenario: The selected Activity item is toggled

- GIVEN the selected Activity tab represents the current Sidebar container
- WHEN the author requests collapse or restore
- THEN the shell MUST call the Views Service Part visibility API
- AND MUST NOT unregister、move or reconstruct the current View descriptor
- AND the visibility event MUST update the horizontal SplitView host visibility

#### Scenario: A Part is hidden

- GIVEN Views Service reports Sidebar or Panel hidden
- WHEN the shell applies that state
- THEN the corresponding SplitView view MUST stop occupying geometry
- AND hidden content MUST not remain focusable through an off-screen or zero-width CSS cell
- AND restoring the Part MUST preserve its native View content

### Requirement: Product state has one owner per domain

The shell SHALL preserve the following ownership matrix:

| Domain | Sole authority |
|---|---|
| Workbench Part instances、selected container and visibility | Monaco VS Code Views Service and its Part APIs; attachment disposables are product resources owned by the runtime controller |
| Sidebar/main and Editor/Panel geometry | The two `SplitView` instances created by the shell layout |
| Current authored document content | VS Code `TextDocument`; durable workspace bytes are owned by the `mmtfs` workspace provider/coordinator |
| Product runtime startup、work admission、quiesce and disposal | One `EditorRuntimeController` containing one `RuntimeOwner` |
| Projection、materialization、accepted preview revision and retained preview artifacts | Stores owned by that `EditorRuntimeController`, including `PreviewArtifactStore` |
| Displayed preview DOM and viewport interaction | The runtime-owned `TypstPreviewController`, bound only to an accepted artifact identity |
| Root PWA registration and waiting-worker update flow | `registerPwaUpdateLifecycle`, using a narrow safe-restart adapter to the same product runtime |

#### Scenario: UI needs to reflect state

- GIVEN a Part、document or preview state changes
- WHEN UI updates
- THEN UI MAY derive labels、classes and controls from the owning service or store
- BUT MUST NOT create another mutable boolean、document buffer、revision map、artifact selection or persistence queue as a second source of truth

#### Scenario: PWA update prepares a reload

- GIVEN a waiting root Service Worker and a running editor
- WHEN the author accepts the update
- THEN the PWA adapter MUST flush durable workspace state、abort or drain registered work and call the existing controller's quiesce boundary
- AND MUST NOT create a second `RuntimeOwner` or independently dispose product Workers and subscriptions
- AND activation/reload ownership MUST remain separate from runtime disposal ownership

### Requirement: Initialization and disposal preserve dependency order

One `EditorRuntimeController` SHALL serialize each editor lifetime. The shell layout and custom View registration SHALL exist before `api.start()`. Part attachment SHALL occur only inside the Views Service initialization callback. Part queries、visibility subscriptions and status-bar rendering SHALL occur only after `api.start()` resolves.

Every product resource、subscription、listener、Worker handle、layout and preview controller SHALL be registered with the same controller as it is acquired. The runtime SHALL publish ready only after initialization completes. Startup failure and graceful disposal SHALL release resources in reverse acquisition order; HMR and unload SHALL route through the same idempotent controller disposal/termination boundary.

#### Scenario: Startup fails after Part attachment

- GIVEN layout and one or more Workbench/runtime resources have been acquired
- WHEN a later initialization step fails
- THEN ready MUST NOT be published
- AND the controller MUST roll back owned resources in reverse acquisition order
- AND the existing synchronous Worker/process termination fallback MUST remain available for a missed graceful deadline

#### Scenario: The page unloads or HMR replaces the module

- GIVEN the product runtime is ready or partially initialized
- WHEN unload or HMR disposal begins
- THEN no new product work may be admitted
- AND the event MUST reach the same `EditorRuntimeController`
- AND a separate shell、PWA or service-specific disposal graph MUST NOT be introduced

### Requirement: WorkspaceService adoption requires a separate migration proposal

The current `ViewsService` plus `attachPart` shell SHALL remain the layout model until a separate OpenSpec proposal explicitly migrates ownership to Monaco's `WorkspaceService`. Such a proposal is REQUIRED when a change depends on full Workbench shell/layout ownership rather than attached Parts—for example native ownership of additional Workbench regions、Workbench layout commands across the complete shell、or durable Workbench sash/layout restoration across reload.

WorkspaceService MUST NOT be added alongside the current SplitView geometry as a second layout owner. A migration proposal SHALL identify the complete topology cutover、state migration/removal、persistence semantics、service configuration、accessibility behavior and browser verification. WorkspaceService MAY replace shell/layout ownership, but it MUST NOT replace MomoScript's `EditorRuntimeController`、`RuntimeOwner`、document persistence、preview revision ownership or runtime disposal.

#### Scenario: A feature requires persisted sash sizes

- GIVEN current SplitView sizes are page-lifetime state only
- WHEN persisted reload restoration becomes a product requirement
- THEN the change MUST first propose the persistence and layout owner
- AND if it selects WorkspaceService it MUST remove the superseded SplitView geometry path rather than synchronize two layouts
- AND the runtime lifecycle MUST remain owned by `EditorRuntimeController`

### Requirement: Verification proves observable ownership boundaries

Shell changes SHALL be verified in a real browser through native accessible semantics and user-visible behavior. Verification SHALL cover initial Part state、subsequent hide/restore、native sash resize、preservation of Explorer/View content、Panel behavior and disposal/reload boundaries applicable to the change.

#### Scenario: Sidebar behavior is verified

- GIVEN Explorer is the selected native Activity tab
- WHEN the author collapses、restores、resizes and switches containers
- THEN tests MUST observe native `tab`/`aria-selected` semantics
- AND MUST observe the real `Files Explorer` tree after restore
- AND MUST prove that hidden Sidebar geometry is absent
- AND MUST NOT treat a CSS class、title or screenshot alone as proof

#### Scenario: Lifecycle behavior is verified

- GIVEN a startup failure、HMR、unload or accepted PWA restart path changes
- WHEN focused verification runs
- THEN it MUST observe one runtime controller、reverse rollback or quiesce/disposal ordering and the termination fallback relevant to that path
- AND a PWA test MUST prove durable-state blockers prevent activation without creating a second runtime owner
- AND reload tests MUST distinguish authored-document persistence from the currently unsupported sash-size persistence
