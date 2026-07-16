# Design: Versioned Typst theme API

## 1. Design goals

The theme API should make common customization declarative without pretending that every Typst layout can be reduced to tokens. It must support three audiences:

1. ordinary callers selecting a complete preset;
2. theme authors deriving a complete theme with typed partial overrides;
3. advanced Typst authors performing position-dependent visual changes or composing lower-level façade calls.

The public contract must leave internal implementation free to change. Callers depend on `lib.typ` exports, documented signatures, theme schema, precedence, and observable output—not on file layout, backing `state`, or private helpers.

## 2. Current baseline

`lib.typ` currently exports:

```text
themes
configure
template
bubble
chat
chat-left
chat-right
narration
reply
bond
avatar
sticker
```

`themes` currently exposes only `moetalk()`. `config.typ` stores:

```typst
(
  theme: moetalk(),
  chat: (continued: auto),
)
```

Current update behavior is asymmetric:

- `configure(theme: value)` replaces the complete theme;
- `configure(chat: dictionary)` shallow-merges the chat behavior dictionary.

Current consumption is incomplete:

- `template` reads `page` and `text` groups;
- `chat` reads only the bubble fill/text/inset/radius subset of `theme.chat`; declared avatar size/gap and message/continued gap tokens are currently unused while layout values remain hard-coded;
- `narration` reads `theme.narration`;
- header/footer are hard-coded in `template.typ`;
- `reply` and `bond` use literal/internal values instead of their theme groups;
- `bubble` is intentionally a low-level helper with literal defaults.

The current facts are documented in `typst_sandbox/mmt_render/API.md` and remain distinct from this proposed target.

## 3. Public versus internal API

`lib.typ` remains the only public entry. A source file may change location or implementation without compatibility work when it is not re-exported there.

Public API:

- built-in theme constructors exposed through `mmt.themes`;
- complete theme patch/validation helpers exposed through `mmt.themes`;
- `mmt.template`;
- `mmt.configure`;
- semantic façade and documented advanced visual helpers.

Internal API:

- the backing `state` keys and record layout;
- `current-config`;
- header/footer helper functions;
- normalization and validation helpers;
- direct `themes/*.typ` paths;
- renderer implementation file boundaries.

## 4. Complete theme record

The first supported external record carries an explicit schema marker:

```typst
(
  schema: "mmt-theme.v1",
  id: "local::dusk",
  page: (...),
  text: (...),
  header: (...),
  footer: (...),
  chat: (...),
  narration: (...),
  reply: (...),
  bond: (...),
)
```

`schema` is required for externally supplied complete themes. Built-in constructors MUST return the same supported shape. `id` is diagnostic metadata and does not select or resolve a theme by itself.

### 4.1 Proposed groups

The initial schema should cover every visual value currently managed by the template and semantic components:

| Group | Token families | Initialization class |
|---|---|---|
| `page` | width, margin, fill | static |
| `text` | font, size, fill | static by default |
| `header` | fill, text fill, inset, project/title/meta typography and spacing | static |
| `footer` | visibility-independent visual values, text fill/size and spacing | static |
| `chat` | avatar geometry, side fills, text fill, inset, radius, tip geometry, message/continued gaps | dynamic |
| `narration` | fill, text fill, inset, radius | dynamic |
| `reply` | panel/item fills, accent, text fill, inset, radius, decoration | dynamic |
| `bond` | panel/event fills, accent, text fill, inset, radius, decoration | dynamic |

The implementation task MUST publish the exact token table, accepted Typst value shapes, and default values before declaring `mmt-theme.v1` supported. The table is part of the public ABI once published.

### 4.2 Static and dynamic groups

Static tokens are consumed while `mmt.template` establishes page/text/header/footer output. Position-dependent updates cannot change content that already rendered or page settings already installed.

Dynamic tokens are read by contextual components at their document position. A valid update affects subsequent components only.

A position-dependent **partial patch** containing a static group MUST fail with a direct error naming that group. A complete supported theme record remains accepted for compatibility: it replaces the current complete theme state, so subsequent dynamic components use its dynamic groups, while its static groups do not retroactively rebuild page/text/header/footer output. The schema marker distinguishes a complete record from a partial patch.

## 5. Built-in themes

The first implementation should expose at least two visually distinct complete themes; otherwise selection has no observable value. The intended initial set is:

- `mmt.themes.moetalk()` — compatibility default preserving current output;
- `mmt.themes.minimal()` — neutral, low-decoration, print/debug-friendly output;
- `mmt.themes.dark()` — optional in the first batch, but MUST be complete if exposed.

A built-in is a function returning a fresh complete theme dictionary. Callers do not mutate a shared object.

The emitter maps validated theme identities to known constructor calls. It MUST NOT interpolate an arbitrary function name or user-provided Typst expression.

## 6. Complete-theme derivation

### 6.1 Proposed API

```typst
// Proposed; unavailable until implemented.
#let dusk = mmt.themes.patch(
  mmt.themes.moetalk(),
  page: (
    fill: rgb("141821"),
  ),
  chat: (
    bubble-left-fill: rgb("30394a"),
    bubble-right-fill: rgb("596fa3"),
  ),
)

#show: mmt.template.with(theme: dusk)
```

