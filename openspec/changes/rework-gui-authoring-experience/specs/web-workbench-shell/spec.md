## MODIFIED Requirements

### Requirement: Native notifications are visible and actionable

The Views Service shell SHALL register Monaco VS Code's notifications service override before Workbench initialization. When visible, the rendered Status Bar SHALL expose the native notifications button, and non-modal `showInformationMessage`、`showWarningMessage` and `showErrorMessage` calls SHALL feed the same native toast and notification-center model. Product modes MAY temporarily hide the Status Bar through the native Part API, but SHALL retain an actionable route to the same native notification center. The shell MUST NOT implement a parallel product-specific notification queue or migrate layout ownership merely to obtain these surfaces.

#### Scenario: An extension publishes a notification

- GIVEN the embedded shell is ready
- WHEN an extension publishes a non-modal message
- THEN a native notification toast MUST become visible
- AND the Status Bar notifications button in source mode or the product menu's native-notification entry MUST expose that message in the same notification center
- AND clearing the notification through native notification-center actions MUST remove it from the shared model

### Requirement: Visibility and geometry have explicit owners

Views Service SHALL be the authority for Workbench Part existence、selected view container and Part visibility. The two shell SplitViews SHALL own host geometry and SHALL mirror the initial and subsequent Sidebar/Panel visibility reported by Views Service. Chat/layout product modes MAY temporarily change Parts through native visibility APIs and tabs through EditorPart's temporary configuration; returning to source SHALL restore prior native state without overwriting persistent user preferences. CSS classes MAY expose state for styling or diagnostics, but MUST NOT be an authoritative visibility state or leave hidden Parts occupying geometry.

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

## ADDED Requirements

### Requirement: Product modes borrow native Parts without changing layout ownership

The existing controller SHALL own URI-bound AuthoringMode chat/layout/source. ViewsService Part existence/visibility, EditorPart temporary tab configuration and existing SplitView geometry SHALL remain authoritative. The product SHALL NOT add a shell framework, parallel layout owner or CSS-hidden native Parts that still occupy geometry.

#### Scenario: A source workspace enters a product mode

- GIVEN native activity/sidebar/panel/status/tab visibility and source split state
- WHEN chat or layout is selected
- THEN the host MUST use existing isPartVisibile/setPartVisibility and native EditorPart temporary configuration to remove irrelevant chrome and geometry
- AND returning to source MUST restore the prior native state
- AND persistent user preferences MUST NOT be overwritten
- AND menus MUST retain real advanced-workspace, diagnostics, history and native notification entry points

#### Scenario: Restoring source chrome synchronously re-enters surface layout

- GIVEN an accepted mode transition to source while the retiring GUI input is still active
- WHEN native Part restoration synchronously triggers another surface synchronization
- THEN the target source mode MUST prevent the retiring GUI input from hiding Parts again
- AND temporary product-hidden visibility MUST NOT be captured as the user's source preference
- AND repeated chat/layout/source switches MUST retain reachable native activity, tabs and advanced preview splitting


#### Scenario: Existing source state restores

- GIVEN Workbench has a restored source workspace and split arrangement
- WHEN startup restoration settles
- THEN that state MUST remain rather than force GUI by width
- AND a new ordinary work MUST instead select chat at any width
- AND explicit source choice MUST remain respected at550px and below
- AND this rule MUST replace prior desktop-source/mobile-GUI first-open defaults, not run alongside them

#### Scenario: Fresh startup selects the existing GUI story entry

- GIVEN native restoration has settled and a fresh workspace has no restored active input
- WHEN the existing startup fallback runs
- THEN it MUST open existing seeded STORY in chat through the ordinary GUI entry rather than intro.typ source
- AND only that fresh fallback branch MUST change; source/split restoration and explicit source choice MUST remain intact
- AND intro/source tooling MUST stay advanced-openable without a new landing pane, document model or runtime owner

#### Scenario: A current preview compilation fails after the pane opens

- GIVEN the native chat/layout pane has opened and its current project has a diagnosed preview compilation failure
- WHEN startup or the requested mode awaits that same preview binding
- THEN the requested pane and real failed preview state MUST remain available
- AND the language runtime MUST NOT be reported as failed solely because that current preview failed
- AND source, native history and unsent draft MUST remain unchanged, with Source and new-work recovery reachable
- AND unrelated initialization failures, obsolete work and cancellation MUST retain their existing error boundaries


### Requirement: One retained SVG mount serves both authorized MMT presentations

PreviewSurfaceMount/syncPreviewSurface SHALL bind chat and layout to the existing ComposerRuntime/ComposerTextSession through one live retained-overlay claim. Native previewHostPane SHALL accept editing only for authored MMT with valid current Rust capabilities. Presentation mode alone SHALL never confer write authority.

#### Scenario: Layout edits an authorized MMT message

- GIVEN the active document is MMT and Rust admits an exact current text/property target
- WHEN layout is active in the native preview mount
- THEN it MUST route input through the same Composer runtime, input bridge, version checks and native undo as chat
- AND original Typst, generated projection and external package resources MUST retain existing read-only/source-navigation boundaries
- AND the previous source-preview read-only rule MUST NOT block an otherwise authorized MMT layout edit

#### Scenario: Source split or another native pane becomes active

- GIVEN source with optional chat/output SVG split or multiple document panes
- WHEN active/visible native editors change
- THEN at most one mount MUST claim the existing overlay and one active document/render identity
- AND inactive panes MUST retain an honest focusable placeholder
- AND no second renderer, artifact owner, selected-document authority or durable source buffer MAY be created
- AND old claimant release/messages MUST NOT detach or edit the new claimant's document

### Requirement: Mobile modes share a single native group and safe auxiliary slot

At550 CSS px and below, product modes SHALL switch full-screen within a single EditorGroup. Source preview splitting SHALL become View canvas / Return to source, not simultaneous narrow columns. Native pane allocation and visualViewport geometry SHALL remain inputs to the existing surface layout path.

#### Scenario: A compact Source editor explicitly requests its MMT canvas

- GIVEN an authored workspace MMT document is open in Source at550 CSS px or below
- WHEN the author requests its preview
- THEN the existing layout-mode transition MUST present the same authorized document full-screen in one native EditorGroup
- AND Source chrome MUST NOT consume the product canvas allocation
- AND source, draft, native history and the single retained overlay MUST be preserved
- AND original Typst and other read-only source preview permissions MUST remain unchanged

#### Scenario: Automatic preview cannot replace compact Source

- GIVEN an explicit or restored Source editor at550 CSS px or below
- WHEN the existing open-on-document preview preference would automatically open a preview
- THEN Source MUST remain active rather than being replaced by a full-screen canvas
- AND an explicit preview request MUST remain available


#### Scenario: Keyboard and native Part layout change

- GIVEN a mounted overlay and an auxiliary Sheet
- WHEN native Part visibility/allocation, ResizeObserver or visualViewport changes
- THEN native Part layout MUST propagate actual dimensions to the same mount and clipping container
- AND the overlay MUST NOT cover another Part/editor group
- AND input, Send, caret and Sheet close MUST remain reachable with44px targets and safe-area protection
- AND no separate mobile app/runtime or alternate scroll owner MAY be introduced
