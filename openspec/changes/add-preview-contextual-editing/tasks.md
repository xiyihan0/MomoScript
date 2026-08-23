## 1. Rust node targeting and source-edit core

- [ ] 1.1 Define versioned Composer target/command/result wire types with strict serde tagging and bounded strings/ranges
- [ ] 1.2 Resolve one current generated renderer location through projection origin ancestry to a unique left/right `StatementSyntax`; reject fallback、stale、ambiguous and unsupported nodes
- [ ] 1.3 Parse top-level statement patch arguments structurally and implement minimal `continued` update/insert/remove while preserving all unrelated bytes
- [ ] 1.4 Implement from-statement `display-name`: update a same-scope adjacent actor block or insert a canonical actor revision before the target
- [ ] 1.5 Reanalyze candidate source and prove statement/ActorId/resource invariants before producing an edit
- [ ] 1.6 Add Rust core tests for CJK、CRLF、existing/absent/multi-argument patch、quoted display names、adjacent revision optimization and all rejection paths

## 2. Shared language-service protocol

- [ ] 2.1 Add pure `mmt/previewComposerTarget` request bound to source version、revision、sourceContent、projectDigest、projectionKey and backend encoding
- [ ] 2.2 Add pure `mmt/composerEdit` request returning only a current-version single-document WorkspaceEdit or explicit rejection
- [ ] 2.3 Keep server snapshots immutable: no direct apply、private apply notification、partial edit or automatic retry on a newer document
- [ ] 2.4 Route both requests identically through native stdio and WASM bridge; add positive/negative JSON-RPC transcript tests
- [ ] 2.5 Cover UTF-8/UTF-16 conversion、stale document version、stale preview identity、document errors、builtin/unresolved actor and candidate reanalysis failure

## 3. Preview host and strict client boundary

- [ ] 3.1 Refactor preview point resolution so context targeting can obtain a current backend location without opening a source editor or changing navigation status prematurely
- [ ] 3.2 Add strict TypeScript parsers for Composer target/result and versioned WorkspaceEdit; reject unknown keys、unversioned `changes` and malformed ranges
- [ ] 3.3 Add a client applier that rechecks open TextDocument version immediately before `vscode.workspace.applyEdit` and reports false/stale without retry
- [ ] 3.4 Add context point message to `previewWebviewProtocol` and positive/negative protocol contracts
- [ ] 3.5 Cancel context requests and dismiss transient input whenever artifact identity、document version or runtime owner changes

## 4. Web Workbench contextual UI

- [ ] 4.1 Handle no-selection `contextmenu` in the current preview page and leave browser text-selection behavior intact
- [ ] 4.2 Show native Quick Pick actions for source navigation、continued state and available actor display-name editing
- [ ] 4.3 Apply `continued` auto/true/false through `mmt/composerEdit`; never construct patch text in TypeScript
- [ ] 4.4 Apply non-empty “从本条起修改人物显示名” through `mmt/composerEdit`; keep actor Rename and per-bubble nickname separate
- [ ] 4.5 Surface unsupported/stale/rejected states through concise native notifications without guessing another target
- [ ] 4.6 Register every request、cancellation and Quick Input disposable under the existing `EditorRuntimeController`

## 5. Verification

- [ ] 5.1 Run `openspec validate add-preview-contextual-editing --strict`
- [ ] 5.2 Run focused `mmt_rs` source-edit tests and `cargo test --manifest-path mmt_lsp/Cargo.toml`
- [ ] 5.3 Run VS Code Worker/Web transport contracts and Workbench TypeScript/protocol checks
- [ ] 5.4 Browser-drive right-click→continued edit and prove exact MMT bytes、history admission and rerendered avatar/name grouping
- [ ] 5.5 Browser-drive right-click→display-name edit and prove earlier messages retain old presentation while target/later messages show the new name
- [ ] 5.6 Browser-drive stale menu、text selection、generated/package/Typst、builtin actor、syntax-error and apply-failure rejection paths
- [ ] 5.7 Run production build and relevant full Editor Runtime E2E; inspect 240–320 px Quick Input/preview interaction without changing Workbench topology

## Deferred follow-ups

- [ ] D.1 Specify a statement-local one-bubble display-name override in a separate DSL/Typst delta
- [ ] D.2 Publish typed schemas and controls for visual properties beyond `continued`
- [ ] D.3 Build format brush as typed property-bag copy/apply over the proven Composer edit path
- [ ] D.4 Reuse surface-independent Composer commands in a future structured/mobile editor
