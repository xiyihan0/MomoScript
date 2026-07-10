#import "../lib.typ" as mmt

#show: mmt.template.with(
  title: "无题",
  author: "xiyihan",
  compiled-at: "2026-07-10 23:06:38",
)

#mmt.chat-left(
  avatar: mmt.avatar(circle(fill: rgb("91d7d9"))),
  name: [柚子],
)[1]

#mmt.chat-left(
  avatar: mmt.avatar(circle(fill: rgb("91d7d9"))),
  name: [柚子],
  auto-continued: true,
)[2]

#mmt.configure(chat: (continued: false))
#mmt.chat-right(auto-continued: true)[3]

#mmt.configure(chat: (continued: auto))
#mmt.chat-left(
  avatar: mmt.avatar(circle(fill: rgb("91d7d9"))),
  name: [柚子],
)[4]

#mmt.reply[a][b]
#mmt.bond[进入柚子的羁绊剧情]

#let sticker-probe = mmt.sticker(rect(width: 2em, height: 2em, fill: rgb("ef8cab")))