Target signature shape:

```typst
#let patch(base, ..groups) = ...
```

### 6.2 Merge rules

- `base` MUST be a complete supported theme.
- Named arguments identify top-level theme groups.
- Each supplied group MUST be a dictionary.
- Known group fields merge into the corresponding base group.
- Unspecified groups and fields retain the base value.
- Unknown groups and unknown fields fail deterministically.
- `schema` cannot be changed by a patch.
- `id` MAY be supplied through a dedicated parameter or helper, but MUST NOT be treated as a visual group.
- The operation returns a complete theme and does not modify the input record.
- The helper validates the resulting complete record before returning it.

The implementation may use explicit per-group merge functions instead of a generic recursive merge. Explicit functions are preferred when they produce better unknown-field and type errors.

## 7. Position-dependent configuration

### 7.1 Proposed compatible signature

The public name and existing arguments remain:

```typst
#let configure(theme: none, chat: none)
```

The accepted value contract expands:

| Argument value | Target behavior |
|---|---|
| `none` | Do not update that configuration group |
| complete supported theme dictionary | Replace the current complete theme state; only later dynamic consumers can observe the change |
| partial theme dictionary | Validate and merge allowed dynamic groups; reject static groups |
| `auto` | Restore the template-established baseline for that group |

Examples:

```typst
// Proposed theme patch behavior.
#mmt.configure(
  theme: (
    chat: (bubble-right-fill: rgb("7c5cff")),
  ),
)

// Restore the document theme selected by template.
#mmt.configure(theme: auto)
```

The current `chat: (continued: ...)` behavior remains supported:

```typst
#mmt.configure(chat: (continued: true))
#mmt.configure(chat: (continued: auto))
```

`theme` carries visual tokens. The separate top-level `chat` configuration carries chat behavior such as `continued`; visual and behavioral namespaces do not silently alias each other.

### 7.2 Baseline and current state

Reset requires two logical values:

```text
baseline config established by template
current position-dependent config
```

The backing representation is internal. It may use one state containing both records or separate states. The public invariant is that `auto` restores the values established by the current `mmt.template` invocation, not library hard-coded defaults and not a previous document's state.

### 7.3 Precedence

```text
explicit node/function argument
> current mmt.configure position state
> template theme and behavior baseline
> emitter auto facts such as auto-continued
```

For visual parameters, `auto` normally consults current theme state. For `continued`, explicit booleans override configured behavior, which overrides emitter `auto-continued`.

## 8. User-defined Typst themes

A user can define a theme as Typst data without replacing renderer structure:

```typst
#import "lib.typ" as mmt

#let dusk = mmt.themes.patch(
  mmt.themes.moetalk(),
  chat: (...),
  narration: (...),
)

#show: mmt.template.with(theme: dusk)
```

This is the initial advanced customization path. It permits arbitrary Typst values inside documented token types while retaining a validated record structure.

A separate local or pack theme resolver may later map `local::dusk` or `namespace::theme` to such a record. That resolver belongs to a future MMT/project/pack change. Direct absolute paths, remote imports, and host I/O are not added by this Typst API change.

Replacing component structure or behavior with custom functions is a template/plugin concern, not theme customization. Raw Typst remains available, but no stable plugin ABI is implied here.

## 9. Component migration

Before the schema is declared supported:

1. move header/footer visual literals into documented theme groups;
2. make `reply` and `bond` resolve `auto` parameters from current theme state;
3. make chat avatar geometry and message/continued spacing consume their documented theme tokens instead of fixed layout values;
4. preserve explicit node arguments above theme values;
5. keep `bubble` documented as a low-level non-theme-aware helper unless a separate decision changes it;
6. ensure every built-in returns all required fields;
7. ensure `moetalk()` retains the existing visual baseline.

Internal layout code may continue to evolve after these migrations as long as public tokens retain their documented meaning and observable precedence.

## 10. Diagnostics

Theme errors should identify:

- unsupported schema versions;
- missing required groups or fields in complete records;
- unknown group or field names;
- invalid use of static groups in position-dependent configuration;
- value-shape errors where the library can validate them;
- invalid built-in or externally resolved theme identity at the MMT layer.

Errors from a call in `@typ` must remain source-mappable to the raw Typst chunk. Emitter-generated theme setup uses synthetic wrapper origins while preserving source ranges for user-authored DSL values in a future integration.

## 11. Compatibility strategy

- `mmt.themes.moetalk()` and existing façade names remain available.
- The theme record is experimental until `mmt-theme.v1` is explicitly declared supported.
- Once supported, incompatible field removal, rename, or meaning changes require `mmt-theme.v2`.
- Adding an optional field with a defined default may remain compatible.
- Internal files, state representation, and helper functions may change without API impact.
- Proposed APIs are never shown as current in runnable user documentation before implementation and tests.

## 12. Deferred decisions

- exact token names and value shapes for header/footer decoration;
- whether `dark()` lands with the first implementation or after `minimal()`;
- whether base text fields can have a safe dynamic subset;
- external theme module packaging and ABI discovery;
- pack-v3 theme contributions;
- MMT syntax for named themes and position-dependent configuration;
- whether theme metadata needs display name, description, preview colors, or author fields beyond `schema` and `id`.
