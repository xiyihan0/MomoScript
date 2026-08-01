let monospaceAdvanceAt128Px: number | undefined;

export function normalizeTextSelectionNode(node: SVGForeignObjectElement): void {
  const source = node.children[0];
  if (!(source instanceof HTMLElement) || !source.classList.contains("tsel")) return;
  const normalized = node.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "div");
  normalized.setAttribute("class", "tsel");
  const style = source.getAttribute("style");
  if (style !== null) normalized.setAttribute("style", style);
  const text = source.textContent ?? "";
  const tokens = layoutTextSelectionTokens(node, text);
  if (tokens) normalized.append(...tokens);
  else normalized.textContent = text;
  node.replaceChildren(normalized);
}

export function normalizeTextSelectionLayers(root: ParentNode): void {
  for (const node of root.querySelectorAll("foreignObject")) {
    if (!(node instanceof SVGForeignObjectElement)) continue;
    const source = node.children[0];
    if (!(source instanceof HTMLElement)
      || !source.classList.contains("tsel")
      || source.querySelector(":scope > .tsel-token")) continue;
    normalizeTextSelectionNode(node);
  }
}

function layoutTextSelectionTokens(
  node: SVGForeignObjectElement,
  text: string,
): readonly HTMLSpanElement[] | undefined {
  const textGroup = node.closest(".typst-text");
  if (!textGroup) return undefined;
  const glyphs = [...textGroup.children].filter((child) => child.localName === "use");
  const advances = glyphs.map((glyph) => Number.parseFloat(glyph.getAttribute("x") ?? "") / 16);
  const lengths = glyphs.map((glyph) => {
    const href = glyph.getAttribute("href") ?? glyph.getAttribute("xlink:href") ?? "";
    const definition = href.startsWith("#") ? node.ownerDocument.getElementById(href.slice(1)) : null;
    return 1 + (Number.parseInt(definition?.getAttribute("data-liga-len") ?? "0", 10) || 0);
  });
  const fontSize = Number.parseFloat((node.children[0] as HTMLElement).style.fontSize);
  const finalAdvance = Number.parseFloat(node.getAttribute("width") ?? "");
  if (
    text.length === 0
    || glyphs.length === 0
    || advances.some((advance) => !Number.isFinite(advance))
    || !Number.isFinite(fontSize)
    || !Number.isFinite(finalAdvance)
  ) return undefined;

  if (monospaceAdvanceAt128Px === undefined) {
    const context = node.ownerDocument.createElement("canvas").getContext("2d");
    if (!context) return undefined;
    context.font = "128px monospace";
    monospaceAdvanceAt128Px = context.measureText("A").width;
  }
  const characterAdvance = monospaceAdvanceAt128Px * fontSize / 128;
  const tokens: HTMLSpanElement[] = [];
  let glyphIndex = 0;
  let ligatureIndex = 0;
  let previousAdvance = 0;
  let previousToken: HTMLSpanElement | undefined;

  for (const character of text) {
    if (glyphIndex >= advances.length) return undefined;
    let advance = advances[glyphIndex]!;
    if (lengths[glyphIndex]! > 1) advance += ligatureIndex * characterAdvance;
    const token = node.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "span");
    token.setAttribute("class", "tsel-token");
    token.textContent = character;
    if (previousToken) {
      previousToken.style.letterSpacing = `${advance - previousAdvance - characterAdvance}px`;
    }
    tokens.push(token);
    previousToken = token;
    previousAdvance = advance;
    ligatureIndex += 1;
    if (ligatureIndex >= lengths[glyphIndex]!) {
      glyphIndex += 1;
      ligatureIndex = 0;
    }
  }
  if (glyphIndex !== advances.length || ligatureIndex !== 0 || !previousToken) return undefined;
  previousToken.style.letterSpacing = `${finalAdvance - previousAdvance - characterAdvance}px`;
  return tokens;
}
