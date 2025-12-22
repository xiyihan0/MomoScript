#import "@preview/based:0.2.0": base64
#set text(font:"FZLanTingYuanGBK",size: 10pt)
#set page(width:300pt,height: auto,margin: (x:10pt,y:20pt))

#set par(spacing: 1em)
#show raw.where(block: true): it => block(
  fill: luma(240),
  inset: 10pt,
  radius: 4pt,
  text(fill: black, it)
)
#let typst_mode = sys.inputs.at("typst_mode", default: "0") == "1"
#let _image_scale_raw = sys.inputs.at("image_scale", default: "0.7")
#let image_scale = {
  let v = float(_image_scale_raw)
  if v < 0.1 { 0.1 } else if v > 1.0 { 1.0 } else { v }
}

#let header_bar(project: "MomoScript", title: "无题", author: "", compiled_at: "") = {
  set text(fill: white)
  block(width: 100%, fill: rgb("86aedd"), inset: (x: 12pt, y: 8pt), radius: 6pt)[
    #grid(
      columns: (120pt, 1fr),
      column-gutter: 12pt,
      align: (left, right),
      [
        #set text(size: 16pt, weight: "bold")
        #project
      ],
      [
        #set text(size: 9pt)
        #align(right)[
          [标题：#title]
          #if author != "" { [作者：#author] }
          #if compiled_at != "" { [编译：#compiled_at] }
        ]
      ],
    )
  ]
}
#let idmap = none
#let mt_characters = none
#let char_imgs = none
#let bubble(text_color:black, fill_color: luma(230), side:left, tip:true, inset: 5pt, content)={
  set text(fill: text_color)
  let tip_element = if(tip){
    if(side==left){
      place(left, dy:3pt, dx:-1.5pt, scale(y:50%,rotate(45deg, rect(fill: fill_color, width: 6pt, height: 6pt, radius: 0.5pt))))
    }
    else if(side==right){
      place(right, dy:3pt, dx:1.5pt, scale(y:50%,rotate(45deg, rect(fill: fill_color, width: 6pt, height: 6pt, radius: 0.5pt))))
    }
  }
  box(inset: 0pt,  outset: 0pt,
    tip_element + block(fill: fill_color,inset: inset,radius: 5pt,content)
  )
}
#let bubble_left = bubble.with(side: left)
#let bubble_right = bubble.with(side: right)
#let image_bubble = bubble.with(fill_color: luma(240), tip:false, inset: 3pt)
#let circle_avater(img, size:3em)={
  set image(width: size, height: size, fit: "cover")
  box(width: size,height: size,radius: 50%,clip: true,img)
}

// #let avater = circle_avater(image("./Student_Portrait_CH0070_Collection.png"))
// #let avater = circle_avater(circle(fill: yellow))
// #let user_profile=(avater:avater, user_name:"Seia")

#let single_chat(image: false, side:left, bubble_tip:true, align_with_avater:true, avater:none, username:"", content)={
  let bubble_color = if(side==left){rgb("4c5b6f")}else{rgb("4a8aca")}
  let text_color = white
  box(width: 100%, inset: 0pt, outset: 0pt,fill: none)[
    #if(avater != none){
      place(side, dy: 0pt, avater)
    }
    #if(side==left){
      pad(left: if(avater != none or align_with_avater){4em} else{0em})[
        #if(username != none){[#v(0.25em)#strong(username)]}
        #v(0.5em,weak: true)
        #if(not image){bubble_left(fill_color:bubble_color, text_color: text_color, tip:bubble_tip, content)} else {
          image_bubble(content)
        }
      ]
    }
    #if(side==right){
      pad(right: if(avater != none or align_with_avater){4em} else{0em})[
        #align(right)[
          #box(
            // 让气泡内文本左对齐
            align(left)[
              #if(username != none){[#v(0.25em)#align(right,strong(username))]}
              #v(0.5em,weak: true)
              #if(not image){bubble_right(fill_color:bubble_color, text_color: text_color,tip:bubble_tip, content)} else {
                image_bubble(content)
              }
            ]
          )
        ]
      ]
    }
  ]
}

#let multiline_chat(side:left, user_profile:(avater:none, user_name:none),align_with_avater:false, contents)={
  let (avater, user_name) = user_profile
  if (side==left and avater!=none){align_with_avater=true}
  for (i,content) in contents.enumerate(){
    let tip = i==0
    let now_avater = if(i==0){avater}else{none}
    let now_name = if(i==0){user_name}else{none}
    
    single_chat(side:side,bubble_tip: tip, align_with_avater: align_with_avater, avater: now_avater, username: now_name, content)
    parbreak()
  }
}

#let narration(content, global_code: "")={
  set align(center)
  set text(fill: black)
  block(
    width: 100%,
    fill: rgb(220, 229, 232),
    inset: 5pt,
    radius: 4pt,
    if typst_mode { eval(global_code + "\n" + content, mode: "markup") } else { content },
  )
}
#let parse_base64_img(content)={
  image(base64.decode(content.match(regex("data:image/[^;]+;base64,(.*)")).captures.at(0)))
}

