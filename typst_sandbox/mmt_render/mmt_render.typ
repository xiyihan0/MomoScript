// Minimal renderer for `mmt_text_to_json.py` output.
//
// Usage:
//   typst compile mmt_render.typ out.pdf --root . --input chat=path/to/chat.json

#import "@preview/based:0.2.0": base64

#let data = json(sys.inputs.at("chat",default: "mmt_format_test.json"))
#let typst_global = data.at("typst_global", default: "")
#let typst_assets_global = data.at("typst_assets_global", default: "")
#let meta = data.at("meta", default: (:))
#let doc_title = meta.at("title", default: "无题")
#let doc_author = meta.at("author", default: "")
#let compiled_at = sys.inputs.at("compiled_at", default: "")
#let disable_heading = sys.inputs.at("disable_heading", default: "0") == "1"

#set text(font: "FZLanTingYuanGBK", size: 10pt)
#let _parse_code_or(raw, fallback) = {
  let s = if raw == none { "" } else { str(raw).trim() }
  if s == "" { fallback } else { eval(s, mode: "code") }
}
#let page_width = _parse_code_or(meta.at("width", default: ""), 300pt)
#set page(width: page_width, height: auto, margin: (x: 10pt, y: 20pt))
#set par(spacing: 1em)
#show raw: it => {
  set text(font: ("JetBrains Mono", "FZLanTingYuanGBK"), fill: black)
  if it.block{
      block(
      fill: luma(240),
      inset: 10pt,
      radius: 4pt,
      text(fill: black, it)
    )
  }
  else{
    box(fill: luma(245), inset: (x: 2pt), outset: (y: 3pt), radius: 2pt, it)
  }
}

#let typst_mode = sys.inputs.at("typst_mode", default: "0") == "1"

#let _image_scale_raw = sys.inputs.at("image_scale", default: "0.7")
#let image_scale = {
  let v = float(_image_scale_raw)
  if v < 0.1 { 0.1 } else if v > 1.0 { 1.0 } else { v }
}


#let fake-italic(body, ax:-15deg) = {
  // 匹配所有非空字符
  show regex("."): it => {
    // 对每个字符单独应用倾斜
    // ax: -15deg 表示向右倾斜 15 度
    box(skew(ax: ax, reflow: false, it))
  }
  // 输出处理后的内容
  body
}
#let fake-bold(body) = text(stroke: 0.028em, body)


#let header_bar(project: "MomoScript", title: "无题", author: "", compiled_at: "") = {
  set text(fill: white)
  pad(x:-10pt,top:-20pt,block(width: 100%, fill: rgb("86aedd"), inset: (x: 10pt, y: 8pt))[
    #grid(
      columns: (auto, 1fr),
      column-gutter: 12pt,
      align: (left+horizon, right+horizon),
      [
        #show emph: fake-italic.with(ax: -10deg)
        #set text(size: 20pt, weight: "bold")
        #project
      ],
      [
        #set text(size: 9pt,stroke: 0.02em+white)
        #align(right)[
          标题：#title
          #if author != "" { [\ 作者：#author] }
          #if compiled_at != "" { [\ 创建于：#compiled_at] }
        ]
      ],
    )
  ])
}

#let bubble_inset = _parse_code_or(meta.at("bubble_inset", default: ""), 7pt)
#let bubble(text_color: black, fill_color: luma(230), side: left, tip: true, inset: bubble_inset, content) = {
  set text(fill: text_color)
  let tip_element = if tip {
    if side == left {
      place(
        left,
        dy: 3pt,
        dx: -1.5pt,
        scale(y: 50%, rotate(45deg, rect(fill: fill_color, width: 6pt, height: 6pt, radius: 0.5pt))),
      )
    } else if side == right {
      place(
        right,
        dy: 3pt,
        dx: 1.5pt,
        scale(y: 50%, rotate(45deg, rect(fill: fill_color, width: 6pt, height: 6pt, radius: 0.5pt))),
      )
    }
  }
  box(inset: 0pt, outset: 0pt, tip_element + block(fill: fill_color, inset: inset, radius: 5pt, content))
}

#let bubble_left = bubble.with(side: left)
#let bubble_right = bubble.with(side: right)
#let image_bubble = bubble.with(fill_color: luma(240), text_color: black, tip: false, inset: 3pt)

#let parse_base64_img(content) = {
  image(base64.decode(content.match(regex("data:image/[^;]+;base64,(.*)")).captures.at(0)))
}

#let parse_custom_img(ref) = {
  if ref == "uploaded" {
    none
  } else if ref.starts-with("data:") {
    parse_base64_img(ref)
  } else {
    image(ref)
  }
}

#let inline_expr_image(ref) = {
  set image(width: image_scale * 100%, fit: "contain")
  parse_custom_img(ref)
}

#let render_segments(line, global_code: "") = {
  // 将强样式（*text*）重定义为伪粗体
  show strong: fake-bold
  let segments = line.at("segments", default: none)
  if segments == none {
    let s = line.content
    if typst_mode { eval(typst_assets_global + "\n" + global_code + "\n" + s, mode: "markup") } else { s }
  } else {
    // inline sequence: text + image refs
    for seg in segments {
      let t = seg.at("type", default: "text")
      if t == "text" {
        let s = seg.at("text", default: "")
        if typst_mode { eval(typst_assets_global + "\n" + global_code + "\n" + s, mode: "markup") } else { s }
      } else if t == "image" {
        inline_expr_image(seg.at("ref", default: "uploaded"))
      } else {
        seg.at("text", default: "")
      }
    }
  }
}

