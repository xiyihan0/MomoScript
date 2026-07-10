#import "themes/moetalk.typ": moetalk

#let default-config = (
  theme: moetalk(),
  chat: (continued: auto),
)

#let config-state = state("mmt-render-v2-config", default-config)

#let configure(theme: none, chat: none) = config-state.update(current => {
  let next = current
  if theme != none {
    next = next + (theme: theme)
  }
  if chat != none {
    next = next + (chat: current.chat + chat)
  }
  next
})

#let current-config() = config-state.get()
