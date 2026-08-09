const normalizedTextSelectionNodes = new WeakSet<HTMLElement>();

export function normalizeTextSelectionNode(node: SVGForeignObjectElement): void {
  const source = node.children[0];
  if (!(source instanceof HTMLElement) || !source.classList.contains("tsel")) return;
  const normalized = node.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "div");
  normalized.setAttribute("class", "tsel");
  const style = source.getAttribute("style");
  if (style !== null) normalized.setAttribute("style", style);
  normalized.textContent = source.textContent ?? "";
  normalizedTextSelectionNodes.add(normalized);
  node.replaceChildren(normalized);
}

export function normalizeTextSelectionLayers(root: ParentNode): void {
  for (const node of root.querySelectorAll("foreignObject")) {
    if (!(node instanceof SVGForeignObjectElement)) continue;
    const source = node.children[0];
    if (!(source instanceof HTMLElement)
      || !source.classList.contains("tsel")
      || normalizedTextSelectionNodes.has(source)) continue;
    normalizeTextSelectionNode(node);
  }
}
