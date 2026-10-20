"use client";

import { useEffect, useRef, useState } from "react";

interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Props {
  source: string;
  result: Blob;
  crop: CropRect | null;
  width: number;
  height: number;
}

export default function ImageComparison({ source, result, crop, width, height }: Props) {
  const [beforeSrc, setBeforeSrc] = useState<string | null>(null);
  const [position, setPosition] = useState(50);
  const [afterReady, setAfterReady] = useState(false);
  const afterImageRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const afterUrl = URL.createObjectURL(result);
    if (afterImageRef.current) afterImageRef.current.src = afterUrl;
    return () => URL.revokeObjectURL(afterUrl);
  }, [result]);

  useEffect(() => {
    let active = true;
    let beforeUrl: string | null = null;

    const image = new Image();
    image.onload = () => {
      if (!active) return;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        setBeforeSrc(source);
        return;
      }

      if (crop) {
        context.drawImage(image, crop.x, crop.y, crop.w, crop.h, 0, 0, width, height);
      } else {
        context.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight, 0, 0, width, height);
      }

      canvas.toBlob((blob) => {
        if (!active) return;
        if (blob) {
          beforeUrl = URL.createObjectURL(blob);
          setBeforeSrc(beforeUrl);
        } else {
          setBeforeSrc(source);
        }
      }, "image/png");
    };
    image.onerror = () => {
      if (active) setBeforeSrc(source);
    };
    image.src = source;

    return () => {
      active = false;
      if (beforeUrl) URL.revokeObjectURL(beforeUrl);
    };
  }, [source, crop, width, height]);

  const updateFromPointer = (clientX: number, element: HTMLDivElement) => {
    const bounds = element.closest(".image-comparison")?.getBoundingClientRect();
    if (!bounds || bounds.width === 0) return;
    setPosition(Math.max(0, Math.min(100, ((clientX - bounds.left) / bounds.width) * 100)));
  };

  return (
    <div className="image-comparison">
      <div className="comparison-label comparison-label-before">圧縮前</div>
      <div className="comparison-label comparison-label-after">圧縮後</div>
      {beforeSrc && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="comparison-image" src={beforeSrc} alt="圧縮前の画像" draggable={false} />
      )}
      <div className="comparison-after" style={{ clipPath: `inset(0 0 0 ${position}%)` }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={afterImageRef}
          className="comparison-image"
          alt="圧縮後の画像"
          draggable={false}
          onLoad={() => setAfterReady(true)}
        />
      </div>
      <div
        className="comparison-divider"
        style={{ left: `${position}%` }}
        role="slider"
        aria-label="圧縮前後の境界位置"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={position}
        aria-valuetext={`${Math.round(position)}%`}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
            event.preventDefault();
            setPosition((value) => Math.max(0, value - 2));
          } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
            event.preventDefault();
            setPosition((value) => Math.min(100, value + 2));
          } else if (event.key === "Home") {
            event.preventDefault();
            setPosition(0);
          } else if (event.key === "End") {
            event.preventDefault();
            setPosition(100);
          }
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          updateFromPointer(event.clientX, event.currentTarget);
        }}
        onPointerMove={(event) => {
          if (event.buttons === 1) updateFromPointer(event.clientX, event.currentTarget);
        }}
        onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
      >
        <span>↔</span>
      </div>
      <div className="comparison-instruction">中央のつまみを左右にドラッグして比較</div>
      {(!beforeSrc || !afterReady) && (
        <div className="image-comparison-loading" role="status" aria-live="polite">
          <span className="suu-spinner" />
          <span>比較画像を準備しています</span>
        </div>
      )}
    </div>
  );
}
