/**
 * TOONVO video export — MediaRecorder based MP4/WebM encoder.
 * Real-time capture of an offscreen canvas stream, optional mixed audio,
 * optional moving watermark. Works fully offline.
 */
import { drawWatermark } from "./watermark";

export type CanvasFormat = "horizontal" | "vertical" | "square" | "custom";

export interface ExportLayerLike {
  visible: boolean;
  opacity: number;
  blend: string;
  canvas: CanvasImageSource;
}
export interface ExportFrameLike {
  duration: number;
  bg: string | null;
  layers: ExportLayerLike[];
}
export interface ExportAudioLike {
  src: string;
  volume: number;
  muted: boolean;
  solo: boolean;
  offsetFrames: number;
  trimStart: number;
  trimEnd: number;
  speed: number;
}

export function detectFormat(w: number, h: number): CanvasFormat {
  const r = w / h;
  if (Math.abs(r - 1) < 0.06) return "square";
  if (Math.abs(r - 16 / 9) < 0.12 || r > 1.2) return "horizontal";
  if (Math.abs(r - 9 / 16) < 0.12 || r < 0.85) return "vertical";
  return "custom";
}

export function formatLabel(f: CanvasFormat) {
  if (f === "vertical") return "📱 Shorts/Reels Ready!";
  if (f === "square") return "⬛ Square — Instagram";
  if (f === "horizontal") return "🖥 Horizontal — YouTube";
  return "🎬 Custom format";
}

/** Output pixel size for a resolution preset, preserving the canvas aspect. */
export function outputSize(w: number, h: number, res: 480 | 720 | 1080) {
  const fmt = detectFormat(w, h);
  const shortSide = res;
  let ow: number, oh: number;
  if (fmt === "vertical") {
    ow = shortSide; oh = Math.round((shortSide * h) / w);
  } else if (fmt === "square") {
    ow = shortSide; oh = shortSide;
  } else {
    oh = shortSide; ow = Math.round((shortSide * w) / h);
  }
  // encoders want even dimensions
  ow = Math.max(2, ow - (ow % 2));
  oh = Math.max(2, oh - (oh % 2));
  return { w: ow, h: oh };
}

export function blendToCss(b: string): GlobalCompositeOperation {
  if (b === "add") return "lighter";
  if (b === "normal") return "source-over";
  return b as GlobalCompositeOperation;
}

/** Draw one composited frame into a target context of size ow x oh. */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  frame: ExportFrameLike,
  ow: number,
  oh: number,
  transparent = false,
) {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, ow, oh);
  if (!transparent) {
    ctx.fillStyle = frame.bg ?? "#ffffff";
    ctx.fillRect(0, 0, ow, oh);
  }
  frame.layers.forEach((l) => {
    if (!l.visible) return;
    ctx.globalAlpha = l.opacity;
    ctx.globalCompositeOperation = blendToCss(l.blend);
    ctx.drawImage(l.canvas, 0, 0, ow, oh);
  });
  ctx.restore();
}

