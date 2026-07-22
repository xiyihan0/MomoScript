const RUNTIME_ORIGIN = "https://mms-pack.xiyihan.cn";

export const TINYMIST_VERSION = "0.15.2";
export const TINYMIST_WASM_SHA256 = "d9b946a8aa1425eeda71e6fcb603fb85ce30cd79b2a676a5d557971f202af454";
export const TYPST_COMPILER_VERSION = "0.8.0-rc3";
export const TYPST_COMPILER_WASM_SHA256 = "fff6c8d9852edbfb0374722c139a95a2307de19a666206936232e5f21035836c";
export const MAIN_FONT_VERSION = "2026-07-14";
export const MAIN_FONT_REGULAR_SHA256 = "e51cf7d6bcbb3bb3c97dc340b0c80049ffa7d1126790f1a36e59c38540e1a08e";
export const MAIN_FONT_BOLD_SHA256 = "b3ef59863309df4115580b589550fec384c89c9cf6bf52415f65a61e34c79681";
export const NOTO_SANS_CJK_VERSION = "2.004";
export const NOTO_SANS_CJK_REGULAR_SHA256 = "b76b0433203017ca80401b2ee0dd69350349871c4b19d504c34dbdd80541690a";
export const NOTO_SANS_CJK_BOLD_SHA256 = "faa5f3656a78b2e2d450d27fe8382c778bc2b6bb5ea29c986664a6a435056ceb";

export const TINYMIST_WASM_URL = `${RUNTIME_ORIGIN}/wasm/tinymist/${TINYMIST_VERSION}/${TINYMIST_WASM_SHA256}/tinymist_bg.wasm.br?delivery=br-v1`;
export const TYPST_COMPILER_WASM_URL = `${RUNTIME_ORIGIN}/wasm/typst-ts-web-compiler/${TYPST_COMPILER_VERSION}/${TYPST_COMPILER_WASM_SHA256}/typst_ts_web_compiler_bg.wasm.br?delivery=br-v1`;
export const MAIN_FONT_REGULAR_URL = `${RUNTIME_ORIGIN}/fonts/mainfont/${MAIN_FONT_VERSION}/${MAIN_FONT_REGULAR_SHA256}/MainFont.otf.br?delivery=br-v1`;
export const MAIN_FONT_BOLD_URL = `${RUNTIME_ORIGIN}/fonts/mainfont/${MAIN_FONT_VERSION}/${MAIN_FONT_BOLD_SHA256}/MainFont_Bold.otf.br?delivery=br-v1`;
export const NOTO_SANS_CJK_REGULAR_URL = `${RUNTIME_ORIGIN}/fonts/noto-sans-cjk/${NOTO_SANS_CJK_VERSION}/${NOTO_SANS_CJK_REGULAR_SHA256}/NotoSansCJK-Regular.ttc.br?delivery=br-v1`;
export const NOTO_SANS_CJK_BOLD_URL = `${RUNTIME_ORIGIN}/fonts/noto-sans-cjk/${NOTO_SANS_CJK_VERSION}/${NOTO_SANS_CJK_BOLD_SHA256}/NotoSansCJK-Bold.ttc.br?delivery=br-v1`;

export const runtimeIdentityUrl = (url: string): string => url
  .replace(/\.br\?delivery=br-v1$/, "")
  .replace(/\?delivery=zstd-v1$/, "");

const identityUrl = runtimeIdentityUrl;

export const PINNED_RUNTIME_ARTIFACT_URLS = Object.freeze([
  TINYMIST_WASM_URL,
  identityUrl(TINYMIST_WASM_URL),
  TYPST_COMPILER_WASM_URL,
  identityUrl(TYPST_COMPILER_WASM_URL),
  MAIN_FONT_REGULAR_URL,
  identityUrl(MAIN_FONT_REGULAR_URL),
  MAIN_FONT_BOLD_URL,
  identityUrl(MAIN_FONT_BOLD_URL),
  NOTO_SANS_CJK_REGULAR_URL,
  identityUrl(NOTO_SANS_CJK_REGULAR_URL),
  NOTO_SANS_CJK_BOLD_URL,
  identityUrl(NOTO_SANS_CJK_BOLD_URL),
]);

export const PRELOADED_RUNTIME_ARTIFACT_URLS = Object.freeze([
  TINYMIST_WASM_URL,
  TYPST_COMPILER_WASM_URL,
  MAIN_FONT_REGULAR_URL,
  MAIN_FONT_BOLD_URL,
]);
