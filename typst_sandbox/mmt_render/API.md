# MMT Typst Public API

- **Status:** Experimental
- **Implementation baseline:** MomoScript DSL v2 / Typst 0.15
- **Public entry:** `lib.typ`

This document describes the Typst API that exists in the repository today. Proposed theme extension APIs are deliberately kept out of runnable examples; see the [active theme API change](../../openspec/changes/add-typst-theme-api/) for that design.

## Public boundary

Import only `lib.typ`:

```typst
#import "lib.typ" as mmt
```

The import has no visible output and does not install page, text, show, or state configuration by itself. A document opts into the rendering environment with `mmt.template`.

Only names re-exported by `lib.typ` are public. Direct imports from `config.typ`, `chat.typ`, `special.typ`, `resource.typ`, `template.typ`, or `themes/*.typ` are implementation details. In particular, `current-config`, the backing Typst state, and private helpers such as `_header` are not public APIs.

## Quick start

```typst
#import "lib.typ" as mmt

#show: mmt.template.with(
  theme: mmt.themes.moetalk(),
  title: "Example",
  author: "xiyihan",
)

#mmt.chat-left(
  avatar: mmt.avatar(circle(fill: rgb("91d7d9"))),
  name: [柚子],
)[你好。]

#mmt.narration[这是一段旁白。]
#mmt.reply[选项 A][选项 B]
#mmt.bond[羁绊事件]
```

The Rust emitter uses the same façade. It lowers MMT semantics, escapes or preserves body content according to body mode, resolves resources, and emits calls to these functions. The Typst library does not parse MMT source, pack selectors, actor names, or `[:...:]` markers.

## Status summary

| API | Status | Purpose |
|---|---|---|
| `mmt.template` | Current, experimental | Establish the document page, text, header, footer, and initial config |
| `mmt.themes.moetalk()` | Current, experimental | Return the only built-in theme currently available |
| `mmt.configure` | Current, experimental | Update position-dependent theme or chat state |
| `mmt.chat` | Current, experimental | Render a left- or right-side chat message |
| `mmt.chat-left`, `mmt.chat-right` | Current, experimental | Direction-specific wrappers around `mmt.chat` |
| `mmt.narration` | Current, experimental | Render centered narration |
| `mmt.reply` | Current, experimental | Render one or more reply options |
| `mmt.bond` | Current, experimental | Render a bond event |
| `mmt.avatar` | Current, experimental | Crop supplied content into a circular avatar |
| `mmt.sticker` | Current, experimental | Size supplied content as a sticker |
| `mmt.bubble` | Current, advanced | Render a low-level speech bubble without chat layout |

The following names are **not implemented**: `mmt.themes.get`, `mmt.themes.patch`, `mmt.themes.minimal`, `mmt.themes.dark`, and reset behavior such as `mmt.configure(theme: auto)`. They are proposal material, not current API.

## Shared conventions

### Content, not selectors

Visual helpers receive Typst content. They do not accept MMT resource selectors, pack keys, actor names, remote URLs, or untrusted paths.

```typst
#mmt.avatar(image("materialized/avatar.png"))
#mmt.sticker(image("materialized/sticker.png"))
```

The compiler and host are responsible for resolving and materializing resources before Typst compilation.

### `auto` and `none`

`none` normally means that optional content is absent. `auto` normally means that the component should consult configuration or derive a value. The exact fallback chain is documented per function.

### Kebab-case

Public parameters use Typst-style kebab-case. The API does not maintain snake_case aliases.

### Position-dependent state

`mmt.configure` updates Typst state at its document position. Components that read that state see the update only after it occurs. It never changes already rendered content.

## `mmt.template`

### Signature

```typst
#let template(
  theme: moetalk(),
  chat: (:),
  show-header: true,
  show-footer: true,
  project: [Momo_#underline[Script]_],
  title: "无题",
  author: none,
  compiled-at: none,
  body,
)
```

### Parameters

| Parameter | Accepted shape | Default | Meaning |
|---|---|---|---|
| `theme` | theme dictionary | `mmt.themes.moetalk()` | Initial document theme |
| `chat` | dictionary | `(:)` | Initial chat behavior configuration |
| `show-header` | boolean | `true` | Whether to render the document header |
| `show-footer` | boolean | `true` | Whether to render page numbering |
| `project` | content | MomoScript wordmark | Header project label |
| `title` | string or content | `"无题"` | Header title |
| `author` | string, content, or `none` | `none` | Optional header author |
| `compiled-at` | string, content, or `none` | `none` | Optional preformatted compilation time |
| `body` | content | required | Document body supplied by the show rule |

