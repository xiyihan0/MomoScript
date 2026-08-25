## 1. Rust node targeting and source-edit core

- [x] 1.1 Define versioned Composer target/command/result wire types with strict serde tagging and bounded strings/ranges
- [x] 1.2 Resolve one current generated renderer location through projection origin ancestry to a unique left/right `StatementSyntax`; reject fallback、stale、ambiguous and unsupported nodes
- [x] 1.3 Parse top-level statement patch arguments structurally and implement minimal `continued` update/insert/remove while preserving all unrelated bytes
- [x] 1.4 Implement from-statement `display-name`: update a same-scope adjacent actor block or insert a canonical actor revision before the target
- [x] 1.5 Reanalyze candidate source and prove statement/ActorId/resource invariants before producing an edit
- [x] 1.6 Add Rust core tests for CJK、CRLF、existing/absent/multi-argument patch、quoted display names、adjacent revision optimization and all rejection paths

## 2. Shared language-service protocol

- [x] 2.1 Add pure `mmt/previewComposerTarget` request bound to source version、revision、sourceContent、projectDigest、projectionKey and backend encoding
- [x] 2.2 Add pure `mmt/composerEdit` request returning only a current-version single-document WorkspaceEdit or explicit rejection
- [x] 2.3 Keep server snapshots immutable: no direct apply、private apply notification、partial edit or automatic retry on a newer document
- [x] 2.4 Route both requests identically through native stdio and WASM bridge; add positive/negative JSON-RPC transcript tests
- [x] 2.5 Cover UTF-8/UTF-16 conversion、stale document version、stale preview identity、document errors、builtin/unresolved actor and candidate reanalysis failure

## 3. Preview host and strict client boundary

- [x] 3.1 Refactor preview point resolution so context targeting can obtain a current backend location without opening a source editor or changing navigation status prematurely
- [x] 3.2 Add strict TypeScript parsers for Composer target/result and versioned WorkspaceEdit; reject unknown keys、unversioned `changes` and malformed ranges
- [x] 3.3 Add a client applier that rechecks open TextDocument version immediately before `vscode.workspace.applyEdit` and reports false/stale without retry
- [x] 3.4 Add context point message to `previewWebviewProtocol` and positive/negative protocol contracts
- [x] 3.5 Cancel context requests and dismiss transient input whenever artifact identity、document version or runtime owner changes

## 4. Web Workbench contextual UI

- [x] 4.1 Handle no-selection `contextmenu` in the current preview page and leave browser text-selection behavior intact
- [x] 4.2 Show a pointer-adjacent native Workbench context menu for source navigation、continued state and available actor display-name editing
- [x] 4.3 Apply `continued` auto/true/false through `mmt/composerEdit`; never construct patch text in TypeScript
- [x] 4.4 Apply non-empty “从本条起修改人物显示名” through `mmt/composerEdit`; keep actor Rename and per-bubble nickname separate
- [x] 4.5 Surface unsupported/stale/rejected states through concise native notifications without guessing another target
- [x] 4.6 Register every request、cancellation and transient context-menu/Input Box resource under the existing `EditorRuntimeController`
- [x] 4.7 Replace the top Quick Pick with a pointer-adjacent native Workbench context menu and preserve lifecycle cancellation
- [x] 4.8 Offer navigation-only native menus for mapped authored targets that are unavailable for Composer mutation
- [x] 4.9 Snap non-text chat-bubble graphics only to text inside their nearest rendered SVG group
- [x] 4.10 Replace the top display-name Quick Input with a pointer-anchored Workbench context view using the native InputBox
- [x] 4.11 Emit deterministic opaque target labels and attach them to frame-bearing chat bubble、avatar、display-name、narration、reply and bond template regions
- [x] 4.12 Strictly parse reserved semantic SVG labels、treat an unrecognized closest label as a non-text shadow barrier、reject inactive DOM generations and snap context hits only within the same target token without changing the point-only Webview protocol
- [x] 4.13 Preserve exact text selection/navigation precedence、sanitizer/CSP boundaries and Rust-only edit authorization

## 5. Verification

- [x] 5.1 Run `openspec validate add-preview-contextual-editing --strict`
- [x] 5.2 Run focused `mmt_rs` source-edit tests and `cargo test --manifest-path mmt_lsp/Cargo.toml`
- [x] 5.3 Run VS Code Worker/Web transport contracts and Workbench TypeScript/protocol checks
- [x] 5.4 Browser-drive right-click→continued edit and prove exact MMT bytes、history admission and rerendered avatar/name grouping
- [x] 5.5 Browser-drive right-click→display-name edit and prove earlier messages retain old presentation while target/later messages show the new name
- [x] 5.6 Browser-drive stale menu、text selection、generated/package/Typst、builtin actor、syntax-error and apply-failure rejection paths
- [x] 5.7 Run production build and relevant full Editor Runtime E2E; inspect 240–320 px native context-menu、Input Box and preview interaction without changing Workbench topology
- [x] 5.8 Browser-drive pointer anchoring、continued submenu、notification attribution、collapse/expand and update action activation
- [x] 5.9 Browser-drive narration navigation、bubble-background targeting and pointer-adjacent display-name input without weakening text-selection or stale-target guards
- [x] 5.10 Browser-drive bubble、avatar and display-name semantic hits through full SVG and diff-v1 updates; prove visual parity、label retention、orphan rejection、shadow-label rejection and stale DOM-generation rejection
- [x] 5.11 Verify narration、reply and bond labels remain navigation-only or unavailable and cannot acquire mutation actions

## Deferred follow-ups

- [ ] D.1 Specify a statement-local one-bubble display-name override in a separate DSL/Typst delta
- [ ] D.2 Publish typed schemas and controls for visual properties beyond `continued`
- [ ] D.3 Build format brush as typed property-bag copy/apply over the proven Composer edit path
- [ ] D.4 在独立 change 中让 PWA 优先的移动端 GUI + 源码混合表面复用 Composer commands；产品不以 Composer 命名，也不建立第二套 Web/App UI 代码
