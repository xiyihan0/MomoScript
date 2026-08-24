#let semantic-region(composer-key, role, body) = if composer-key == none {
  body
} else {
  [#body #label("mmt:" + role + ":" + composer-key)]
}
