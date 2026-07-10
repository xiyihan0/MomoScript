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
  let tip-shape = if tip {
    let x = if side == left { -1.5pt } else { 1.5pt }
    place(
      side,
      dx: x,
      dy: 3pt,
      scale(y: 50%, rotate(45deg, rect(
        width: 6pt,
        height: 6pt,
        radius: 0.5pt,
        fill: fill,
      ))),
    )
  }
  box(inset: 0pt, outset: 0pt)[
    #tip-shape
    #block(fill: fill, inset: inset, radius: radius)[
      #set text(fill: text-fill)
      #body
    ]
  ]
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
  let bubble-text-fill = if text-fill == auto { theme.bubble-text-fill } else { text-fill }
  let bubble-inset = if inset == auto { theme.bubble-inset } else { inset }
  let bubble-radius = if radius == auto { theme.bubble-radius } else { radius }
  let bubble-tip = if tip == auto { not effective-continued } else { tip }
  let visible-avatar = if effective-continued { none } else { avatar }
  let visible-name = if effective-continued { none } else { name }
  let edge-pad = theme.avatar-size + theme.avatar-gap
  let gap = if effective-continued { theme.continued-gap } else { theme.message-gap }

  block(width: 100%, above: gap, below: 0pt)[
    #if visible-avatar != none {
      place(side, visible-avatar)
    }
    #if side == left {
      pad(left: edge-pad)[
        #if visible-name != none { strong(visible-name) + v(0.35em) }
        #bubble(
          side: left,
          fill: bubble-fill,
          text-fill: bubble-text-fill,
          inset: bubble-inset,
          radius: bubble-radius,
          tip: bubble-tip,
          body,
        )
      ]
    } else {
      pad(left: edge-pad, right: edge-pad)[
        #align(right)[
          #box[
            #if visible-name != none { align(right, strong(visible-name)) + v(0.35em) }
            #bubble(
              side: right,
              fill: bubble-fill,
              text-fill: bubble-text-fill,
              inset: bubble-inset,
              radius: bubble-radius,
              tip: bubble-tip,
              body,
            )
          ]
        ]
      ]
    }
  ]
}

#let chat-left(
  avatar: none,
  name: none,
  auto-continued: false,
  continued: auto,
  fill: auto,
  text-fill: auto,
  inset: auto,
  radius: auto,
  tip: auto,
  body,
) = chat(
  side: left,
  avatar: avatar,
  name: name,
  auto-continued: auto-continued,
  continued: continued,
  fill: fill,
  text-fill: text-fill,
  inset: inset,
  radius: radius,
  tip: tip,
  body,
)

#let chat-right(
  avatar: none,
  name: none,
  auto-continued: false,
  continued: auto,
  fill: auto,
  text-fill: auto,
  inset: auto,
  radius: auto,
  tip: auto,
  body,
) = chat(
  side: right,
  avatar: avatar,
  name: name,
  auto-continued: auto-continued,
  continued: continued,
  fill: fill,
  text-fill: text-fill,
  inset: inset,
  radius: radius,
  tip: tip,
  body,
)
