## Context

MMT text mode currently emits literal bodies through generated calls such as:

```typst
#mmt.chat-left(...)[#text("我也可以继续说。")]
```

The rendered glyphs carry one `Span` plus a `span_offset`. For direct Typst markup text, the span resolves to `SyntaxKind::Text` and the offset is a byte position inside that syntax node. For `#text("...")`, the string is converted through `Value::Str → TextElem::packed`; the resulting text receives the enclosing `FuncCall` span while glyph offsets still describe bytes in the decoded runtime string. Adding those offsets to the `FuncCall` source range is invalid.

Typst 0.15 already uses this rule in `typst-ide::jump_from_click_in_frame`:

```text
Text | MathText → node range start + glyph offset
other           → node offset
```

Tinymist 0.15.2 returns `SourceSpanOffset` and the MMT preview patch currently resolves every result as `node.range().start + offset`, which loses that distinction.

## Evidence

The following cases define the investigation baseline:

| Typst source | Expected click precision |
|---|---|
| `1234abcd` | exact `Text` byte boundary |
| `我也可以继续说。` | exact `Text` byte boundary |
| `#text("1234abcd")` | `FuncCall` start fallback |
| `#text("我也可以继续说。")` | `FuncCall` start fallback |
| `#"hello\nworld"` | `Str` start fallback |

The fallback is intentional. Runtime strings can differ in length and topology from source because of `\n`、`\r`、`\t`、`\"`、`\\`、`\u{...}`、concatenation、slicing、replacement and case transformation. A single `Span + offset` cannot represent those mappings.

## Proposed Navigation Model

### Backend precision

Tinymist SHALL determine offset applicability before returning a preview location:

```rust
let offset = if matches!(node.kind(), SyntaxKind::Text | SyntaxKind::MathText) {
    adjusted_glyph_offset
} else {
    0
};
```

The right-half-of-glyph caret adjustment remains valid only in the `Text` / `MathText` branch. The MMT-specific `preview_location_for_snapshot` SHALL consume this already-classified result rather than independently reinterpreting glyph offsets.

### MMT parent-origin fallback

Generated projection segments remain non-identity. For preview read navigation only, a generated segment MAY expose a fallback authored range derived by walking the emitter origin graph:

```text
Generated::EscapedText / StatementCallWrapper
  → parent
  → Origin::MmtRange { kind: TextBody, range }
  → fallback target = range.start
```

The fallback MUST carry a distinct precision/kind from `AuthoredIdentity`. It MUST NOT make the generated segment eligible for edits or general Typst-to-MMT mapping.

A suitable logical result shape is:

```text
authoredIdentity  — exact reversible Identity mapping
authoredFallback  — authored URI, coarse range start, read navigation only
generatedProjection — retained read-only generated source
staleUnknown      — no current safe target
```

The final wire spelling is a decision-gate item because TypeScript consumers use an explicit allowlist and every new protocol value requires positive and negative contract tests.

### Typst documents

For standalone or authored Typst:

- direct `Text` and `MathText` remain character-accurate;
- `FuncCall` and `Str` navigate to their syntax node start;
- generated content without a source span remains unmapped;
- no MMT parent-origin fallback is attempted.

### Workbench refinement

`refineRenderTextLocation` searches generated source for the `#text("...")` call overlapping the renderer range and combines `.tsel` character offsets with literal source bytes. This is not a Typst string provenance implementation: it never decodes an escape into authored text or maps a fragment across an escape boundary.

The existing Workbench path retains **explicit best-effort** refinement while this broader fallback proposal remains deferred:

- unrelated `#text(...)` calls on the same generated line, including escaped calls, do not hide the overlapping candidate;
- `.tsel` text must occur exactly once inside one contiguous unescaped UTF-8 run of the overlapping literal; a canonical escaped suffix such as `\n` is allowed only because the matched fragment ends before it;
- the fragment's UTF-16 offset is rebased within that proven raw run;
- the refined generated position still passes through `mmt/mapTypstReadLocations`, so only a proven `AuthoredIdentity` segment becomes an exact authored target;
- fragments that cross an escape、repeat、or do not match remain unmapped rather than authorizing a guess.

The emitter preserves the same proof boundary: `emit_text_source` records each byte-identical unescaped run as its own `TextBody` segment and records each escaped source character separately. `ProjectionIndex` may therefore promote the former to `Identity`, while `\n`、quotes、backslashes and other transformed bytes remain `Escaped`. A safe refined point before an escaped suffix can map exactly; the suffix itself cannot.

This maintenance rule does not approve the proposed Tinymist classification change or the new `authoredFallback` wire kind. Those remain behind the other decision-gate items.

## Safety Invariants

- `ProjectionIndex::typst_to_mmt` and `map_text_edit` remain Identity-only.
- Parent-origin fallback is read-navigation-only and revision-bound.
- A stale `projectionKey`、revision、project digest or source content rejects the fallback.
- Generated package files and renderer-internal URIs never become editable authored targets.
- Provider, mapping or open failure reports `unmapped`; it never emits `sourceOpened` or `ready` before a document is actually opened.
- UTF-8 byte ranges are converted through the negotiated backend/client encoding bridge; no byte offset is treated as an LSP character offset.

## Alternatives Considered

### Emit only direct Typst content

Rejected as the immediate fix. Direct markup `Text` improves spans but differs from `Str → Content` for spaces、newlines、tabs、smart punctuation and markup syntax. Reproducing exact string behavior while preserving syntax provenance becomes a serializer and semantic whitespace project.

### Add universal string provenance to Typst

Architecturally complete but out of scope. It requires origin propagation through `Value::Str` operations、`TextElem`、paragraph collection、shaping、glyphs and IDE navigation.

### Decode Typst strings in Tinymist or Workbench

Rejected as the baseline. It can handle static literals but fails for variables、concatenation and transformations, creating a second incomplete evaluator.

### Keep incorrect `FuncCall + span_offset`

Rejected. It returns plausible but invalid positions and is less safe than a coarse node-start fallback.

## Decision Gates

Before implementation, decide:

1. Whether MMT fallback targets the full statement line start or the `TextBody` authored range start. Current emitter parent origins can identify the former for generated statement wrappers; tests must pin the choice.
2. Whether the public projection result adds `authoredFallback` or carries an explicit precision field.
3. Whether `refineRenderTextLocation` is deleted or retained as constrained best-effort.
4. Whether the correctness fix is submitted upstream to Tinymist before or in parallel with rebuilding pinned artifacts.
5. Whether coarse navigation is enabled immediately for all MMT text mode or guarded until native/WASM artifact parity is proven.

## Rollout and Verification

1. Add pure Tinymist regression tests for ASCII/CJK direct text and `#text(...)` fallback.
2. Rebuild native and WASM artifacts from the same pinned revision plus patch; verify digests and protocol transcripts.
3. Add Rust projection tests proving parent-origin fallback cannot map edits.
4. Add Desktop/Web protocol tests for exact、fallback、generated and stale targets.
5. Browser-drive preview clicks on direct Typst text、MMT ASCII/CJK text and escaped MMT text; observe the opened URI and cursor line.
6. Preserve rollback by retaining the prior immutable runtime artifact while the new artifact is qualified.
