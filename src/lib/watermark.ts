/**
 * TOONVO watermark system (Clip Studio Paint style).
 * Fixed, professional, subtle watermarks — logo corner, tiled diagonal
 * pattern, or text. No moving/drifting watermark.
 */

export type PlanTier = "free" | "pro" | "creator" | "studio";
export type WatermarkType = "logo" | "tiled" | "text";
export type WatermarkPosition = "tl" | "tr" | "bl" | "br" | "center";

const PLAN_KEY = "toonvo-plan";

export function getPlanTier(): PlanTier {
  if (typeof window === "undefined") return "free";
  const v = window.localStorage.getItem(PLAN_KEY);
  return v === "pro" || v === "creator" || v === "studio" ? v : "free";
}

export function setPlanTier(tier: PlanTier) {
  if (typeof window !== "undefined") window.localStorage.setItem(PLAN_KEY, tier);
}

export function isPaidPlan(tier: PlanTier) {
  return tier !== "free";
}

export interface WatermarkConfig {
  enabled: boolean;
  type: WatermarkType;
  position: WatermarkPosition;
  /** 0.2 – 0.7 */
  opacity: number;
  /** fraction of canvas width, 0.1 – 0.3 */
  size: number;
  text: string;
  /** Pro users may supply their own logo image. */
  image?: CanvasImageSource | null;
  imageAspect?: number;
}

export type ExportKind = "mp4" | "gif" | "sprite" | "png";

/** Free-plan defaults per export kind. MP4 defaults to the tiled pattern. */
export function defaultWatermark(kind: ExportKind): WatermarkConfig {
  return {
    enabled: true,
    type: kind === "mp4" ? "tiled" : "logo",
    position: "br",
    opacity: kind === "mp4" ? 0.25 : 0.4,
    size: 0.15,
    text: "Made with TOONVO",
    image: null,
  };
}

/** Free plan watermarks everything except Pro-only 1080p MP4. */
export function shouldWatermark(plan: PlanTier) {
  return plan === "free";
}

/* ------------------------------------------------------------------ */

function anchor(pos: WatermarkPosition, w: number, h: number, mw: number, mh: number) {
  const m = Math.round(Math.min(w, h) * 0.04);
  switch (pos) {
    case "tl": return { x: m, y: m };
    case "tr": return { x: w - mw - m, y: m };
    case "bl": return { x: m, y: h - mh - m };
    case "center": return { x: (w - mw) / 2, y: (h - mh) / 2 };
    case "br":
    default: return { x: w - mw - m, y: h - mh - m };
  }
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Draws the TOONVO mark (gradient tile + wordmark) with total width `w`. */
function drawLogoMark(ctx: CanvasRenderingContext2D, x: number, y: number, w: number) {
  const icon = w * 0.24;
  const gap = w * 0.07;
  const fontPx = icon * 0.72;

  const g = ctx.createLinearGradient(x, y, x + icon, y + icon);
  g.addColorStop(0, "#6c63ff");
  g.addColorStop(1, "#a855f7");
  ctx.fillStyle = g;
  roundedRect(ctx, x, y, icon, icon, icon * 0.24);
  ctx.fill();

  // "T" glyph inside the tile
  ctx.fillStyle = "#ffffff";
  ctx.font = `900 ${icon * 0.62}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillText("T", x + icon / 2, y + icon / 2 + icon * 0.03);

  ctx.textAlign = "left";
  ctx.font = `800 ${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.fillStyle = "#ffffff";
  ctx.fillText("TOONVO", x + icon + gap, y + icon / 2);
}

function logoHeight(w: number) {
  return w * 0.24;
}

/** One small tile of the diagonal pattern, drawn centred at (0,0). */
function drawTile(ctx: CanvasRenderingContext2D, cfg: WatermarkConfig, tileW: number) {
  if (cfg.image) {
    const ar = cfg.imageAspect || 1;
    ctx.drawImage(cfg.image, -tileW / 2, -tileW / (2 * ar), tileW, tileW / ar);
    return;
  }
  drawLogoMark(ctx, -tileW / 2, -logoHeight(tileW) / 2, tileW);
}

/**
 * Draw the configured watermark onto a 2D context sized w x h (canvas pixels).
 */
export function drawWatermark(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  cfg: WatermarkConfig,
) {
  if (!cfg || !cfg.enabled) return;
  ctx.save();
  ctx.globalAlpha = Math.max(0.05, Math.min(1, cfg.opacity));
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  if (cfg.type === "tiled") {
    // Diagonal grid, ~150px spacing scaled to the output resolution.
    const scale = Math.max(0.5, Math.min(3, w / 1280));
    const spacing = 150 * scale;
    const tileW = spacing * 0.62 * (cfg.size / 0.15);
    const diag = Math.ceil(Math.hypot(w, h));
    ctx.translate(w / 2, h / 2);
    ctx.rotate((-30 * Math.PI) / 180);
    for (let y = -diag / 2; y <= diag / 2; y += spacing) {
      for (let x = -diag / 2; x <= diag / 2; x += spacing) {
        ctx.save();
        ctx.translate(x, y);
        drawTile(ctx, cfg, tileW);
        ctx.restore();
      }
    }
    ctx.restore();
    return;
  }

  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = Math.max(2, w * 0.003);
  ctx.shadowOffsetY = Math.max(1, w * 0.001);

  if (cfg.type === "text") {
    const fontPx = Math.max(10, w * cfg.size * 0.24);
    ctx.font = `600 ${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    const text = cfg.text || "© TOONVO";
    const tw = ctx.measureText(text).width;
    const th = fontPx * 1.2;
    const p = anchor(cfg.position, w, h, tw, th);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, p.x, p.y + th / 2);
    ctx.restore();
    return;
  }

  // Corner logo
  const mw = w * cfg.size;
  if (cfg.image) {
    const ar = cfg.imageAspect || 1;
    const mh = mw / ar;
    const p = anchor(cfg.position, w, h, mw, mh);
    ctx.drawImage(cfg.image, p.x, p.y, mw, mh);
  } else {
    const mh = logoHeight(mw);
    const p = anchor(cfg.position, w, h, mw, mh);
    drawLogoMark(ctx, p.x, p.y, mw);
  }
  ctx.restore();
}
