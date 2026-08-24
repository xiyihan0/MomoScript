## 1. Decision gate

- [ ] 1.1 Confirm whether the MMT fallback target is the statement line start or `TextBody` range start.
- [ ] 1.2 Choose the protocol representation for coarse authored navigation (`authoredFallback` kind or explicit precision field).
- [x] 1.3 Retain `refineRenderTextLocation` as constrained best-effort: unique text within one unescaped raw run of the overlapping call, followed by Identity classification; ambiguity remains unmapped.
  - Evidence (2026-08-23): `npm run test:preview-interaction` covers fragment rebasing、repetition、escape-boundary rejection、canonical `\n` suffixes and an unrelated escaped call before the target call. Rust projection tests prove byte-identical prefixes remain `AuthoredIdentity` while transformed newline bytes remain generated. A one-off browser reproduction against the supplied full project recorded `untitled:/mmt-projection/.../main-1.typ` line 1400 character 11, refined only that retained entry to character 13, and opened authored line 602 at the exact clicked character; the permanent browser regression covers the equivalent strict-fragment/newline boundary without exposing diagnostic state.
- [ ] 1.4 Decide upstream-first versus local-patch-first delivery for the Tinymist correctness fix.

## 2. Tinymist correctness baseline

- [ ] 2.1 Change preview click resolution so only `SyntaxKind::Text | SyntaxKind::MathText` applies glyph `span_offset`; all other nodes return offset zero/node start.
- [ ] 2.2 Add regression cases for `1234abcd`、`我也可以继续说。`、`#text("1234abcd")`、`#text("我也可以继续说。")` and `#"hello\nworld"`.
- [ ] 2.3 Apply the same semantics to renderer-session `locatePoint` and ordinary preview location paths; do not leave two click policies.
- [ ] 2.4 Rebuild and qualify pinned native/WASM Tinymist artifacts from the same revision and patch set.

## 3. MMT read-navigation fallback

- [ ] 3.1 Preserve the nearest authored parent origin needed by generated projection segments without changing Identity mapping.
- [ ] 3.2 Map eligible generated text wrappers to an explicit authored fallback target at the approved coarse position.
- [ ] 3.3 Keep `typst_to_mmt`、`map_text_edit`、rename and formatting rejection unchanged for Synthetic、Escaped and MacroExpansion segments.
- [ ] 3.4 Reject fallback when revision、projection key、source content or project digest is stale.

## 4. Desktop/Web protocol and UI

- [ ] 4.1 Add the approved fallback representation to Rust、VS Code extension and Workbench allowlists with positive and malformed-input tests.
- [ ] 4.2 Apply the selected `refineRenderTextLocation` policy and remove obsolete scanning code if conservative cutover is chosen.
- [ ] 4.3 Open authored fallback targets as editable MMT, while generated projections and package files remain read-only.
- [ ] 4.4 Ensure provider、mapping or document-open failure reports only `unmapped` and never false `sourceOpened`/`ready`.

## 5. Verification

- [ ] 5.1 Rust tests prove exact Identity mapping and coarse parent fallback are distinct, and fallback cannot authorize edits.
- [ ] 5.2 Native and Web Tinymist transcripts prove direct Typst `Text` / `MathText` remains character-accurate.
- [ ] 5.3 Browser E2E clicks MMT ASCII、CJK、escaped text and confirms the approved authored line/range fallback.
- [ ] 5.4 Browser E2E clicks authored Typst direct text and confirms exact character navigation; `#text(...)` and direct string cases confirm node-start fallback.
- [ ] 5.5 Run the focused MMT LSP、VS Code protocol and Workbench preview-interaction checks before replacing production runtime artifacts.
