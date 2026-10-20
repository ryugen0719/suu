/**
 * HEIC/HEIF decoder helper — dynamically imported only when needed.
 * This keeps the initial bundle lean.
 */

export async function decodeHeic(file: File): Promise<Blob> {
  // Dynamic import to avoid loading the heavy WASM bundle on start
  const heic2any = (await import("heic2any")).default;
  const result = await heic2any({
    blob: file,
    toType: "image/jpeg",
    quality: 0.92,
  });
  // heic2any may return an array for multi-frame HEIC
  return Array.isArray(result) ? result[0] : result;
}

export function isHeic(file: File): boolean {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return (
    name.endsWith(".heic") ||
    name.endsWith(".heif") ||
    type === "image/heic" ||
    type === "image/heif"
  );
}
