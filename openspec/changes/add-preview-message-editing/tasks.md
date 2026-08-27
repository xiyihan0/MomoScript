## 1. Rust Composer authority

- [x] 1.1 Add optional `statement_text` capability and structured `ComposerCommand::SetStatementText` without URI、range duplication、ActorId or AST leakage
- [x] 1.2 Restrict capability to unique resolved non-builtin actor chat statements with nonempty bounded single-line TextMacro/TextRaw bodies
- [x] 1.3 Replace only the authorized body range while preserving speaker、patch parameters、indentation、line endings and every unrelated byte
- [x] 1.4 Reject empty、CR/LF、overlong、same-current、stale-target、builtin and unsupported multiline bodies deterministically
- [x] 1.5 Fully reanalyze the candidate and prove statement shape、non-target bodies、actor/speaker/resource semantics remain stable
- [x] 1.6 Add core behavior coverage for Unicode、quotes/backslashes、CRLF、parameters、invalid candidate and unavailable regions

## 2. Native/WASM contract

- [x] 2.1 Add strict `statementText: { current }` response projection and `setStatementText { value }` deny-unknown-fields command
- [x] 2.2 Enforce identical 1–65536 UTF-8 byte nonempty single-line value boundary in core and language service
- [x] 2.3 Carry capability through Typst projection without a second target/document state
- [x] 2.4 Keep one current-version TextDocumentEdit、no `changes`、no server apply and no retry
- [x] 2.5 Add request-json/native/WASM contract cases for exact bytes、unknown fields、stale version、invalid candidate and capability omission

## 3. Web Preview Composer

- [x] 3.1 Extend TypeScript exact-key parsing and command union with strict `statementText`/`setStatementText`
- [x] 3.2 Add exact menu label “编辑消息…” only when the server capability exists
- [x] 3.3 Reuse the existing pointer-anchored `contextInput` with current source body prefill and no DOM/SVG text fallback
- [x] 3.4 Suppress cancel、empty and same-current submissions before `mmt/composerEdit`
- [x] 3.5 Apply valid results once through the existing freshness gate、WorkspaceEdit、Local History and preview rerender chain
- [x] 3.6 Add parser/controller/E2E coverage for success、Unicode/escapes、no-op/cancel、capability omission、history and rerender

## 4. Verification

- [x] 4.1 Run `openspec validate add-preview-message-editing --strict`
- [x] 4.2 Run `cargo test --manifest-path mmt_rs/Cargo.toml --test composer_edits`
- [x] 4.3 Run `cargo test --manifest-path mmt_lsp/Cargo.toml` and native stdio transcript coverage
- [x] 4.4 Run `cd editors/vscode && npm run test:worker` for WASM parity
- [x] 4.5 Run `cd editors/vscode-web && npm run test:composer-edit && npm run test:preview-composer`
- [x] 4.6 Run `cd editors/vscode-web && npm run test:e2e -- preview-composer.spec.ts`
