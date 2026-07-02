import { useEffect, useRef, useState, useCallback } from "react";
import {
  saveProject,
  listProjects,
  getProject,
  deleteProject,
  type SavedProject,
} from "@/lib/toonvo-db";

// ------------- Types -------------
type BlendMode = "normal" | "multiply" | "screen" | "overlay" | "add";
interface Layer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blend: BlendMode;
  canvas: HTMLCanvasElement;
}
interface BgImage {
  src: string;
  fit: "fill" | "fit" | "stretch";
  opacity: number;
}
interface Frame {
  duration: number;
  layers: Layer[];
  activeLayer: number;
  bg: string | null; // null = transparent
  bgImage?: BgImage | null;
}
interface RefImage {
  id: string;
  src: string;
  x: number; y: number; w: number; h: number;
  opacity: number;
  flipH: boolean; flipV: boolean;
  minimized: boolean;
  zoom: number;
}
interface AudioTrack {
  id: string;
  name: string;
  src: string;
  volume: number;
  muted: boolean;
  solo: boolean;
  offsetFrames: number;
  trimStart: number;
  trimEnd: number; // 0 = end of file
  loop: boolean;
  speed: number;
  color: string;
  duration: number;
}
type Tool =
  | "pen" | "pencil" | "brush" | "marker" | "airbrush" | "ink" | "crayon" | "charcoal"
  | "eraserHard" | "eraserSoft" | "eraserStroke"
  | "bucket" | "rect" | "ellipse" | "line" | "polygon" | "star"
  | "select" | "lasso" | "move" | "eyedropper";

const TOOL_GROUPS: { title: string; tools: { id: Tool; label: string; key?: string; icon: string }[] }[] = [
  { title: "Stroke", tools: [
    { id: "pen", label: "Pen", key: "P", icon: "✒️" },
    { id: "pencil", label: "Pencil", key: "N", icon: "✏️" },
    { id: "brush", label: "Brush", key: "B", icon: "🖌️" },
    { id: "marker", label: "Marker", key: "M", icon: "🖍️" },
    { id: "airbrush", label: "Airbrush", key: "A", icon: "💨" },
    { id: "ink", label: "Ink Pen", key: "I", icon: "🖋️" },
    { id: "crayon", label: "Crayon", key: "C", icon: "🟧" },
    { id: "charcoal", label: "Charcoal", key: "H", icon: "⚫" },
  ]},
  { title: "Eraser", tools: [
    { id: "eraserHard", label: "Hard Eraser", key: "E", icon: "🧽" },
    { id: "eraserSoft", label: "Soft Eraser", icon: "🌫️" },
    { id: "eraserStroke", label: "Stroke Eraser", icon: "❌" },
  ]},
  { title: "Fill", tools: [
    { id: "bucket", label: "Bucket", key: "G", icon: "🪣" },
  ]},
  { title: "Shapes", tools: [
    { id: "rect", label: "Rectangle", key: "R", icon: "▭" },
    { id: "ellipse", label: "Ellipse", key: "O", icon: "◯" },
    { id: "line", label: "Line", key: "L", icon: "／" },
    { id: "polygon", label: "Polygon", icon: "⬡" },
    { id: "star", label: "Star", icon: "★" },
  ]},
  { title: "Transform", tools: [
    { id: "select", label: "Select", key: "S", icon: "⬚" },
    { id: "lasso", label: "Lasso", icon: "🪢" },
    { id: "move", label: "Pan", key: "V", icon: "✥" },
    { id: "eyedropper", label: "Eyedropper", icon: "💧" },
  ]},
];

const PALETTES: Record<string, string[]> = {
  Basic: ["#000000","#ffffff","#ff0000","#00ff00","#0000ff","#ffff00","#ff00ff","#00ffff","#ff8800","#888888"],
  Skin: ["#ffdbac","#f1c27d","#e0ac69","#c68642","#8d5524","#5c3317","#3b1f0f","#ffe0bd","#d1a17a","#a06840"],
  Pastel: ["#ffd1dc","#ffe5b4","#fdfd96","#bff3a3","#aec6cf","#cfcfff","#e0bbff","#ffb7ce","#c1f0c1","#ffe0e9"],
  Neon: ["#ff00aa","#00ffea","#bfff00","#ff5500","#a200ff","#00ff66","#ffea00","#ff007f","#00b3ff","#ff3300"],
  Anime: ["#1a1a2e","#16213e","#0f3460","#e94560","#f5f5f5","#ffb6c1","#ffd700","#9370db","#40e0d0","#ff6347"],
  Nature: ["#2d5016","#4a7c2c","#8fbf3c","#cde85c","#8b4513","#a0522d","#deb887","#87ceeb","#4682b4","#191970"],
};

// ------------- Helpers -------------
const uid = () => Math.random().toString(36).slice(2, 10);

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

function makeLayer(w: number, h: number, name: string): Layer {
  return { id: uid(), name, visible: true, locked: false, opacity: 1, blend: "normal", canvas: makeCanvas(w, h) };
}

