#import "@preview/shadowed:0.2.0": shadowed
#import "config.typ": current-config

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

// Layout values intentionally match the legacy reply_box implementation.
#let reply(
  label: [回复],
  fill: rgb("e1edf0"),
  accent: rgb("4b6989"),
  decoration: image("mmt_options.webp"),
  ..items,
) = pad(left: 4em, box(
  fill: fill,
  radius: 0.5em,
  inset: (x: 6pt, y: 8pt),
  width: 100%,
  height: auto,
  clip: true,
)[
  #if decoration != none {
    place(top + right, dx: 6pt, dy: -8pt, decoration)
  }
  #place(line(
    start: (2pt, -0.2em),
    end: (2pt, 1em),
    stroke: blue + 0.15em,
  ))
  #v(1pt)
  #h(5pt)#label
  #v(-0.4em)
  #line(length: 100%, stroke: gray + 0.05em)
  #v(-0.7em)
  #set text(fill: accent)
  #set align(center)
  #stack(
    ..items.pos().map(item => pad(x: -4pt, y: -4pt,
      shadowed(
        radius: 4pt,
        dy: 3pt,
        color: rgb(89, 85, 101, 50%),
        block(width: 100%, fill: white, inset: 8pt, radius: 4pt, [#item]),
      ),
    )),
  )
])

// Layout values intentionally match the legacy bond_box implementation.
#let bond(
  label: [羁绊事件],
  fill: rgb("fc879b"),
  text-fill: white,
  decoration: image("mmt_favor.webp", width: 25%),
  body,
) = pad(left: 4em, box(
  fill: rgb("fceef0"),
  radius: 0.5em,
  inset: (x: 6pt, y: 8pt),
  width: 100%,
  height: auto,
  clip: true,
)[
  #if decoration != none {
    place(top + right, dx: 6pt, dy: -8pt, decoration)
  }
  #place(line(
    start: (2pt, -0.2em),
    end: (2pt, 1em),
    stroke: rgb("ff8e9b") + 0.15em,
  ))
  #v(1pt)
  #h(5pt)#label
  #v(-0.4em)
  #line(length: 100%, stroke: gray + 0.05em)
  #v(-0.7em)
  #set text(fill: text-fill)
  #set align(center)
  #pad(x: -4pt, y: -4pt,
    shadowed(
      radius: 4pt,
      dy: 3pt,
      color: rgb(89, 85, 101, 50%),
      block(width: 100%, fill: fill, inset: 8pt, radius: 4pt, [#body]),
    ),
  )
])
