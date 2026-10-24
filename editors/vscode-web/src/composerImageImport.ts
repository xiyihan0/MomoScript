import * as vscode from "vscode";
import type { MmtIndexedDbFileSystemProvider } from "./filesystem";
import { WorkspaceAssetMirror } from "./workspaceAssetMirror.ts";

export interface ComposerLocalImageImport {
  readonly media: { readonly kind: "workspaceImage"; readonly relativePath: string };
  finish(accepted: boolean): Promise<void>;
}

export async function importComposerLocalImage(
  source: vscode.Uri,
  workspace: vscode.Uri,
  provider: MmtIndexedDbFileSystemProvider,
  canImport: () => boolean,
  canCleanup: () => boolean,
  signal: AbortSignal,
): Promise<ComposerLocalImageImport | null> {
  if (source.scheme !== workspace.scheme || source.authority !== workspace.authority
    || !source.path.startsWith(workspace.path) || source.query || source.fragment || !canImport()) {
    throw new Error("当前作品不可写，未导入图片。");
  }
  const file = await pickImageFile(signal);
  if (!file) return null;
  if (file.size > WorkspaceAssetMirror.MAX_FILE_BYTES) {
    throw new Error(`图片超过预览支持的单文件大小（${WorkspaceAssetMirror.MAX_FILE_BYTES / 1024 / 1024} MiB）。`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const extension = imageExtension(bytes);
  if (!extension) throw new Error("请选择 PNG 或 JPEG 图片。");
  const url = URL.createObjectURL(new Blob([bytes], { type: extension === "png" ? "image/png" : "image/jpeg" }));
  const image = new Image();
  try {
    image.src = url;
    await image.decode();
    if (image.naturalWidth === 0 || image.naturalHeight === 0) throw new Error("图片没有可用的像素尺寸。");
  } catch (error) {
    throw new Error("无法解码这张图片，未写入工作区。", { cause: error });
  } finally {
    image.removeAttribute("src");
    URL.revokeObjectURL(url);
  }
  signal.throwIfAborted();
  if (!canImport()) throw new Error("作品或编辑权限已改变，未导入图片。");
  const directory = vscode.Uri.joinPath(source, "..", "assets");
  const relativePath = `assets/${crypto.randomUUID()}.${extension}`;
  const resource = vscode.Uri.joinPath(source, "..", relativePath);
  await vscode.workspace.fs.createDirectory(directory);
  signal.throwIfAborted();
  if (!canImport()) throw new Error("作品或编辑权限已改变，未导入图片。");
  await provider.writeFile(resource, bytes, { create: true, overwrite: false });
  const { workspaceId, backendGeneration, headSequence } = provider.coordinator.state.metadata;
  let finished = false;
  return {
    media: { kind: "workspaceImage", relativePath },
    async finish(accepted) {
      if (finished) return;
      if (accepted) {
        finished = true;
        return;
      }
      // A rejected command does not prove that another authored edit left this path unused.
      const metadata = provider.coordinator.state.metadata;
      if (!canCleanup() || metadata.workspaceId !== workspaceId
        || metadata.backendGeneration !== backendGeneration || metadata.headSequence !== headSequence) {
        finished = true;
        return;
      }
      let current: Uint8Array;
      try {
        current = provider.readFile(resource);
      } catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
          finished = true;
          return;
        }
        throw error;
      }
      if (current.byteLength === bytes.byteLength && current.every((value, index) => value === bytes[index])) {
        await provider.delete(resource, { recursive: false });
      }
      finished = true;
    },
  };
}

function imageExtension(bytes: Uint8Array): "png" | "jpg" | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  return undefined;
}

function pickImageFile(signal: AbortSignal): Promise<File | null> {
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<File | null>();
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".png,.jpg,.jpeg,image/png,image/jpeg";
  input.hidden = true;
  const cleanup = () => {
    signal.removeEventListener("abort", abort);
    input.remove();
  };
  const abort = () => {
    cleanup();
    reject(signal.reason);
  };
  input.addEventListener("change", () => {
    const file = input.files?.[0] ?? null;
    cleanup();
    resolve(file);
  }, { once: true });
  input.addEventListener("cancel", () => {
    cleanup();
    resolve(null);
  }, { once: true });
  signal.addEventListener("abort", abort, { once: true });
  document.body.append(input);
  try {
    input.click();
  } catch (error) {
    cleanup();
    reject(error);
  }
  return promise;
}