### Behavior

`template` installs page width and margin from `theme.page`, installs base text properties from `theme.text`, initializes theme/chat state, renders the optional header, and supplies an optional page-number footer.

`compiled-at` must already be formatted. The template does not read a clock, infer a timezone, or format an instant. MMT preview/export hosts inject a revision- or export-pinned value before emission.

Page, base text, header, and footer setup happens when the show rule starts. A later `mmt.configure(theme: ...)` call cannot retroactively change these values.

## `mmt.themes.moetalk()`

### Signature

```typst
#let moetalk() = (...)
```

It returns the current complete built-in theme dictionary:

```text
page
  width
  margin
text
  font
  size
  fill
chat
  avatar-size
  avatar-gap
  bubble-left-fill
  bubble-right-fill
  bubble-text-fill
  bubble-inset
  bubble-radius
  message-gap
  continued-gap
narration
  fill
  text-fill
  inset
  radius
reply
  fill
  accent
  inset
  radius
bond
  fill
  text-fill
  inset
  radius
```

### Current limitations

The dictionary is not yet a versioned external theme schema:

- Header and footer tokens are still implemented directly in `template.typ`.
- `mmt.reply` and `mmt.bond` still contain visual defaults that are not read from `theme.reply` and `theme.bond`.
- `theme.chat.avatar-size`, `avatar-gap`, `message-gap`, and `continued-gap` are currently declared but not consumed; `chat.typ` still uses fixed layout values for those decisions.
- `mmt.bubble` is a low-level helper with literal defaults and does not consult theme state.
- Unknown theme fields are not currently validated.
- There is no public theme patch or inheritance helper.

Callers may pass `mmt.themes.moetalk()` to `template`, but external code should not yet treat every nested key as a stable cross-version ABI.

## `mmt.configure`

### Current signature

```typst
#let configure(theme: none, chat: none)
```

### Current behavior

| Input | Current effect |
|---|---|
| `theme: none` | Leave the current theme unchanged |
| `theme: dictionary` | Replace the complete current theme value |
| `chat: none` | Leave chat configuration unchanged |
| `chat: dictionary` | Shallow-merge fields into the current chat dictionary |

Theme updates are complete replacement today, not deep patches. There is no current reset operation.

```typst
#mmt.configure(chat: (continued: true))
#mmt.chat-left(auto-continued: false)[Forced continued rendering]

#mmt.configure(chat: (continued: auto))
#mmt.chat-left(auto-continued: false)[Emitter behavior is active again]
```

`mmt.chat`, `mmt.chat-left`, `mmt.chat-right`, and `mmt.narration` read current configuration in a Typst `context`. Page setup and the already-rendered header do not.

The following does not work because these APIs are ordinary Typst functions rather than element functions:

```typst
// Invalid Typst.
#set mmt.chat-left(continued: true)
```

Use `mmt.configure` for position-dependent configuration.

## `mmt.chat`

### Signature

```typst
#let chat(
  side: left,
  avatar: none,
  name: none,
  auto-continued: false,
  continued: auto,
  fill: auto,
  text-fill: auto,
  inset: auto,
  radius: auto,
  tip: auto,
  image-only: false,
  reserve-avatar-space: auto,
  body,
)
```

### Parameters

| Parameter | Meaning |
|---|---|
| `side` | `left` or `right` layout direction |
| `avatar` | Already prepared avatar content or `none` |
| `name` | Display-name content or `none` |
| `auto-continued` | Continuation fact computed by the emitter |
| `continued` | Explicit `true`/`false`, or `auto` to consult configuration and emitter state |
| `fill` | Bubble fill override, or `auto` for the side-specific theme fill |
| `text-fill` | Bubble text override, or `auto` for the theme value |
| `inset` | Bubble inset override, or `auto` for the theme value |
| `radius` | Bubble radius override, or `auto` for the theme value |
| `tip` | Explicit bubble-tip visibility, or `auto` to hide the tip on continued messages |
| `image-only` | Use the current image-only bubble treatment |
| `reserve-avatar-space` | Explicit spacing decision, or `auto` based on avatar presence |
| `body` | Message content |

### Continued-message resolution

```text
explicit continued true/false
> current configure.chat.continued true/false
> emitter auto-continued
```

An effective continued message hides the visible avatar and name, removes the automatic bubble tip, and tightens vertical spacing. `auto-continued` is an emitter fact; hand-written Typst usually leaves it at `false` unless reproducing emitted behavior.