export function pickMime(): { mime: string; ext: string; fallback: boolean } {
  const MR = typeof window !== "undefined" ? window.MediaRecorder : undefined;
  const candidates: { mime: string; ext: string; fallback: boolean }[] = [
    { mime: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", ext: "mp4", fallback: false },
    { mime: "video/mp4;codecs=avc1.42E01E", ext: "mp4", fallback: false },
    { mime: "video/mp4", ext: "mp4", fallback: false },
    { mime: "video/webm;codecs=vp9,opus", ext: "webm", fallback: true },
    { mime: "video/webm;codecs=vp8,opus", ext: "webm", fallback: true },
    { mime: "video/webm", ext: "webm", fallback: true },
  ];
  if (!MR) return { mime: "", ext: "mp4", fallback: true };
  for (const c of candidates) {
    try {
      if (MR.isTypeSupported(c.mime)) return c;
    } catch { /* ignore */ }
  }
  return { mime: "", ext: "webm", fallback: true };
}

const BITRATES: Record<"low" | "medium" | "high", number> = {
  low: 1_500_000,
  medium: 4_000_000,
  high: 9_000_000,
};

export interface RenderOptions {
  frames: ExportFrameLike[];
  srcW: number;
  srcH: number;
  outW: number;
  outH: number;
  fps: number;
  quality: "low" | "medium" | "high";
  watermark: boolean;
  audio: ExportAudioLike[];
  onProgress: (frameIndex: number, total: number) => void;
  signal: { cancelled: boolean };
}

export interface RenderResult {
  blob: Blob;
  ext: string;
  fallback: boolean;
}

/**
 * Renders the animation in real time to a video blob.
 */
export async function renderVideo(opts: RenderOptions): Promise<RenderResult> {
  const { frames, outW, outH, fps, quality, watermark, audio, onProgress, signal } = opts;
  if (typeof window === "undefined" || !window.MediaRecorder) {
    throw new Error("MediaRecorder is not supported in this browser.");
  }
  const { mime, ext, fallback } = pickMime();

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d", { alpha: false })!;
  ctx.imageSmoothingQuality = "high";

  const stream = canvas.captureStream(fps);

  // ---- audio mixing ----
  let audioCtx: AudioContext | null = null;
  const activeTracks = audio.filter((t) => !t.muted);
  const soloed = activeTracks.filter((t) => t.solo);
  const mixList = soloed.length ? soloed : activeTracks;
  const sources: AudioBufferSourceNode[] = [];
  if (mixList.length) {
    try {
      audioCtx = new AudioContext();
      const dest = audioCtx.createMediaStreamDestination();
      for (const t of mixList) {
        const buf = await fetch(t.src)
          .then((r) => r.arrayBuffer())
          .then((ab) => audioCtx!.decodeAudioData(ab));
        const src = audioCtx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = t.speed || 1;
        const gain = audioCtx.createGain();
        gain.gain.value = t.volume;
        src.connect(gain).connect(dest);
        sources.push(src);
      }
      dest.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));
    } catch {
      audioCtx = null;
    }
  }

  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream, {
    ...(mime ? { mimeType: mime } : {}),
    videoBitsPerSecond: BITRATES[quality],
  });
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

  const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
  recorder.start(200);

  const startTime = performance.now();
  if (audioCtx) {
    const now = audioCtx.currentTime + 0.05;
    mixList.forEach((t, i) => {
      const offsetSec = (t.offsetFrames || 0) / fps;
      const when = now + Math.max(0, offsetSec);
      const dur = t.trimEnd > 0 ? Math.max(0, t.trimEnd - t.trimStart) : undefined;
      try {
        if (dur !== undefined) sources[i].start(when, t.trimStart, dur);
        else sources[i].start(when, t.trimStart);
      } catch { /* ignore */ }
    });
  }

  // ---- realtime frame pump ----
  const frameDurMs = frames.map((f) => (1000 / fps) * ((f.duration || 100) / 100));
  const starts: number[] = [];
  let acc = 0;
  for (const d of frameDurMs) { starts.push(acc); acc += d; }
  const totalMs = acc;

  await new Promise<void>((resolve) => {
    let last = -1;
    const tick = () => {
      if (signal.cancelled) { resolve(); return; }
      const elapsed = performance.now() - startTime;
      if (elapsed >= totalMs) {
        // draw the final frame once more, then finish
        drawComposite(frames.length - 1, totalMs);
        resolve();
        return;
      }
      let idx = starts.findIndex((s, i) => elapsed >= s && elapsed < s + frameDurMs[i]);
      if (idx < 0) idx = frames.length - 1;
      drawComposite(idx, elapsed);
      if (idx !== last) { last = idx; onProgress(idx + 1, frames.length); }
      requestAnimationFrame(tick);
    };
    const drawComposite = (idx: number, elapsed: number) => {
      const f = frames[idx];
      if (!f) return;
      drawFrame(ctx, f, outW, outH);
      if (watermark) drawWatermark(ctx, outW, outH, { timeMs: elapsed });
    };
    requestAnimationFrame(tick);
  });

  onProgress(frames.length, frames.length);
  try { recorder.stop(); } catch { /* ignore */ }
  await stopped;
  sources.forEach((s) => { try { s.stop(); } catch { /* ignore */ } });
  stream.getTracks().forEach((t) => t.stop());
  if (audioCtx) { try { await audioCtx.close(); } catch { /* ignore */ } }

  if (signal.cancelled) throw new Error("cancelled");

  const blob = new Blob(chunks, { type: mime || "video/webm" });
  return { blob, ext, fallback };
}

export function estimateSize(frames: number, fps: number, quality: "low" | "medium" | "high") {
  const seconds = frames / Math.max(1, fps);
  return (BITRATES[quality] / 8) * seconds;
}

export function humanSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
