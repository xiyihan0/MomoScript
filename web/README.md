# MomoScript Web Editor

## Setup

- Install Node 22 (nvm recommended).
- From `web`:
  - `npm install`
  - `npm run dev`

## Typst Preview

- Uses `@myriaddreamin/typst.ts` with CDN-hosted WASM modules.
- Preview refreshes on input and when clicking `Render`.

## WASM Hook

- If `window.mmtCompiler` exposes `compileToJson`, it will be used to convert
  MMT into JSON before rendering.

## Rebuild WASM

From repo root:

- `cargo install wasm-pack` (once)
- `wasm-pack build mmt_rs --target web --out-dir ../web/src/wasm/mmt_rs`
