#let avatar(content, size: 3em) = {
  set image(width: size, height: size, fit: "cover")
  box(width: size, height: size, radius: 50%, clip: true, content)
}

#let sticker(content, width: 2em, height: auto, fit: "contain") = box(
  width: width,
  height: height,
)[
  #set image(width: 100%, height: 100%, fit: fit)
  #content
]