#let parse_custom_img(ref)={
  if (ref == "uploaded") {
    none
  } else if (ref.starts-with("data:")) {
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
  let segments = line.at("segments", default: none)
  if segments == none {
    let s = line.content
    if typst_mode { eval(global_code + "\n" + s, mode: "markup") } else { s }
  } else {
    for seg in segments {
      let t = seg.at("type", default: "text")
      if t == "text" {
        let s = seg.at("text", default: "")
        if typst_mode { eval(global_code + "\n" + s, mode: "markup") } else { s }
      } else if t == "image" {
        inline_expr_image(seg.at("ref", default: "uploaded"))
      } else if t == "expr" {
        // unresolved expression; show placeholder
        seg.at("text", default: "")
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


#let parse_moetalk_file(char_imgs:char_imgs, mt_characters: mt_characters,idmap:idmap, data, typst_global: "")={
  let last_key=none
  let avatar_mapping=(:)
  let username_mapping=("__Sensei":none)
  for (char_id, img) in data.chars{
    if (char_id==none) {continue}
    if (img=="uploaded"){
      avatar_mapping.insert(char_id, none)
    }
    else if (img in idmap.at(1)){
      let remapped_name=idmap.at(1).at(img)
      avatar_mapping.insert(char_id, circle_avater(image("CHAR/"+remapped_name+"_BG.webp")))
    }
    else{
      let find_avatar(name)={
        if (name+"_BG.webp" in char_imgs){
          circle_avater(image("CHAR/"+name+"_BG.webp"))
        }
        else if (name+".webp" in char_imgs){
          circle_avater(image("CHAR/"+name+".webp"))
        }
        else{
          panic("Couldn't find image for " + name)
        }
      }
      if (img.ends-with("_Collection")){avatar_mapping.insert(char_id, find_avatar(img.match(regex("(.*)_Collection")).captures.at(0)))}
      else{avatar_mapping.insert(char_id, find_avatar(img))}
    }
    if (char_id.starts-with("ba-")){
      let id1=char_id.match(regex("ba-(.*)")).captures.at(0)
      let id2=idmap.at(0).at(id1)
      let name = mt_characters.at(id2).name.zh_cn
      username_mapping.insert(char_id,name)
    }

  }
  for (char_id, img, name) in data.custom_chars{
    let avatar = parse_custom_img(img)
    avatar_mapping.insert(char_id, if(avatar == none){none}else{circle_avater(avatar)})
    username_mapping.insert(char_id, name)
  }
  for line in data.chat{
    let yuzutalk=line.yuzutalk
    let talk_type=yuzutalk.type
    let avatarState=yuzutalk.avatarState
    if (talk_type=="TEXT" or talk_type=="IMAGE"){
      let char_id=line.at("char_id",default:"__Sensei")
      if char_id==none{char_id="__Sensei"}
      let side=line.at("side", default: none)
      if side == none { side = if char_id == "__Sensei" { "right" } else { "left" } }
      let user_name=yuzutalk.at("nameOverride",default: "")
      if user_name==""{user_name=username_mapping.at(char_id)}
      // let user_name=username_mapping.at(char_id)
      if (user_name==""){user_name=none}
      let chat_content=if (talk_type=="TEXT"){line.content} else{
        set image(width: image_scale * 100%)
        parse_base64_img(line.content)
      }
      if (talk_type=="TEXT") {
        chat_content = render_segments(line, global_code: typst_global)
      }
      let user_name=yuzutalk.at("nameOverride",default: "")
      if user_name==""{user_name=username_mapping.at(char_id)}
      if user_name==""{user_name=none}
      let key = side + ":" + char_id + ":" + str(user_name)
      let show_avatar=avatarState=="SHOW" or (avatarState=="AUTO" and char_id!=none and last_key!=key)
      let avatar=if (show_avatar and char_id!="__Sensei"){
        avatar_mapping.at(char_id)
      }
      if (not show_avatar){
        v(-0.7em)
      }
      let image_only = is_image_only(line)
      if (side=="right"){
        if (char_id=="__Sensei"){
          single_chat(image: talk_type=="IMAGE" or image_only, side: right,align_with_avater: false,avater: none, username: none, bubble_tip: show_avatar, chat_content)
        } else {
          single_chat(image: talk_type=="IMAGE" or image_only, side: right, align_with_avater: true, avater: avatar, username:if(avatar!=none){user_name}, bubble_tip: show_avatar, chat_content)
        }
      } else {
        if (char_id=="__Sensei"){
          single_chat(image: talk_type=="IMAGE" or image_only, side: right,align_with_avater: false,avater: none, username: none, bubble_tip: show_avatar, chat_content)
        } else {
          single_chat(image: talk_type=="IMAGE" or image_only, side: left, align_with_avater: true, avater: avatar, username:if(avatar!=none){user_name}, bubble_tip: show_avatar, chat_content)
        }
      }
      last_key=key
    } else if(talk_type=="NARRATION"){
      let text=line.content
      narration(text, global_code: typst_global)
      last_key=none
    }
    parbreak()
  }
}


#let data = json(sys.inputs.at("chat", default: "mmt_format_test.json"))
#let typst_global = data.at("typst_global", default: "")
#let meta = data.at("meta", default: (:))
#let doc_title = meta.at("title", default: "无题")
#let doc_author = meta.at("author", default: "")
#let compiled_at = sys.inputs.at("compiled_at", default: "")
#let disable_heading = sys.inputs.at("disable_heading", default: "0") == "1"

#if not disable_heading {
  header_bar(project: "MomoScript", title: doc_title, author: doc_author, compiled_at: compiled_at)
  v(0.8em)
}

#parse_moetalk_file(data, typst_global: typst_global)
// #for i in range(1,25+1){
//   {
//     set text(fill:white)
//     set align(right+horizon)
//     align(top,box(fill: blue,width: 100%, height: 20pt, inset: 5pt, heading(level:2,str(i)+".json")))
//   }
//   parse_moetalk_file(json("Arius_Trial/"+str(i)+".json"))
//   pagebreak()
// }
