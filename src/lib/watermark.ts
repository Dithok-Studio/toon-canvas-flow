/**
 * TOONVO moving watermark for free-plan exports.
 * Pure draw helper — call once per export frame with an elapsed time in ms.
 * Pro/creator plans should skip calling entirely.
 */

export type PlanTier = "free" | "pro" | "creator";

const PLAN_KEY = "toonvo-plan";

export function getPlanTier(): PlanTier {
  if (typeof window === "undefined") return "free";
  const v = window.localStorage.getItem(PLAN_KEY);
  return v === "pro" || v === "creator" ? v : "free";
}

export function setPlanTier(tier: PlanTier) {
  if (typeof window !== "undefined") window.localStorage.setItem(PLAN_KEY, tier);
}

export function shouldWatermark(mode: "gif" | "mp4_720" | "mp4_1080" | "png" | "sprite") {
  const plan = getPlanTier();
  if (plan !== "free") return false;
  return mode !== "mp4_1080";
}

interface DrawOpts {
  /** Milliseconds since export start. Drives drift + pulse. */
  timeMs: number;
  /** true = fixed bottom-right (PNG / sprite sheet); false = animated drift (GIF / MP4). */
  fixed?: boolean;
}

/**
 * Draw the watermark on the given 2D context sized w x h (canvas pixels).
 */
export function drawWatermark(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  { timeMs, fixed = false }: DrawOpts,
) {
  const fontPx = Math.max(11, Math.round(h * 0.02));
  const padY = Math.round(fontPx * 0.35);
  const padX = Math.round(fontPx * 0.7);
  const iconGap = Math.round(fontPx * 0.35);
  const iconSize = Math.round(fontPx * 0.9);
  const text = "Made with TOONVO";

  ctx.save();
  ctx.font = `600 ${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const tw = ctx.measureText(text).width;
  const pillW = Math.ceil(iconSize + iconGap + tw + padX * 2);
  const pillH = Math.ceil(fontPx + padY * 2);

  const margin = Math.round(Math.min(w, h) * 0.05);
  let x: number, y: number;

  if (fixed) {
    x = w - pillW - margin;
    y = h - pillH - margin;
  } else {
    // sine-wave drift within safe zone
    const safeW = Math.max(1, w - pillW - margin * 2);
    const safeH = Math.max(1, h - pillH - margin * 2);
    const tSec = timeMs / 1000;
    const nx = 0.5 + 0.45 * Math.sin((tSec / 10) * Math.PI * 2);          // 10s cycle
    const ny = 0.5 + 0.45 * Math.sin((tSec / 10) * Math.PI * 2 + Math.PI / 2);
    x = margin + nx * safeW;
    y = margin + ny * safeH;
    // avoid dead-center 20% box
    const cx = w / 2, cy = h / 2;
    const px = x + pillW / 2, py = y + pillH / 2;
    if (Math.abs(px - cx) < w * 0.1 && Math.abs(py - cy) < h * 0.1) {
      y = y + (py < cy ? -h * 0.15 : h * 0.15);
      y = Math.max(margin, Math.min(h - pillH - margin, y));
    }
  }

  // opacity pulse 45% → 65% → 45% over 4s
  const pulse = 0.55 + 0.10 * Math.sin((timeMs / 4000) * Math.PI * 2);
  ctx.globalAlpha = pulse;

  // drop shadow
  ctx.shadowColor = "rgba(0,0,0,0.3)";
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1;

  // pill background
  const r = pillH / 2;
  ctx.fillStyle = "rgba(0,0,0,0.55)"; // higher than 25% so it reads over bright frames
  roundedRect(ctx, x, y, pillW, pillH, r);
  ctx.fill();

  // clear shadow for text
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // TOONVO logo mark (gradient square)
  const ix = x + padX;
  const iy = y + (pillH - iconSize) / 2;
  const g = ctx.createLinearGradient(ix, iy, ix + iconSize, iy + iconSize);
  g.addColorStop(0, "#6c63ff");
  g.addColorStop(1, "#a855f7");
  ctx.fillStyle = g;
  roundedRect(ctx, ix, iy, iconSize, iconSize, iconSize * 0.22);
  ctx.fill();

  // text
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.fillText(text, ix + iconSize + iconGap, y + pillH / 2 + 1);

  ctx.restore();
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y,     x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x,     y + h, rr);
  ctx.arcTo(x,     y + h, x,     y,     rr);
  ctx.arcTo(x,     y,     x + w, y,     rr);
  ctx.closePath();
}
