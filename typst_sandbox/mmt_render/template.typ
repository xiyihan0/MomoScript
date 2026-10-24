#import "config.typ": configure
#import "themes/moetalk.typ": moetalk

#let _header(
  project: [Momo_#underline[Script]_],
  title: "无题",
  author: none,
  compiled-at: none,
) = {
  set text(fill: white)
  pad(x: -10pt, top: -20pt, block(
    width: 100%,
    fill: rgb("86aedd"),
    inset: (x: 10pt, y: 8pt),
  )[
    #grid(
      columns: (auto, 1fr),
      column-gutter: 12pt,
      align: (left + horizon, right + horizon),
      text(size: 20pt, weight: "bold", project),
      align(right)[
        #set text(size: 9pt, weight: "bold", stroke: 0.02em + white)
        标题：#title
        #if author != none { [\ 作者：#author] }
        #if compiled-at != none { [\ 创建于：#compiled-at] }
      ],
    )
  ])
}

#let template(
  theme: moetalk(),
  chat: (:),
  show-header: true,
  show-footer: true,
  project: [Momo_#underline[Script]_],
  title: "无题",
  author: none,
  compiled-at: none,
  presentation: "output",
  chat-width: none,
  body,
) = {
  let authoring-chat = presentation == "chat"
  let theme = if authoring-chat {
    theme + (
      page: theme.page + (
        width: chat-width,
        margin: (x: 12pt, y: 12pt),
      ),
      text: theme.text + (size: 16pt),
      chat: theme.chat + (
        avatar-size: 40pt,
        avatar-gap: 8pt,
        message-gap: 12pt,
        continued-gap: 4pt,
        bubble-radius: 12pt,
      ),
    )
  } else {
    theme
  }
  set page(fill: none) if authoring-chat
  set page(
    width: theme.page.width,
    height: auto,
    margin: theme.page.margin,
    footer: if show-footer and not authoring-chat {
      context align(center, counter(page).display("1 / 1", both: true))
    },
  )
  set text(
    font: theme.text.font,
    size: theme.text.size,
    fill: theme.text.fill,
  )
  set par(spacing: if authoring-chat { 0pt } else { 1em })
  configure(theme: theme, chat: chat + (presentation: presentation))

  if show-header and not authoring-chat {
    _header(
      project: project,
      title: title,
      author: author,
      compiled-at: compiled-at,
    )
    v(0.8em)
  }
  body
}
