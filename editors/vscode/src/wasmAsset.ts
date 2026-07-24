export async function loadWasmAssetBytes(assetUrl: string): Promise<ArrayBuffer> {
  if (!assetUrl.startsWith("data:")) {
    const response = await fetch(assetUrl);
    if (!response.ok) throw new Error(`WASM fetch failed: HTTP ${response.status}`);
    return response.arrayBuffer();
  }

  const separator = assetUrl.indexOf(",");
  if (separator < 0 || !assetUrl.slice(5, separator).split(";").includes("base64")) {
    throw new Error("WASM data URL must use base64 encoding");
  }
  const binary = atob(assetUrl.slice(separator + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}
