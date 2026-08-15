## ADDED Requirements

### Requirement: Preview click precision follows Typst syntax provenance

Preview-to-source navigation SHALL apply a rendered glyph offset only when the glyph span resolves to `SyntaxKind::Text` or `SyntaxKind::MathText`. For every other syntax kind, navigation SHALL fall back to the resolved syntax node start rather than adding a runtime-text offset to an unrelated source range.

#### Scenario: Direct Typst text remains character-accurate

- GIVEN a rendered glyph span resolves to a direct Typst `Text` or `MathText` node
- WHEN the author clicks the left or right half of that glyph
- THEN the backend returns the corresponding UTF-8 boundary within that node
- AND the host converts that byte position through the negotiated position encoding

#### Scenario: Function-generated text falls back to the function call

- GIVEN text rendered from `#text("1234abcd")` or `#text("我也可以继续说。")` carries a `FuncCall` span
- WHEN the author clicks any glyph produced by that call
- THEN the backend returns the `FuncCall` node start
- AND it MUST NOT add the glyph's runtime-string offset to the `FuncCall` source range

#### Scenario: String-generated text falls back to the string expression

- GIVEN text rendered from a direct string expression contains escapes or Unicode characters
- WHEN the author clicks a glyph produced by that string
- THEN the backend returns the `Str` node start
- AND it MUST NOT claim a character-accurate source position

### Requirement: MMT generated text navigation may use an explicit authored fallback

Preview read navigation MAY map a generated Typst wrapper to the start of its nearest authored MMT `TextBody` parent origin. Such a result SHALL be explicitly distinguishable from `AuthoredIdentity` and SHALL NOT authorize reverse edits or general projection mapping.

#### Scenario: Generated MMT text returns to its authored line

- GIVEN an MMT text-mode statement emits a generated `#text(...)` wrapper whose origin parent is the statement `TextBody`
- AND the renderer returns the wrapper node start
- WHEN the current revision maps that preview location
- THEN the language service returns the authored MMT URI and the approved coarse statement/text-body start
- AND the result identifies itself as fallback precision rather than exact Identity mapping

#### Scenario: Fallback never makes a generated segment editable

- GIVEN a Synthetic、Escaped or MacroExpansion projection segment has an authored parent origin
- WHEN rename、formatting、TextEdit or general Typst-to-MMT mapping evaluates that segment
- THEN the operation remains rejected under the Identity-only projection contract
- AND the preview fallback MUST NOT be reused as edit authorization

#### Scenario: Stale fallback is rejected

- GIVEN a fallback candidate belongs to an obsolete revision、projection key、source content or project digest
- WHEN it arrives after a newer projection is current
- THEN the host rejects the result
- AND it does not open either authored MMT or generated Typst

### Requirement: Authored Typst and MMT fallback precision remain distinct

Standalone/authored Typst SHALL retain exact click navigation for direct `Text` and `MathText`, while function-generated or string-generated text SHALL use syntax-node fallback. MMT parent-origin fallback SHALL apply only to a current MMT projection with a proven authored parent.

#### Scenario: Authored Typst function text uses node fallback

- GIVEN an authored `.typ` document contains `#text("hello")`
- WHEN the author clicks inside the rendered word
- THEN navigation opens that authored Typst document at the function call start
- AND no MMT parent-origin lookup occurs

#### Scenario: Unmapped generated content remains unmapped

- GIVEN rendered content has no source span or its generated projection segment has no authored `TextBody` parent
- WHEN the author clicks it
- THEN the host reports the location as unmapped or retained generated projection according to the existing read-only policy
- AND it MUST NOT invent an authored source target