#let is_image_only(line) = {
  let segs = line.at("segments", default: none)
  if segs == none { false } else {
    let images = segs.filter(s => s.at("type", default: "text") == "image")
    let nonws_text = segs.filter(s =>
      s.at("type", default: "text") == "text" and s.at("text", default: "").trim() != ""
    )
    let others = segs.filter(s => {
      let t = s.at("type", default: "text")
      t != "text" and t != "image"
    })
    images.len() == 1 and nonws_text.len() == 0 and others.len() == 0
  }
}

#let circle_avatar(img, size: 3em) = {
  set image(width: size, height: size, fit: "cover")
  box(width: size, height: size, radius: 50%, clip: true, img)
}

#let single_chat(side: left, bubble_tip: true, align_with_avatar: true, avatar: none, username: "", image_only: false, content) = {
  let bubble_color = if side == left { rgb("4c5b6f") } else { rgb("4a8aca") }
  let text_color = white
  box(width: 100%, inset: 0pt, outset: 0pt, fill: none)[
    #if avatar != none { place(side, dy: 0pt, avatar) }
    #if side == left {
      pad(left: if avatar != none or align_with_avatar { 4em } else { 0em })[
        #if username != none { [#v(0.25em)#strong(username)] }
        #v(0.5em, weak: true)
        #if image_only { image_bubble(content) } else { bubble_left(fill_color: bubble_color, text_color: text_color, tip: bubble_tip, content) }
      ]
    }
    #if side == right {
      pad(right: if avatar != none or align_with_avatar { 4em } else { 0em }, left: 4em)[
        #align(right)[
          #box(
            align(left)[
              #if username != none { [#v(0.25em)#align(right, strong(username))] }
              #v(0.5em, weak: true)
              #if image_only { image_bubble(content) } else { bubble_right(fill_color: bubble_color, text_color: text_color, tip: bubble_tip, content) }
            ]
          )
        ]
      ]
    }
  ]
}

#let narration(line, global_code: "") = {
  // 将强样式（*text*）重定义为伪粗体
  show strong: fake-bold
  // 将强调样式（_text_）应用此逻辑
  show emph: fake-italic
  set align(center)
  set text(fill: black)
  let segs = line.at("segments", default: none)
  let image_only = is_image_only(line)
  let content = if segs == none {
    line.content
  } else {
    render_segments(line, global_code: global_code)
  }
  if image_only {
    image_bubble(content)
  } else {
    block(
      width: 100%,
      fill: rgb(220, 229, 232),
      inset: 5pt,
      radius: 4pt,
      if segs == none {
        if typst_mode { eval(typst_assets_global + "\n" + global_code + "\n" + content, mode: "markup") } else { content }
      } else {
        content
      },
    )
  }
}



#if not disable_heading {
  header_bar(project: [Momo_#underline[Script]_], title: doc_title, author: doc_author, compiled_at: compiled_at)
  v(0.8em)
}

#let avatar_mapping = (:)
#let username_mapping = ("__Sensei": none)

#for (char_id, img, name) in data.custom_chars {
  let avatar = parse_custom_img(img)
  avatar_mapping.insert(char_id, if avatar == none { none } else { circle_avatar(avatar) })
  username_mapping.insert(char_id, name)
}

#let last_key = none
#for line in data.chat {
  let yuzutalk = line.yuzutalk
  let t = yuzutalk.type
  if t == "NARRATION" {
    narration(line, global_code: typst_global)
    last_key = none
    parbreak()
    } else if t == "PAGEBREAK" {
      last_key = none
      pagebreak()
    } else if t == "TEXT" {
      let char_id = line.at("char_id", default: "__Sensei")
      if char_id == none { char_id = "__Sensei" }
      let side = line.at("side", default: none)
      if side == none { side = if char_id == "__Sensei" { "right" } else { "left" } }
    let raw_override = line.yuzutalk.at("nameOverride", default: "")
    let name_override = if raw_override == none { "" } else { str(raw_override) }
    let raw_avatar_override = line.at("avatar_override", default: "")
    let avatar_override = if raw_avatar_override == none { "" } else { str(raw_avatar_override) }
    let key = side + ":" + char_id + ":" + name_override + ":" + avatar_override
    let show_avatar = key != last_key
    let avatar = if show_avatar and char_id != "__Sensei" {
      if avatar_override != "" {
        let img = parse_custom_img(avatar_override)
        if img == none { avatar_mapping.at(char_id) } else { circle_avatar(img) }
      } else {
        avatar_mapping.at(char_id)
      }
    }
    let image_only = is_image_only(line)
    if not show_avatar { v(-0.7em) }
    if side == "right" {
      if char_id == "__Sensei" {
        single_chat(side: right, align_with_avatar: false, avatar: none, username: none, bubble_tip: show_avatar, image_only: image_only, render_segments(line, global_code: typst_global))
      } else {
        let username = if name_override != "" { name_override } else { username_mapping.at(char_id) }
          single_chat(side: right, align_with_avatar: true, avatar: avatar, username: if avatar != none { username }, bubble_tip: show_avatar, image_only: image_only, render_segments(line, global_code: typst_global))
        }
      } else {
        if char_id == "__Sensei" {
          single_chat(side: right, align_with_avatar: false, avatar: none, username: none, bubble_tip: show_avatar, image_only: image_only, render_segments(line, global_code: typst_global))
        } else {
          let username = if name_override != "" { name_override } else { username_mapping.at(char_id) }
          single_chat(side: left, align_with_avatar: true, avatar: avatar, username: if avatar != none { username }, bubble_tip: show_avatar, image_only: image_only, render_segments(line, global_code: typst_global))
        }
      }
      last_key = key
      parbreak()
  }
}
