export const TINYMIST_VERSION = "0.15.2";
export const TINYMIST_WASM_SHA256 = "d9b946a8aa1425eeda71e6fcb603fb85ce30cd79b2a676a5d557971f202af454";
export const TYPST_COMPILER_VERSION = "0.7.0-rc2";
export const TYPST_COMPILER_WASM_SHA256 = "acac51459fa84907843d7a1927ae7b6fc5c743d5de4f61473c866829c9c46e2d";
export const TINYMIST_WASM_URL = `https://mms-pack.xiyihan.cn/wasm/tinymist/${TINYMIST_VERSION}/${TINYMIST_WASM_SHA256}/tinymist_bg.wasm?delivery=zstd-v1`;
export const TYPST_COMPILER_WASM_URL = `https://mms-pack.xiyihan.cn/wasm/typst-ts-web-compiler/${TYPST_COMPILER_VERSION}/${TYPST_COMPILER_WASM_SHA256}/typst_ts_web_compiler_bg.wasm?delivery=zstd-v1`;

export const PINNED_RUNTIME_WASM_URLS = Object.freeze([
  TINYMIST_WASM_URL,
  TINYMIST_WASM_URL.replace("?delivery=zstd-v1", ""),
  TYPST_COMPILER_WASM_URL,
  TYPST_COMPILER_WASM_URL.replace("?delivery=zstd-v1", ""),
]);