function makeFrame(w: number, h: number, bg: string | null = "#ffffff"): Frame {
  return { duration: 100, layers: [makeLayer(w, h, "Layer 1")], activeLayer: 0, bg, bgImage: null };
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHex(r: number, g: number, b: number) {
  return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}

function blendCss(b: BlendMode): GlobalCompositeOperation {
  if (b === "add") return "lighter";
  if (b === "normal") return "source-over";
  return b as GlobalCompositeOperation;
}

// Flood fill
function floodFill(canvas: HTMLCanvasElement, x: number, y: number, hex: string) {
  const ctx = canvas.getContext("2d")!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = img.data;
  const w = canvas.width, h = canvas.height;
  x = Math.floor(x); y = Math.floor(y);
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const idx = (y * w + x) * 4;
  const tr = data[idx], tg = data[idx + 1], tb = data[idx + 2], ta = data[idx + 3];
  const [nr, ng, nb] = hexToRgb(hex);
  if (tr === nr && tg === ng && tb === nb && ta === 255) return;
  const stack: number[] = [x, y];
  const tol = 20;
  while (stack.length) {
    const py = stack.pop()!; const px = stack.pop()!;
    if (px < 0 || py < 0 || px >= w || py >= h) continue;
    const i = (py * w + px) * 4;
    const dr = data[i] - tr, dg = data[i + 1] - tg, db = data[i + 2] - tb, da = data[i + 3] - ta;
    if (dr * dr + dg * dg + db * db + da * da > tol * tol) continue;
    if (data[i] === nr && data[i + 1] === ng && data[i + 2] === nb && data[i + 3] === 255) continue;
    data[i] = nr; data[i + 1] = ng; data[i + 2] = nb; data[i + 3] = 255;
    stack.push(px + 1, py, px - 1, py, px, py + 1, px, py - 1);
  }
  ctx.putImageData(img, 0, 0);
}

// ------------- Component -------------
export default function ToonvoEditor() {
  const [showNew, setShowNew] = useState(true);
  const [showProjects, setShowProjects] = useState(false);
  const [savedList, setSavedList] = useState<SavedProject[]>([]);

  const [projectId, setProjectId] = useState<string>(uid());
  const [projectName, setProjectName] = useState("Untitled");
  const [dims, setDims] = useState({ w: 1920, h: 1080 });
  const [fps, setFps] = useState(12);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [currentFrame, setCurrentFrame] = useState(0);

  const [tool, setTool] = useState<Tool>("brush");
  const [color, setColor] = useState("#ffffff");
  const [bgColor, setBgColor] = useState("#000000");
  const [size, setSize] = useState(8);
  const [opacity, setOpacity] = useState(1);
  const [smoothing, setSmoothing] = useState(3);
  const [hardness, setHardness] = useState(0.8);
  const [flow, setFlow] = useState(1);
  const [recentColors, setRecentColors] = useState<string[]>([]);
  const [shapeStyle, setShapeStyle] = useState<"fill" | "stroke" | "both">("stroke");
  const [shapeFill, setShapeFill] = useState("#6c63ff");
  const [cornerRadius, setCornerRadius] = useState(0);
  const [polygonSides, setPolygonSides] = useState(6);
  const [starPoints, setStarPoints] = useState(5);
  const [starInnerRatio, setStarInnerRatio] = useState(0.5);

  const [onion, setOnion] = useState(false);
  const [onionBefore, setOnionBefore] = useState(1);
  const [onionAfter, setOnionAfter] = useState(1);
  const [onionOpacity, setOnionOpacity] = useState(0.35);

  const [showGrid, setShowGrid] = useState(false);
  const [symmetry, setSymmetry] = useState<"none" | "h" | "v" | "both">("none");

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [fitOnce, setFitOnce] = useState(0);

  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);

  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const [history, setHistory] = useState<{ frame: number; layer: number; image: ImageData; label: string }[]>([]);
  const [redoStack, setRedoStack] = useState<{ frame: number; layer: number; image: ImageData; label: string }[]>([]);
  const [historyLabels, setHistoryLabels] = useState<string[]>([]);

  const [online, setOnline] = useState(true);
  const [installPrompt, setInstallPrompt] = useState<any>(null);

  const [cursorPos, setCursorPos] = useState<{ x: number; y: number; visible: boolean }>({ x: 0, y: 0, visible: false });
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showBgPicker, setShowBgPicker] = useState(false);
  const [alpha, setAlpha] = useState(1);

  // Reference images (up to 3 floating panels)
  const [refImages, setRefImages] = useState<RefImage[]>([]);
  // Audio tracks (up to 3)
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
  const [selectedAudio, setSelectedAudio] = useState<string | null>(null);

  const spaceDownRef = useRef(false);
  const [spaceDown, setSpaceDown] = useState(false);
  const panModeRef = useRef(false);
  const saveNowRef = useRef<(() => void) | null>(null);
  const bgImgCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const audioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const bgFileRef = useRef<HTMLInputElement>(null);
  const refFileRef = useRef<HTMLInputElement>(null);
  const audioFileRef = useRef<HTMLInputElement>(null);

  const displayRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef({ cssW: 0, cssH: 0, dpr: 1, scale: 1, offX: 0, offY: 0 });
  const drawingRef = useRef<{
    active: boolean; lastX: number; lastY: number; startX: number; startY: number;
    snapshot?: ImageData; pts: { x: number; y: number; p: number }[];
    curX?: number; curY?: number; shift?: boolean; alt?: boolean;
  }>({ active: false, lastX: 0, lastY: 0, startX: 0, startY: 0, pts: [] });
  const airbrushTimerRef = useRef<number | null>(null);

  const framesRef = useRef(frames);
  const currentRef = useRef(currentFrame);
  framesRef.current = frames;
  currentRef.current = currentFrame;

  // ------------- Init / lifecycle -------------
  useEffect(() => {
    if (typeof window === "undefined") return;
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    setOnline(navigator.onLine);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    const bip = (e: Event) => { e.preventDefault(); setInstallPrompt(e); };
    window.addEventListener("beforeinstallprompt", bip);
    if ("serviceWorker" in navigator && location.protocol !== "blob:") {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      window.removeEventListener("beforeinstallprompt", bip);
    };
  }, []);

  // Composite render (DPR aware, all math in CSS pixels)
  const render = useCallback(() => {
    const disp = displayRef.current;
    const cont = containerRef.current;
    if (!disp || !cont || frames.length === 0) return;
    const ctx = disp.getContext("2d")!;
    const r = cont.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(100, r.width);
    const cssH = Math.max(100, r.height);
    const pw = Math.round(cssW * dpr);
    const ph = Math.round(cssH * dpr);
    if (disp.width !== pw) disp.width = pw;
    if (disp.height !== ph) disp.height = ph;
    disp.style.width = cssW + "px";
    disp.style.height = cssH + "px";

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#0a0a14";
    ctx.fillRect(0, 0, pw, ph);

    const fitScale = Math.min(cssW / dims.w, cssH / dims.h);
    const scale = fitScale * zoom;
    const offX = (cssW - dims.w * scale) / 2 + pan.x;
    const offY = (cssH - dims.h * scale) / 2 + pan.y;
    viewRef.current = { cssW, cssH, dpr, scale, offX, offY };

    // Set transform: CSS px -> device px, then translate+scale to canvas-local px
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, offX * dpr, offY * dpr);

    // Background (per-frame)
    const cur = frames[currentFrame];
    if (cur) {
      if (cur.bg) {
        ctx.fillStyle = cur.bg;
        ctx.fillRect(0, 0, dims.w, dims.h);
      } else {
        // transparent checker
        const s = 16;
        for (let yy = 0; yy < dims.h; yy += s) {
          for (let xx = 0; xx < dims.w; xx += s) {
            ctx.fillStyle = ((xx / s + yy / s) & 1) ? "#bfbfbf" : "#ffffff";
            ctx.fillRect(xx, yy, s, s);
          }
        }
      }
      // Background image (per-frame, locked behind layers)
      if (cur.bgImage && cur.bgImage.src) {
        const cache = bgImgCacheRef.current;
        let img = cache.get(cur.bgImage.src);
        if (!img) {
          img = new Image();
          img.onload = () => render();
          img.src = cur.bgImage.src;
          cache.set(cur.bgImage.src, img);
        }
        if (img.complete && img.naturalWidth > 0) {
          ctx.save();
          ctx.globalAlpha = cur.bgImage.opacity;
          const iw = img.naturalWidth, ih = img.naturalHeight;
          const cw = dims.w, ch = dims.h;
          if (cur.bgImage.fit === "stretch") {
            ctx.drawImage(img, 0, 0, cw, ch);
          } else if (cur.bgImage.fit === "fill") {
            const s = Math.max(cw / iw, ch / ih);
            const dw = iw * s, dh = ih * s;
            ctx.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
          } else {
            const s = Math.min(cw / iw, ch / ih);
            const dw = iw * s, dh = ih * s;
            ctx.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
          }
          ctx.restore();
        }
      }
    }

    if (onion) {
      for (let i = 1; i <= onionBefore; i++) {
        const f = frames[currentFrame - i];
        if (!f) break;
        ctx.globalAlpha = onionOpacity * (1 - (i - 1) * 0.2);
        const tmp = makeCanvas(dims.w, dims.h);
        const tctx = tmp.getContext("2d")!;
        f.layers.forEach((l) => {
          if (!l.visible) return;
          tctx.globalAlpha = l.opacity;
          tctx.globalCompositeOperation = blendCss(l.blend);
          tctx.drawImage(l.canvas, 0, 0);
        });
        tctx.globalCompositeOperation = "source-in";
        tctx.fillStyle = "#ff3333";
        tctx.fillRect(0, 0, dims.w, dims.h);
        ctx.drawImage(tmp, 0, 0);
      }
      for (let i = 1; i <= onionAfter; i++) {
        const f = frames[currentFrame + i];
        if (!f) break;
        ctx.globalAlpha = onionOpacity * (1 - (i - 1) * 0.2);
        const tmp = makeCanvas(dims.w, dims.h);
        const tctx = tmp.getContext("2d")!;
        f.layers.forEach((l) => {
          if (!l.visible) return;
          tctx.globalAlpha = l.opacity;
          tctx.globalCompositeOperation = blendCss(l.blend);
          tctx.drawImage(l.canvas, 0, 0);
        });
        tctx.globalCompositeOperation = "source-in";
        tctx.fillStyle = "#33aaff";
        tctx.fillRect(0, 0, dims.w, dims.h);
        ctx.drawImage(tmp, 0, 0);
      }
      ctx.globalAlpha = 1;
    }

    if (cur) {
      cur.layers.forEach((l) => {
        if (!l.visible) return;
        ctx.globalAlpha = l.opacity;
        ctx.globalCompositeOperation = blendCss(l.blend);
        ctx.drawImage(l.canvas, 0, 0);
      });
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    if (showGrid) {
      ctx.strokeStyle = "rgba(255,255,255,0.15)";
      ctx.lineWidth = 1 / scale;
      const step = 64;
      for (let x = 0; x <= dims.w; x += step) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, dims.h); ctx.stroke();
      }
      for (let y = 0; y <= dims.h; y += step) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(dims.w, y); ctx.stroke();
      }
    }

    ctx.strokeStyle = "#6c63ff";
    ctx.lineWidth = 2 / scale;
    ctx.strokeRect(0, 0, dims.w, dims.h);
  }, [frames, currentFrame, dims, zoom, pan, onion, onionBefore, onionAfter, onionOpacity, showGrid]);

  // Resize observer
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const ro = new ResizeObserver(() => render());
    ro.observe(c);
    window.addEventListener("resize", render);
    return () => { ro.disconnect(); window.removeEventListener("resize", render); };
  }, [render]);

  useEffect(() => { render(); }, [render]);

  // Fit canvas to screen helper
  const fitToScreen = useCallback(() => {
    setZoom(1); setPan({ x: 0, y: 0 });
    setFitOnce((n) => n + 1);
  }, []);
  useEffect(() => { if (fitOnce) render(); }, [fitOnce, render]);

  // Build thumbnail for a frame
  const buildThumb = useCallback((idx: number) => {
    const f = framesRef.current[idx];
    if (!f) return;
    const tw = 96, th = Math.round((tw * dims.h) / dims.w);
    const c = makeCanvas(tw, th);
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(0, 0, tw, th);
    f.layers.forEach((l) => {
      if (!l.visible) return;
      ctx.globalAlpha = l.opacity;
      ctx.globalCompositeOperation = blendCss(l.blend);
      ctx.drawImage(l.canvas, 0, 0, tw, th);
    });
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    setThumbs((t) => ({ ...t, [idx]: c.toDataURL("image/png") }));
  }, [dims]);

  // ------------- Project setup -------------
  const startProject = (name: string, w: number, h: number, f: number) => {
    setProjectId(uid());
    setProjectName(name || "Untitled");
    setDims({ w, h });
    setFps(f);
    const frame = makeFrame(w, h);
    setFrames([frame]);
    setCurrentFrame(0);
    setThumbs({});
    setHistory([]); setRedoStack([]); setHistoryLabels([]);
    setShowNew(false);
    setZoom(1); setPan({ x: 0, y: 0 });
    setTimeout(() => buildThumb(0), 50);
  };

  // ------------- History -------------
  const pushHistory = (label: string) => {
    const frame = framesRef.current[currentRef.current];
    if (!frame) return;
    const layer = frame.layers[frame.activeLayer];
    if (!layer) return;
    const ctx = layer.canvas.getContext("2d")!;
    const snap = ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height);
    setHistory((h) => {
      const next = [...h, { frame: currentRef.current, layer: frame.activeLayer, image: snap, label }];
      if (next.length > 50) next.shift();
      return next;
    });
    setRedoStack([]);
    setHistoryLabels((l) => {
      const n = [...l, label];
      if (n.length > 50) n.shift();
      return n;
    });
  };

  const undo = () => {
    setHistory((h) => {
      if (h.length === 0) return h;
      const last = h[h.length - 1];
      const f = framesRef.current[last.frame];
      const l = f?.layers[last.layer];
      if (l) {
        const ctx = l.canvas.getContext("2d")!;
        const cur = ctx.getImageData(0, 0, l.canvas.width, l.canvas.height);
        setRedoStack((r) => [...r, { ...last, image: cur }]);
        ctx.putImageData(last.image, 0, 0);
        render();
        buildThumb(last.frame);
      }
      setHistoryLabels((ls) => ls.slice(0, -1));
      return h.slice(0, -1);
    });
  };
  const redo = () => {
    setRedoStack((r) => {
      if (r.length === 0) return r;
      const last = r[r.length - 1];
      const f = framesRef.current[last.frame];
      const l = f?.layers[last.layer];
      if (l) {
        const ctx = l.canvas.getContext("2d")!;
        const cur = ctx.getImageData(0, 0, l.canvas.width, l.canvas.height);
        setHistory((h) => [...h, { ...last, image: cur }]);
        ctx.putImageData(last.image, 0, 0);
        render();
        buildThumb(last.frame);
      }
      setHistoryLabels((ls) => [...ls, last.label]);
      return r.slice(0, -1);
    });
  };

  // ------------- Coord transform (CSS px -> canvas px) -------------
  const eventToCanvas = (e: { clientX: number; clientY: number }) => {
    const disp = displayRef.current!;
    const rect = disp.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const v = viewRef.current;
    return { x: (px - v.offX) / v.scale, y: (py - v.offY) / v.scale };
  };
  const eventToCss = (e: { clientX: number; clientY: number }) => {
    const disp = displayRef.current!;
    const rect = disp.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const setFrameBg = (bg: string | null) => {
    setFrames((fs) => {
      const copy = fs.slice();
      const f = copy[currentFrame];
      if (!f) return fs;
      copy[currentFrame] = { ...f, bg };
      return copy;
    });
  };

  const updateFrame = (idx: number, patch: Partial<Frame>) => {
    setFrames((fs) => fs.map((f, i) => i === idx ? { ...f, ...patch } : f));
  };
  const updateBgImage = (patch: Partial<BgImage>, all = false) => {
    setFrames((fs) => fs.map((f, i) => {
      if (!all && i !== currentFrame) return f;
      const cur = f.bgImage ?? { src: "", fit: "fill" as const, opacity: 1 };
      return { ...f, bgImage: { ...cur, ...patch } };
    }));
  };
  const importBgImage = (file: File) => {
    const fr = new FileReader();
    fr.onload = () => {
      const src = String(fr.result);
      updateBgImage({ src, fit: "fill", opacity: 1 });
      setTimeout(() => { buildThumb(currentFrame); render(); }, 50);
    };
    fr.readAsDataURL(file);
  };
  const applyBgToAll = () => {
    const cur = frames[currentFrame]?.bgImage;
    if (!cur) return;
    setFrames(fs => fs.map(f => ({ ...f, bgImage: { ...cur } })));
    setTimeout(() => framesRef.current.forEach((_, i) => buildThumb(i)), 50);
  };
  const clearBgImage = () => {
    updateBgImage({ src: "" });
    setFrames(fs => fs.map((f, i) => i === currentFrame ? { ...f, bgImage: null } : f));
    setTimeout(() => buildThumb(currentFrame), 30);
  };

  // Reference images
  const importRefImage = (file: File) => {
    if (refImages.length >= 3) return;
    const fr = new FileReader();
    fr.onload = () => {
      const src = String(fr.result);
      const w = Math.min(300, window.innerWidth - 40);
      const x = Math.max(20, window.innerWidth - w - 320);
      setRefImages(rs => [...rs, {
        id: uid(), src, x, y: 80, w, h: w,
        opacity: 1, flipH: false, flipV: false, minimized: false, zoom: 1,
      }]);
    };
    fr.readAsDataURL(file);
  };
  const updateRefImage = (id: string, patch: Partial<RefImage>) => {
    setRefImages(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r));
  };
  const removeRefImage = (id: string) => setRefImages(rs => rs.filter(r => r.id !== id));

  // Audio
  const TRACK_COLORS = ["#9b6cff", "#3aa7ff", "#43d18d"];
  const importAudio = (file: File) => {
    if (audioTracks.length >= 3) return;
    if (file.size > 50 * 1024 * 1024) { alert("Audio max 50MB"); return; }
    const fr = new FileReader();
    fr.onload = () => {
      const src = String(fr.result);
      const id = uid();
      const audio = new Audio(src);
      audioElsRef.current.set(id, audio);
      audio.addEventListener("loadedmetadata", () => {
        setAudioTracks(ts => ts.map(t => t.id === id ? { ...t, duration: audio.duration } : t));
      });
      const defaults = ["Music", "Voice", "Sound FX"];
      setAudioTracks(ts => [...ts, {
        id, name: defaults[ts.length] || file.name, src,
        volume: 1, muted: false, solo: false,
        offsetFrames: 0, trimStart: 0, trimEnd: 0,
        loop: true, speed: 1,
        color: TRACK_COLORS[ts.length] || "#888",
        duration: 0,
      }]);
      setSelectedAudio(id);
    };
    fr.readAsDataURL(file);
  };
  const updateAudio = (id: string, patch: Partial<AudioTrack>) => {
    setAudioTracks(ts => ts.map(t => t.id === id ? { ...t, ...patch } : t));
  };
  const removeAudio = (id: string) => {
    const a = audioElsRef.current.get(id);
    if (a) { a.pause(); audioElsRef.current.delete(id); }
    setAudioTracks(ts => ts.filter(t => t.id !== id));
    if (selectedAudio === id) setSelectedAudio(null);
  };

  const getToolCursor = (t: Tool, spaceDown: boolean): string => {
    if (spaceDown) return "grab";
    if (t === "move") return "grab";
    if (t === "select") return "crosshair";
    if (t === "eyedropper") return "crosshair";
    return "none";
  };
  const shouldShowBrushCursor = (t: Tool) => {
    return !["move", "select", "eyedropper", "bucket"].includes(t);
  };

  // ------------- Stroke drawing -------------
  const applyStrokeStyle = (ctx: CanvasRenderingContext2D, t: Tool, pressure: number) => {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = opacity * flow;
    ctx.lineWidth = size * (0.5 + pressure * 0.5);
    switch (t) {
      case "pen": ctx.globalAlpha = opacity; break;
      case "pencil": ctx.globalAlpha = opacity * 0.6; break;
      case "brush": ctx.globalAlpha = opacity * (0.4 + hardness * 0.6); break;
      case "marker": ctx.globalAlpha = opacity * 0.5; break;
      case "ink": ctx.lineWidth = size * pressure; break;
      case "crayon": ctx.globalAlpha = opacity * 0.7; break;
      case "charcoal": ctx.globalAlpha = opacity * 0.45; break;
    }
  };

  // Airbrush: single dab using radial gradient. Hardness controls softness of edges.
  const airbrushDab = (ctx: CanvasRenderingContext2D, x: number, y: number) => {
    const r = Math.max(2, size);
    const [cr, cg, cb] = hexToRgb(color);
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    // Higher hardness = sharper center. Convert to inner solid stop.
    const inner = Math.min(0.95, hardness * 0.9);
    const centerAlpha = Math.max(0.02, opacity * flow * 0.6);
    grad.addColorStop(0, `rgba(${cr},${cg},${cb},${centerAlpha})`);
    grad.addColorStop(inner, `rgba(${cr},${cg},${cb},${centerAlpha * 0.6})`);
    grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  const drawStrokeSegment = (
    ctx: CanvasRenderingContext2D, t: Tool, x0: number, y0: number, x1: number, y1: number, pressure: number
  ) => {
    applyStrokeStyle(ctx, t, pressure);
    if (t === "airbrush") {
      const dx = x1 - x0, dy = y1 - y0;
      const d = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.ceil(d / Math.max(2, size * 0.25)));
      for (let i = 0; i <= steps; i++) {
        const x = x0 + (dx * i) / steps;
        const y = y0 + (dy * i) / steps;
        airbrushDab(ctx, x, y);
      }
      return;
    }
    if (t === "pencil" || t === "crayon" || t === "charcoal") {
      // textured: draw segment + jitter dots
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      const dx = x1 - x0, dy = y1 - y0;
      const d = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.ceil(d / 3));
      const jitter = t === "charcoal" ? size * 0.4 : size * 0.25;
      for (let i = 0; i < steps; i++) {
        const x = x0 + (dx * i) / steps + (Math.random() - 0.5) * jitter;
        const y = y0 + (dy * i) / steps + (Math.random() - 0.5) * jitter;
        ctx.globalAlpha = opacity * (t === "charcoal" ? 0.25 : 0.4);
        ctx.beginPath();
        ctx.arc(x, y, size * 0.25, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  };

  const drawWithSymmetry = (
    layer: Layer, t: Tool, x0: number, y0: number, x1: number, y1: number, p: number
  ) => {
    const ctx = layer.canvas.getContext("2d")!;
    const cx = dims.w / 2, cy = dims.h / 2;
    const variants: [number, number, number, number][] = [[x0, y0, x1, y1]];
    if (symmetry === "h" || symmetry === "both") variants.push([2 * cx - x0, y0, 2 * cx - x1, y1]);
    if (symmetry === "v" || symmetry === "both") variants.push([x0, 2 * cy - y0, x1, 2 * cy - y1]);
    if (symmetry === "both") variants.push([2 * cx - x0, 2 * cy - y0, 2 * cx - x1, 2 * cy - y1]);
    variants.forEach(([a, b, c, d]) => drawStrokeSegment(ctx, t, a, b, c, d, p));
  };

  // Draw a shape (rect/ellipse/line/polygon/star) with modifiers.
  const drawShape = (
    ctx: CanvasRenderingContext2D,
    t: Tool,
    sx: number, sy: number, ex: number, ey: number,
    shift: boolean, alt: boolean,
  ) => {
    let x0 = sx, y0 = sy, x1 = ex, y1 = ey;
    if (t === "rect" || t === "ellipse") {
      let dx = x1 - x0, dy = y1 - y0;
      if (shift) {
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        dx = Math.sign(dx || 1) * m; dy = Math.sign(dy || 1) * m;
      }
      let rx: number, ry: number, cx: number, cy: number;
      if (alt) { cx = x0; cy = y0; rx = Math.abs(dx); ry = Math.abs(dy); }
      else { cx = x0 + dx / 2; cy = y0 + dy / 2; rx = Math.abs(dx) / 2; ry = Math.abs(dy) / 2; }
      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.lineWidth = Math.max(0, size);
      ctx.lineJoin = "round"; ctx.lineCap = "round";
      ctx.fillStyle = shapeFill; ctx.strokeStyle = color;
      ctx.beginPath();
      if (t === "rect") {
        const rw = rx * 2, rh = ry * 2;
        const r = Math.min(cornerRadius, rw / 2, rh / 2);
        if (r > 0 && (ctx as CanvasRenderingContext2D & { roundRect?: (x: number, y: number, w: number, h: number, r: number) => void }).roundRect) {
          (ctx as CanvasRenderingContext2D & { roundRect: (x: number, y: number, w: number, h: number, r: number) => void }).roundRect(cx - rx, cy - ry, rw, rh, r);
        } else {
          ctx.rect(cx - rx, cy - ry, rw, rh);
        }
      } else {
        ctx.ellipse(cx, cy, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
      }
      if (shapeStyle !== "stroke") ctx.fill();
      if (shapeStyle !== "fill" && size > 0) ctx.stroke();
      ctx.restore();
      return;
    }
    if (t === "line") {
      if (shift) {
        const dx = x1 - x0, dy = y1 - y0;
        const ang = Math.atan2(dy, dx);
        const snap = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        x1 = x0 + Math.cos(snap) * len;
        y1 = y0 + Math.sin(snap) * len;
      }
      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.lineWidth = Math.max(1, size);
      ctx.lineCap = "round"; ctx.strokeStyle = color;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.restore();
      return;
    }
    if (t === "polygon" || t === "star") {
      const cx = alt ? x0 : (x0 + x1) / 2;
      const cy = alt ? y0 : (y0 + y1) / 2;
      const R = alt ? Math.hypot(x1 - x0, y1 - y0) : Math.hypot(x1 - x0, y1 - y0) / 2;
      const baseAng = shift ? -Math.PI / 2 : Math.atan2(y1 - cy, x1 - cx);
      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.lineWidth = Math.max(0, size); ctx.lineJoin = "round";
      ctx.fillStyle = shapeFill; ctx.strokeStyle = color;
      ctx.beginPath();
      if (t === "polygon") {
        const n = Math.max(3, Math.min(20, polygonSides));
        for (let i = 0; i < n; i++) {
          const a = baseAng + (i * Math.PI * 2) / n;
          const px = cx + Math.cos(a) * R, py = cy + Math.sin(a) * R;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
      } else {
        const n = Math.max(3, Math.min(12, starPoints));
        const rInner = R * Math.max(0.1, Math.min(0.95, starInnerRatio));
        for (let i = 0; i < n * 2; i++) {
          const a = baseAng + (i * Math.PI) / n;
          const rr = i % 2 === 0 ? R : rInner;
          const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
      }
      ctx.closePath();
      if (shapeStyle !== "stroke") ctx.fill();
      if (shapeStyle !== "fill" && size > 0) ctx.stroke();
      ctx.restore();
    }
  };

  const isShapeTool = (t: Tool) => t === "rect" || t === "ellipse" || t === "line" || t === "polygon" || t === "star";

  // ------------- Pointer handlers -------------
  const onPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const cssP = eventToCss(e);
    setCursorPos({ x: cssP.x, y: cssP.y, visible: true });

    // Pan: space-hold, middle-mouse, or move tool
    const isPan = spaceDownRef.current || e.button === 1 || tool === "move";
    if (isPan) {
      panModeRef.current = true;
      drawingRef.current = { active: true, lastX: e.clientX, lastY: e.clientY, startX: e.clientX, startY: e.clientY, pts: [] };
      return;
    }

    const { x, y } = eventToCanvas(e);
    const frame = frames[currentFrame];
    if (!frame) return;
    const layer = frame.layers[frame.activeLayer];
    if (!layer) return;

    if (tool === "eyedropper") {
      const ctx = layer.canvas.getContext("2d")!;
      if (x >= 0 && y >= 0 && x < layer.canvas.width && y < layer.canvas.height) {
        const data = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
        if (data[3] > 0) updateColor(rgbToHex(data[0], data[1], data[2]));
      }
      return;
    }
    if (layer.locked) return;

    if (tool === "bucket") {
      pushHistory("Bucket fill");
      floodFill(layer.canvas, x, y, color);
      render(); buildThumb(currentFrame);
      return;
    }
    if (isShapeTool(tool)) {
      pushHistory(tool[0].toUpperCase() + tool.slice(1));
      const ctx = layer.canvas.getContext("2d")!;
      const snapshot = ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height);
      drawingRef.current = { active: true, lastX: x, lastY: y, startX: x, startY: y, curX: x, curY: y, snapshot, pts: [], shift: e.shiftKey, alt: e.altKey };
      return;
    }
    if (tool === "eraserStroke") {
      pushHistory("Erase");
      const ctx = layer.canvas.getContext("2d")!;
      ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
      render(); buildThumb(currentFrame);
      return;
    }

    pushHistory(TOOL_GROUPS.flatMap(g => g.tools).find(t => t.id === tool)?.label ?? tool);
    drawingRef.current = { active: true, lastX: x, lastY: y, startX: x, startY: y, curX: x, curY: y, pts: [{ x, y, p: e.pressure || 0.5 }] };
    const ctx = layer.canvas.getContext("2d")!;
    if (tool === "eraserHard" || tool === "eraserSoft") {
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.globalAlpha = tool === "eraserSoft" ? 0.4 : 1;
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.lineWidth = size;
      ctx.beginPath(); ctx.arc(x, y, size / 2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    } else if (tool === "airbrush") {
      // Immediate dab and start continuous spray timer for stationary hold.
      airbrushDab(ctx, x, y);
      if (airbrushTimerRef.current) window.clearInterval(airbrushTimerRef.current);
      airbrushTimerRef.current = window.setInterval(() => {
        const dd = drawingRef.current;
        if (!dd.active) { if (airbrushTimerRef.current) { window.clearInterval(airbrushTimerRef.current); airbrushTimerRef.current = null; } return; }
        const f = framesRef.current[currentRef.current];
        const l = f?.layers[f.activeLayer];
        if (!l || l.locked) return;
        airbrushDab(l.canvas.getContext("2d")!, dd.curX ?? dd.lastX, dd.curY ?? dd.lastY);
        render();
      }, 30);
    } else {
      drawWithSymmetry(layer, tool, x, y, x + 0.01, y + 0.01, e.pressure || 0.5);
    }
    render();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const cssP = eventToCss(e);
    setCursorPos({ x: cssP.x, y: cssP.y, visible: true });

    const d = drawingRef.current;
    if (!d.active) return;

    if (panModeRef.current) {
      setPan((p) => ({ x: p.x + (e.clientX - d.lastX), y: p.y + (e.clientY - d.lastY) }));
      drawingRef.current.lastX = e.clientX;
      drawingRef.current.lastY = e.clientY;
      return;
    }

    const frame = frames[currentFrame];
    if (!frame) return;
    const layer = frame.layers[frame.activeLayer];
    if (!layer || layer.locked) return;

    const { x, y } = eventToCanvas(e);
    const ctx = layer.canvas.getContext("2d")!;
    drawingRef.current.curX = x; drawingRef.current.curY = y;

    if (isShapeTool(tool)) {
      if (d.snapshot) ctx.putImageData(d.snapshot, 0, 0);
      drawShape(ctx, tool, d.startX, d.startY, x, y, e.shiftKey, e.altKey);
      render();
      return;
    }

    let nx = x, ny = y;
    if (smoothing > 0) {
      const s = smoothing / 10;
      nx = d.lastX + (x - d.lastX) * (1 - s * 0.7);
      ny = d.lastY + (y - d.lastY) * (1 - s * 0.7);
    }

    if (tool === "eraserHard" || tool === "eraserSoft") {
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.globalAlpha = tool === "eraserSoft" ? 0.4 : 1;
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.lineWidth = size;
      ctx.beginPath(); ctx.moveTo(d.lastX, d.lastY); ctx.lineTo(nx, ny); ctx.stroke();
      ctx.restore();
    } else {
      drawWithSymmetry(layer, tool, d.lastX, d.lastY, nx, ny, e.pressure || 0.5);
    }

    drawingRef.current.lastX = nx;
    drawingRef.current.lastY = ny;
    render();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!drawingRef.current.active) return;
    drawingRef.current.active = false;
    panModeRef.current = false;
    if (airbrushTimerRef.current) { window.clearInterval(airbrushTimerRef.current); airbrushTimerRef.current = null; }
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    buildThumb(currentFrame);
    if (color !== recentColors[0]) {
      setRecentColors((r) => [color, ...r.filter(c => c !== color)].slice(0, 20));
    }
  };
  const onPointerLeave = () => setCursorPos((c) => ({ ...c, visible: false }));

  // Wheel zoom centered on cursor
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const cssP = eventToCss(e);
    const v = viewRef.current;
    const factor = (e.ctrlKey ? 1.2 : 1.1);
    const dir = e.deltaY < 0 ? factor : 1 / factor;
    const newZoom = Math.max(0.05, Math.min(20, zoom * dir));
    // Keep canvas point under cursor stationary
    // worldX = (cssP.x - offX)/scale; want worldX same after.
    // newScale = fitScale * newZoom; newOffX = cssP.x - worldX * newScale
    // newPan.x = newOffX - (cssW - dims.w*newScale)/2
    const fitScale = Math.min(v.cssW / dims.w, v.cssH / dims.h);
    const newScale = fitScale * newZoom;
    const worldX = (cssP.x - v.offX) / v.scale;
    const worldY = (cssP.y - v.offY) / v.scale;
    const newOffX = cssP.x - worldX * newScale;
    const newOffY = cssP.y - worldY * newScale;
    setZoom(newZoom);
    setPan({ x: newOffX - (v.cssW - dims.w * newScale) / 2, y: newOffY - (v.cssH - dims.h * newScale) / 2 });
  };

  const updateColor = (c: string) => {
    setColor(c);
  };

  // ------------- Frames -------------
  const addFrame = (copy?: boolean) => {
    setFrames((fs) => {
      const f = copy ? cloneFrame(fs[currentFrame], dims.w, dims.h) : makeFrame(dims.w, dims.h);
      const next = [...fs.slice(0, currentFrame + 1), f, ...fs.slice(currentFrame + 1)];
      setTimeout(() => buildThumb(currentFrame + 1), 30);
      return next;
    });
    setCurrentFrame((c) => c + 1);
  };
  const deleteFrame = (idx: number) => {
    if (frames.length <= 1) return;
    setFrames((fs) => fs.filter((_, i) => i !== idx));
    setCurrentFrame((c) => Math.max(0, c >= idx ? c - 1 : c));
    setThumbs({});
    setTimeout(() => { framesRef.current.forEach((_, i) => buildThumb(i)); }, 30);
  };
  const moveFrame = (from: number, to: number) => {
    if (from === to) return;
    setFrames((fs) => {
      const arr = [...fs];
      const [m] = arr.splice(from, 1);
      arr.splice(to, 0, m);
      return arr;
    });
    setThumbs({});
    setTimeout(() => { framesRef.current.forEach((_, i) => buildThumb(i)); }, 30);
    setCurrentFrame(to);
  };

  // ------------- Layers -------------
  const addLayer = () => {
    setFrames((fs) => fs.map((f, i) => i === currentFrame
      ? { ...f, layers: [...f.layers, makeLayer(dims.w, dims.h, `Layer ${f.layers.length + 1}`)], activeLayer: f.layers.length }
      : f));
  };
  const deleteLayer = (idx: number) => {
    setFrames((fs) => fs.map((f, i) => {
      if (i !== currentFrame) return f;
      if (f.layers.length <= 1) return f;
      const layers = f.layers.filter((_, j) => j !== idx);
      return { ...f, layers, activeLayer: Math.max(0, Math.min(f.activeLayer, layers.length - 1)) };
    }));
    setTimeout(() => buildThumb(currentFrame), 30);
  };
  const duplicateLayer = (idx: number) => {
    setFrames((fs) => fs.map((f, i) => {
      if (i !== currentFrame) return f;
      const src = f.layers[idx];
      const dup = makeLayer(dims.w, dims.h, src.name + " copy");
      dup.opacity = src.opacity; dup.blend = src.blend; dup.visible = src.visible;
      dup.canvas.getContext("2d")!.drawImage(src.canvas, 0, 0);
      const layers = [...f.layers.slice(0, idx + 1), dup, ...f.layers.slice(idx + 1)];
      return { ...f, layers, activeLayer: idx + 1 };
    }));
    setTimeout(() => buildThumb(currentFrame), 30);
  };
  const updateLayer = (idx: number, patch: Partial<Layer>) => {
    setFrames((fs) => fs.map((f, i) => i === currentFrame
      ? { ...f, layers: f.layers.map((l, j) => j === idx ? { ...l, ...patch } : l) }
      : f));
    setTimeout(() => buildThumb(currentFrame), 30);
  };

  // ------------- Playback -------------
  useEffect(() => {
    if (!playing) return;
    const interval = setInterval(() => {
      setCurrentFrame((c) => {
        const next = c + 1;
        if (next >= framesRef.current.length) {
          if (loop) return 0;
          setPlaying(false);
          return c;
        }
        return next;
      });
    }, 1000 / fps);
    return () => clearInterval(interval);
  }, [playing, fps, loop]);

  // Audio playback sync
  useEffect(() => {
    const anySolo = audioTracks.some(t => t.solo);
    audioTracks.forEach(t => {
      const a = audioElsRef.current.get(t.id);
      if (!a) return;
      const audible = !t.muted && (!anySolo || t.solo);
      a.volume = audible ? t.volume : 0;
      a.loop = t.loop;
      a.playbackRate = t.speed;
      if (playing) {
        const frameTime = currentRef.current / fps;
        const offsetSec = t.offsetFrames / fps;
        const target = Math.max(t.trimStart, frameTime - offsetSec + t.trimStart);
        if (frameTime >= offsetSec) {
          if (Math.abs(a.currentTime - target) > 0.15) {
            try { a.currentTime = target; } catch {}
          }
          a.play().catch(() => {});
        } else {
          a.pause();
        }
      } else {
        a.pause();
      }
    });
    return () => {
      if (!playing) audioTracks.forEach(t => {
        const a = audioElsRef.current.get(t.id);
        if (a) a.pause();
      });
    };
  }, [playing, audioTracks, fps]);

  // Stop audio when scrubbing (re-sync handled in next play)
  useEffect(() => {
    if (!playing) return;
    audioTracks.forEach(t => {
      const a = audioElsRef.current.get(t.id);
      if (!a) return;
      const frameTime = currentFrame / fps;
      const offsetSec = t.offsetFrames / fps;
      if (frameTime < offsetSec) { a.pause(); return; }
      const target = frameTime - offsetSec + t.trimStart;
      if (Math.abs(a.currentTime - target) > 0.3) {
        try { a.currentTime = target; } catch {}
      }
    });
  }, [currentFrame, playing, audioTracks, fps]);


  // ------------- Keyboard -------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      const inField = tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA");
      if (e.key === " " && !inField) { e.preventDefault(); if (!spaceDownRef.current) { spaceDownRef.current = true; setSpaceDown(true); } return; }
      if (inField) return;
      if (e.ctrlKey || e.metaKey) {
        if (e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
        if (e.key === "y" || (e.key === "z" && e.shiftKey)) { e.preventDefault(); redo(); return; }
        if (e.key === "s") { e.preventDefault(); saveNowRef.current?.(); return; }
        if (e.key === "n") { e.preventDefault(); setShowNew(true); return; }
        if (e.key === "=" || e.key === "+") { e.preventDefault(); setZoom(z => Math.min(20, z * 1.2)); return; }
        if (e.key === "-" || e.key === "_") { e.preventDefault(); setZoom(z => Math.max(0.05, z / 1.2)); return; }
        if (e.key === "0") { e.preventDefault(); setZoom(1); setPan({ x: 0, y: 0 }); return; }
        if (e.key === "f" && e.shiftKey) { e.preventDefault(); fitToScreen(); return; }
        return;
      }
      const k = e.key.toLowerCase();
      const map: Record<string, Tool> = {
        p: "pen", n: "pencil", b: "brush", m: "marker", a: "airbrush", i: "ink", c: "crayon", h: "charcoal",
        e: "eraserHard", g: "bucket", r: "rect", o: "ellipse", l: "line", s: "select", v: "move",
      };
      if (map[k]) { setTool(map[k]); return; }
      if (e.key === "[") setSize(s => Math.max(1, s - 2));
      if (e.key === "]") setSize(s => Math.min(200, s + 2));
      if (e.altKey) setTool("eyedropper");
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === " ") { spaceDownRef.current = false; setSpaceDown(false); }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onKeyUp); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // ------------- Persistence -------------
  const serialize = useCallback((): SavedProject => {
    const base: SavedProject = {
      id: projectId,
      name: projectName,
      width: dims.w, height: dims.h, fps,
      frames: framesRef.current.map(f => ({
        duration: f.duration,
        layers: f.layers.map(l => ({
          id: l.id, name: l.name, visible: l.visible, locked: l.locked,
          opacity: l.opacity, blend: l.blend, data: l.canvas.toDataURL("image/png"),
        })),
      })),
      thumbnail: thumbs[0] || "",
      updatedAt: Date.now(),
    };
    // Extra (untyped) persistence for bg / audio
    framesRef.current.forEach((f, i) => {
      (base.frames[i] as unknown as { bg?: string | null; bgImage?: BgImage | null }).bg = f.bg;
      (base.frames[i] as unknown as { bg?: string | null; bgImage?: BgImage | null }).bgImage = f.bgImage ?? null;
    });
    (base as unknown as { audioTracks?: AudioTrack[] }).audioTracks = audioTracks;
    return base;
  }, [projectId, projectName, dims, fps, thumbs, audioTracks]);

  const saveNow = useCallback(async () => {
    if (framesRef.current.length === 0) return;
    try { await saveProject(serialize()); } catch (e) { console.error(e); }
  }, [serialize]);
  saveNowRef.current = saveNow;

  useEffect(() => {
    if (frames.length === 0) return;
    const t = setInterval(saveNow, 30000);
    return () => clearInterval(t);
  }, [frames.length, saveNow]);

  const loadProject = async (id: string) => {
    const p = await getProject(id);
    if (!p) return;
    setProjectId(p.id);
    setProjectName(p.name);
    setDims({ w: p.width, h: p.height });
    setFps(p.fps);
    const loaded: Frame[] = [];
    for (const f of p.frames) {
      const layers: Layer[] = [];
      for (const l of f.layers) {
        const layer = makeLayer(p.width, p.height, l.name);
        layer.id = l.id; layer.visible = l.visible; layer.locked = l.locked;
        layer.opacity = l.opacity; layer.blend = l.blend as BlendMode;
        await new Promise<void>((res) => {
          const img = new Image();
          img.onload = () => { layer.canvas.getContext("2d")!.drawImage(img, 0, 0); res(); };
          img.onerror = () => res();
          img.src = l.data;
        });
        layers.push(layer);
      }
      const ext = f as { bg?: string | null; bgImage?: BgImage | null };
      loaded.push({ duration: f.duration, layers, activeLayer: 0, bg: ext.bg ?? "#ffffff", bgImage: ext.bgImage ?? null });
    }
    setFrames(loaded);
    setCurrentFrame(0);
    setShowProjects(false); setShowNew(false);
    setThumbs({});
    // Restore audio tracks
    const at = (p as unknown as { audioTracks?: AudioTrack[] }).audioTracks;
    if (at && Array.isArray(at)) {
      audioElsRef.current.forEach(a => a.pause());
      audioElsRef.current.clear();
      at.forEach(t => audioElsRef.current.set(t.id, new Audio(t.src)));
      setAudioTracks(at);
    } else {
      setAudioTracks([]);
    }
    setRefImages([]);
    setTimeout(() => loaded.forEach((_, i) => buildThumb(i)), 50);
  };

  const exportToonvo = () => {
    const data = serialize();
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${data.name}.toonvo`;
    a.click();
  };

  // ------------- UI -------------
  const frame = frames[currentFrame];
  const layer = frame?.layers[frame.activeLayer];

  return (
    <div className="toonvo">
      {/* Top bar */}
      <header className="topbar">
        <div className="brand">
          <span className="logo">●</span> TOONVO
        </div>
        <div className="filemenu">
          <button onClick={() => setShowNew(true)}>New</button>
          <button onClick={async () => { setSavedList(await listProjects()); setShowProjects(true); }}>Open</button>
          <button onClick={saveNow}>Save</button>
          <button onClick={exportToonvo}>Export</button>
          <button onClick={() => bgFileRef.current?.click()} title="Import Background Image">🖼️＋ BG</button>
          <button onClick={() => refFileRef.current?.click()} title="Import Reference Image" disabled={refImages.length >= 3}>👁 Ref</button>
          <button onClick={() => audioFileRef.current?.click()} title="Import Audio" disabled={audioTracks.length >= 3}>🎵 Audio</button>
          <input ref={bgFileRef} type="file" accept="image/jpeg,image/jpg,image/png,image/webp,image/gif" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) importBgImage(f); e.target.value = ""; }} />
          <input ref={refFileRef} type="file" accept="image/jpeg,image/jpg,image/png,image/webp" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) importRefImage(f); e.target.value = ""; }} />
          <input ref={audioFileRef} type="file" accept="audio/mpeg,audio/mp3,audio/wav,audio/aac,audio/ogg,audio/mp4,audio/x-m4a,.m4a" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) importAudio(f); e.target.value = ""; }} />
        </div>
        <div className="toolopts">
          {["pen","pencil","brush","marker","airbrush","ink","crayon","charcoal","eraserHard","eraserSoft"].includes(tool) && (
            <>
              <label>Size <input type="range" min={1} max={200} value={size} onChange={e => setSize(+e.target.value)} /><input className="num" type="number" value={size} onChange={e => setSize(+e.target.value)} /></label>
              <label>Opacity <input type="range" min={0} max={100} value={Math.round(opacity*100)} onChange={e => setOpacity(+e.target.value/100)} /></label>
              <label>Smooth <input type="range" min={0} max={10} value={smoothing} onChange={e => setSmoothing(+e.target.value)} /></label>
              <label>Hard <input type="range" min={0} max={100} value={Math.round(hardness*100)} onChange={e => setHardness(+e.target.value/100)} /></label>
              <label>Flow <input type="range" min={0} max={100} value={Math.round(flow*100)} onChange={e => setFlow(+e.target.value/100)} /></label>
            </>
          )}
        </div>
        <div className="topright">
          <span className="dim">{dims.w}×{dims.h} • {fps}fps</span>
          <span className={"netdot " + (online ? "on" : "off")}>{online ? "ONLINE" : "OFFLINE"}</span>
          {installPrompt && <button onClick={async () => { await installPrompt.prompt(); setInstallPrompt(null); }}>Install</button>}
          <button onClick={undo} title="Undo (Ctrl+Z)">↶</button>
          <button onClick={redo} title="Redo (Ctrl+Y)">↷</button>
        </div>
      </header>

      <div className="main">
        {/* Left sidebar tools */}
        <aside className="left">
          {TOOL_GROUPS.map((g) => (
            <div key={g.title} className="toolgroup">
              <div className="grouplabel">{g.title}</div>
              <div className="grouptools">
                {g.tools.map((t) => (
                  <button
                    key={t.id}
                    className={"toolbtn " + (tool === t.id ? "active" : "")}
                    onClick={() => setTool(t.id)}
                    title={t.label + (t.key ? ` (${t.key})` : "")}
                  >
                    <span className="ticon">{t.icon}</span>
                    <span className="tlabel">{t.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="toolgroup">
            <div className="grouplabel">Assist</div>
            <div className="grouptools">
              <button className={"toolbtn " + (onion ? "active" : "")} onClick={() => setOnion(o => !o)}><span className="ticon">👻</span><span className="tlabel">Onion</span></button>
              <button className={"toolbtn " + (showGrid ? "active" : "")} onClick={() => setShowGrid(g => !g)}><span className="ticon">▦</span><span className="tlabel">Grid</span></button>
              <button className={"toolbtn " + (symmetry !== "none" ? "active" : "")} onClick={() => setSymmetry(s => s === "none" ? "h" : s === "h" ? "v" : s === "v" ? "both" : "none")}><span className="ticon">⇋</span><span className="tlabel">Sym:{symmetry}</span></button>
            </div>
          </div>
          {onion && (
            <div className="onionopts">
              <label>Before {onionBefore}<input type="range" min={0} max={3} value={onionBefore} onChange={e => setOnionBefore(+e.target.value)} /></label>
              <label>After {onionAfter}<input type="range" min={0} max={3} value={onionAfter} onChange={e => setOnionAfter(+e.target.value)} /></label>
              <label>Alpha<input type="range" min={5} max={80} value={Math.round(onionOpacity*100)} onChange={e => setOnionOpacity(+e.target.value/100)} /></label>
            </div>
          )}
        </aside>

        {/* Canvas */}
        <div className="center">
          <div ref={containerRef} className="canvasarea" style={{ position: "relative" }}>
            <canvas
              ref={displayRef}
              className="display"
              style={{ touchAction: "none", cursor: getToolCursor(tool, spaceDown) }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onPointerLeave={onPointerLeave}
              onWheel={onWheel}
            />
            {cursorPos.visible && shouldShowBrushCursor(tool) && (
              <div
                style={{
                  position: "absolute", pointerEvents: "none",
                  left: cursorPos.x, top: cursorPos.y,
                  width: Math.max(4, size * viewRef.current.scale),
                  height: Math.max(4, size * viewRef.current.scale),
                  transform: "translate(-50%, -50%)",
                  borderRadius: "50%",
                  border: `1.5px solid ${tool.startsWith("eraser") ? "#ff4d4d" : "#ffffff"}`,
                  boxShadow: "0 0 0 1px #000, inset 0 0 0 1px #000",
                }}
              >
                <div style={{ position: "absolute", left: "50%", top: "50%", width: 2, height: 2, background: "#fff", boxShadow: "0 0 0 1px #000", transform: "translate(-50%,-50%)" }} />
              </div>
            )}
          </div>

          {/* Status bar */}
          <div className="statusbar" style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 10px", background: "#0f0f1c", borderTop: "1px solid #222", fontSize: 12, color: "#aaa" }}>
            <button onClick={() => setZoom(z => Math.max(0.05, z / 1.2))} title="Zoom out">−</button>
            <select value={Math.round(zoom * 100)} onChange={(e) => setZoom(+e.target.value / 100)} style={{ background: "#1a1a2e", color: "#fff", border: "1px solid #333" }}>
              {[5,10,25,50,75,100,125,150,200,400,800,1600,2000].map(z => <option key={z} value={z}>{z}%</option>)}
            </select>
            <button onClick={() => setZoom(z => Math.min(20, z * 1.2))} title="Zoom in">+</button>
            <button onClick={fitToScreen} title="Fit to screen (Ctrl+Shift+F)">⛶ Fit</button>
            <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} title="100% (Ctrl+0)">1:1</button>
            <span style={{ marginLeft: 12 }}>BG:</span>
            <button onClick={() => setFrameBg("#ffffff")} style={{ background: "#fff", width: 22, height: 22, border: "1px solid #444" }} title="White" />
            <button onClick={() => setFrameBg("#000000")} style={{ background: "#000", width: 22, height: 22, border: "1px solid #444" }} title="Black" />
            <button onClick={() => setFrameBg(null)} style={{ background: "repeating-conic-gradient(#ccc 0 25%, #fff 0 50%) 50%/12px 12px", width: 22, height: 22, border: "1px solid #444" }} title="Transparent" />
            <input type="color" onChange={(e) => setFrameBg(e.target.value)} title="Custom bg" style={{ width: 28, height: 22, padding: 0, background: "transparent", border: "1px solid #444" }} />
            <div style={{ flex: 1 }} />
            <span>Tool: {tool}</span>
            <span>Size: {size}</span>
            <span>Zoom: {Math.round(zoom * 100)}%</span>
          </div>


          {/* Audio tracks bars */}
          {audioTracks.length > 0 && (
            <div style={{ background: "#0f0f1c", borderTop: "1px solid #222", padding: "4px 8px", display: "flex", flexDirection: "column", gap: 3 }}>
              {audioTracks.map(t => {
                const totalSec = (frames.length || 1) / fps;
                const audioVisibleSec = Math.min(t.duration || totalSec, totalSec);
                const startPct = Math.max(0, Math.min(100, (t.offsetFrames / fps / totalSec) * 100));
                const widthPct = Math.max(2, Math.min(100 - startPct, (audioVisibleSec / totalSec) * 100));
                return (
                  <div key={t.id} onClick={() => setSelectedAudio(t.id)} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", height: 22 }}>
                    <span style={{ width: 70, fontSize: 10, color: "#aaa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</span>
                    <div style={{ position: "relative", flex: 1, height: 18, background: "#1a1a2e", borderRadius: 3, overflow: "hidden", border: selectedAudio === t.id ? `1px solid ${t.color}` : "1px solid #222" }}>
                      <div style={{ position: "absolute", left: `${startPct}%`, width: `${widthPct}%`, top: 0, bottom: 0, background: `linear-gradient(180deg, ${t.color}aa, ${t.color}55)`, backgroundImage: `repeating-linear-gradient(90deg, ${t.color}cc 0 1px, ${t.color}33 1px 3px)` }} />
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); updateAudio(t.id, { muted: !t.muted }); }} style={{ padding: "2px 6px", fontSize: 10 }} title="Mute">{t.muted ? "🔇" : "🔊"}</button>
                  </div>
                );
              })}
              {selectedAudio && (() => {
                const t = audioTracks.find(x => x.id === selectedAudio);
                if (!t) return null;
                return (
                  <div style={{ background: "#1a1a2e", padding: 8, borderRadius: 4, marginTop: 4, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", fontSize: 11, color: "#bbb" }}>
                    <input value={t.name} onChange={e => updateAudio(t.id, { name: e.target.value })} style={{ width: 90 }} />
                    <label>Vol <input type="range" min={0} max={100} value={Math.round(t.volume * 100)} onChange={e => updateAudio(t.id, { volume: +e.target.value / 100 })} /></label>
                    <label>Speed
                      <select value={t.speed} onChange={e => updateAudio(t.id, { speed: +e.target.value })}>
                        {[0.5, 0.75, 1, 1.25, 1.5, 2].map(s => <option key={s} value={s}>{s}x</option>)}
                      </select>
                    </label>
                    <label>Trim start <input type="number" step="0.1" value={t.trimStart} onChange={e => updateAudio(t.id, { trimStart: +e.target.value })} style={{ width: 50 }} />s</label>
                    <label>Trim end <input type="number" step="0.1" value={t.trimEnd} onChange={e => updateAudio(t.id, { trimEnd: +e.target.value })} style={{ width: 50 }} />s</label>
                    <label>Offset <input type="number" value={t.offsetFrames} onChange={e => updateAudio(t.id, { offsetFrames: +e.target.value })} style={{ width: 50 }} />frames</label>
                    <label><input type="checkbox" checked={t.loop} onChange={e => updateAudio(t.id, { loop: e.target.checked })} /> Loop</label>
                    <button onClick={() => updateAudio(t.id, { solo: !t.solo })} className={t.solo ? "active" : ""}>Solo</button>
                    <span>{t.duration ? `${t.duration.toFixed(1)}s` : ""}</span>
                    <button onClick={() => removeAudio(t.id)}>Remove</button>
                  </div>
                );
              })()}
            </div>
          )}

          {/* Timeline */}
          <div className="timeline">
            <div className="playbar">
              <button onClick={() => setPlaying(p => !p)} title="Play/Pause (Space)">{playing ? "❚❚" : "▶"}</button>
              <button onClick={() => { setPlaying(false); setCurrentFrame(0); }}>■</button>
              <button className={loop ? "active" : ""} onClick={() => setLoop(l => !l)}>↻</button>
              <span className="counter">{currentFrame + 1} / {frames.length}</span>
              <span className="counter">{fps} fps</span>
              <div className="grow" />
              <button onClick={() => addFrame(false)}>+ Frame</button>
              <button onClick={() => addFrame(true)}>Duplicate</button>
              <button onClick={() => deleteFrame(currentFrame)}>Delete</button>
            </div>
            <div className="frames">
              {frames.map((f, i) => (
                <div
                  key={i}
                  className={"frameitem " + (i === currentFrame ? "active" : "")}
                  onClick={() => setCurrentFrame(i)}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/plain", String(i))}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => { e.preventDefault(); moveFrame(+e.dataTransfer.getData("text/plain"), i); }}
                >
                  <div className="thumb" style={{ position: "relative" }}>
                    {thumbs[i] ? <img src={thumbs[i]} alt="" /> : <span>{i + 1}</span>}
                    {f.bgImage?.src && (
                      <img src={f.bgImage.src} alt="" style={{ position: "absolute", left: 2, bottom: 2, width: 18, height: 18, objectFit: "cover", border: "1px solid #6c63ff", borderRadius: 2 }} />
                    )}
                  </div>
                  <div className="finfo">
                    <span>#{i + 1}</span>
                    <input
                      type="number"
                      value={f.duration}
                      onChange={(e) => setFrames(fs => fs.map((x, j) => j === i ? { ...x, duration: +e.target.value } : x))}
                    />ms
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right sidebar */}
        <aside className="right">
          {/* Color */}
          <section className="panel">
            <h3>Color</h3>
            <input type="color" value={color} onChange={(e) => updateColor(e.target.value)} className="bigcolor" />
            <div className="swatches">
              <div className="sw" style={{ background: color }} title="Foreground" />
              <button onClick={() => { const t = color; setColor(bgColor); setBgColor(t); }}>⇄</button>
              <div className="sw" style={{ background: bgColor }} title="Background" onClick={() => setColor(bgColor)} />
            </div>
            <input type="text" className="hex" value={color} onChange={(e) => /^#[0-9a-fA-F]{6}$/.test(e.target.value) && updateColor(e.target.value)} />
            <div className="rgb">
              {(["r","g","b"] as const).map((ch, i) => {
                const rgb = hexToRgb(color);
                return (
                  <label key={ch}>{ch.toUpperCase()}
                    <input type="range" min={0} max={255} value={rgb[i]} onChange={(e) => {
                      const v = +e.target.value; rgb[i] = v; updateColor(rgbToHex(rgb[0], rgb[1], rgb[2]));
                    }} />
                  </label>
                );
              })}
            </div>
            <div className="recent">
              {recentColors.map((c, i) => (
                <div key={i} className="rc" style={{ background: c }} onClick={() => updateColor(c)} />
              ))}
            </div>
            <div className="palettes">
              {Object.entries(PALETTES).map(([name, cols]) => (
                <div key={name} className="pal">
                  <div className="palname">{name}</div>
                  <div className="palrow">
                    {cols.map((c) => <div key={c} className="rc" style={{ background: c }} onClick={() => updateColor(c)} />)}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Layers */}
          <section className="panel">
            <h3>Layers</h3>
            <div className="layeractions">
              <button onClick={addLayer}>+</button>
              <button onClick={() => layer && duplicateLayer(frame.activeLayer)}>⎘</button>
              <button onClick={() => layer && deleteLayer(frame.activeLayer)}>✕</button>
            </div>
            <div className="layerlist">
              {frame?.layers.slice().reverse().map((l) => {
                const idx = frame.layers.indexOf(l);
                const active = idx === frame.activeLayer;
                return (
                  <div key={l.id} className={"layeritem " + (active ? "active" : "")} onClick={() => setFrames(fs => fs.map((f, i) => i === currentFrame ? { ...f, activeLayer: idx } : f))}>
                    <button className="iconbtn" onClick={(e) => { e.stopPropagation(); updateLayer(idx, { visible: !l.visible }); }}>{l.visible ? "👁" : "—"}</button>
                    <button className="iconbtn" onClick={(e) => { e.stopPropagation(); updateLayer(idx, { locked: !l.locked }); }}>{l.locked ? "🔒" : "🔓"}</button>
                    <input
                      className="lname"
                      value={l.name}
                      onChange={(e) => updateLayer(idx, { name: e.target.value })}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <select value={l.blend} onChange={(e) => updateLayer(idx, { blend: e.target.value as BlendMode })} onClick={(e) => e.stopPropagation()}>
                      <option value="normal">Normal</option>
                      <option value="multiply">Multiply</option>
                      <option value="screen">Screen</option>
                      <option value="overlay">Overlay</option>
                      <option value="add">Add</option>
                    </select>
                    <input type="range" min={0} max={100} value={Math.round(l.opacity*100)} onChange={(e) => updateLayer(idx, { opacity: +e.target.value/100 })} onClick={(e) => e.stopPropagation()} />
                  </div>
                );
              })}
            </div>
          </section>

          {/* History */}
          <section className="panel">
            <h3>History ({historyLabels.length})</h3>
            <div className="hist">
              {historyLabels.slice().reverse().slice(0, 20).map((h, i) => (
                <div key={i} className="histitem">{h}</div>
              ))}
            </div>
          </section>

          {/* Background Image */}
          <section className="panel">
            <h3>Background Image</h3>
            {frame?.bgImage?.src ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <img src={frame.bgImage.src} alt="" style={{ width: "100%", maxHeight: 90, objectFit: "contain", background: "#000", borderRadius: 4 }} />
                <div style={{ display: "flex", gap: 4 }}>
                  <button onClick={() => bgFileRef.current?.click()} style={{ flex: 1 }}>Replace</button>
                  <button onClick={clearBgImage} style={{ flex: 1 }}>Remove</button>
                </div>
                <label style={{ fontSize: 11 }}>Opacity
                  <input type="range" min={0} max={100} value={Math.round(frame.bgImage.opacity * 100)} onChange={e => updateBgImage({ opacity: +e.target.value / 100 })} />
                </label>
                <div style={{ display: "flex", gap: 4, fontSize: 11 }}>
                  {(["fill", "fit", "stretch"] as const).map(m => (
                    <button key={m} className={frame.bgImage!.fit === m ? "active" : ""} onClick={() => updateBgImage({ fit: m })} style={{ flex: 1, textTransform: "capitalize" }}>{m}</button>
                  ))}
                </div>
                <button onClick={applyBgToAll} style={{ fontSize: 11 }}>Apply to all frames</button>
              </div>
            ) : (
              <button onClick={() => bgFileRef.current?.click()} style={{ width: "100%" }}>Import Background Image</button>
            )}
          </section>
        </aside>
      </div>

      {/* Floating reference image panels */}
      {refImages.map(r => (
        <ReferencePanel key={r.id} data={r} onChange={(p) => updateRefImage(r.id, p)} onClose={() => removeRefImage(r.id)} />
      ))}

      {/* New Project Modal */}
      {showNew && <NewProjectModal onConfirm={startProject} onCancel={() => frames.length > 0 && setShowNew(false)} hasProject={frames.length > 0} onOpen={async () => { setSavedList(await listProjects()); setShowProjects(true); }} />}
      {showProjects && <ProjectsModal projects={savedList} onLoad={loadProject} onDelete={async (id) => { await deleteProject(id); setSavedList(await listProjects()); }} onClose={() => setShowProjects(false)} />}
    </div>
  );
}

function ReferencePanel({ data, onChange, onClose }: { data: RefImage; onChange: (p: Partial<RefImage>) => void; onClose: () => void }) {
  const dragRef = useRef<{ mode: "move" | "resize"; sx: number; sy: number; x: number; y: number; w: number; h: number } | null>(null);
  const onPointerDown = (mode: "move" | "resize") => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = { mode, sx: e.clientX, sy: e.clientY, x: data.x, y: data.y, w: data.w, h: data.h };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current; if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (d.mode === "move") onChange({ x: d.x + dx, y: d.y + dy });
    else onChange({ w: Math.max(150, Math.min(800, d.w + dx)), h: Math.max(150, Math.min(800, d.h + dy)) });
  };
  const onPointerUp = () => { dragRef.current = null; };

  const headerH = 26;
  const totalH = data.minimized ? headerH : data.h;
  return (
    <div onPointerMove={onPointerMove} onPointerUp={onPointerUp} style={{ position: "fixed", left: data.x, top: data.y, width: data.w, height: totalH, background: "#0f0f1c", border: "1px solid #6c63ff", borderRadius: 6, zIndex: 9999, boxShadow: "0 8px 30px rgba(0,0,0,0.6)", display: "flex", flexDirection: "column", overflow: "hidden", color: "#ddd", fontSize: 11 }}>
      <div onPointerDown={onPointerDown("move")} style={{ height: headerH, background: "#1a1a2e", display: "flex", alignItems: "center", padding: "0 6px", cursor: "move", gap: 4, userSelect: "none" }}>
        <span style={{ flex: 1, fontWeight: 600 }}>Reference Image</span>
        <button onClick={() => onChange({ flipH: !data.flipH })} title="Flip H" style={{ padding: "0 4px" }}>⇋</button>
        <button onClick={() => onChange({ flipV: !data.flipV })} title="Flip V" style={{ padding: "0 4px" }}>⇅</button>
        <button onClick={() => onChange({ zoom: Math.max(0.2, data.zoom - 0.1) })} title="Zoom out" style={{ padding: "0 4px" }}>－</button>
        <button onClick={() => onChange({ zoom: Math.min(5, data.zoom + 0.1) })} title="Zoom in" style={{ padding: "0 4px" }}>＋</button>
        <button onClick={() => onChange({ minimized: !data.minimized })} title="Minimize" style={{ padding: "0 4px" }}>{data.minimized ? "▢" : "─"}</button>
        <button onClick={() => onChange({ w: 600, h: 600, minimized: false })} title="Maximize" style={{ padding: "0 4px" }}>⛶</button>
        <button onClick={onClose} title="Close" style={{ padding: "0 4px" }}>✕</button>
      </div>
      {!data.minimized && (
        <>
          <div style={{ flex: 1, position: "relative", overflow: "hidden", background: "#000" }}>
            <img src={data.src} alt="" style={{ width: "100%", height: "100%", objectFit: "contain", opacity: data.opacity, transform: `scale(${data.zoom * (data.flipH ? -1 : 1)}, ${data.zoom * (data.flipV ? -1 : 1)})`, pointerEvents: "none" }} />
          </div>
          <div style={{ padding: "4px 6px", background: "#15152a", display: "flex", alignItems: "center", gap: 6 }}>
            <span>Opacity</span>
            <input style={{ flex: 1 }} type="range" min={0} max={100} value={Math.round(data.opacity * 100)} onChange={e => onChange({ opacity: +e.target.value / 100 })} />
            <span>{Math.round(data.opacity * 100)}%</span>
          </div>
          <div onPointerDown={onPointerDown("resize")} style={{ position: "absolute", right: 0, bottom: 0, width: 14, height: 14, cursor: "nwse-resize", background: "linear-gradient(135deg, transparent 50%, #6c63ff 50%)" }} />
        </>
      )}
    </div>
  );
}


function cloneFrame(f: Frame, w: number, h: number): Frame {
  return {
    duration: f.duration,
    activeLayer: f.activeLayer,
    bg: f.bg,
    bgImage: f.bgImage ? { ...f.bgImage } : null,
    layers: f.layers.map(l => {
      const c = makeCanvas(w, h);
      c.getContext("2d")!.drawImage(l.canvas, 0, 0);
      return { ...l, id: uid(), canvas: c };
    }),
  };
}

function NewProjectModal({ onConfirm, onCancel, hasProject, onOpen }: {
  onConfirm: (name: string, w: number, h: number, fps: number) => void;
  onCancel: () => void;
  hasProject: boolean;
  onOpen: () => void;
}) {
  const [name, setName] = useState("Untitled");
  const [preset, setPreset] = useState<"16:9" | "9:16" | "1:1" | "custom">("16:9");
  const [cw, setCw] = useState(1920);
  const [ch, setCh] = useState(1080);
  const [fps, setFps] = useState(12);

  const apply = () => {
    let w = cw, h = ch;
    if (preset === "16:9") { w = 1920; h = 1080; }
    else if (preset === "9:16") { w = 1080; h = 1920; }
    else if (preset === "1:1") { w = 1080; h = 1080; }
    onConfirm(name, w, h, fps);
  };

  return (
    <div className="modal">
      <div className="modalbox">
        <h2>New Project</h2>
        <label>Name<input value={name} onChange={e => setName(e.target.value)} /></label>
        <div className="presets">
          {([
            ["16:9", "16:9 Landscape (1920×1080)"],
            ["9:16", "9:16 Portrait (1080×1920)"],
            ["1:1", "1:1 Square (1080×1080)"],
            ["custom", "Custom"],
          ] as const).map(([k, l]) => (
            <button key={k} className={preset === k ? "active" : ""} onClick={() => setPreset(k)}>{l}</button>
          ))}
        </div>
        {preset === "custom" && (
          <div className="customdim">
            <label>Width<input type="number" value={cw} onChange={e => setCw(+e.target.value)} /></label>
            <label>Height<input type="number" value={ch} onChange={e => setCh(+e.target.value)} /></label>
          </div>
        )}
        <label>FPS
          <select value={fps} onChange={e => setFps(+e.target.value)}>
            <option value={8}>8</option>
            <option value={12}>12</option>
            <option value={24}>24</option>
            <option value={30}>30</option>
          </select>
        </label>
        <div className="modalactions">
          <button onClick={onOpen}>My Projects</button>
          {hasProject && <button onClick={onCancel}>Cancel</button>}
          <button className="primary" onClick={apply}>Create</button>
        </div>
      </div>
    </div>
  );
}

function ProjectsModal({ projects, onLoad, onDelete, onClose }: {
  projects: SavedProject[]; onLoad: (id: string) => void; onDelete: (id: string) => void; onClose: () => void;
}) {
  return (
    <div className="modal">
      <div className="modalbox wide">
        <h2>My Projects</h2>
        {projects.length === 0 && <p className="muted">No saved projects yet.</p>}
        <div className="projgrid">
          {projects.map(p => (
            <div key={p.id} className="projcard">
              <div className="projthumb">{p.thumbnail ? <img src={p.thumbnail} alt="" /> : <div className="empty" />}</div>
              <div className="projname">{p.name}</div>
              <div className="projmeta">{p.width}×{p.height} • {p.fps}fps • {p.frames.length} frames</div>
              <div className="projactions">
                <button onClick={() => onLoad(p.id)}>Open</button>
                <button onClick={() => { if (confirm(`Delete "${p.name}"?`)) onDelete(p.id); }}>Delete</button>
              </div>
            </div>
          ))}
        </div>
        <div className="modalactions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
