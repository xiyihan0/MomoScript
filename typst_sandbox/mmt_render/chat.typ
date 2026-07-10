#import "config.typ": current-config

#let bubble(
  side: left,
  fill: luma(90%),
  text-fill: black,
  inset: 7pt,
  radius: 5pt,
  tip: true,
  body,
) = {
  set text(fill: text-fill)
  let tip-element = if tip {
    if side == left {
      place(
        left,
        dy: 3pt,
        dx: -1.5pt,
        scale(y: 50%, rotate(45deg, rect(
          fill: fill,
          width: 6pt,
          height: 6pt,
          radius: 0.5pt,
        ))),
      )
    } else {
      place(
        right,
        dy: 3pt,
        dx: 1.5pt,
        scale(y: 50%, rotate(45deg, rect(
          fill: fill,
          width: 6pt,
          height: 6pt,
          radius: 0.5pt,
        ))),
      )
    }
  }
  box(
    inset: 0pt,
    outset: 0pt,
    tip-element + block(fill: fill, inset: inset, radius: radius, body),
  )
}

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
) = context {
  let config = current-config()
  let theme = config.theme.chat
  let configured = config.chat.at("continued", default: auto)
  let effective-continued = if continued != auto {
    continued
  } else if configured != auto {
    configured
  } else {
    auto-continued
  }
  let bubble-fill = if fill != auto {
    fill
  } else if side == left {
    theme.bubble-left-fill
  } else {
    theme.bubble-right-fill
  }
  let bubble-text = if text-fill == auto { theme.bubble-text-fill } else { text-fill }
  let bubble-inset = if inset == auto { theme.bubble-inset } else { inset }
  let bubble-radius = if radius == auto { theme.bubble-radius } else { radius }
  let bubble-tip = if tip == auto { not effective-continued } else { tip }
  let visible-avatar = if effective-continued { none } else { avatar }
  let visible-name = if effective-continued { none } else { name }
  let reserve-avatar-space = if reserve-avatar-space == auto {
    avatar != none
  } else {
    reserve-avatar-space
  }
  let content-bubble = if image-only {
    bubble(
      side: side,
      fill: luma(94%),
      text-fill: black,
      tip: false,
      inset: 3pt,
      radius: bubble-radius,
      body,
    )
  } else {
    bubble(
      side: side,
      fill: bubble-fill,
      text-fill: bubble-text,
      tip: bubble-tip,
      inset: bubble-inset,
      radius: bubble-radius,
      body,
    )
  }

  if effective-continued { v(-0.7em) }
  box(width: 100%, inset: 0pt, outset: 0pt, fill: none)[
    #if visible-avatar != none { place(side, dy: 0pt, visible-avatar) }
    #if side == left {
      pad(left: if avatar != none or reserve-avatar-space { 4em } else { 0em })[
        #if visible-name != none { [#v(0.25em)#strong(visible-name)] }
        #v(0.5em, weak: true)
        #content-bubble
      ]
    } else {
      pad(
        right: if avatar != none or reserve-avatar-space { 4em } else { 0em },
        left: 4em,
      )[
        #align(right)[
          #box(align(left)[
            #if visible-name != none { [#v(0.25em)#align(right, strong(visible-name))] }
            #v(0.5em, weak: true)
            #content-bubble
          ])
        ]
      ]
    }
  ]
}

#let chat-left(..args) = chat(side: left, ..args)
#let chat-right(..args) = chat(side: right, ..args)
