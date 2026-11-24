// Screenshot limits the feedback service enforces (Bobbie D4): one JPEG per report, long edge ≤ 1280 px, ≤ 400 KB.
export const SCREENSHOT = { maxEdge: 1280, maxBytes: 400 * 1024, qualities: [0.6, 0.5, 0.4, 0.3] } as const;

/** A screenshot's JPEG bytes (backed by a plain ArrayBuffer, so they can be a fetch body or a Blob part). */
export type JpegBytes = Uint8Array<ArrayBuffer>;

const isJpeg = (bytes: JpegBytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

/** The native plugin's snapshot as bytes, or null when it is not a JPEG within the size cap. */
export function snapshotBytes(jpegBase64: string): JpegBytes | null {
  let bytes: JpegBytes;
  try {
    bytes = Uint8Array.from(atob(jpegBase64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  return isJpeg(bytes) && bytes.length <= SCREENSHOT.maxBytes ? bytes : null;
}

/** Fits width × height inside maxEdge, keeping the aspect ratio; never scales up. */
export function fitWithin(width: number, height: number, maxEdge: number = SCREENSHOT.maxEdge): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * A picked or pasted image (web, Mac) redrawn through a canvas as a JPEG within the limits, before it is hashed
 * and signed. Redrawing drops EXIF and GPS and turns any format into JPEG. Null when it can't be decoded or fit.
 */
export async function reencodeImage(file: Blob): Promise<JpegBytes | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  const { width, height } = fitWithin(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  for (const quality of SCREENSHOT.qualities) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) return null;
    if (blob.size <= SCREENSHOT.maxBytes) return new Uint8Array(await blob.arrayBuffer());
  }
  return null;
}
