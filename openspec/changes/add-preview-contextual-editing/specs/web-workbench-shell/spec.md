## ADDED Requirements

### Requirement: Preview contextual controls remain transient clients of owned state

The production Web Workbench MAY expose contextual editing from the displayed preview, but the preview DOM、native context menu and Input Box SHALL remain transient clients of the current PreviewArtifact、MMT language service and VS Code TextDocument owners. They SHALL NOT create another document buffer、AST cache、property store or preview revision authority.

#### Scenario: Author right-clicks an editable chat bubble

- GIVEN the displayed artifact is current and no preview text selection is active
- WHEN the author invokes `contextmenu` on rendered text or on an exporter-labelled bubble、avatar or display-name region whose opaque token groups one rendered target
- AND the labelled SVG root is connected beneath the current preview page with the active DOM render generation
- AND the runtime resolves a labelled text region with that same token or preserves the exact text hit
- AND the language service proves one editable statement target from the resulting current backend location
- THEN the Workbench MUST open its native context-menu service beside the pointer to offer source navigation、continued state and available actor display-name editing
- AND a display-name action MUST open a native InputBox in a Workbench context view beside the original pointer rather than in the top Quick Input
- AND semantic hit testing MUST NOT cross target tokens、infer ownership from SVG order、cross an unrecognized closest label、accept an earlier DOM generation or convert page whitespace into a guessed target
- AND SVG labels MUST contain only a bounded deterministic opaque token plus visual role, never authored ranges、actor identity、display text、freshness evidence or edit authority
- AND the preview Webview message MUST carry only the normalized point and a visual-only screen anchor
- AND every mutation MUST be requested from the shared language service as a structured Composer command

#### Scenario: Interactive SVG labels do not authorize unsupported nodes

- GIVEN narration、reply or bond output carries exporter-authored target and role labels
- WHEN the author invokes `contextmenu` on those labelled regions
- THEN the runtime MAY use the label only to resolve a same-target visual point within the active DOM generation
- AND the language service MUST continue to classify narration、reply and bond as unsupported for mutation in this slice
- AND the Workbench MUST expose navigation only when the existing permission-checked mapping allows it
- AND the Workbench MUST NOT expose continued or display-name actions for them

#### Scenario: Author has selected preview text

- GIVEN a non-collapsed rendered text selection exists
- WHEN the author right-clicks the selection
- THEN contextual editing MUST NOT replace the browser's text-selection/copy interaction
- AND no Composer target request may be sent for that gesture

#### Scenario: Context UI outlives its identity

- GIVEN a native context menu or Input Box was opened for document version V and artifact identity A
- WHEN the document version、accepted artifact、runtime owner or preview binding changes before application
- THEN the transient UI/request MUST be cancelled or its result rejected
- AND it MUST NOT retarget the command to the new document or artifact

#### Scenario: Contextual edit succeeds

- GIVEN the language service returns one current-version WorkspaceEdit and the client applies it
- WHEN normal TextDocument change handling runs
- THEN workspace persistence、Local History、diagnostics and latest-wins preview scheduling MUST observe the same edit
- AND the preview UI MUST derive the next visible state from the newly accepted artifact rather than mutating the old SVG

#### Scenario: Authored content is navigable but not editable

- GIVEN the current mapped point belongs to authored narration or another target intentionally unavailable for Composer mutation
- WHEN the author requests contextual editing and bidirectional navigation is enabled
- THEN the Workbench MUST show a pointer-adjacent native menu containing only `转到源码`
- AND navigation MUST use the existing permission-checked preview navigation path
- AND the Workbench MUST NOT guess a nearby editable statement、show mutation actions or modify source

#### Scenario: Contextual edit and navigation are unavailable

- GIVEN the point belongs to stale、unmapped、ambiguous、package/generated-only content or cannot be proven as current authored source
- WHEN the author requests contextual editing
- THEN the Workbench MAY show a concise native unavailable/rejected notification
- AND MUST NOT guess a nearby statement、open a custom persistent inspector or modify source

### Requirement: Preview contextual resources use the existing runtime owner

Context-point listeners、in-flight target/edit requests、cancellation controllers and transient context-menu/Input Box resources SHALL be acquired and released through the existing `EditorRuntimeController` lifecycle.

#### Scenario: Workbench tears down during contextual editing

- GIVEN a target request、native context menu or Input Box is active
- WHEN HMR、unload、startup rollback or controlled runtime disposal begins
- THEN the request and input MUST be cancelled before stale callbacks can publish or apply state
- AND no second runtime owner or independent disposal graph may be created
