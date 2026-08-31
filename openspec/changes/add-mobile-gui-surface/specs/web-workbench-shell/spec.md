## ADDED Requirements

### Requirement: GUI Composer is a native URI-only Workbench editor

The production GUI Composer SHALL register `mmt.guiComposer` before `api.start()` through the pinned ViewsService override's public `SimpleEditorPane`、`SimpleEditorInput`、`registerEditorPane`、`registerEditor` and `registerEditorSerializer` exports. It SHALL be acquired、quiesced and disposed by the existing single `EditorRuntimeController`; it SHALL NOT use Sidebar、overlay、Webview/iframe、WorkspaceService or a second shell as its primary card editor.

#### Scenario: GUI editor registration succeeds

- GIVEN the pinned 21.6.0 public editor APIs are available
- WHEN the GUI Composer is registered
- THEN `**/*.mmt` and `**/*.mmt.txt` MUST have one optional、single-per-resource `mmt.guiComposer` editor
- AND `vscode.openWith(uri, "mmt.guiComposer")` MUST open that native editor pane
- AND the pane、ComposerRuntime、snapshot subscriptions and transient sheets MUST each be owned by the current EditorRuntimeController
- AND it MUST consume the existing TextDocument、mmtfs workspace、Pack catalog、notification service、PreviewArtifactStore、history and export owners
- AND no second document buffer、Monaco model、persistence queue、preview store or runtime lifecycle may be created

#### Scenario: GUI input is serialized and restored

- GIVEN `ComposerEditorInput` is opened for one resource
- WHEN Workbench serializes or reloads the editor
- THEN the input MUST persist only a versioned `{uri}` envelope and use singleton resource capability
- AND restoration MUST call `openTextDocument(resource)` and rebuild from the current Rust snapshot
- AND card/model/document content MUST NOT be serialized by the editor input

#### Scenario: Author switches source and GUI surfaces

- GIVEN source editor and GUI Composer are both available for one MMT URI
- WHEN the selected surface changes
- THEN both MUST continue to address the same open TextDocument、Monaco model and current preview owner
- AND switching MUST NOT copy bytes、close/reopen the document to synchronize state or create a competing selected-document authority

#### Scenario: Runtime quiesces or PWA update is accepted

- GIVEN GUI requests、pending commands or bottom sheets exist
- WHEN runtime quiesce、HMR、unload or safe PWA restart begins
- THEN GUI work admission MUST stop through the same EditorRuntimeController boundary
- AND pending work/subscriptions MUST cancel and dispose in reverse acquisition order
- AND durable TextDocument flushing and Service Worker activation MUST remain owned by the existing PWA safe-restart path

### Requirement: Desktop and mobile presentations preserve stable shell geometry

The native GUI editor pane MAY present desktop and mobile layouts in the same Web bundle, but SHALL preserve ViewsService part ownership and the existing SplitView geometry. Responsive styling SHALL NOT become a second shell state machine.

#### Scenario: Desktop GUI is opened

- GIVEN the viewport is wider than 550 CSS px and uses the stable Activity Bar、Sidebar、Editor/Panel topology
- WHEN an MMT document first opens
- THEN the ordinary text editor MUST remain the default surface
- AND explicit GUI activation MUST open `mmt.guiComposer` in the native editor area
- AND Sidebar/main and Editor/Panel geometry MUST remain owned by the existing SplitViews
- AND custom CSS or card state MUST NOT hide/reconstruct Workbench Parts as an alternative layout owner

#### Scenario: Mobile GUI is opened by default once

- GIVEN `matchMedia("(max-width: 550px)")` matches for an MMT URI/document-incarnation not yet admitted in this page lifecycle
- WHEN the document first opens or restores
- THEN Workbench MUST open `mmt.guiComposer` and MAY hide Sidebar through the existing Part visibility API
- AND if the user explicitly switches to advanced source, that URI/incarnation MUST NOT be forced back to GUI again during the same page lifecycle
- AND a different URI or new document incarnation MUST independently apply the rule
- AND ViewsService MUST remain the authority for Parts and visibility
- AND no legacy React shell or separate App bundle may own the mobile document

#### Scenario: Source fallback is requested

- GIVEN an Opaque node or advanced action requests source navigation
- WHEN the GUI adapter opens the authored range
- THEN it MUST use the existing TextDocument/editor/navigation boundary
- AND MUST NOT promote preview fallback、opaque display source or client-calculated offsets into edit authority

### Requirement: GUI observable behavior is browser-qualified at desktop and mobile boundaries

GUI ownership、accessibility、freshness and persistence SHALL be verified through the actual production Workbench/PWA surface rather than source-text assertions or standalone component mocks alone.

#### Scenario: Desktop authoring loop is verified

- GIVEN a production-built Workbench opens a mixed MMT document
- WHEN browser automation inserts、edits、moves and deletes supported cards
- THEN tests MUST observe one accepted WorkspaceEdit per action、one TextDocument version chain、Local History entries、latest preview revisions、reload persistence and export readiness
- AND source bytes for every non-target Opaque node MUST remain exact

#### Scenario: Mobile controls are verified

- GIVEN 550px and 320px mobile viewports plus a 551px desktop-default boundary
- WHEN browser automation opens cards、editors、pickers、history and preview
- THEN 551px MUST initially show source while 550px and 320px initially show `mmt.guiComposer`
- AND tests MUST observe reachable 44px controls、safe-area protection、soft-keyboard-safe focus and button-only reorder capability at 320px
- AND no required action may depend on hover、right click、drag or horizontal page scrolling
- AND the GUI card list and preview viewport MUST retain their respective sole scroll ownership without body-level double scrolling

#### Scenario: Stale GUI operation is verified

- GIVEN a card editor、confirmation or picker is open
- WHEN TextDocument version、Composer snapshot、PreviewArtifact、Pack catalog or runtime identity advances
- THEN the actual transient surface MUST close or reject
- AND tests MUST observe zero retargeted edit/apply attempts and at most one native MomoScript notification
- AND the new surface state MUST derive from the newly accepted owners