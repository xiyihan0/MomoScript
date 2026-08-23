## ADDED Requirements

### Requirement: Preview contextual controls remain transient clients of owned state

The production Web Workbench MAY expose contextual editing from the displayed preview, but the preview DOM and Quick Input UI SHALL remain transient clients of the current PreviewArtifact、MMT language service and VS Code TextDocument owners. They SHALL NOT create another document buffer、AST cache、property store or preview revision authority.

#### Scenario: Author right-clicks an editable chat bubble

- GIVEN the displayed artifact is current and no preview text selection is active
- WHEN the author invokes `contextmenu` inside a rendered page and the language service proves one editable statement target
- THEN the Workbench MUST use native Quick Pick/Input Box controls to offer source navigation、continued state and available actor display-name editing
- AND the preview Webview message MUST carry only the normalized point rather than authored ranges、actor identity or property values
- AND every mutation MUST be requested from the shared language service as a structured Composer command

#### Scenario: Author has selected preview text

- GIVEN a non-collapsed rendered text selection exists
- WHEN the author right-clicks the selection
- THEN contextual editing MUST NOT replace the browser's text-selection/copy interaction
- AND no Composer target request may be sent for that gesture

#### Scenario: Context UI outlives its identity

- GIVEN Quick Pick/Input Box was opened for document version V and artifact identity A
- WHEN the document version、accepted artifact、runtime owner or preview binding changes before application
- THEN the transient UI/request MUST be cancelled or its result rejected
- AND it MUST NOT retarget the command to the new document or artifact

#### Scenario: Contextual edit succeeds

- GIVEN the language service returns one current-version WorkspaceEdit and the client applies it
- WHEN normal TextDocument change handling runs
- THEN workspace persistence、Local History、diagnostics and latest-wins preview scheduling MUST observe the same edit
- AND the preview UI MUST derive the next visible state from the newly accepted artifact rather than mutating the old SVG

#### Scenario: Contextual edit is unavailable

- GIVEN the point belongs to narration、reply、bond、raw Typst、package/generated-only content、a stale artifact or an unsupported actor
- WHEN the author requests contextual editing
- THEN the Workbench MAY show a concise native unavailable/rejected notification
- AND MUST NOT guess a nearby statement、open a custom persistent inspector or modify source

### Requirement: Preview contextual resources use the existing runtime owner

Context-point listeners、in-flight target/edit requests、cancellation controllers and transient Quick Input resources SHALL be acquired and released through the existing `EditorRuntimeController` lifecycle.

#### Scenario: Workbench tears down during contextual editing

- GIVEN a target request or Quick Input is active
- WHEN HMR、unload、startup rollback or controlled runtime disposal begins
- THEN the request and input MUST be cancelled before stale callbacks can publish or apply state
- AND no second runtime owner or independent disposal graph may be created
