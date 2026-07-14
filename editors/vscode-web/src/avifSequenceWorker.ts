import { validateAvifProfile } from "./avifProfile";

const MAX_DIMENSION = 4096;
const MAX_PIXELS = 16_777_216;

interface DecodeRequest {
  id: number;
  bytes: ArrayBuffer;
  frame: number;
  sha256: string;
  size: [number, number];
  profile: unknown;
}

interface DecodeResult {
  image: VideoFrame;
}

interface ImageDecoderInstance {
  readonly tracks: { ready: Promise<unknown> };
  decode(options: { frameIndex: number; completeFramesOnly: boolean }): Promise<DecodeResult>;
  close(): void;
}

interface ImageDecoderConstructor {
  new(options: { data: ArrayBuffer; type: string; preferAnimation: boolean }): ImageDecoderInstance;
  isTypeSupported(type: string): Promise<boolean>;
}

self.onmessage = (event: MessageEvent<DecodeRequest>) => {
  void decode(event.data).then(
    ({ id, png }) => self.postMessage({ id, png }, { transfer: [png] }),
    (error: unknown) => self.postMessage({
      id: event.data.id,
      error: error instanceof Error ? error.message : String(error)
    })
  );
};

async function decode(request: DecodeRequest): Promise<{ id: number; png: ArrayBuffer }> {
  validateAvifProfile(request.profile);
  const [width, height] = request.size;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("AVIFS manifest dimensions are invalid");
  }
  const pixels = width * height;
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || !Number.isSafeInteger(pixels) || pixels > MAX_PIXELS) {
    throw new Error("AVIFS decoded dimensions exceed the browser limit");
  }
  if (!Number.isInteger(request.frame) || request.frame < 0) throw new Error("AVIFS frame index is invalid");
  const digest = await crypto.subtle.digest("SHA-256", request.bytes);
  if (hex(new Uint8Array(digest)) !== request.sha256.toLowerCase()) throw new Error("AVIFS SHA-256 mismatch");

  const decoderValue: unknown = Reflect.get(globalThis, "ImageDecoder");
  if (typeof decoderValue !== "function") throw new Error("This browser does not provide the WebCodecs ImageDecoder API");
  // ImageDecoder is implemented by Chromium but is not yet present in every TypeScript DOM library.
  const ImageDecoderClass = decoderValue as ImageDecoderConstructor;
  if (!await ImageDecoderClass.isTypeSupported("image/avif")) throw new Error("This browser cannot decode AVIF images");
  const decoder = new ImageDecoderClass({ data: request.bytes, type: "image/avif", preferAnimation: true });
  try {
    await decoder.tracks.ready;
    const result = await decoder.decode({ frameIndex: request.frame, completeFramesOnly: true });
    const frame = result.image;
    try {
      if (frame.displayWidth !== width || frame.displayHeight !== height) {
        throw new Error(`AVIFS frame dimensions ${frame.displayWidth}x${frame.displayHeight} do not match ${width}x${height}`);
      }
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Cannot create AVIFS conversion canvas");
      context.drawImage(frame, 0, 0);
      return { id: request.id, png: await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer() };
    } finally {
      frame.close();
    }
  } finally {
    decoder.close();
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
