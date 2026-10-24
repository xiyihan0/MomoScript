export type RenderPreset =
  | { readonly kind: "output" }
  | { readonly kind: "chat"; readonly widthPt: number };

const OUTPUT_RENDER_PRESET: RenderPreset = Object.freeze({ kind: "output" });

export function isRenderPreset(value: unknown): value is RenderPreset {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const preset = value as Record<string, unknown>;
  const keys = Object.keys(preset);
  if (!Object.hasOwn(preset, "kind")) return false;
  if (preset.kind === "output") return keys.length === 1;
  return preset.kind === "chat"
    && keys.length === 2
    && Object.hasOwn(preset, "widthPt")
    && typeof preset.widthPt === "number"
    && Number.isInteger(preset.widthPt)
    && preset.widthPt >= 240
    && preset.widthPt <= 720;
}

export function parseRenderPreset(value: unknown): RenderPreset {
  if (!isRenderPreset(value)) {
    throw new Error("Invalid render preset: expected output or chat with an integer widthPt from 240 to 720 and no extra fields");
  }
  return value.kind === "output"
    ? OUTPUT_RENDER_PRESET
    : Object.freeze({ kind: "chat", widthPt: value.widthPt });
}
