/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MMT_BUILD_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "tiny-brotli-dec-wasm" {
  export default class BrotliDecompressStream {
    static init(readFile?: typeof fetch): Promise<void>;
    static create(): BrotliDecompressStream | Promise<BrotliDecompressStream>;
    dec(input: Uint8Array, outputSize: number): Uint8Array;
    result(): number;
    lastInputOffset(): number;
    free(): void;
  }

  export const Result: Readonly<{
    Error: number;
    Success: number;
    NeedsMoreInput: number;
    NeedsMoreOutput: number;
  }>;
}
