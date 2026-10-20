"use client";

import { useCallback, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  compress,
  CompressError,
  CompressResult,
  CompressionWarning,
  QualityConfirmationRequired,
  extForFormat,
  labelForFormat,
  fmtBytes,
  loadImage,
  OutputFormat,
  reductionPct,
} from "../lib/compress";
import { decodeHeic, isHeic } from "../lib/heic";
import type { CropRect } from "./Cropper";
import ImageComparison from "./ImageComparison";

const Cropper = dynamic(() => import("./Cropper"), { ssr: false });

/* ─── Types ──────────────────────────────────────── */
interface LoadedImage {
  file: File;
  objectUrl: string;
  naturalWidth: number;
  naturalHeight: number;
  originalBytes: number;
}

type Stage = "idle" | "loading" | "loaded" | "compressing" | "done" | "error";
type SizeUnit = "KB" | "MB";

/* ─── Component ──────────────────────────────────── */
export default function SuuApp() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [dragOver, setDragOver] = useState(false);

  const [image, setImage] = useState<LoadedImage | null>(null);
  const [crop, setCrop] = useState<CropRect | null>(null);

  const [targetValue, setTargetValue] = useState("128");
  const [unit, setUnit] = useState<SizeUnit>("KB");
  const [format, setFormat] = useState<OutputFormat>("image/jpeg");
  const [monochrome, setMonochrome] = useState(false);
  const [preserveDimensions, setPreserveDimensions] = useState(false);
  const [showSizeOptions, setShowSizeOptions] = useState(false);
  const [outputWidth, setOutputWidth] = useState("");
  const [outputHeight, setOutputHeight] = useState("");

  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");

  const [result, setResult] = useState<CompressResult | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [qualityWarning, setQualityWarning] = useState<CompressionWarning | null>(null);

  /* ─── File loading ──────────────────────────────── */
  const handleFile = useCallback(async (file: File) => {
    if (image?.objectUrl) URL.revokeObjectURL(image.objectUrl);
    setImage(null);
    setStage("loading");
    setResult(null);
    setErrorMsg("");
    setQualityWarning(null);
    setCrop(null);
    setProgressLabel("読み込み中...");
    setProgress(0);

    if (file.size > 100 * 1024 * 1024) {
      setErrorMsg("100MB以下の画像を選択してください。");
      setStage("error");
      return;
    }

    let objectUrl: string | undefined;
    const originalBytes = file.size;

    try {
      if (isHeic(file)) {
        setProgressLabel("HEIC / HEIF を変換中...");
        const converted = await decodeHeic(file);
        objectUrl = URL.createObjectURL(converted);
      } else {
        objectUrl = URL.createObjectURL(file);
      }

      const img = await loadImage(objectUrl);
      if (img.naturalWidth * img.naturalHeight > 50_000_000) {
        URL.revokeObjectURL(objectUrl);
        setErrorMsg("画像が大きすぎます。5,000万画素以下の画像を選択してください。");
        setStage("error");
        return;
      }
      setImage({
        file,
        objectUrl,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        originalBytes,
      });
      setStage("loaded");
    } catch (e) {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      console.error(e);
      setErrorMsg(isHeic(file)
        ? "HEIC / HEIF画像を変換できませんでした。別の画像を選ぶか、JPEG形式に変換してからお試しください。"
        : "画像の読み込みに失敗しました。別の画像を選んでもう一度お試しください。");
      setStage("error");
    }
  }, [image]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = "";
  };

  /* ─── Compression ───────────────────────────────── */
  const handleCompress = async (allowLowQuality = false) => {
    if (!image) return;

    const val = Number(targetValue);
    const targetBytes = Math.round(unit === "KB" ? val * 1024 : val * 1024 * 1024);
    const requestedWidth = outputWidth.trim() ? Number(outputWidth) : null;
    const requestedHeight = outputHeight.trim() ? Number(outputHeight) : null;
    const cropWidth = crop?.w ?? image.naturalWidth;
    const cropHeight = crop?.h ?? image.naturalHeight;
    const finalWidth = requestedWidth && requestedHeight
      ? requestedWidth
      : requestedWidth
        ? Math.round(cropHeight * (requestedWidth / cropWidth))
        : requestedHeight
          ? Math.round(cropWidth * (requestedHeight / cropHeight))
          : cropWidth;
    const finalHeight = requestedWidth && requestedHeight
      ? requestedHeight
      : requestedHeight
        ? requestedHeight
        : requestedWidth
          ? Math.round(cropHeight * (requestedWidth / cropWidth))
          : cropHeight;

    if (!Number.isFinite(val) || val < 1 || !Number.isSafeInteger(targetBytes)) {
      setErrorMsg("目標容量は1以上の数値で指定してください。");
      setStage("error");
      return;
    }
    const invalidDimension = (value: number | null) =>
      value !== null && (!Number.isSafeInteger(value) || value < 1 || value > 32_000);
    if (
      invalidDimension(requestedWidth) ||
      invalidDimension(requestedHeight) ||
      !Number.isSafeInteger(finalWidth) ||
      !Number.isSafeInteger(finalHeight) ||
      finalWidth > 32_000 ||
      finalHeight > 32_000 ||
      finalWidth * finalHeight > 50_000_000
    ) {
      setErrorMsg("出力サイズが大きすぎるか無効です。各辺を32,000px以下、合計5,000万画素以下にしてください。");
      setStage("error");
      return;
    }

    setStage("compressing");
    setResult(null);
    setErrorMsg("");
    setQualityWarning(null);
    setProgress(0);
    setProgressLabel("圧縮を準備中...");

    try {
      const img = await loadImage(image.objectUrl);
      const res = await compress(img, {
        targetBytes,
        format,
        monochrome,
        preserveDimensions,
        allowLowQuality,
        crop,
        outputWidth: requestedWidth,
        outputHeight: requestedHeight,
        onProgress: (p) => {
          setProgress(p);
          if (p < 0.3) setProgressLabel("画質を調整中...");
          else if (p < 0.6) setProgressLabel("サイズを最適化中...");
          else if (p < 0.9) setProgressLabel("仕上げを確認中...");
          else setProgressLabel("完了を確認中...");
        },
      });

      if (res.blob.size > targetBytes) {
        throw new CompressError(
          `圧縮後の容量が目標を超えています（${fmtBytes(res.blob.size)}）。`,
          res.blob.size
        );
      }

      setResult(res);
      setStage("done");
    } catch (e) {
      if (e instanceof QualityConfirmationRequired) {
        setQualityWarning(e.warning);
        setStage("loaded");
      } else if (e instanceof CompressError) {
        const hint = !monochrome
          ? " モノクロをオンにするか、目標容量を調整してください。"
          : preserveDimensions
            ? "「サイズを維持」をオフにすると、縮小して目標容量に合わせられます。"
            : ` モノクロでも達成できません。目標容量を ${fmtBytes(e.smallest)} 以上にしてください。`;
        setErrorMsg(`${e.message}${hint}`);
        setStage("error");
      } else {
        setErrorMsg("圧縮中にエラーが発生しました。");
        console.error(e);
        setStage("error");
      }
    }
  };

  /* ─── Download ──────────────────────────────────── */
  const handleDownload = () => {
    if (!result) return;
    const url = URL.createObjectURL(result.blob);
    const a = document.createElement("a");
    const baseName = image!.file.name.replace(/\.[^.]+$/, "");
    a.href = url;
    a.download = `${baseName}_compressed.${extForFormat(result.actualFormat)}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const clearCompressionFeedback = () => {
    setQualityWarning(null);
    setErrorMsg("");
    if (stage === "done" || stage === "error") {
      setResult(null);
      setStage("loaded");
    }
  };

  const reduction = result
    ? reductionPct(image!.originalBytes, result.blob.size)
    : 0;

  const hasImage = Boolean(image);

  /* ─── Render ────────────────────────────────────── */
  return (
    <div className={`app-shell${hasImage ? " has-image" : ""}${stage === "compressing" ? " is-compressing" : ""}`}>

      {/* ══ IDLE: full-screen drop zone ══════════════ */}
      {!image && stage === "idle" && (
        <div
          id="dropzone"
          className={`idle-screen${dragOver ? " drag-over" : ""}`}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          role="button"
          tabIndex={0}
          aria-label="画像を選択またはドラッグ＆ドロップ"
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              fileInputRef.current?.click();
            }
          }}
        >
          <div className="idle-inner">
            <div className="idle-logo">suu<span className="idle-logo-dot">.</span></div>
            <div className="idle-tagline">LOCAL IMAGE COMPRESSOR</div>

            <div className="idle-upload-area">
              <svg className="idle-icon" viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="1.2">
                <rect x="8" y="14" width="48" height="36" rx="5" />
                <circle cx="24" cy="27" r="4" />
                <path d="M8 42l14-14 10 10 8-8 16 16" />
              </svg>
              <div className="idle-cta">画像を選択</div>
              <div className="idle-sub">クリックまたはドラッグ＆ドロップ</div>
              <div className="idle-formats">
                {["HEIC", "HEIF", "JPEG", "PNG", "WebP"].map((f) => (
                  <span key={f} className="suu-badge">{f}</span>
                ))}
              </div>
            </div>

            <div className="idle-privacy">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              完全ローカル処理
            </div>
          </div>
        </div>
      )}

      {!image && stage === "loading" && (
        <div className="file-state-screen" role="status" aria-live="polite">
          <span className="suu-spinner" />
          <strong>{progressLabel || "画像を読み込んでいます"}</strong>
          <span>画像は端末内で処理されます</span>
        </div>
      )}

      {!image && stage === "error" && (
        <div className="file-state-screen file-state-error" role="alert">
          <strong>画像を読み込めませんでした</strong>
          <span>{errorMsg || "対応形式の画像を選び直してください。"}</span>
          <button className="panel-compress-btn" onClick={() => fileInputRef.current?.click()}>
            画像を選び直す
          </button>
        </div>
      )}

      {/* ══ IMAGE VIEW ═══════════════════════════════ */}
      {hasImage && image && (
        <>
          {/* Image + cropper fills the viewport */}
          <div className="image-stage">
            {/* Top bar overlay */}
            <div className="top-bar">
              <button
                className="top-bar-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={stage === "compressing"}
                aria-label="別の画像を選ぶ"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M19 12H5M12 5l-7 7 7 7" />
                </svg>
              </button>
              <div className="top-bar-logo">suu<span className="idle-logo-dot">.</span></div>
              <div className="top-bar-meta">
                <span className="top-bar-name">{image.file.name}</span>
                <span className="top-bar-size">{fmtBytes(image.originalBytes)} · {image.naturalWidth}×{image.naturalHeight}</span>
              </div>
              {crop && (
                <button
                  className="top-bar-crop-clear"
                  onClick={() => {
                    setCrop(null);
                    clearCompressionFeedback();
                  }}
                  title="トリミングをリセット"
                  disabled={stage === "compressing"}
                >
                  ✂ {crop.w}×{crop.h}
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginLeft: 4 }}>
                    <path d="M12 4 4 12M4 4l8 8" />
                  </svg>
                </button>
              )}
            </div>

            {/* Keep the cropper mounted so returning to editing preserves its selection. */}
            <div className={`cropper-layer${stage === "done" && result ? " is-covered" : ""}`}>
              <Cropper
                src={image.objectUrl}
                naturalWidth={image.naturalWidth}
                naturalHeight={image.naturalHeight}
                onCropChange={(nextCrop) => {
                  // Ignore resize/layout notifications while processing or showing results.
                  // The cropper's displayed selection can shift by a pixel as the stage resizes.
                  if (stage !== "loaded" && stage !== "error") return;
                  // Only the explicit reset button should clear an existing crop.
                  if (nextCrop === null) return;
                  const cropChanged = crop === null ||
                    nextCrop.x !== crop.x ||
                    nextCrop.y !== crop.y ||
                    nextCrop.w !== crop.w ||
                    nextCrop.h !== crop.h;
                  if (!cropChanged) return;
                  setCrop(nextCrop);
                  clearCompressionFeedback();
                }}
                crop={crop}
              />
            </div>

            {stage === "done" && result && (
              <ImageComparison
                source={image.objectUrl}
                result={result.blob}
                crop={crop}
                width={result.width}
                height={result.height}
              />
            )}

            {/* Hint overlay — only before first crop */}
            {!crop && stage === "loaded" && (
              <div className="crop-hint">
                ドラッグしてトリミング範囲を指定（任意）
              </div>
            )}
          </div>

          {/* ── Bottom panel ──────────────────────── */}
          <div className="bottom-panel">
            <div className="workflow-heading">
              <div>
                <span className="workflow-step">
                  {stage === "done" ? "圧縮結果" : stage === "error" ? "要確認" : "出力設定"}
                </span>
                <h2>{stage === "done" ? "圧縮が完了しました" : stage === "error" ? "圧縮できませんでした" : stage === "compressing" ? "圧縮しています" : "容量と形式を選択"}</h2>
              </div>
              <p>
                {stage === "done"
                  ? "目標容量以下に仕上がりました。内容を確認して保存してください。"
                  : stage === "compressing"
                    ? "目標容量を確認しながら処理しています。"
                    : "目標容量以下に収まるように圧縮します。画像は端末内で処理されます。"}
              </p>
            </div>

            {/* Settings row */}
            <div className="settings-row">
              {/* Target size */}
              <div className="suu-field-group">
                <label className="suu-field-label" htmlFor="target-size">目標容量</label>
                <div className="suu-size-input-row">
                  <input
                    id="target-size"
                    type="number"
                    className="suu-number-input"
                    value={targetValue}
                    min={1}
                    disabled={stage === "compressing"}
                    onChange={(e) => {
                      setTargetValue(e.target.value);
                      clearCompressionFeedback();
                    }}
                    style={{ width: 80 }}
                  />
                  <select
                    id="target-unit"
                    className="suu-unit-select"
                    value={unit}
                    disabled={stage === "compressing"}
                    onChange={(e) => {
                      setUnit(e.target.value as SizeUnit);
                      clearCompressionFeedback();
                    }}
                  >
                    <option value="KB">KB</option>
                    <option value="MB">MB</option>
                  </select>
                </div>
              </div>

              <fieldset className="format-picker">
                <legend className="suu-field-label">出力形式</legend>
                {[
                  { format: "image/jpeg" as const, label: "JPEG", ext: ".jpg", feature: "写真向き・軽量" },
                  { format: "image/png" as const, label: "PNG", ext: ".png", feature: "透過に対応" },
                  { format: "image/webp" as const, label: "WebP", ext: ".webp", feature: "高圧縮で容量を節約" },
                ].map((option) => (
                  <label
                    className={`format-option${format === option.format ? " selected" : ""}`}
                    key={option.format}
                  >
                    <input
                      type="radio"
                      name="output-format"
                      value={option.format}
                      checked={format === option.format}
                      disabled={stage === "compressing"}
                      onChange={() => {
                        setFormat(option.format);
                        clearCompressionFeedback();
                      }}
                    />
                    <span className="format-option-heading">
                      <strong>{option.label}</strong>
                      <span>{option.ext}</span>
                    </span>
                    <span className="format-option-feature">{option.feature}</span>
                  </label>
                ))}
              </fieldset>

              <div className="switch-stack">
                <div className="switch-setting">
                  <div className="switch-copy">
                    <strong>モノクロ</strong>
                    <span>{monochrome ? "白黒に変換" : "カラーを維持"}</span>
                  </div>
                  <button
                    type="button"
                    className={`toggle-switch${monochrome ? " on" : ""}`}
                    role="switch"
                    aria-checked={monochrome}
                    aria-label="モノクロ出力"
                    disabled={stage === "compressing"}
                    onClick={() => {
                      setMonochrome(!monochrome);
                      if (monochrome) setPreserveDimensions(false);
                      clearCompressionFeedback();
                    }}
                  >
                    <span />
                  </button>
                </div>
                {monochrome && (
                  <div className="switch-setting switch-setting-secondary">
                    <div className="switch-copy">
                      <strong>サイズを維持</strong>
                      <span>{preserveDimensions ? "縮小しない" : "必要なら縮小"}</span>
                    </div>
                    <button
                      type="button"
                      className={`toggle-switch${preserveDimensions ? " on" : ""}`}
                      role="switch"
                      aria-checked={preserveDimensions}
                      aria-label="出力画像のサイズを維持"
                      disabled={stage === "compressing"}
                      onClick={() => {
                        setPreserveDimensions(!preserveDimensions);
                        clearCompressionFeedback();
                      }}
                    >
                      <span />
                    </button>
                  </div>
                )}
              </div>

              {/* Advanced size options */}
              <div className="suu-field-group">
                <button
                  id="toggle-size-options"
                  className="suu-size-toggle"
                  style={{ marginTop: 0 }}
                  disabled={stage === "compressing"}
                  onClick={() => setShowSizeOptions(!showSizeOptions)}
                  aria-expanded={showSizeOptions}
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
                    style={{ transform: showSizeOptions ? "rotate(90deg)" : "none", transition: "transform 0.2s" }}>
                    <path d="m6 3 5 5-5 5" />
                  </svg>
                  サイズ指定
                </button>
              </div>

            </div>

            {/* Size inputs (accordion) */}
            {showSizeOptions && (
              <div className="size-options-row">
                <div className="suu-field-group">
                  <label className="suu-field-label" htmlFor="output-width">幅 (px)</label>
                  <div className="suu-size-input-row">
                    <input
                      id="output-width"
                      type="number"
                      className="suu-number-input"
                      placeholder="自動"
                      value={outputWidth}
                      min={1}
                      disabled={stage === "compressing"}
                      onChange={(e) => {
                        setOutputWidth(e.target.value);
                        clearCompressionFeedback();
                      }}
                      style={{ width: 100 }}
                    />
                  </div>
                </div>
                <div className="suu-field-group">
                  <label className="suu-field-label" htmlFor="output-height">高さ (px)</label>
                  <div className="suu-size-input-row">
                    <input
                      id="output-height"
                      type="number"
                      className="suu-number-input"
                      placeholder="自動"
                      value={outputHeight}
                      min={1}
                      disabled={stage === "compressing"}
                      onChange={(e) => {
                        setOutputHeight(e.target.value);
                        clearCompressionFeedback();
                      }}
                      style={{ width: 100 }}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Progress bar */}
            {stage === "compressing" && (
              <div className="workflow-progress">
                <div className="panel-progress">
                  <span className="suu-spinner" />
                  <span className="panel-progress-label" aria-live="polite">{progressLabel}</span>
                  <span className="workflow-progress-value">{Math.round(progress * 100)}%</span>
                </div>
                <div
                  className="panel-progress-bar-wrap"
                  role="progressbar"
                  aria-label="圧縮の進捗"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progress * 100)}
                >
                  <div
                    className="panel-progress-bar"
                    style={{ width: `${Math.round(progress * 100)}%` }}
                  />
                </div>
              </div>
            )}

            {qualityWarning && stage !== "compressing" && (
              <div className="mono-choice" role="alert">
                <div className="mono-choice-copy">
                    <strong>
                      {qualityWarning.kind === "quality"
                        ? `目標容量を守るには、圧縮品質を約${Math.round(qualityWarning.quality * 100)}%まで下げる必要があります。`
                        : qualityWarning.kind === "resize"
                          ? `目標容量を守るには、画像を${qualityWarning.width}×${qualityWarning.height}pxまで縮小する必要があります。`
                          : `目標容量を守るには、色数を約${qualityWarning.count}色まで減らす必要があります。`}
                    </strong>
                    <span>この設定で圧縮を続けますか？</span>
                </div>
                <div className="mono-choice-actions">
                  <button
                    className="mono-choice-accept"
                    onClick={() => handleCompress(true)}
                  >
                    続ける
                  </button>
                  <button
                    className="mono-choice-cancel"
                    onClick={() => setQualityWarning(null)}
                  >
                    キャンセル
                  </button>
                </div>
              </div>
            )}

            {/* Result */}
            {stage === "done" && result && (
              <div className="result-row">
                <div className="result-stats">
                  <div className="result-stat">
                    <span className="result-stat-label">圧縮前</span>
                    <span className="result-stat-value">{fmtBytes(image.originalBytes)}</span>
                  </div>
                  <div className="result-arrow">→</div>
                  <div className="result-stat">
                    <span className="result-stat-label">圧縮後</span>
                    <span className="result-stat-value accent">{fmtBytes(result.blob.size)}</span>
                  </div>
                  <div className="result-stat">
                    <span className="result-stat-label">{reduction < 0 ? "容量増加" : "削減率"}</span>
                    <span className="result-stat-value">{Math.abs(reduction)}%</span>
                  </div>
                  <div className="result-stat">
                    <span className="result-stat-label">サイズ</span>
                    <span className="result-stat-value">{result.width}×{result.height}</span>
                  </div>
                </div>
                <button
                  id="download-btn"
                  className="panel-download-btn"
                  onClick={handleDownload}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  {labelForFormat(result.actualFormat)} で保存
                </button>
              </div>
            )}

            {/* Error */}
            {stage === "error" && (
              <div className="error-row" role="alert">
                <span className="error-icon">✕</span>
                <span className="error-text">{errorMsg}</span>
              </div>
            )}

            {stage !== "compressing" && stage !== "done" && !qualityWarning && (
              <div className="workflow-actions">
                <span className="workflow-action-hint">
                  {stage === "error" ? "設定を見直して、もう一度お試しください。" : "圧縮後の容量を確認してから保存できます。"}
                </span>
                <button
                  id="compress-btn"
                  className="panel-compress-btn"
                  onClick={() => handleCompress()}
                >
                  {stage === "error" ? "もう一度試す" : "圧縮を開始"}
                </button>
              </div>
            )}
          </div>
        </>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/jpg,image/png,image/webp,image/heic,image/heif,.heic,.heif,.jpg,.jpeg,.png,.webp"
        style={{ display: "none" }}
        onChange={onFileChange}
      />
    </div>
  );
}
