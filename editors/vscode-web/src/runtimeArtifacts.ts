export const RUNTIME_ORIGIN = "https://mms-pack.esa.xiyihan.cn";
export const PACK_BASE_URL = `${RUNTIME_ORIGIN}/ba_kivo/`;
export const PACK_MANIFEST_URL = `${PACK_BASE_URL}manifest.json`;

export interface BundledRuntimeArtifact {
  readonly id: "tinymist-wasm" | "typst-compiler-wasm" | "main-font-regular" | "main-font-bold";
  readonly url: string;
  readonly encoding: "brotli";
  readonly expectedEncodedSha256: string;
  readonly expectedRawSha256: string;
  readonly encodedBytes: number;
  readonly rawBytes: number;
  readonly mediaType: "application/wasm" | "font/otf";
}

export interface BuildRuntimeArtifactSource {
  readonly artifact: BundledRuntimeArtifact;
  readonly sourceUrl: string;
}

export const TINYMIST_VERSION = "0.15.4-rc3";
export const TINYMIST_WASM_SHA256 = "ea5f5d289c143b321543c1bc04bf2d20c8c6e212eab8e397a4ff763088a7e1e8";
export const TYPST_COMPILER_VERSION = "0.8.0-rc3";
export const TYPST_COMPILER_WASM_SHA256 = "fff6c8d9852edbfb0374722c139a95a2307de19a666206936232e5f21035836c";
export const MAIN_FONT_VERSION = "2026-07-14";
export const MAIN_FONT_REGULAR_SHA256 = "e51cf7d6bcbb3bb3c97dc340b0c80049ffa7d1126790f1a36e59c38540e1a08e";
export const MAIN_FONT_BOLD_SHA256 = "b3ef59863309df4115580b589550fec384c89c9cf6bf52415f65a61e34c79681";

const bundledArtifact = (
  value: BundledRuntimeArtifact,
): Readonly<BundledRuntimeArtifact> => Object.freeze(value);

export const TINYMIST_WASM_ARTIFACT = bundledArtifact({
  id: "tinymist-wasm",
  url: "/runtime/2b2289605befc3b06f891a092fd4bced622ecd729b7de90b2cfdb51a8601ce5a/tinymist_bg.wasm.brotli.bin",
  encoding: "brotli",
  expectedEncodedSha256: "2b2289605befc3b06f891a092fd4bced622ecd729b7de90b2cfdb51a8601ce5a",
  expectedRawSha256: TINYMIST_WASM_SHA256,
  encodedBytes: 8_781_775,
  rawBytes: 32_911_559,
  mediaType: "application/wasm",
});

export const TYPST_COMPILER_WASM_ARTIFACT = bundledArtifact({
  id: "typst-compiler-wasm",
  url: "/runtime/f2250904c04c9f468255066b05ab0e647d79840691fd99b9bbf7561e4df34431/typst_ts_web_compiler_bg.wasm.brotli.bin",
  encoding: "brotli",
  expectedEncodedSha256: "f2250904c04c9f468255066b05ab0e647d79840691fd99b9bbf7561e4df34431",
  expectedRawSha256: TYPST_COMPILER_WASM_SHA256,
  encodedBytes: 7_640_225,
  rawBytes: 30_326_020,
  mediaType: "application/wasm",
});

export const MAIN_FONT_REGULAR_ARTIFACT = bundledArtifact({
  id: "main-font-regular",
  url: "/runtime/e5714baab54de30a9e1e8f96f6b587b9bb427821d892f6d840658d3309eb521b/MainFont.otf.brotli.bin",
  encoding: "brotli",
  expectedEncodedSha256: "e5714baab54de30a9e1e8f96f6b587b9bb427821d892f6d840658d3309eb521b",
  expectedRawSha256: MAIN_FONT_REGULAR_SHA256,
  encodedBytes: 6_005_574,
  rawBytes: 10_418_260,
  mediaType: "font/otf",
});

export const MAIN_FONT_BOLD_ARTIFACT = bundledArtifact({
  id: "main-font-bold",
  url: "/runtime/a0853240426a1b9d2f2acdb2a797e60b60d2c7cdd52ee13d70ab69a812292934/MainFont_Bold.otf.brotli.bin",
  encoding: "brotli",
  expectedEncodedSha256: "a0853240426a1b9d2f2acdb2a797e60b60d2c7cdd52ee13d70ab69a812292934",
  expectedRawSha256: MAIN_FONT_BOLD_SHA256,
  encodedBytes: 6_170_795,
  rawBytes: 10_275_552,
  mediaType: "font/otf",
});

export const BUNDLED_RUNTIME_ARTIFACTS = Object.freeze([
  TINYMIST_WASM_ARTIFACT,
  TYPST_COMPILER_WASM_ARTIFACT,
  MAIN_FONT_REGULAR_ARTIFACT,
  MAIN_FONT_BOLD_ARTIFACT,
]);

export const BUILD_RUNTIME_ARTIFACT_SOURCES: readonly BuildRuntimeArtifactSource[] = Object.freeze([
  Object.freeze({
    artifact: TINYMIST_WASM_ARTIFACT,
    sourceUrl: `${RUNTIME_ORIGIN}/wasm/tinymist/${TINYMIST_VERSION}/${TINYMIST_WASM_SHA256}/tinymist_bg.wasm.br?delivery=br-v1`,
  }),
  Object.freeze({
    artifact: TYPST_COMPILER_WASM_ARTIFACT,
    sourceUrl: `${RUNTIME_ORIGIN}/wasm/typst-ts-web-compiler/${TYPST_COMPILER_VERSION}/${TYPST_COMPILER_WASM_SHA256}/typst_ts_web_compiler_bg.wasm.br?delivery=br-v1`,
  }),
  Object.freeze({
    artifact: MAIN_FONT_REGULAR_ARTIFACT,
    sourceUrl: `${RUNTIME_ORIGIN}/fonts/mainfont/${MAIN_FONT_VERSION}/${MAIN_FONT_REGULAR_SHA256}/MainFont.otf.br?delivery=br-v1`,
  }),
  Object.freeze({
    artifact: MAIN_FONT_BOLD_ARTIFACT,
    sourceUrl: `${RUNTIME_ORIGIN}/fonts/mainfont/${MAIN_FONT_VERSION}/${MAIN_FONT_BOLD_SHA256}/MainFont_Bold.otf.br?delivery=br-v1`,
  }),
]);

export const TINYMIST_WASM_URL = TINYMIST_WASM_ARTIFACT.url;
export const TYPST_COMPILER_WASM_URL = TYPST_COMPILER_WASM_ARTIFACT.url;
export const MAIN_FONT_REGULAR_URL = MAIN_FONT_REGULAR_ARTIFACT.url;
export const MAIN_FONT_BOLD_URL = MAIN_FONT_BOLD_ARTIFACT.url;
