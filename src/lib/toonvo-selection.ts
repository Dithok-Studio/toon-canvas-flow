// Mask-based selection helpers for TOONVO.
// A "mask" is a full-canvas-size canvas whose alpha channel marks the selection.

export function makeMask(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.floor(w));
  c.height = Math.max(1, Math.floor(h));
  return c;
}

export function cloneMask(m: HTMLCanvasElement): HTMLCanvasElement {
  const c = makeMask(m.width, m.height);
  c.getContext("2d")!.drawImage(m, 0, 0);
  return c;
}

export function maskFromPath(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const c = makeMask(w, h);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  draw(ctx);
  ctx.fill();
  return c;
}

export function maskBBox(m: HTMLCanvasElement): { x: number; y: number; w: number; h: number } | null {
  const ctx = m.getContext("2d", { willReadFrequently: true })!;
  const d = ctx.getImageData(0, 0, m.width, m.height).data;
  let minX = m.width, minY = m.height, maxX = -1, maxY = -1;
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      if (d[(y * m.width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function invertMask(m: HTMLCanvasElement): HTMLCanvasElement {
  const out = makeMask(m.width, m.height);
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.globalCompositeOperation = "destination-out";
  ctx.drawImage(m, 0, 0);
  return out;
}

/** Grow the mask by `px` pixels (approximate radial dilation). */
export function expandMask(m: HTMLCanvasElement, px: number): HTMLCanvasElement {
  if (px <= 0) return cloneMask(m);
  const out = makeMask(m.width, m.height);
  const ctx = out.getContext("2d")!;
  const steps = 16;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    ctx.drawImage(m, Math.round(Math.cos(a) * px), Math.round(Math.sin(a) * px));
  }
  ctx.drawImage(m, 0, 0);
  return out;
}

/** Shrink the mask by `px` pixels. */
export function contractMask(m: HTMLCanvasElement, px: number): HTMLCanvasElement {
  if (px <= 0) return cloneMask(m);
  return invertMask(expandMask(invertMask(m), px));
}

/** Keep only the edge band of the mask, `px` wide. */
export function borderMask(m: HTMLCanvasElement, px: number): HTMLCanvasElement {
  const grown = expandMask(m, Math.max(1, px));
  const shrunk = contractMask(m, Math.max(1, px));
  const out = makeMask(m.width, m.height);
  const ctx = out.getContext("2d")!;
  ctx.drawImage(grown, 0, 0);
  ctx.globalCompositeOperation = "destination-out";
  ctx.drawImage(shrunk, 0, 0);
  return out;
}

/** Soften the mask edge with a blur. */
export function featherMask(m: HTMLCanvasElement, px: number): HTMLCanvasElement {
  if (px <= 0) return cloneMask(m);
  const out = makeMask(m.width, m.height);
  const ctx = out.getContext("2d")!;
  ctx.filter = `blur(${px}px)`;
  ctx.drawImage(m, 0, 0);
  ctx.filter = "none";
  return out;
}

/**
 * Magic wand: select pixels whose colour matches the pixel at (sx, sy)
 * within `tolerance` (0-100). Contiguous restricts to the connected region.
 */
export function magicWandMask(
  src: HTMLCanvasElement,
  sx: number,
  sy: number,
  tolerance: number,
  contiguous: boolean,
): HTMLCanvasElement | null {
  const w = src.width, h = src.height;
  sx = Math.floor(sx); sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;
  const sctx = src.getContext("2d", { willReadFrequently: true })!;
  const img = sctx.getImageData(0, 0, w, h);
  const d = img.data;
  const si = (sy * w + sx) * 4;
  const tr = d[si], tg = d[si + 1], tb = d[si + 2], ta = d[si + 3];
  const tol = (tolerance / 100) * 442; // max euclidean RGB distance ~441.7

  const match = (i: number) => {
    const dr = d[i] - tr, dg = d[i + 1] - tg, db = d[i + 2] - tb, da = d[i + 3] - ta;
    if (ta === 0) return Math.abs(da) <= (tolerance / 100) * 255;
    return Math.sqrt(dr * dr + dg * dg + db * db) <= tol && Math.abs(da) <= 255 * (tolerance / 100) + 32;
  };

  const out = makeMask(w, h);
  const octx = out.getContext("2d")!;
  const omg = octx.createImageData(w, h);
  const od = omg.data;

  if (!contiguous) {
    for (let p = 0; p < w * h; p++) {
      if (match(p * 4)) { od[p * 4] = 255; od[p * 4 + 1] = 255; od[p * 4 + 2] = 255; od[p * 4 + 3] = 255; }
    }
  } else {
    const seen = new Uint8Array(w * h);
    const stack: number[] = [sy * w + sx];
    while (stack.length) {
      const p = stack.pop()!;
      if (seen[p]) continue;
      seen[p] = 1;
      if (!match(p * 4)) continue;
      od[p * 4] = 255; od[p * 4 + 1] = 255; od[p * 4 + 2] = 255; od[p * 4 + 3] = 255;
      const x = p % w, y = (p / w) | 0;
      if (x > 0) stack.push(p - 1);
      if (x < w - 1) stack.push(p + 1);
      if (y > 0) stack.push(p - w);
      if (y < h - 1) stack.push(p + w);
    }
  }
  octx.putImageData(omg, 0, 0);
  return out;
}
