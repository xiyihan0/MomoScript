## 1. Rust Composer authority

- [x] 1.1 Add optional structured `statement_text` capability and `SetStatementText` / `SetStatementTextMode` commands without URI、range duplication、ActorId or AST leakage
- [x] 1.2 Restrict capability to unique resolved non-builtin actor chat statements or narration statements with bounded single-line TextMacro/TextRaw bodies
- [x] 1.3 Replace only the authorized body content; minimally rewrite or create the local `t`/`rt` fence while preserving every unrelated byte
- [x] 1.4 Reject invalid text、no-op mode、Typst inheritance、stale target、builtin、unsafe fence and unsupported multiline bodies deterministically
- [x] 1.5 Fully reanalyze candidates; preserve all non-target semantics while allowing only target-local mode/resource interpretation to change
- [x] 1.6 Add core behavior coverage for left/right chat、narration、plain/fenced mode transitions、Unicode、CRLF and invalid candidates

## 2. Native/WASM contract

- [x] 2.1 Add strict four-field `statementText` response projection and deny-unknown-fields text/mode commands
- [x] 2.2 Enforce identical text boundaries and strict `inherit | textMacro | textRaw` mode enums in core and language service
- [x] 2.3 Carry the structured capability through Typst projection without a second target/document state
- [x] 2.4 Keep one current-version TextDocumentEdit、no `changes`、no server apply and no retry
- [x] 2.5 Add request-json/native/WASM contract cases for exact mode enums、unknown fields、stale version and capability omission

## 3. Web Preview Composer

- [x] 3.1 Extend TypeScript exact-key parsing and command unions with strict text/mode fields
- [x] 3.2 Add “编辑消息…” and the “解析模式” radio submenu only when server capability exists
- [x] 3.3 Display inherited mode、disable Typst inheritance and omit local `T`/`rT`
- [x] 3.4 Reuse the pointer-anchored `contextInput`; suppress text/mode no-op and cancellation requests
- [x] 3.5 Apply valid text/mode results once through the existing freshness gate、WorkspaceEdit、Local History and preview rerender chain
- [x] 3.6 Add parser/controller/E2E coverage for left/right chat、narration、mode radio state、success、no-op and history/rerender

## 4. Verification

- [x] 4.1 Run `openspec validate add-preview-message-editing --strict`
- [x] 4.2 Run `cargo test --manifest-path mmt_rs/Cargo.toml --test composer_edits`
- [x] 4.3 Run `cargo test --manifest-path mmt_lsp/Cargo.toml` and native stdio transcript coverage
- [x] 4.4 Run `cd editors/vscode && npm run test:worker` for WASM parity
- [x] 4.5 Run `cd editors/vscode-web && npm run test:composer-edit && npm run test:preview-composer`
- [x] 4.6 Run `cd editors/vscode-web && npm run test:e2e -- preview-composer.spec.ts`
