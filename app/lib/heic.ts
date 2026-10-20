/**
 * HEIC/HEIF decoder helper — dynamically imported only when needed.
 * This keeps the initial bundle lean.
 */

export async function decodeHeic(file: File): Promise<Blob> {
  // Load the decoder only for HEIC/HEIF input to keep the initial bundle small.
  const { heicTo } = await import("heic-to");
  return heicTo({
    blob: file,
    type: "image/jpeg",
    quality: 0.92,
  });
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
