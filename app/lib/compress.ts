/**
 * compress.ts — Core compression algorithm for suu
 *
 * Strategy:
 *  JPEG/WebP: quality binary-search → pixel downsample
 *  PNG:       lossless → quantize to 256/128/64 colors → pixel downsample
 *
 * NEVER resolves with a blob larger than targetBytes.
 * If the target cannot be met, throws CompressError.
 */

export type OutputFormat = "image/jpeg" | "image/png" | "image/webp";

export interface CompressOptions {
  targetBytes: number;
  format: OutputFormat;
  monochrome?: boolean;
  preserveDimensions?: boolean;
  allowLowQuality?: boolean;
  crop?: { x: number; y: number; w: number; h: number } | null;
  outputWidth?: number | null;
  outputHeight?: number | null;
  onProgress?: (p: number) => void;
}

export interface CompressResult {
  blob: Blob;
  actualFormat: OutputFormat;
  width: number;
  height: number;
}

export type CompressionWarning =
  | { kind: "quality"; quality: number }
  | { kind: "resize"; width: number; height: number; sourceWidth: number; sourceHeight: number }
  | { kind: "colors"; count: number };

export class CompressError extends Error {
  constructor(message: string, public readonly smallest: number) {
    super(message);
    this.name = "CompressError";
  }
}

export class QualityConfirmationRequired extends Error {
  constructor(public readonly warning: CompressionWarning) {
    super("目標容量に合わせるには画質を大きく下げる必要があります。");
    this.name = "QualityConfirmationRequired";
  }
}

const QUALITY_WARNING_THRESHOLD = 0.5;

/* ─── helpers ──────────────────────────────────────── */

function progress(fn: ((p: number) => void) | undefined, v: number) {
  fn?.(Math.max(0, Math.min(1, v)));
}

/** Draw image (or cropped region) onto a new canvas. */
function drawToCanvas(
  img: HTMLImageElement | ImageBitmap,
  crop: { x: number; y: number; w: number; h: number } | null | undefined,
  targetW: number,
  targetH: number,
  addWhiteBg: boolean,
  monochrome = false
): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width  = Math.max(1, Math.round(targetW));
  c.height = Math.max(1, Math.round(targetH));
  const ctx = c.getContext("2d")!;
  if (addWhiteBg) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
  }
  if (crop) {
    ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, c.width, c.height);
  } else {
    const iw = img instanceof HTMLImageElement ? img.naturalWidth  : img.width;
    const ih = img instanceof HTMLImageElement ? img.naturalHeight : img.height;
    ctx.drawImage(img, 0, 0, iw, ih, 0, 0, c.width, c.height);
  }
  if (monochrome) {
    const imageData = ctx.getImageData(0, 0, c.width, c.height);
    const pixels = imageData.data;
    for (let i = 0; i < pixels.length; i += 4) {
      const gray = Math.round(pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722);
      pixels[i] = gray;
      pixels[i + 1] = gray;
      pixels[i + 2] = gray;
    }
    ctx.putImageData(imageData, 0, 0);
  }
  return c;
}

/** canvas.toBlob promise wrapper */
function toBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        if (b) resolve(b);
        else reject(new Error("canvas.toBlob returned null"));
      },
      mime,
      quality
    );
  });
}

/**
 * Validate the requested output encoder before starting compression.
 * The selected format is preserved; unsupported native WebP uses WASM.
 */
async function probeFormat(requested: OutputFormat): Promise<OutputFormat> {
  const c = document.createElement("canvas");
  c.width = c.height = 4;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#f00";
  ctx.fillRect(0, 0, 4, 4);
  // Make sure the requested format can be encoded. WebP has a WASM fallback,
  // so an unsupported canvas encoder never silently changes the user's choice.
  await toFormatBlob(c, requested, 0.8);
  return requested;
}

/** Encode in the requested format, using the WebP WASM encoder if needed. */
async function toFormatBlob(canvas: HTMLCanvasElement, mime: OutputFormat, quality?: number): Promise<Blob> {
  const blob = await toBlob(canvas, mime, quality);
  if (blob.type === mime) return blob;

  if (mime === "image/webp") {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("WebPエンコーダーを初期化できませんでした。");
    const { encode } = await import("@jsquash/webp");
    const data = await encode(ctx.getImageData(0, 0, canvas.width, canvas.height), {
      quality: Math.round((quality ?? 0.8) * 100),
    });
    return new Blob([data], { type: "image/webp" });
  }

  throw new Error(`${mime}形式の画像をエンコードできませんでした。`);
}

