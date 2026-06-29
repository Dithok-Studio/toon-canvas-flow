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
interface Frame {
  duration: number;
  layers: Layer[];
  activeLayer: number;
  bg: string | null; // null = transparent
}
type Tool =
  | "pen" | "pencil" | "brush" | "marker" | "airbrush" | "ink" | "crayon" | "charcoal"
  | "eraserHard" | "eraserSoft" | "eraserStroke"
  | "bucket" | "rect" | "ellipse" | "line"
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
  { title: "Fill & Shape", tools: [
    { id: "bucket", label: "Bucket", key: "G", icon: "🪣" },
    { id: "rect", label: "Rectangle", key: "R", icon: "▭" },
    { id: "ellipse", label: "Ellipse", key: "O", icon: "◯" },
    { id: "line", label: "Line", key: "L", icon: "／" },
  ]},
  { title: "Transform", tools: [
    { id: "select", label: "Select", key: "S", icon: "⬚" },
    { id: "lasso", label: "Lasso", icon: "🪢" },
    { id: "move", label: "Move/Pan", key: "V", icon: "✥" },
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
  return { duration: 100, layers: [makeLayer(w, h, "Layer 1")], activeLayer: 0, bg };
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

  const spaceDownRef = useRef(false);
  const panModeRef = useRef(false);

  const displayRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef({ cssW: 0, cssH: 0, dpr: 1, scale: 1, offX: 0, offY: 0 });
  const drawingRef = useRef<{
    active: boolean; lastX: number; lastY: number; startX: number; startY: number;
    snapshot?: ImageData; pts: { x: number; y: number; p: number }[];
  }>({ active: false, lastX: 0, lastY: 0, startX: 0, startY: 0, pts: [] });

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

  const drawStrokeSegment = (
    ctx: CanvasRenderingContext2D, t: Tool, x0: number, y0: number, x1: number, y1: number, pressure: number
  ) => {
    applyStrokeStyle(ctx, t, pressure);
    if (t === "airbrush") {
      const dx = x1 - x0, dy = y1 - y0;
      const d = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.ceil(d / 2));
      for (let i = 0; i < steps; i++) {
        const x = x0 + (dx * i) / steps;
        const y = y0 + (dy * i) / steps;
        const r = size;
        for (let k = 0; k < 6; k++) {
          const a = Math.random() * Math.PI * 2;
          const rr = Math.random() * r;
          ctx.globalAlpha = opacity * 0.06 * flow;
          ctx.beginPath();
          ctx.arc(x + Math.cos(a) * rr, y + Math.sin(a) * rr, 1, 0, Math.PI * 2);
          ctx.fill();
        }
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

  // ------------- Pointer handlers -------------
  const onPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const { x, y } = eventToCanvas(e);
    const frame = frames[currentFrame];
    if (!frame) return;
    const layer = frame.layers[frame.activeLayer];
    if (!layer) return;

    if (tool === "eyedropper") {
      const ctx = layer.canvas.getContext("2d")!;
      const data = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
      if (data[3] > 0) updateColor(rgbToHex(data[0], data[1], data[2]));
      return;
    }
    if (tool === "move") {
      drawingRef.current = { active: true, lastX: e.clientX, lastY: e.clientY, startX: e.clientX, startY: e.clientY, pts: [] };
      return;
    }
    if (layer.locked) return;

    if (tool === "bucket") {
      pushHistory("Bucket fill");
      floodFill(layer.canvas, x, y, color);
      render(); buildThumb(currentFrame);
      return;
    }
    if (tool === "rect" || tool === "ellipse" || tool === "line") {
      pushHistory(tool === "rect" ? "Rectangle" : tool === "ellipse" ? "Ellipse" : "Line");
      const ctx = layer.canvas.getContext("2d")!;
      const snapshot = ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height);
      drawingRef.current = { active: true, lastX: x, lastY: y, startX: x, startY: y, snapshot, pts: [] };
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
    drawingRef.current = { active: true, lastX: x, lastY: y, startX: x, startY: y, pts: [{ x, y, p: e.pressure || 0.5 }] };
    const ctx = layer.canvas.getContext("2d")!;
    if (tool === "eraserHard" || tool === "eraserSoft") {
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.globalAlpha = tool === "eraserSoft" ? 0.4 : 1;
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.lineWidth = size;
      ctx.beginPath(); ctx.arc(x, y, size / 2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    } else {
      // dot
      drawWithSymmetry(layer, tool, x, y, x + 0.01, y + 0.01, e.pressure || 0.5);
    }
    render();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drawingRef.current;
    if (!d.active) return;
    const frame = frames[currentFrame];
    if (!frame) return;
    const layer = frame.layers[frame.activeLayer];

    if (tool === "move") {
      setPan((p) => ({ x: p.x + (e.clientX - d.lastX), y: p.y + (e.clientY - d.lastY) }));
      drawingRef.current.lastX = e.clientX;
      drawingRef.current.lastY = e.clientY;
      return;
    }
    if (!layer || layer.locked) return;

    const { x, y } = eventToCanvas(e);
    const ctx = layer.canvas.getContext("2d")!;

    if (tool === "rect" || tool === "ellipse" || tool === "line") {
      if (d.snapshot) ctx.putImageData(d.snapshot, 0, 0);
      applyStrokeStyle(ctx, "pen", 1);
      ctx.beginPath();
      if (tool === "rect") {
        ctx.strokeRect(d.startX, d.startY, x - d.startX, y - d.startY);
      } else if (tool === "ellipse") {
        ctx.ellipse((d.startX + x) / 2, (d.startY + y) / 2, Math.abs(x - d.startX) / 2, Math.abs(y - d.startY) / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.moveTo(d.startX, d.startY); ctx.lineTo(x, y); ctx.stroke();
      }
      render();
      return;
    }

    // Smoothing
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
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    buildThumb(currentFrame);
    if (color !== recentColors[0]) {
      setRecentColors((r) => [color, ...r.filter(c => c !== color)].slice(0, 20));
    }
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

  // ------------- Keyboard -------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA")) return;
      if (e.ctrlKey || e.metaKey) {
        if (e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
        if (e.key === "y" || (e.key === "z" && e.shiftKey)) { e.preventDefault(); redo(); return; }
        if (e.key === "s") { e.preventDefault(); saveNow(); return; }
        if (e.key === "n") { e.preventDefault(); setShowNew(true); return; }
        return;
      }
      const k = e.key.toLowerCase();
      const map: Record<string, Tool> = {
        p: "pen", n: "pencil", b: "brush", m: "marker", a: "airbrush", i: "ink", c: "crayon", h: "charcoal",
        e: "eraserHard", g: "bucket", r: "rect", o: "ellipse", l: "line", s: "select", v: "move",
      };
      if (map[k]) { setTool(map[k]); return; }
      if (e.key === " ") { e.preventDefault(); setPlaying(p => !p); return; }
      if (e.key === "[") setSize(s => Math.max(1, s - 2));
      if (e.key === "]") setSize(s => Math.min(200, s + 2));
      if (e.altKey) setTool("eyedropper");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ------------- Persistence -------------
  const serialize = useCallback((): SavedProject => {
    return {
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
  }, [projectId, projectName, dims, fps, thumbs]);

  const saveNow = useCallback(async () => {
    if (framesRef.current.length === 0) return;
    try { await saveProject(serialize()); } catch (e) { console.error(e); }
  }, [serialize]);

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
      loaded.push({ duration: f.duration, layers, activeLayer: 0, bg: (f as { bg?: string | null }).bg ?? "#ffffff" });
    }
    setFrames(loaded);
    setCurrentFrame(0);
    setShowProjects(false); setShowNew(false);
    setThumbs({});
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
          <div ref={containerRef} className="canvasarea">
            <canvas
              ref={displayRef}
              className="display"
              style={{ touchAction: "none", cursor: tool === "move" ? "grab" : "crosshair" }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onWheel={(e) => { e.preventDefault(); setZoom(z => Math.max(0.1, Math.min(8, z * (e.deltaY < 0 ? 1.1 : 0.9)))); }}
            />
          </div>

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
                  <div className="thumb">
                    {thumbs[i] ? <img src={thumbs[i]} alt="" /> : <span>{i + 1}</span>}
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
        </aside>
      </div>

      {/* New Project Modal */}
      {showNew && <NewProjectModal onConfirm={startProject} onCancel={() => frames.length > 0 && setShowNew(false)} hasProject={frames.length > 0} onOpen={async () => { setSavedList(await listProjects()); setShowProjects(true); }} />}
      {showProjects && <ProjectsModal projects={savedList} onLoad={loadProject} onDelete={async (id) => { await deleteProject(id); setSavedList(await listProjects()); }} onClose={() => setShowProjects(false)} />}
    </div>
  );
}

function cloneFrame(f: Frame, w: number, h: number): Frame {
  return {
    duration: f.duration,
    activeLayer: f.activeLayer,
    bg: f.bg,
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
