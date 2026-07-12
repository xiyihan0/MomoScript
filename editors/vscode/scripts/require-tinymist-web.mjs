import { access } from "node:fs/promises";
import path from "node:path";

const packageRoot = process.env.TINYMIST_WEB_PKG;
if (!packageRoot) {
  throw new Error("TINYMIST_WEB_PKG must point to the fixed tinymist-web pkg directory");
}
await Promise.all(
  ["tinymist.js", "tinymist_bg.wasm"].map((name) =>
    access(path.join(path.resolve(packageRoot), name))
  )
);