/* ─── PNG quantization via @jsquash (optional) ─────── */
async function quantizePng(imageData: ImageData, channelLevels: number): Promise<Blob | null> {
  try {
    const { encode } = await import("@jsquash/png");
    const data = new Uint8ClampedArray(imageData.data);
    const step = 255 / (channelLevels - 1);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = Math.round(data[i] / step) * step;
      data[i + 1] = Math.round(data[i + 1] / step) * step;
      data[i + 2] = Math.round(data[i + 2] / step) * step;
      // Keep alpha unchanged so transparent edges remain intact.
    }
    const reduced = new ImageData(data, imageData.width, imageData.height);
    const buf = await encode(reduced, { bitDepth: 8 });
    return new Blob([buf], { type: "image/png" });
  } catch {
    return null;
  }
}

function warnIfLargeResize(
  width: number,
  height: number,
  sourceWidth: number,
  sourceHeight: number,
  allowLowQuality: boolean
) {
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  if (scale < 0.7 && !allowLowQuality) {
    throw new QualityConfirmationRequired({ kind: "resize", width, height, sourceWidth, sourceHeight });
  }
}

function warnIfStrongPaletteReduction(
  channelLevels: number,
  monochrome: boolean,
  allowLowQuality: boolean
) {
  const count = monochrome ? channelLevels : channelLevels ** 3;
  const strongReduction = monochrome ? channelLevels <= 32 : channelLevels <= 8;
  if (strongReduction && !allowLowQuality) {
    throw new QualityConfirmationRequired({ kind: "colors", count });
  }
}

function getImageData(canvas: HTMLCanvasElement): ImageData {
  return canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
}

