#set text(font: ("Noto Sans CJK SC", "Noto Sans", "Arial Unicode MS"), size: 10pt)
#set page(width: 360pt, height: auto, margin: (x: 12pt, y: 16pt))
#let data = json.decode(sys.inputs.at("chat", default: ""))
#let meta = data.at("meta", default: (:))
#let title = meta.at("title", default: "预览")
#let author = meta.at("author", default: "")

#heading(level: 1)[#title]
#if author != "" { text(size: 9pt, fill: gray)[作者：#author] }
#v(8pt)

#let bubble(fill, content) = block(fill: fill, radius: 6pt, inset: (x: 8pt, y: 6pt))[#content]
#let render_segments(segs) = {
  for seg in segs {
    let t = seg.at("type", default: "text")
    if t == "text" { seg.at("text", default: "") }
    if t == "image" { "[image]" }
    if t == "expr" { seg.at("text", default: "") }
  }
}
#let render_line_content(line) = {
  let segs = line.at("segments", default: none)
  if segs == none { line.at("content", default: "") } else { render_segments(segs) }
}
#let render_text(line) = {
  let side = line.at("side", default: "left")
  let name_override = line.yuzutalk.at("nameOverride", default: "")
  let name = if name_override != "" { name_override } else { line.at("char_id", default: "Sensei") }
  let content = render_line_content(line)
  if side == "right" {
    align(right)[
      #text(size: 9pt, fill: gray)[#name]
      #bubble(rgb("E8F1FF"), content)
    ]
  } else {
    align(left)[
      #text(size: 9pt, fill: gray)[#name]
      #bubble(rgb("F3F4F6"), content)
    ]
  }
}

#let render_narration(line) = {
  let content = render_line_content(line)
  align(center)[#text(fill: gray)[#content]]
}

#for line in data.at("chat", default: ()) {
  let t = line.yuzutalk.at("type", default: "")
  if t == "TEXT" { render_text(line) }
  if t == "NARRATION" { render_narration(line) }
  if t == "REPLY" {
    let items = line.at("items", default: ())
    align(left)[#text(weight: "bold")[回复]]
    for it in items { bullet([#it.at("text", default: "")]) }
  }
  if t == "BOND" {
    align(left)[#text(fill: rgb("E11D48"))[羁绊事件：#line.at("content", default: "")]]
  }
  if t == "PAGEBREAK" { pagebreak() }
  v(6pt)
}
