export const previewSemanticRoles = [
  "bubble",
  "avatar",
  "display-name",
  "narration",
  "reply",
  "reply-item",
  "bond",
  "bond-body",
] as const;

export type PreviewSemanticRole = (typeof previewSemanticRoles)[number];

export interface PreviewSemanticTarget {
  role: PreviewSemanticRole;
  token: string;
}

const PREVIEW_SEMANTIC_LABEL_PATTERN =
  /^mmt:(bubble|avatar|display-name|narration|reply|reply-item|bond|bond-body):(t[0-9a-f]{8})$/;

export function parsePreviewSemanticLabel(value: string): PreviewSemanticTarget | undefined {
  const match = PREVIEW_SEMANTIC_LABEL_PATTERN.exec(value);
  if (!match) return undefined;
  return {
    role: match[1] as PreviewSemanticRole,
    token: match[2],
  };
}

export function isReservedPreviewSemanticLabel(value: string): boolean {
  return value.startsWith("mmt:");
}
