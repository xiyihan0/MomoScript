/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MMT_BUILD_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
