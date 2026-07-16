## ADDED Requirements

### Requirement: Public Typst API distinguishes implemented and proposed behavior

The MMT Typst renderer SHALL publish `lib.typ` as its only supported import boundary and SHALL document current callable behavior separately from unavailable proposals.

#### Scenario: Current documentation is executable

- GIVEN a function is shown in an unqualified runnable example in the public API reference
- WHEN a caller imports `lib.typ` under Typst 0.15
- THEN that name and documented signature MUST exist in the current implementation
- AND the example MUST NOT depend on private modules or private state helpers

#### Scenario: Proposed APIs are not presented as current

- GIVEN a theme helper or preset has not been exported by `lib.typ`
- WHEN design documentation discusses that helper
- THEN it MUST be labeled proposed or unavailable
- AND the current API reference MUST NOT imply that the call can be compiled

### Requirement: Supported themes are complete versioned records

Every supported built-in or external theme SHALL conform to one complete schema version and provide every required static and dynamic group.

#### Scenario: Built-in theme returns a complete record

- GIVEN a caller invokes a supported built-in theme constructor
- WHEN the returned value is supplied to `mmt.template`
- THEN the record MUST identify its supported theme schema
- AND MUST contain all required `page`, `text`, `header`, `footer`, `chat`, `narration`, `reply`, and `bond` groups

#### Scenario: Unsupported complete record fails deterministically

- GIVEN a caller supplies a complete record with an unsupported schema version, missing required group, missing required token, or unknown required structure
- WHEN the template or public theme validator consumes it
- THEN Typst compilation MUST fail with a message identifying the unsupported or malformed portion
- AND MUST NOT silently fall back to `moetalk`

### Requirement: Theme derivation preserves unspecified base values

The public theme patch helper SHALL derive a complete validated theme from a complete base and explicitly supplied group patches.

#### Scenario: Partial group patch inherits the base

- GIVEN a complete `moetalk` theme
- WHEN a caller patches only `chat.bubble-right-fill`
- THEN the returned complete theme MUST use the supplied right-bubble fill
- AND every unspecified chat token and every other group MUST retain the base value
- AND the input base record MUST remain unchanged

#### Scenario: Unknown group or field is rejected

- GIVEN a caller supplies an unknown theme group or token name
- WHEN the public patch helper validates the patch
- THEN compilation MUST fail deterministically
- AND the message MUST identify the unknown name

#### Scenario: Patch cannot rewrite schema identity

- GIVEN a caller attempts to replace the theme schema marker through a visual patch
- WHEN the public patch helper validates the request
- THEN compilation MUST fail
- AND the caller MUST use a constructor or future explicit migration API instead

### Requirement: Static and dynamic theme values have explicit timing

The theme contract SHALL classify every public token as template-initialized or position-dynamic.

#### Scenario: Template applies static values once

- GIVEN a complete theme sets page, base text, header, or footer tokens
- WHEN `mmt.template` establishes the show environment
- THEN those values MUST affect the document initialization and header/footer output
- AND a later position-dependent call MUST NOT claim to retroactively change earlier output

#### Scenario: Dynamic patch affects only subsequent components

- GIVEN a caller emits a valid partial patch for a dynamic chat, narration, reply, or bond token
- WHEN components render before and after that call
- THEN earlier components MUST keep their previous appearance
- AND later components MUST use the patched value unless an explicit node argument overrides it

#### Scenario: Partial position patch rejects static groups

- GIVEN a caller passes a partial position-dependent theme patch containing `page`, `text`, `header`, or `footer`
- WHEN `mmt.configure` validates that patch
- THEN compilation MUST fail with a message naming the static group
- AND MUST NOT silently accept a value that cannot take effect

#### Scenario: Complete theme replacement remains compatible

- GIVEN existing advanced Typst calls `mmt.configure(theme: mmt.themes.moetalk())` or another complete supported theme
- WHEN that call occurs after template initialization
- THEN the call MUST remain valid
- AND subsequent dynamic components MUST use the replacement theme's dynamic groups
- AND its static groups MUST NOT retroactively rebuild page, text, header, or footer output

### Requirement: Position configuration supports partial update and baseline restoration

`mmt.configure` SHALL preserve its public name while distinguishing no-op, partial update, complete-theme replacement, and template-baseline restoration.

#### Scenario: None leaves configuration unchanged

- GIVEN a caller omits `theme` or `chat`, or supplies `none`
- WHEN `mmt.configure` updates another group
- THEN the omitted group MUST retain its current value

#### Scenario: Auto restores the active template baseline

- GIVEN `mmt.template` established a theme and chat behavior baseline
- AND later calls changed one or both groups
- WHEN a caller supplies `theme: auto` or `chat: auto`
- THEN the selected group MUST return to the baseline established by that template invocation
- AND MUST NOT reset to a hidden library default or state from another document

#### Scenario: Existing continued configuration remains valid

- GIVEN a caller uses `mmt.configure(chat: (continued: true))`
- WHEN later chat nodes leave `continued: auto`
- THEN those nodes MUST use the configured value
- WHEN the caller restores `continued: auto`
- THEN later nodes MUST again use emitter `auto-continued`

### Requirement: Explicit node values retain highest precedence

Theme and position configuration SHALL provide defaults without overriding explicit semantic façade parameters.

#### Scenario: Node fill overrides configured theme

- GIVEN the document theme and current position config each provide a chat fill
- WHEN a chat call supplies an explicit non-`auto` fill
- THEN the explicit fill MUST be used for that node
- AND later nodes without an explicit fill MUST continue using current configuration

### Requirement: Every supported token has observable verification

The implementation SHALL verify that documented theme tokens affect the intended output rather than only existing in a dictionary.

#### Scenario: Token consumption is tested

- GIVEN a public token is included in the supported schema
- WHEN validation runs under Typst 0.15
- THEN at least one focused probe or render assertion MUST distinguish its overridden output from the base output
- AND tokens for header, footer, reply, and bond MUST be covered after their migration from hard-coded values
