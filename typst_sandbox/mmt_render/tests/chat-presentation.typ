#import "../lib.typ" as mmt
#import "../config.typ": current-config

#let width-pt = int(sys.inputs.at("width", default: "390"))
#let chat-width = width-pt * 1pt

#let base = mmt.themes.moetalk()
#let authored-theme = base + (
  text: base.text + (font: "DejaVu Sans", fill: rgb("213547")),
  narration: base.narration + (fill: rgb("dde6ee")),
)

#show: mmt.template.with(
  theme: authored-theme,
  presentation: "chat",
  chat-width: chat-width,
  show-header: true,
  show-footer: true,
  title: [#metadata("unexpected header") <unexpected-header>],
)

#context {
  let config = current-config()
  assert(config.theme.page.width == chat-width)
  assert(config.theme.page.margin == (x: 12pt, y: 12pt))
  assert(config.theme.text.size == 16pt)
  assert(config.theme.text.font == authored-theme.text.font)
  assert(config.theme.text.fill == authored-theme.text.fill)
  assert(config.theme.narration == authored-theme.narration)
  assert(config.theme.reply == authored-theme.reply)
  assert(config.theme.bond == authored-theme.bond)
  assert(config.theme.chat.avatar-size == 40pt)
  assert(config.theme.chat.avatar-gap == 8pt)
  assert(config.theme.chat.message-gap == 12pt)
  assert(config.theme.chat.continued-gap == 4pt)
  assert(config.theme.chat.bubble-radius == 12pt)
  assert(config.theme.chat.bubble-left-fill == authored-theme.chat.bubble-left-fill)
  assert(config.theme.chat.bubble-right-fill == authored-theme.chat.bubble-right-fill)
  assert(config.theme.chat.bubble-text-fill == authored-theme.chat.bubble-text-fill)
  assert(config.theme.chat.bubble-inset == authored-theme.chat.bubble-inset)
  assert(text.size == 16pt)
  assert(page.fill == none)
  assert(page.footer == none)
  assert(query(<unexpected-header>).len() == 0)
  layout(size => {
    assert(size.width == chat-width - 24pt)
    let portrait = mmt.avatar(circle(fill: rgb("91d7d9")))
    let explicit-portrait = mmt.avatar(circle(fill: rgb("91d7d9")), size: 24pt)
    assert(measure(portrait).width == 40pt)
    assert(measure(portrait).height == 40pt)
    assert(measure(explicit-portrait).width == 24pt)
    mmt.chat-left(avatar: portrait, name: [Author])[Readable text and an avatar]
  })
}

#mmt.chat-left(auto-continued: true)[Continued message]
#mmt.chat-right(fill: rgb("4a8ac6"), radius: 5pt)[An explicit message patch is retained]
#mmt.narration[Authored narration]
#mmt.reply[First option][Second option]
#mmt.bond(decoration: none)[Authored bond content]

#pagebreak()
#mmt.chat-right[Explicit authored page break]
