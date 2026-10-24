## ADDED Requirements

### Requirement: Viewport and interaction identities include presentation

Compatible viewport bookmarks SHALL be keyed by logical workspace, source URI and complete presentation including chat width/version. Existing semantic/page anchors, native scrolling and required renderKey report admission SHALL remain authoritative. Layout SHALL retain zoom/fit/page behavior; chat SHALL use fixed logical scale and no fit-width.

#### Scenario: A document changes mode or width

- GIVEN distinct chat/output reading anchors for one URI
- WHEN presentation changes or an old frame reports viewport
- THEN only a report matching the currently bound artifact renderKey MUST update its corresponding presentation bookmark
- AND another URI/preset/width MUST NOT be overwritten by old scrollTop or an in-flight report
- AND saved compatible semantic/page target MUST take precedence over the previous frame's viewport center
- AND a new fit/resize MUST preserve current reading point rather than earlier caret/selection, subject to real scroll bounds

#### Scenario: A presentation change retires an in-flight renderer candidate

- GIVEN render, discard or commit is in flight for an old session
- WHEN a preset/source change closes that session and a replacement starts
- THEN producer lifecycle operations MUST retain their per-session order and reject late retired results
- AND old candidate cleanup MUST NOT close a replacement session or clear a newer published consumer frame, including before producer commit
- AND genuine acknowledgement mismatches MUST remain errors; unrelated source sessions MUST remain independent


### Requirement: Export work transitions to an exact output snapshot automatically

Unified Export work SHALL use existing ExactExportUiController/ExactExportService queue and immutable artifacts. It SHALL accept only renderPreset output. From chat/source it SHALL drain accepted input, enter layout, wait for the output snapshot and automatically continue generation without a second click or another renderer owner. This requirement replaces the old unrestricted displayed-snapshot policy only where presentation differs.

#### Scenario: Export is requested from chat with a draft

- GIVEN accepted edits plus unsent bottom draft
- WHEN Export work is invoked
- THEN accepted edits MUST drain through the existing text channel
- AND output rendering MUST be awaited in layout before export
- AND unsent draft MUST remain intact and be explicitly excluded from the product
- AND the operation MUST NOT send the draft, implicitly save or export chat as output
- AND composition MUST obey the existing deferred mode-switch transaction

#### Scenario: Latest output is pending or old output exists

- GIVEN latest output is not ready
- WHEN the export queue is waiting
- THEN it MUST automatically continue once the correct complete output artifact is accepted
- AND only an explicit Export current layout snapshot choice MAY use stale output
- AND no stale chat artifact MAY be offered as an output fallback
- AND artifact identity, source/projection/render validation, immutable compiler/resource/font/runtime pin and finally release MUST remain enforced

### Requirement: Product exports declare format range and actual image size

Default format SHALL be PDF for the complete document unless an existing valid `mmt.export.defaultFormat` user preference overrides the initial selection. Selecting a format in the product Sheet SHALL NOT silently persist a new preference. PNG/JPG/SVG SHALL explicitly select an output page, including a page chooser for multipage products. Raster output SHALL be2× with actual pixel dimensions shown; JPG SHALL keep white background and0.92 quality. No unused DPI/scale/format controls SHALL be added.

#### Scenario: A multipage product is exported

- GIVEN an accepted complete output artifact
- WHEN PDF or a page image/SVG is generated
- THEN PDF MUST contain the complete document
- AND PNG/JPG/SVG MUST identify the selected page rather than call page1 the full document
- AND SVG MUST inline only authorized resources and remove selection/edit layers
- AND rasterization MUST consume exact sanitized output page geometry and reveal real2× pixel dimensions

#### Scenario: Generation succeeds, fails or is cancelled

- GIVEN existing idle/waiting/exporting/complete/cancelled/error states
- WHEN export runs
- THEN complete MUST be published only after actual Blob/download success with filename, format and page range
- AND cancellation or error MUST preserve document/draft and allow retry
- AND missing resources or oversized images MUST report their real error with PDF/layout recovery, never silently change format or truncate output
- AND evicted immutable inputs MUST fail as unavailable rather than compile current mutable state under the old identity

### Requirement: Source download remains separate from persistence and product export

Work menu SHALL offer Download source file for current canonical TextDocument `.mmt`. Save SHALL continue writing the existing workspace. Neither operation SHALL create a new project format or imply cloud persistence.

#### Scenario: Source is downloaded while chat is active

- GIVEN current canonical source and a temporary chat preset
- WHEN Download source file is chosen
- THEN downloaded bytes MUST be the current authored TextDocument
- AND chat parameters and unsent draft MUST NOT be included
- AND file download MUST NOT masquerade as saving the workspace or exporting a finished PDF/image

### Requirement: Export acceptance opens real generated files

Qualification SHALL inspect generated content in actual readers/decoders, not only response success, magic bytes or nonempty files.

#### Scenario: Final product evidence is collected

- GIVEN a story with two people, revised content and reordered statements
- WHEN PDF/PNG/JPG/SVG are exported
- THEN PDF MUST be opened in a real reader/browser and checked for people, revision, order and page count
- AND PNG/JPG MUST be decoded and inspected for dimensions/content
- AND SVG MUST be independently opened to confirm authorized inlined images and absent selection layers
- AND output SVG MUST be visually compared with layout at the same renderKey; PDF MAY use the existing project screenshot/render path
- AND the report MUST distinguish exercised artifact checks from unavailable real-device/reader evidence
