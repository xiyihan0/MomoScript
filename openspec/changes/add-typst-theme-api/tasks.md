## 1. Public contract and current documentation

- [x] 1.1 Inventory every name currently re-exported by `lib.typ`
- [x] 1.2 Document current signatures, precedence, state behavior, resource boundaries, and known theme gaps in `typst_sandbox/mmt_render/API.md`
- [x] 1.3 Separate current runnable examples from proposed theme APIs
- [x] 1.4 Define public versus internal Typst boundaries and compatibility direction

## 2. Theme schema design

- [x] 2.1 Define complete theme groups and static versus dynamic initialization classes
- [x] 2.2 Define proposed `mmt-theme.v1` versioning and complete-record invariants
- [x] 2.3 Define complete-theme patch, validation, position update, reset, and precedence semantics
- [ ] 2.4 Finalize the exact field/type/default table for every `mmt-theme.v1` token
- [ ] 2.5 Decide whether `dark()` belongs to the first implementation batch

## 3. Template implementation

- [ ] 3.1 Move page/header/footer/text visual literals into complete theme groups
- [ ] 3.2 Make `reply` and `bond` consume current theme state while preserving explicit parameter precedence
- [ ] 3.3 Make chat avatar size/gap and message/continued spacing consume their documented theme tokens
- [ ] 3.4 Implement complete theme validation with deterministic unknown/missing field errors
- [ ] 3.5 Implement `mmt.themes.patch(base, ..groups)` as a validated non-mutating merge
- [ ] 3.6 Change position-dependent theme updates to validated dynamic-group patches
- [ ] 3.7 Implement `theme: auto` and `chat: auto` restoration to the active template baseline
- [ ] 3.8 Preserve existing `mmt.configure(chat: (continued: ...))` behavior

## 4. Built-in themes

- [ ] 4.1 Migrate `moetalk()` to the complete versioned schema without visual regression
- [ ] 4.2 Add a complete, observably distinct `minimal()` preset
- [ ] 4.3 Add `dark()` only if its complete contrast/resource behavior is specified and verified
- [ ] 4.4 Export only supported constructors and helpers through `lib.typ`

## 5. Verification and publication

- [ ] 5.1 Add Typst 0.15 probes for patch inheritance, unknown fields, type errors, static-group rejection, position effects, and reset
- [ ] 5.2 Add observable render checks proving each documented token reaches its intended component
- [ ] 5.3 Verify current hand-written façade examples and Rust-emitted projects use the same API
- [ ] 5.4 Promote implemented proposal sections into `API.md` and remove their unavailable markers
- [ ] 5.5 Record the final `mmt-theme.v1` field/type/default table as the supported external ABI

## 6. Deferred integration

- [ ] 6.1 Design MMT syntax for document theme selection in a separate change
- [ ] 6.2 Design named declarative MMT themes and position-dependent DSL configuration in a separate change
- [ ] 6.3 Design workspace/pack theme identity resolution and trust boundaries in a separate change
