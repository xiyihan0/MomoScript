// Renders a table of expression images for a single student.
// Inputs:
// - sys.inputs["data"]: path to a json file: { "character": str, "student_id": int, "items": [{...}] }
// - sys.inputs["title"]: optional title override

#let data_path = sys.inputs.at("data", default: "")
#if data_path == "" {
  panic("missing input: data")
}

#let raw = read(data_path,encoding: none)
#let data = json(raw)

#let title = sys.inputs.at("title", default: none)
#let character = if title != none { title } else { data.character }
#let sid = data.student_id
#let items = data.items

#set page(width: 280mm, height: auto, margin: (x: 10mm, y: 10mm))
#set text(font: "Source Han Sans SC", size: 10pt)

#let get_file_name(path) = {
  let parts = path.split("/")
  if parts.len() == 0 {
    return path
  }
  return parts.at(-1)
}
#heading(level: 1)[#character (#sid)]

#table(
  columns: (25mm, auto, auto),
  inset: 2pt,
  stroke: 0.5pt,
  align: left+horizon,
  table.header([img], [img_name], [tags/description]),
  ..items.map(it=>(
    image(it.img_path, width: 23mm, height: 23mm, fit: "contain"),
    [#get_file_name(it.img_path)],
    [#(it.tags.join(", "))\ #it.description],
  )).flatten(),
)
