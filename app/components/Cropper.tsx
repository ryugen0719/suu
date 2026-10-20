"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Props {
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  onCropChange: (crop: CropRect | null) => void;
  /** External crop state — when parent resets to null, clear internal sel too */
  crop: CropRect | null;
}

type HandleId =
  | "tl" | "tr" | "bl" | "br"
  | "tm" | "bm" | "ml" | "mr"
  | "move";

interface Sel { x: number; y: number; w: number; h: number }
interface DR  { x: number; y: number; w: number; h: number; scale: number }

export default function Cropper({
  src,
  naturalWidth,
  naturalHeight,
  onCropChange,
  crop,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [sel, setSel]   = useState<Sel | null>(null);
  const [dr, setDr]     = useState<DR>({ x: 0, y: 0, w: 0, h: 0, scale: 1 });
  const cropRef = useRef(crop);
  const dragging = useRef<{
    handle: HandleId | null;
    startX: number;
    startY: number;
    origSel: Sel | null;
  } | null>(null);

  /* ── Sync internal sel when parent resets crop to null ── */
  useEffect(() => {
    cropRef.current = crop;
    // This synchronizes the cropper's local drag state with an explicit parent reset.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (crop === null) setSel(null);
  }, [crop]);

  /* ── Measure container & compute image display rect ─── */
  useEffect(() => {
    const update = () => {
      const el = containerRef.current;
      if (!el) return;
      const { width, height } = el.getBoundingClientRect();
      if (!width || !height) return;
      const imgR = naturalWidth / naturalHeight;
      const conR = width / height;
      let iw: number, ih: number, ix: number, iy: number;
      if (imgR > conR) {
        iw = width; ih = width / imgR; ix = 0; iy = (height - ih) / 2;
      } else {
        ih = height; iw = height * imgR; ix = (width - iw) / 2; iy = 0;
      }
      const nextDr = { x: ix, y: iy, w: iw, h: ih, scale: iw / naturalWidth };
      const currentCrop = cropRef.current;
      if (currentCrop) {
        setSel({
          x: nextDr.x + currentCrop.x * nextDr.scale,
          y: nextDr.y + currentCrop.y * nextDr.scale,
          w: currentCrop.w * nextDr.scale,
          h: currentCrop.h * nextDr.scale,
        });
      }
      setDr(nextDr);
    };
    update();
    const ro = new ResizeObserver(update);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [naturalWidth, naturalHeight]);

  /* ── Convert sel → natural coords, notify parent ─────── */
  useEffect(() => {
    if (!sel || !dr.scale) { onCropChange(null); return; }
    const s = dr.scale;
    const c: CropRect = {
      x: Math.max(0, Math.round((sel.x - dr.x) / s)),
      y: Math.max(0, Math.round((sel.y - dr.y) / s)),
      w: Math.max(1, Math.round(sel.w / s)),
      h: Math.max(1, Math.round(sel.h / s)),
    };
    c.w = Math.min(c.w, naturalWidth  - c.x);
    c.h = Math.min(c.h, naturalHeight - c.y);
    onCropChange(c);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, dr]);

  /* ── Clamp helper ────────────────────────────────────── */
  const clamp = useCallback((x: number, y: number, w: number, h: number): Sel => {
    const cx = Math.max(dr.x, Math.min(x, dr.x + dr.w - 2));
    const cy = Math.max(dr.y, Math.min(y, dr.y + dr.h - 2));
    const cw = Math.max(2, Math.min(w, dr.x + dr.w - cx));
    const ch = Math.max(2, Math.min(h, dr.y + dr.h - cy));
    return { x: cx, y: cy, w: cw, h: ch };
  }, [dr]);

  /* ── Drag start ──────────────────────────────────────── */
  const startDrag = useCallback(
    (e: React.MouseEvent | React.TouchEvent, handle: HandleId | null) => {
      // Only start new selection if clicking on image area (not on existing sel)
      if (handle === null) {
        const r = containerRef.current!.getBoundingClientRect();
        const { cx, cy } = "touches" in e
          ? { cx: e.touches[0].clientX, cy: e.touches[0].clientY }
          : { cx: e.clientX, cy: e.clientY };
        const lx = cx - r.left, ly = cy - r.top;
        // Must be within image bounds
        if (lx < dr.x || lx > dr.x + dr.w || ly < dr.y || ly > dr.y + dr.h) return;
      }

      e.preventDefault();
      e.stopPropagation();

      const r = containerRef.current!.getBoundingClientRect();
      const { cx, cy } = "touches" in e
        ? { cx: e.touches[0].clientX, cy: e.touches[0].clientY }
        : { cx: e.clientX, cy: e.clientY };

      dragging.current = {
        handle,
        startX: cx - r.left,
        startY: cy - r.top,
        origSel: sel,
      };

      const onMove = (ev: MouseEvent | TouchEvent) => {
        ev.preventDefault();
        const bounds = containerRef.current!.getBoundingClientRect();
        const { cx, cy } = "touches" in ev && ev.touches.length
          ? { cx: ev.touches[0].clientX, cy: ev.touches[0].clientY }
          : { cx: (ev as MouseEvent).clientX, cy: (ev as MouseEvent).clientY };
        const lx = cx - bounds.left;
        const ly = cy - bounds.top;
        const d = dragging.current!;
        const dx = lx - d.startX, dy = ly - d.startY;

        if (d.handle === null) {
          // New selection
          setSel(clamp(
            Math.min(d.startX, lx), Math.min(d.startY, ly),
            Math.abs(lx - d.startX), Math.abs(ly - d.startY),
          ));
          return;
        }
        const o = d.origSel;
        if (!o) return;
        if (d.handle === "move") { setSel(clamp(o.x + dx, o.y + dy, o.w, o.h)); return; }
        let { x, y, w, h } = o;
        if (d.handle.includes("r")) w = Math.max(2, w + dx);
        if (d.handle.includes("l")) { x += dx; w = Math.max(2, w - dx); }
        if (d.handle.includes("b")) h = Math.max(2, h + dy);
        if (d.handle.includes("t")) { y += dy; h = Math.max(2, h - dy); }
        setSel(clamp(x, y, w, h));
      };

      const onUp = () => {
        // If drag was too small (< 4px), clear selection
        if (dragging.current?.handle === null) {
          setSel(prev => {
            if (prev && prev.w < 4 && prev.h < 4) return null;
            return prev;
          });
        }
        dragging.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup",   onUp);
        window.removeEventListener("touchmove", onMove);
        window.removeEventListener("touchend",  onUp);
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup",   onUp);
      window.addEventListener("touchmove", onMove, { passive: false });
      window.addEventListener("touchend",  onUp);
    },
    [sel, clamp, dr],
  );

  const handles: HandleId[] = ["tl","tr","bl","br","tm","bm","ml","mr"];

  /* ── Render ──────────────────────────────────────────── */
  return (
    <div
      ref={containerRef}
      className="cropper-stage"
      onMouseDown={(e) => {
        const t = e.target as HTMLElement;
        if (t === containerRef.current || t.tagName === "IMG") startDrag(e, null);
      }}
      onTouchStart={(e) => {
        const t = e.target as HTMLElement;
        if (t === containerRef.current || t.tagName === "IMG") startDrag(e, null);
      }}
    >
      {/* Image */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt="preview"
        draggable={false}
        style={{
          position: "absolute",
          left: dr.x, top: dr.y,
          width: dr.w, height: dr.h,
          objectFit: "fill",
          userSelect: "none",
          cursor: "crosshair",
          pointerEvents: "auto",
        }}
        onMouseDown={(e) => startDrag(e, null)}
        onTouchStart={(e) => startDrag(e, null)}
      />

      {/* Dark mask outside selection */}
      {sel && (
        <>
          {/* top */}
          <div className="mask" style={{ left: dr.x, top: dr.y, width: dr.w, height: sel.y - dr.y }} />
          {/* bottom */}
          <div className="mask" style={{ left: dr.x, top: sel.y + sel.h, width: dr.w, height: dr.y + dr.h - sel.y - sel.h }} />
          {/* left */}
          <div className="mask" style={{ left: dr.x, top: sel.y, width: sel.x - dr.x, height: sel.h }} />
          {/* right */}
          <div className="mask" style={{ left: sel.x + sel.w, top: sel.y, width: dr.x + dr.w - sel.x - sel.w, height: sel.h }} />
        </>
      )}

      {/* Selection box */}
      {sel && (
        <div
          className="crop-sel"
          style={{ left: sel.x, top: sel.y, width: sel.w, height: sel.h }}
          onMouseDown={(e) => { e.stopPropagation(); startDrag(e, "move"); }}
          onTouchStart={(e) => { e.stopPropagation(); startDrag(e, "move"); }}
        >
          {/* Rule-of-thirds grid */}
          <div className="crop-grid">
            <div className="crop-grid-h" style={{ top: "33.33%" }} />
            <div className="crop-grid-h" style={{ top: "66.66%" }} />
            <div className="crop-grid-v" style={{ left: "33.33%" }} />
            <div className="crop-grid-v" style={{ left: "66.66%" }} />
          </div>

          {/* Handles */}
          {handles.map((h) => (
            <div
              key={h}
              className={`crop-handle ${h}`}
              onMouseDown={(e) => { e.stopPropagation(); startDrag(e, h); }}
              onTouchStart={(e) => { e.stopPropagation(); startDrag(e, h); }}
            />
          ))}

          {/* Size label */}
          {dr.scale > 0 && (
            <div className="crop-size-label">
              {Math.round(sel.w / dr.scale)} × {Math.round(sel.h / dr.scale)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
