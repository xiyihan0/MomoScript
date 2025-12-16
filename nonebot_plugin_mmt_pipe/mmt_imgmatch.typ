// Renders a top-n match table of expression images for a single student.
// Inputs:
// - sys.inputs["data"]: path to a json file:
//   { "character": str, "student_id": int, "query": str, "items": [{ img_path, image_name, tags, description, score }] }

#let data_path = sys.inputs.at("data", default: "")
#if data_path == "" {
  panic("missing input: data")
}

#let raw = read(data_path, encoding: none)
#let data = json(raw)

#let character = data.character
#let sid = data.student_id
#let query = data.query
#let items = data.items

#set page(width: 210mm, height: auto, margin: (x: 10mm, y: 10mm))
#set text(font: "Source Han Sans SC", size: 10pt)

#heading(level: 1)[#character (#sid)]
#text(size: 9pt, fill: luma(70%))[query: #query]

#table(
  columns: (20mm, auto, auto, 18mm),
  inset: 2pt,
  stroke: 0.5pt,
  align: left,
  table.header([img], [img_name], [tags/description], [score]),
  ..items.map(it => {(
    image(it.img_path, width: 18mm, height: 18mm, fit: "contain"),
    [#it.image_name],
    [#(it.tags.join(", "))\n#it.description],
    [#str(it.score)],
  )}).flatten(),
)

