#let template(show-header: true, title: "", author: none, compiled-at: none, body) = body

#let chat-left(composer-key: none, name: none, avatar: none, reserve-avatar-space: true, auto-continued: false, continued: auto, body) = body
#let chat-right(composer-key: none, name: none, avatar: none, reserve-avatar-space: true, auto-continued: false, continued: auto, body) = body
#let narration(body) = body
#let reply(composer-key: none, ..items) = stack(..items.pos())
#let bond(composer-key: none, body) = body
#let avatar(body) = body
#let sticker(body, ..args) = body
