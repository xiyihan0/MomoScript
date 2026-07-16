#let template(show-header: true, title: "", author: none, compiled-at: none, body) = body

#let chat-left(name: none, avatar: none, reserve-avatar-space: true, auto-continued: false, continued: auto, body) = body
#let chat-right(name: none, avatar: none, reserve-avatar-space: true, auto-continued: false, continued: auto, body) = body
#let narration(body) = body
#let reply(..items) = stack(..items.pos())
#let bond(body) = body
#let avatar(body) = body
#let sticker(body, ..args) = body
