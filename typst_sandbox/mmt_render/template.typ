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
  body,
) = {
  set page(
    width: theme.page.width,
    height: auto,
    margin: theme.page.margin,
    footer: if show-footer {
      context align(center, counter(page).display("1 / 1", both: true))
    },
  )
  set text(
    font: theme.text.font,
    size: theme.text.size,
    fill: theme.text.fill,
  )
  set par(spacing: 1em)
  configure(theme: theme, chat: chat)

  if show-header {
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
