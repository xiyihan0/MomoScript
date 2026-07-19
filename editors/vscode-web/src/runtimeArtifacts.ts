export const TINYMIST_VERSION = "0.15.2";
export const TINYMIST_WASM_SHA256 = "d9b946a8aa1425eeda71e6fcb603fb85ce30cd79b2a676a5d557971f202af454";
export const TYPST_COMPILER_VERSION = "0.8.0-rc3";
export const TYPST_COMPILER_WASM_SHA256 = "85a071522388ca99f0cf7f749a287b5578b4c3256ac16014d2894e73e862979a";
export const TYPST_RENDERER_VERSION = "0.8.0-rc3";
export const TYPST_RENDERER_WASM_SHA256 = "b6947e0293db377ada7b8e74f8ac756552a248c8d86c85927df1eff58ecd3f62";
export const TINYMIST_WASM_URL = `https://mms-pack.xiyihan.cn/wasm/tinymist/${TINYMIST_VERSION}/${TINYMIST_WASM_SHA256}/tinymist_bg.wasm?delivery=zstd-v1`;
export const TYPST_COMPILER_WASM_URL = `https://mms-pack.xiyihan.cn/wasm/typst-ts-web-compiler/${TYPST_COMPILER_VERSION}/${TYPST_COMPILER_WASM_SHA256}/typst_ts_web_compiler_bg.wasm?delivery=zstd-v1`;

export const PINNED_RUNTIME_WASM_URLS = Object.freeze([
  TINYMIST_WASM_URL,
  TINYMIST_WASM_URL.replace("?delivery=zstd-v1", ""),
  TYPST_COMPILER_WASM_URL,
  TYPST_COMPILER_WASM_URL.replace("?delivery=zstd-v1", ""),
]);