### Example

```typst
#mmt.chat(
  side: right,
  avatar: mmt.avatar(circle(fill: aqua)),
  name: [Sensei],
  fill: rgb("3155a6"),
)[Message]
```

## `mmt.chat-left` and `mmt.chat-right`

```typst
#let chat-left(..args) = chat(side: left, ..args)
#let chat-right(..args) = chat(side: right, ..args)
```

They accept the remaining `mmt.chat` arguments and force `side`. Prefer them for normal hand-written calls.

```typst
#mmt.chat-left(name: [柚子])[Left message]
#mmt.chat-right(name: [Sensei])[Right message]
```

## `mmt.bubble`

### Signature

```typst
#let bubble(
  side: left,
  fill: luma(90%),
  text-fill: black,
  inset: 7pt,
  radius: 5pt,
  tip: true,
  body,
)
```

This is an advanced low-level visual primitive. It renders only a bubble and optional tip. It does not place an avatar or name, determine continuation, reserve chat columns, or read current theme state.

Use `mmt.chat-left` or `mmt.chat-right` unless composing a custom layout.

## `mmt.narration`

### Signature

```typst
#let narration(
  fill: auto,
  text-fill: auto,
  inset: auto,
  radius: auto,
  body,
)
```

Each `auto` value resolves from `current-config().theme.narration`. The body is centered.

```typst
#mmt.narration(fill: luma(95%))[Narration]
```

## `mmt.reply`

### Signature

```typst
#let reply(
  label: [回复],
  fill: rgb("e1edf0"),
  accent: rgb("4b6989"),
  decoration: image("mmt_options.webp"),
  ..items,
)
```

`items` are variadic positional content arguments. Typst 0.15 supports consecutive content blocks:

```typst
#mmt.reply(label: [Choose])[Option A][Option B][Option C]
```

`decoration: none` disables the top-right decoration.

Current limitation: visual defaults are still literal function defaults; `theme.reply` is not yet consumed by this function.

## `mmt.bond`

### Signature

```typst
#let bond(
  label: [羁绊事件],
  fill: rgb("fc879b"),
  text-fill: white,
  decoration: image("mmt_favor.webp", width: 25%),
  body,
)
```

```typst
#mmt.bond(label: [Bond event])[Content]
```

`decoration: none` disables the top-right decoration.

Current limitation: visual defaults are still literal or internal values; `theme.bond` is not yet consumed by this function.

## `mmt.avatar`

### Signature

```typst
#let avatar(content, size: 3em)
```

The helper sets image sizing for its content and clips it into a circular box.

```typst
#mmt.avatar(image("materialized/avatar.png"), size: 3em)
```

It does not locate, download, decode, or resolve the image.

## `mmt.sticker`

### Signature

```typst
#let sticker(
  content,
  width: 70%,
  height: auto,
  fit: "contain",
)
```

When `height` is `auto`, the helper preserves content-driven height inside a box of the requested width. With an explicit height, it creates a fixed-size box and applies both image dimensions.

```typst
#mmt.sticker(
  image("materialized/sticker.png"),
  width: 50%,
  fit: "contain",
)
```

It does not interpret MMT marker suffixes. The Rust emitter maps validated resource patch arguments to this call.

## Diagnostics and source mapping

A call emitted as compiler scaffolding may have a synthetic source origin. Body content, node parameters, resource parameters, and raw `@typ` chunks retain finer generated-to-MMT mappings.

When a user writes a public API call inside `@typ`, Typst syntax or type diagnostics should map to that source chunk. The Typst library must not catch errors by evaluating source strings or hide them behind an unrelated generated location.

## Compatibility policy

The façade is experimental until a stable API version is declared.

- New public names are exported only from `lib.typ`.
- Public parameters use kebab-case; compatibility aliases are not added by default.
- Importing `lib.typ` remains side-effect free.
- Rust emitter output and hand-written Typst use the same façade.
- A future external theme ABI must carry an explicit schema version.
- Removing or renaming public functions, parameters, or documented theme fields requires an OpenSpec change and behavior-test updates.

## Verification

The current façade smoke source is `tests/v2-smoke.typ`:

```bash
cd typst_sandbox/mmt_render
typst compile tests/v2-smoke.typ /tmp/mmt-v2-smoke.pdf --root ..
```

A successful compile verifies callable signatures and basic Typst integration. Theme work additionally requires observable output checks so that a token is proven to affect the intended component rather than merely being accepted.
