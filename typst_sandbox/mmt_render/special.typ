#import "config.typ": current-config

#let _shadow-card(fill: white, shadow: rgb(89, 85, 101, 28%), radius: 4pt, inset: 8pt, body) = box(
  width: 100%,
  inset: 0pt,
  outset: 0pt,
)[
  #place(dx: 0pt, dy: 3pt, block(
    width: 100%,
    fill: shadow,
    inset: inset,
    radius: radius,
  )[#body])
  #block(width: 100%, fill: fill, inset: inset, radius: radius)[#body]
]

#let narration(fill: auto, text-fill: auto, inset: auto, radius: auto, body) = context {
  let theme = current-config().theme.narration
  block(
    width: 100%,
    fill: if fill == auto { theme.fill } else { fill },
    inset: if inset == auto { theme.inset } else { inset },
    radius: if radius == auto { theme.radius } else { radius },
  )[
    #set align(center)
    #set text(fill: if text-fill == auto { theme.text-fill } else { text-fill })
    #body
  ]
}

#let reply(
  label: [回复],
  fill: auto,
  accent: auto,
  inset: auto,
  radius: auto,
  decoration: image("mmt_options.webp"),
  ..items,
) = context {
  let theme = current-config().theme.reply
  let panel-fill = if fill == auto { theme.fill } else { fill }
  let item-accent = if accent == auto { theme.accent } else { accent }
  let panel-inset = if inset == auto { theme.inset } else { inset }
  let panel-radius = if radius == auto { theme.radius } else { radius }

  pad(left: 4em, box(
    width: 100%,
    fill: panel-fill,
    radius: panel-radius,
    inset: (x: 6pt, y: panel-inset),
    clip: true,
  )[
    #if decoration != none {
      place(top + right, dx: 6pt, dy: -panel-inset, decoration)
    }
    #place(line(
      start: (2pt, -0.2em),
      end: (2pt, 1em),
      stroke: rgb("168eea") + 0.15em,
    ))
    #v(1pt)
    #h(5pt)#strong(label)
    #v(-0.4em)
    #line(length: 100%, stroke: gray + 0.05em)
    #v(-0.7em)
    #set text(fill: item-accent)
    #set align(center)
    #stack(
      spacing: 0.5em,
      ..items.pos().map(item => pad(x: -4pt)[
        #_shadow-card(fill: white, inset: 8pt, radius: 4pt)[#item]
      ]),
    )
  ])
}

#let bond(
  label: [羁绊事件],
  fill: auto,
  text-fill: auto,
  inset: auto,
  radius: auto,
  decoration: image("mmt_favor.webp", width: 25%),
  body,
) = context {
  let theme = current-config().theme.bond
  let panel-inset = if inset == auto { theme.inset } else { inset }
  let panel-radius = if radius == auto { theme.radius } else { radius }
  let button-fill = if fill == auto { theme.fill } else { fill }
  let button-text = if text-fill == auto { theme.text-fill } else { text-fill }

  pad(left: 4em, box(
    width: 100%,
    fill: rgb("fceef0"),
    radius: panel-radius,
    inset: (x: 6pt, y: panel-inset),
    clip: true,
  )[
    #if decoration != none {
      place(top + right, dx: 6pt, dy: -panel-inset, decoration)
    }
    #place(line(
      start: (2pt, -0.2em),
      end: (2pt, 1em),
      stroke: rgb("ff8e9b") + 0.15em,
    ))
    #v(1pt)
    #h(5pt)#strong(label)
    #v(-0.4em)
    #line(length: 100%, stroke: gray + 0.05em)
    #v(-0.7em)
    #set text(fill: button-text)
    #set align(center)
    #pad(x: -4pt)[
      #_shadow-card(fill: button-fill, inset: 8pt, radius: 4pt)[#body]
    ]
  ])
}
