/**
 * Minimal animated GIF89a encoder (uniform 6x6x6 palette + grayscale ramp).
 * Offline, dependency-free. Good enough for cartoon/flat-color animation.
 */

const PALETTE: number[][] = (() => {
  const p: number[][] = [];
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++)
      for (let b = 0; b < 6; b++)
        p.push([r * 51, g * 51, b * 51]);
  for (let i = 0; i < 40; i++) {
    const v = Math.round((i / 39) * 255);
    p.push([v, v, v]);
  }
  return p; // 256 entries
})();

function nearest(r: number, g: number, b: number) {
  const ri = Math.round(r / 51), gi = Math.round(g / 51), bi = Math.round(b / 51);
  return ri * 36 + gi * 6 + bi;
}

class ByteBuf {
  bytes: number[] = [];
  u8(v: number) { this.bytes.push(v & 0xff); }
  u16(v: number) { this.u8(v); this.u8(v >> 8); }
  str(s: string) { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); }
  raw(a: number[]) { for (const v of a) this.u8(v); }
}

function lzwEncode(indices: Uint8Array, out: ByteBuf) {
  const minCode = 8;
  const clear = 1 << minCode;
  const eoi = clear + 1;
  let codeSize = minCode + 1;
  let dict = new Map<string, number>();
  let next = eoi + 1;
  const reset = () => { dict = new Map(); next = eoi + 1; codeSize = minCode + 1; };

  const chunk: number[] = [];
  let cur = 0, curBits = 0;
  const emit = (code: number) => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) { chunk.push(cur & 0xff); cur >>= 8; curBits -= 8; }
  };

  out.u8(minCode);
  reset();
  emit(clear);
  let prefix = "" + indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const combo = prefix + "," + k;
    if (dict.has(combo)) { prefix = combo; continue; }
    emit(prefix.includes(",") ? dict.get(prefix)! : +prefix);
    dict.set(combo, next++);
    if (next > (1 << codeSize)) {
      if (codeSize < 12) codeSize++;
      else { emit(clear); reset(); }
    }
    prefix = "" + k;
  }
  emit(prefix.includes(",") ? dict.get(prefix)! : +prefix);
  emit(eoi);
  if (curBits > 0) chunk.push(cur & 0xff);

  for (let i = 0; i < chunk.length; i += 255) {
    const slice = chunk.slice(i, i + 255);
    out.u8(slice.length);
    out.raw(slice);
  }
  out.u8(0);
}

export interface GifFrameInput {
  data: Uint8ClampedArray; // RGBA
  delayMs: number;
}

export function encodeGif(width: number, height: number, frames: GifFrameInput[], loop = true): Blob {
  const buf = new ByteBuf();
  buf.str("GIF89a");
  buf.u16(width); buf.u16(height);
  buf.u8(0xf7); // global color table, 256 entries
  buf.u8(0); buf.u8(0);
  for (const c of PALETTE) buf.raw(c);

  if (loop) {
    buf.u8(0x21); buf.u8(0xff); buf.u8(11);
    buf.str("NETSCAPE2.0");
    buf.u8(3); buf.u8(1); buf.u16(0); buf.u8(0);
  }

  for (const f of frames) {
    const delay = Math.max(2, Math.round(f.delayMs / 10));
    buf.u8(0x21); buf.u8(0xf9); buf.u8(4);
    buf.u8(0x04); // no transparency, restore-to-bg
    buf.u16(delay);
    buf.u8(0); buf.u8(0);

    buf.u8(0x2c);
    buf.u16(0); buf.u16(0); buf.u16(width); buf.u16(height);
    buf.u8(0);

    const n = width * height;
    const idx = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      idx[i] = nearest(f.data[i * 4], f.data[i * 4 + 1], f.data[i * 4 + 2]);
    }
    lzwEncode(idx, buf);
  }

  buf.u8(0x3b);
  return new Blob([new Uint8Array(buf.bytes)], { type: "image/gif" });
}