/* ─── Main ─────────────────────────────────────────── */
export async function compress(
  img: HTMLImageElement | ImageBitmap,
  opts: CompressOptions
): Promise<CompressResult> {
  const { targetBytes, format, crop, onProgress } = opts;

  // Source region dimensions
  const srcW = crop ? crop.w : (img instanceof HTMLImageElement ? img.naturalWidth  : img.width);
  const srcH = crop ? crop.h : (img instanceof HTMLImageElement ? img.naturalHeight : img.height);

  // Output dimensions
  let baseW: number, baseH: number;
  if (opts.outputWidth && opts.outputHeight) {
    baseW = opts.outputWidth;
    baseH = opts.outputHeight;
  } else if (opts.outputWidth) {
    baseW = opts.outputWidth;
    baseH = Math.round(srcH * (opts.outputWidth / srcW));
  } else if (opts.outputHeight) {
    baseH = opts.outputHeight;
    baseW = Math.round(srcW * (opts.outputHeight / srcH));
  } else {
    baseW = srcW;
    baseH = srcH;
  }

  // Probe actual browser format support
  const actualFormat = await probeFormat(format);
  const isPng = actualFormat === "image/png";
  // Add white background when encoding to JPEG (JPEG has no alpha channel)
  const addWhiteBg = actualFormat === "image/jpeg";

  progress(onProgress, 0.05);

  if (opts.preserveDimensions) {
    const canvas = drawToCanvas(img, crop, baseW, baseH, addWhiteBg, true);
    if (isPng) {
      const lossless = await toBlob(canvas, "image/png");
      if (lossless.size <= targetBytes) {
        progress(onProgress, 1);
        return { blob: lossless, actualFormat, width: baseW, height: baseH };
      }
      const imageData = getImageData(canvas);
      let smallest = lossless.size;
      const paletteLevels = [16, 8, 6, 4, 3, 2];
      for (let index = 0; index < paletteLevels.length; index++) {
        const levels = paletteLevels[index];
        const quantized = await quantizePng(imageData, levels);
        if (quantized) smallest = Math.min(smallest, quantized.size);
        if (quantized && quantized.size <= targetBytes) {
          warnIfStrongPaletteReduction(levels, true, Boolean(opts.allowLowQuality));
          progress(onProgress, 1);
          return { blob: quantized, actualFormat, width: baseW, height: baseH };
        }
        progress(onProgress, 0.1 + 0.8 * ((index + 1) / paletteLevels.length));
      }
      throw new CompressError(
        `モノクロで画像サイズを保つと目標容量に収まりません（最小: ${fmtBytes(smallest)}）。`,
        smallest
      );
    }

    let low = 0.01;
    let high = 0.99;
    let best: Blob | null = null;
    let bestQuality = 0;
    let smallest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 12; i++) {
      const quality = (low + high) / 2;
      const blob = await toFormatBlob(canvas, actualFormat, quality);
      smallest = Math.min(smallest, blob.size);
      if (blob.size <= targetBytes) {
        best = blob;
        bestQuality = quality;
        low = quality;
      } else {
        high = quality;
      }
      progress(onProgress, 0.05 + 0.9 * ((i + 1) / 12));
    }
    if (best) {
      if (bestQuality < QUALITY_WARNING_THRESHOLD && !opts.allowLowQuality) {
        throw new QualityConfirmationRequired({ kind: "quality", quality: bestQuality });
      }
      progress(onProgress, 1);
      return { blob: best, actualFormat, width: baseW, height: baseH };
    }
    throw new CompressError(
      `モノクロで画像サイズを保つと目標容量に収まりません（最小: ${fmtBytes(smallest)}）。`,
      smallest
    );
  }

  /* ══ PNG path ════════════════════════════════════ */
  if (isPng) {
    // Stage 1: lossless full-size PNG
    progress(onProgress, 0.08);
    const full = drawToCanvas(img, crop, baseW, baseH, false, opts.monochrome);
    const lossless = await toBlob(full, "image/png");
    if (lossless.size <= targetBytes) {
      progress(onProgress, 1);
      return { blob: lossless, actualFormat: "image/png", width: full.width, height: full.height };
    }

    // Stage 2: reduce channel precision while preserving alpha at full size.
    const fullImageData = getImageData(full);
    const paletteLevels = [16, 8, 6, 4, 3, 2];
    for (let index = 0; index < paletteLevels.length; index++) {
      const levels = paletteLevels[index];
      const qBlob = await quantizePng(fullImageData, levels);
      if (qBlob && qBlob.size <= targetBytes) {
        warnIfStrongPaletteReduction(levels, Boolean(opts.monochrome), Boolean(opts.allowLowQuality));
        progress(onProgress, 1);
        return { blob: qBlob, actualFormat: "image/png", width: full.width, height: full.height };
      }
      progress(onProgress, 0.1 + 0.22 * ((index + 1) / paletteLevels.length));
    }

    // Stage 3: downsample (with optional quantization at each scale)
    const scales = [0.85, 0.70, 0.55, 0.40, 0.30, 0.20, 0.15, 0.10, 0.05];
    for (let si = 0; si < scales.length; si++) {
      const w = Math.max(1, Math.round(baseW * scales[si]));
      const h = Math.max(1, Math.round(baseH * scales[si]));
      const c = drawToCanvas(img, crop, w, h, false, opts.monochrome);

      const plain = await toBlob(c, "image/png");
      progress(onProgress, 0.30 + 0.65 * ((si + 0.2) / scales.length));
      if (plain.size <= targetBytes) {
        warnIfLargeResize(w, h, baseW, baseH, Boolean(opts.allowLowQuality));
        progress(onProgress, 1);
        return { blob: plain, actualFormat: "image/png", width: w, height: h };
      }

      const imageData = getImageData(c);
      for (let index = 0; index < paletteLevels.length; index++) {
        const levels = paletteLevels[index];
        const qBlob = await quantizePng(imageData, levels);
        if (qBlob && qBlob.size <= targetBytes) {
          warnIfLargeResize(w, h, baseW, baseH, Boolean(opts.allowLowQuality));
          warnIfStrongPaletteReduction(levels, Boolean(opts.monochrome), Boolean(opts.allowLowQuality));
          progress(onProgress, 1);
          return { blob: qBlob, actualFormat: "image/png", width: w, height: h };
        }
        progress(onProgress, 0.30 + 0.65 * ((si + (index + 1) / paletteLevels.length) / scales.length));
      }
    }

    const tiny = drawToCanvas(img, crop, 1, 1, false, opts.monochrome);
    const tinyBlob = await toBlob(tiny, "image/png");
    throw new CompressError(
      `目標容量 ${fmtBytes(targetBytes)} への圧縮ができませんでした（最小: ${fmtBytes(tinyBlob.size)}）。目標容量を大きくするか、JPEG形式をお試しください。`,
      tinyBlob.size
    );
  }

  /* ══ JPEG / WebP path ════════════════════════════ */
  // Phase 1: binary-search quality at full size
  let lo = 0.01, hi = 0.99;
  let bestBlob: Blob | null = null;
  let bestQuality = 0;

  for (let i = 0; i < 8; i++) {
    const q = (lo + hi) / 2;
    const canvas = drawToCanvas(img, crop, baseW, baseH, addWhiteBg, opts.monochrome);
    const blob = await toFormatBlob(canvas, actualFormat, q);
    progress(onProgress, 0.05 + 0.40 * (i / 8));
    if (blob.size <= targetBytes) { bestBlob = blob; bestQuality = q; lo = q; }
    else hi = q;
  }

  if (bestBlob && bestBlob.size <= targetBytes) {
    if (bestQuality < QUALITY_WARNING_THRESHOLD && !opts.allowLowQuality) {
      throw new QualityConfirmationRequired({ kind: "quality", quality: bestQuality });
    }
    progress(onProgress, 1);
    return { blob: bestBlob, actualFormat, width: baseW, height: baseH };
  }

  // Phase 2: downsample
  const scales = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.15, 0.1, 0.05];
  const qualities = [0.8, 0.5, 0.2, 0.05];
  for (let si = 0; si < scales.length; si++) {
    const w = Math.max(1, Math.round(baseW * scales[si]));
    const h = Math.max(1, Math.round(baseH * scales[si]));
    for (let qi = 0; qi < qualities.length; qi++) {
      const canvas = drawToCanvas(img, crop, w, h, addWhiteBg, opts.monochrome);
      const blob = await toFormatBlob(canvas, actualFormat, qualities[qi]);
      progress(onProgress, 0.45 + 0.50 * ((si * qualities.length + qi) / (scales.length * qualities.length)));
      if (blob.size <= targetBytes) {
        warnIfLargeResize(w, h, baseW, baseH, Boolean(opts.allowLowQuality));
        if (qualities[qi] < QUALITY_WARNING_THRESHOLD && !opts.allowLowQuality) {
          throw new QualityConfirmationRequired({ kind: "quality", quality: qualities[qi] });
        }
        progress(onProgress, 1);
        return { blob, actualFormat, width: w, height: h };
      }
    }
  }

  const tiny = drawToCanvas(img, crop, 1, 1, addWhiteBg, opts.monochrome);
  const tinyBlob = await toFormatBlob(tiny, actualFormat, 0.01);
  if (tinyBlob.size <= targetBytes) {
    progress(onProgress, 1);
    return { blob: tinyBlob, actualFormat, width: 1, height: 1 };
  }

  throw new CompressError(
    `目標容量 ${fmtBytes(targetBytes)} への圧縮ができませんでした（最小: ${fmtBytes(tinyBlob.size)}）。目標容量を大きくするか、別の形式を試してください。`,
    tinyBlob.size
  );
}

/* ─── Utilities ────────────────────────────────────── */

export function fmtBytes(bytes: number): string {
  if (bytes < 1024)            return `${bytes} B`;
  if (bytes < 1024 * 1024)     return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function reductionPct(original: number, compressed: number): number {
  if (!Number.isFinite(original) || original <= 0 || !Number.isFinite(compressed)) return 0;
  return Math.round(((original - compressed) / original) * 100);
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("画像データを読み込めませんでした。"));
    img.src = src;
  });
}

/**
 * Returns the file extension for a given MIME type.
 * Always returns a valid string — falls back to "jpg" if unknown.
 */
export function extForFormat(fmt: OutputFormat | string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png":  "png",
    "image/webp": "webp",
  };
  return map[fmt] ?? "jpg";
}

/** Human-readable label for a format. */
export function labelForFormat(fmt: OutputFormat | string): string {
  const map: Record<string, string> = {
    "image/jpeg": "JPEG",
    "image/png":  "PNG",
    "image/webp": "WebP",
  };
  return map[fmt] ?? "JPEG";
}
