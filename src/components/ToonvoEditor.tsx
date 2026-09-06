import { useEffect, useRef, useState, useCallback } from "react";
import {
  saveProject,
  listProjects,
  getProject,
  deleteProject,
  type SavedProject,
} from "@/lib/toonvo-db";
import { useBreakpoint } from "@/hooks/use-breakpoint";
import ExportModal from "@/components/ExportModal";
import ColorWheel from "@/components/ColorWheel";
import {
  maskFromPath,
  maskBBox,
  invertMask,
  expandMask,
  contractMask,
  borderMask,
  featherMask,
  magicWandMask,
} from "@/lib/toonvo-selection";

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
  | "select" | "lasso" | "magicwand" | "move" | "eyedropper" | "text"
  | "grass" | "tree" | "flower" | "cloud" | "snow" | "rain" | "fire" | "smoke";

type Selection =
  | { kind: "rect"; x: number; y: number; w: number; h: number }
  | { kind: "lasso"; points: { x: number; y: number }[]; bbox: { x: number; y: number; w: number; h: number } }
  | { kind: "mask"; mask: HTMLCanvasElement; bbox: { x: number; y: number; w: number; h: number } };

type Floating = { canvas: HTMLCanvasElement; x: number; y: number };

// ---- Ruler / guide ----
type RulerType = "none" | "line" | "ellipse" | "rect" | "perspective";
type MirrorMode = "none" | "h" | "v" | "both";
interface RulerState {
  type: RulerType;
  cx: number; cy: number;
  w: number; h: number;
  angle: number;
  locked: boolean;
  mirror: MirrorMode;
}

const rulerToLocal = (r: RulerState, x: number, y: number) => {
  const c = Math.cos(-r.angle), s = Math.sin(-r.angle);
  const dx = x - r.cx, dy = y - r.cy;
  return { x: dx * c - dy * s, y: dx * s + dy * c };
};
const rulerToWorld = (r: RulerState, x: number, y: number) => {
  const c = Math.cos(r.angle), s = Math.sin(r.angle);
  return { x: r.cx + x * c - y * s, y: r.cy + x * s + y * c };
};
const rulerHandles = (r: RulerState): { id: string; x: number; y: number }[] => {
  if (r.type === "line") {
    const a = rulerToWorld(r, -r.w / 2, 0);
    const b = rulerToWorld(r, r.w / 2, 0);
    const rot = rulerToWorld(r, 0, -60);
    return [{ id: "start", ...a }, { id: "end", ...b }, { id: "rot", ...rot }];
  }
  if (r.type === "perspective") {
    return [{ id: "rot", ...rulerToWorld(r, 0, -60) }];
  }
  const hx = r.w / 2, hy = r.h / 2;
  return [
    { id: "nw", ...rulerToWorld(r, -hx, -hy) },
    { id: "ne", ...rulerToWorld(r, hx, -hy) },
    { id: "se", ...rulerToWorld(r, hx, hy) },
    { id: "sw", ...rulerToWorld(r, -hx, hy) },
    { id: "rot", ...rulerToWorld(r, 0, -hy - 60) },
  ];
};
// Snap a point onto the active guide. (sx, sy) = stroke start (used by perspective).
const snapToRuler = (r: RulerState, x: number, y: number, sx: number, sy: number) => {
  if (r.type === "perspective") {
    let vx = sx - r.cx, vy = sy - r.cy;
    if (Math.hypot(vx, vy) < 1) { vx = x - r.cx; vy = y - r.cy; }
    const len = Math.hypot(vx, vy) || 1;
    const ux = vx / len, uy = vy / len;
    const t = (x - r.cx) * ux + (y - r.cy) * uy;
    return { x: r.cx + ux * t, y: r.cy + uy * t };
  }
  const p = rulerToLocal(r, x, y);
  if (r.type === "line") {
    const hx = Math.max(1, r.w / 2);
    return rulerToWorld(r, Math.max(-hx, Math.min(hx, p.x)), 0);
  }
  if (r.type === "ellipse") {
    const rx = Math.max(1, r.w / 2), ry = Math.max(1, r.h / 2);
    const t = Math.atan2(p.y / ry, p.x / rx);
    return rulerToWorld(r, Math.cos(t) * rx, Math.sin(t) * ry);
  }
  const hx = r.w / 2, hy = r.h / 2;
  const cands = [
    { x: Math.max(-hx, Math.min(hx, p.x)), y: -hy },
    { x: Math.max(-hx, Math.min(hx, p.x)), y: hy },
    { x: -hx, y: Math.max(-hy, Math.min(hy, p.y)) },
    { x: hx, y: Math.max(-hy, Math.min(hy, p.y)) },
  ];
  let best = cands[0], bd = Infinity;
  for (const c of cands) {
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d < bd) { bd = d; best = c; }
  }
  return rulerToWorld(r, best.x, best.y);
};
const mirrorAcrossRuler = (r: RulerState, x: number, y: number, mode: "h" | "v" | "both") => {
  const p = rulerToLocal(r, x, y);
  const mx = mode === "h" || mode === "both" ? -p.x : p.x;
  const my = mode === "v" || mode === "both" ? -p.y : p.y;
  return rulerToWorld(r, mx, my);
};


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
    { id: "rect", label: "Rectangle", key: "K", icon: "▭" },
    { id: "ellipse", label: "Ellipse", key: "O", icon: "◯" },
    { id: "line", label: "Line", key: "L", icon: "／" },
    { id: "polygon", label: "Polygon", icon: "⬡" },
    { id: "star", label: "Star", icon: "★" },
  ]},
  { title: "Text", tools: [
    { id: "text", label: "Text", key: "T", icon: "T" },
  ]},
  { title: "Transform", tools: [
    { id: "select", label: "Select", key: "S", icon: "⬚" },
    { id: "lasso", label: "Lasso", icon: "🪢" },
    { id: "move", label: "Pan", key: "V", icon: "✥" },
    { id: "eyedropper", label: "Eyedropper", icon: "💧" },
  ]},
  { title: "NATURE", tools: [
    { id: "grass", label: "Grass Brush", icon: "🌿" },
    { id: "tree", label: "Tree Brush", icon: "🌳" },
    { id: "flower", label: "Flower Brush", icon: "🌸" },
    { id: "cloud", label: "Cloud Brush", icon: "☁️" },
    { id: "snow", label: "Snow Brush", icon: "❄️" },
    { id: "rain", label: "Rain Brush", icon: "🌧️" },
    { id: "fire", label: "Fire Brush", icon: "🔥" },
    { id: "smoke", label: "Smoke Brush", icon: "💨" },
  ]},
];

// Flat, FlipAClip-style ordering for the mobile bottom tool strip
const MOBILE_TOOLS: { id: Tool; label: string; icon: string }[] = [
  { id: "pen", label: "Pen", icon: "✒️" },
  { id: "pencil", label: "Pencil", icon: "✏️" },
  { id: "brush", label: "Brush", icon: "🖌️" },
  { id: "marker", label: "Marker", icon: "🖍️" },
  { id: "airbrush", label: "Airbrush", icon: "💨" },
  { id: "ink", label: "Ink Pen", icon: "🖋️" },
  { id: "crayon", label: "Crayon", icon: "🟧" },
  { id: "charcoal", label: "Charcoal", icon: "⚫" },
  { id: "eraserHard", label: "Eraser", icon: "🧽" },
  { id: "bucket", label: "Fill", icon: "🪣" },
  { id: "eyedropper", label: "Eyedropper", icon: "💧" },
  { id: "select", label: "Select", icon: "⬚" },
  { id: "lasso", label: "Lasso", icon: "🪢" },
  { id: "magicwand", label: "Magic Wand", icon: "🪄" },
  { id: "move", label: "Move / Pan", icon: "✥" },
  { id: "text", label: "Text", icon: "T" },
  { id: "rect", label: "Rectangle", icon: "▭" },
  { id: "ellipse", label: "Ellipse", icon: "◯" },
  { id: "line", label: "Line", icon: "／" },
  { id: "polygon", label: "Polygon", icon: "⬡" },
  { id: "star", label: "Star", icon: "★" },
];


const FONT_FAMILIES = [
  "Arial", "Helvetica", "Times New Roman", "Georgia", "Courier New",
  "Comic Sans MS", "Impact", "Trebuchet MS", "Verdana", "Roboto",
  "Palatino Linotype", "Lucida Console", "Tahoma", "Garamond",
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

function mixHex(a: string, b: string, amount: number) {
  const ac = hexToRgb(a), bc = hexToRgb(b);
  return rgbToHex(
    ac[0] + (bc[0] - ac[0]) * amount,
    ac[1] + (bc[1] - ac[1]) * amount,
    ac[2] + (bc[2] - ac[2]) * amount,
  );
}

function rgba(hex: string, alpha: number) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`;
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
  const [showExport, setShowExport] = useState(false);
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
  const [natureExpanded, setNatureExpanded] = useState(true);
  const [recentColors, setRecentColors] = useState<string[]>([]);
  const [shapeStyle, setShapeStyle] = useState<"fill" | "stroke" | "both">("stroke");
  const [shapeFill, setShapeFill] = useState("#6c63ff");
  const [cornerRadius, setCornerRadius] = useState(0);
  const [polygonSides, setPolygonSides] = useState(6);
  const [starPoints, setStarPoints] = useState(5);
  const [starInnerRatio, setStarInnerRatio] = useState(0.5);

  // Dreamy blur effect state
  const [dreamyBlurEnabled, setDreamyBlurEnabled] = useState(false);
  const [blurRadius, setBlurRadius] = useState(5);
  const [glowIntensity, setGlowIntensity] = useState(50);
  const [hazeOpacity, setHazeOpacity] = useState(30);
  const [warmth, setWarmth] = useState(0);
  const [vignette, setVignette] = useState(20);

  // Text tool state
  const [textFont, setTextFont] = useState("Arial");
  const [textSize, setTextSize] = useState(48);
  const [textBold, setTextBold] = useState(false);
  const [textItalic, setTextItalic] = useState(false);
  const [textUnderline, setTextUnderline] = useState(false);
  const [textColor, setTextColor] = useState("#ffffff");
  const [textOpacity, setTextOpacity] = useState(1);
  const [textAlign, setTextAlign] = useState<"left" | "center" | "right">("left");
  const [textLetterSpacing, setTextLetterSpacing] = useState(0);
  const [textLineHeight, setTextLineHeight] = useState(1.2);
  const [textOutlineOn, setTextOutlineOn] = useState(false);
  const [textOutlineColor, setTextOutlineColor] = useState("#000000");
  const [textOutlineWidth, setTextOutlineWidth] = useState(2);
  const [textShadowOn, setTextShadowOn] = useState(false);
  const [textShadowX, setTextShadowX] = useState(3);
  const [textShadowY, setTextShadowY] = useState(3);
  const [textShadowBlur, setTextShadowBlur] = useState(6);
  const [textShadowColor, setTextShadowColor] = useState("#000000");
  const [textBgOn, setTextBgOn] = useState(false);
  const [textBgColor, setTextBgColor] = useState("#000000");
  const [textBgPadding, setTextBgPadding] = useState(6);
  const [textEditing, setTextEditing] = useState<{ canvasX: number; canvasY: number; value: string } | null>(null);

  const [onion, setOnion] = useState(false);
  const [onionBefore, setOnionBefore] = useState(1);
  const [onionAfter, setOnionAfter] = useState(1);
  const [onionOpacity, setOnionOpacity] = useState(0.35);

  const [showGrid, setShowGrid] = useState(false);
  const [symmetry, setSymmetry] = useState<"none" | "h" | "v" | "both">("none");

  // ------------- Ruler / guide (FlipaClip-style) -------------
  const [ruler, setRuler] = useState<RulerState>({
    type: "none", cx: 960, cy: 540, w: 800, h: 500, angle: 0, locked: false, mirror: "none",
  });
  const rulerActionRef = useRef<{ mode: string | null; startX: number; startY: number; orig: RulerState }>({
    mode: null, startX: 0, startY: 0,
    orig: { type: "none", cx: 0, cy: 0, w: 0, h: 0, angle: 0, locked: false, mirror: "none" },
  });
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const gestureRef = useRef<{ active: boolean; dist: number; angle: number; orig: RulerState }>({
    active: false, dist: 1, angle: 0,
    orig: { type: "none", cx: 0, cy: 0, w: 0, h: 0, angle: 0, locked: false, mirror: "none" },
  });
  const toggleRulerRef = useRef<(() => void) | null>(null);
  const setRulerType = (t: RulerType) => {
    setRuler((r) => ({
      ...r,
      type: t,
      cx: dims.w / 2,
      cy: dims.h / 2,
      w: t === "perspective" ? Math.max(dims.w, dims.h) : dims.w * 0.6,
      h: dims.h * 0.5,
      angle: 0,
    }));
  };
  const toggleRuler = () => {
    if (ruler.type === "none") setRulerType("line");
    else setRuler((r) => ({ ...r, type: "none" }));
  };
  toggleRulerRef.current = toggleRuler;


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

  const [selection, setSelection] = useState<Selection | null>(null);
  const [floating, setFloating] = useState<Floating | null>(null);

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
  const pushHistoryRef = useRef<((label: string) => void) | null>(null);
  const buildThumbRef = useRef<((i: number) => void) | null>(null);

  const selectionRef = useRef<Selection | null>(null);
  const floatingRef = useRef<Floating | null>(null);
  const clipboardRef = useRef<HTMLCanvasElement | null>(null);
  const selActionRef = useRef<{ mode: "new-rect" | "new-lasso" | "move-floating" | null; startX: number; startY: number; pts?: { x: number; y: number }[]; origFloatX?: number; origFloatY?: number }>({ mode: null, startX: 0, startY: 0 });
  const dashOffsetRef = useRef(0);
  const undoRef = useRef<() => void>(() => {});
  const redoRef = useRef<() => void>(() => {});
  const deleteSelRef = useRef<() => void>(() => {});
  const copySelRef = useRef<(cut: boolean) => void>(() => {});
  const pasteRef = useRef<() => void>(() => {});
  const commitFloatRef = useRef<() => void>(() => {});
  const escapeRef = useRef<() => void>(() => {});

  // ---- Responsive layout ----
  const bp = useBreakpoint();
  const isTouchLayout = bp !== "desktop";
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [colorPopup, setColorPopup] = useState(false);
  const isMobile = bp === "mobile";
  const isTablet = bp === "tablet";
  // Mobile: transient tool-options popup above the bottom tool strip
  const [toolPopup, setToolPopup] = useState<string | null>(null);
  const toolPopupTimer = useRef<number | null>(null);
  const showToolPopup = useCallback((id: string) => {
    setToolPopup(id);
    if (toolPopupTimer.current) window.clearTimeout(toolPopupTimer.current);
    toolPopupTimer.current = window.setTimeout(() => setToolPopup(null), 3000);
  }, []);
  const [mobileMore, setMobileMore] = useState(false);
  // Two-finger pinch-zoom / pan of the canvas view (touch)
  const viewGestureRef = useRef<{
    active: boolean; dist: number; cx: number; cy: number; zoom: number;
    offX: number; offY: number; scale: number;
  }>({ active: false, dist: 1, cx: 0, cy: 0, zoom: 1, offX: 0, offY: 0, scale: 1 });
  const touchPtsRef = useRef<Map<number, { x: number; y: number }>>(new Map());


  // ---- Toasts ----
  const [toasts, setToasts] = useState<{ id: number; msg: string }[]>([]);
  const toastIdRef = useRef(0);
  const toast = useCallback((msg: string) => {
    const id = ++toastIdRef.current;
    setToasts(t => [...t, { id, msg }]);
    window.setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 1800);
  }, []);

  // ---- Frame selection & clipboards ----
  const [selectedFrames, setSelectedFrames] = useState<number[]>([0]);
  const selectedFramesRef = useRef<number[]>([0]);
  selectedFramesRef.current = selectedFrames;
  const frameClipRef = useRef<Frame[]>([]);
  const [frameClipCount, setFrameClipCount] = useState(0);
  const clipOriginRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [clipThumb, setClipThumb] = useState<string | null>(null);
  const [showClipInfo, setShowClipInfo] = useState(false);

  // ---- Context menus / focus / gestures ----
  const [frameMenu, setFrameMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  const [layerMenu, setLayerMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  const focusAreaRef = useRef<"canvas" | "timeline">("canvas");
  const longPressRef = useRef<number | null>(null);

  // ---- Magic wand ----
  const [wandTolerance, setWandTolerance] = useState(20);
  const [wandContiguous, setWandContiguous] = useState(true);
  const [featherPx, setFeatherPx] = useState(0);
  const [growPx, setGrowPx] = useState(2);
  const [pasteTargetMenu, setPasteTargetMenu] = useState(false);

  const kbRef = useRef<{
    selectedFrames: () => number[];
    copyFrames: (idxs: number[], cut: boolean) => void;
    pasteFrames: (inPlace: boolean) => void;
    duplicateFrames: (idxs: number[]) => void;
    deleteFrames: (idxs: number[], silent?: boolean) => void;
    selectAllFrames: () => void;
    selectAllLayer: () => void;
    deselect: () => void;
    invertSelection: () => void;
    duplicateInPlace: () => void;
    pasteInPlace: () => void;
    nudge: (dx: number, dy: number) => void;
    toast: (m: string) => void;
  } | null>(null);


  const framesRef = useRef(frames);
  const currentRef = useRef(currentFrame);
  framesRef.current = frames;
  currentRef.current = currentFrame;
  selectionRef.current = selection;
  floatingRef.current = floating;

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
      navigator.serviceWorker.register("/sw.js").then((reg) => {
        // Force an update check on every load so a bumped VERSION in
        // sw.js takes effect immediately instead of on the next visit.
        reg.update().catch(() => {});
        reg.addEventListener("updatefound", () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener("statechange", () => {
            if (nw.state === "activated") {
              // New SW took over — reload so the page runs the fresh
              // bundle instead of the previously cached one.
              if (navigator.serviceWorker.controller) location.reload();
            }
          });
        });
      }).catch(() => {});
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



    // Ruler / guide overlay (never exported — display canvas only)
    if (ruler.type !== "none") {
      const inv = 1 / scale;
      ctx.save();
      ctx.strokeStyle = ruler.locked ? "#ffb347" : "#6c63ff";
      ctx.lineWidth = Math.max(1, 2 * inv);
      ctx.setLineDash([]);
      if (ruler.type === "line") {
        const a = rulerToWorld(ruler, -ruler.w / 2, 0);
        const b = rulerToWorld(ruler, ruler.w / 2, 0);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      } else if (ruler.type === "perspective") {
        ctx.setLineDash([10 * inv, 8 * inv]);
        const rays = 16;
        for (let i = 0; i < rays; i++) {
          const t = (i / rays) * Math.PI * 2 + ruler.angle;
          ctx.beginPath();
          ctx.moveTo(ruler.cx, ruler.cy);
          ctx.lineTo(ruler.cx + Math.cos(t) * ruler.w, ruler.cy + Math.sin(t) * ruler.w);
          ctx.stroke();
        }
        ctx.setLineDash([]);
      } else {
        ctx.save();
        ctx.translate(ruler.cx, ruler.cy);
        ctx.rotate(ruler.angle);
        ctx.beginPath();
        if (ruler.type === "ellipse") ctx.ellipse(0, 0, Math.max(1, ruler.w / 2), Math.max(1, ruler.h / 2), 0, 0, Math.PI * 2);
        else ctx.rect(-ruler.w / 2, -ruler.h / 2, ruler.w, ruler.h);
        ctx.stroke();
        ctx.restore();
      }
      // Mirror axes
      if (ruler.mirror !== "none") {
        ctx.save();
        ctx.setLineDash([6 * inv, 6 * inv]);
        ctx.strokeStyle = "rgba(108,99,255,0.55)";
        ctx.translate(ruler.cx, ruler.cy);
        ctx.rotate(ruler.angle);
        const ex = Math.max(ruler.w, ruler.h);
        if (ruler.mirror === "h" || ruler.mirror === "both") { ctx.beginPath(); ctx.moveTo(0, -ex); ctx.lineTo(0, ex); ctx.stroke(); }
        if (ruler.mirror === "v" || ruler.mirror === "both") { ctx.beginPath(); ctx.moveTo(-ex, 0); ctx.lineTo(ex, 0); ctx.stroke(); }
        ctx.restore();
      }
      // Handles
      const hr = 7 * inv;
      ctx.fillStyle = ruler.locked ? "#ffb347" : "#ffffff";
      ctx.strokeStyle = "#6c63ff";
      ctx.lineWidth = Math.max(1, 2 * inv);
      [{ x: ruler.cx, y: ruler.cy }, ...rulerHandles(ruler)].forEach((h) => {
        ctx.beginPath(); ctx.arc(h.x, h.y, hr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      });
      ctx.restore();
    }

    ctx.strokeStyle = "#6c63ff";
    ctx.lineWidth = 2 / scale;
    ctx.strokeRect(0, 0, dims.w, dims.h);

    // Apply dreamy blur effect if enabled (post-processing on display canvas)
    if (dreamyBlurEnabled) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      
      // Create a temporary canvas for effect processing
      const tempCanvas = makeCanvas(pw, ph);
      const tempCtx = tempCanvas.getContext("2d")!;
      tempCtx.drawImage(disp, 0, 0);
      
      // Apply blur
      if (blurRadius > 0) {
        ctx.filter = `blur(${blurRadius * dpr}px)`;
        ctx.drawImage(tempCanvas, 0, 0);
        ctx.filter = "none";
      }
      
      // Apply glow intensity
      if (glowIntensity > 0) {
        ctx.globalAlpha = glowIntensity / 100;
        ctx.globalCompositeOperation = "screen";
        ctx.drawImage(tempCanvas, 0, 0);
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
      }
      
      // Apply haze overlay
      if (hazeOpacity > 0) {
        ctx.globalAlpha = hazeOpacity / 100;
        ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
        ctx.fillRect(0, 0, pw, ph);
        ctx.globalAlpha = 1;
      }
      
      // Apply warmth (color temperature)
      if (warmth !== 0) {
        ctx.globalCompositeOperation = warmth > 0 ? "overlay" : "color";
        ctx.globalAlpha = Math.abs(warmth) / 100;
        ctx.fillStyle = warmth > 0 ? "rgba(255, 200, 150, 0.5)" : "rgba(150, 200, 255, 0.5)";
        ctx.fillRect(0, 0, pw, ph);
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
      }
      
      // Apply vignette
      if (vignette > 0) {
        const gradient = ctx.createRadialGradient(
          pw / 2, ph / 2, 0,
          pw / 2, ph / 2, Math.max(pw, ph) / 1.5
        );
        gradient.addColorStop(0, "rgba(0, 0, 0, 0)");
        gradient.addColorStop(1, `rgba(0, 0, 0, ${vignette / 100})`);
        ctx.globalCompositeOperation = "multiply";
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, pw, ph);
        ctx.globalCompositeOperation = "source-over";
      }
      
      ctx.restore();
    }
  }, [frames, currentFrame, dims, zoom, pan, onion, onionBefore, onionAfter, onionOpacity, showGrid, ruler, dreamyBlurEnabled, blurRadius, glowIntensity, hazeOpacity, warmth, vignette]);


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

  // Expose to text tool commit
  pushHistoryRef.current = pushHistory;
  buildThumbRef.current = buildThumb;

  const undo = () => {
    const h = history;
    if (h.length === 0) return;
    const last = h[h.length - 1];
    const f = framesRef.current[last.frame];
    const l = f?.layers[last.layer];
    if (!l) return;
    const ctx = l.canvas.getContext("2d")!;
    const cur = ctx.getImageData(0, 0, l.canvas.width, l.canvas.height);
    ctx.putImageData(last.image, 0, 0);
    render();
    buildThumb(last.frame);
    setHistory(h.slice(0, -1));
    setHistoryLabels((ls) => ls.slice(0, -1));
    setRedoStack((r) => [...r, { ...last, image: cur }]);
  };
  const redo = () => {
    const r = redoStack;
    if (r.length === 0) return;
    const last = r[r.length - 1];
    const f = framesRef.current[last.frame];
    const l = f?.layers[last.layer];
    if (!l) return;
    const ctx = l.canvas.getContext("2d")!;
    const cur = ctx.getImageData(0, 0, l.canvas.width, l.canvas.height);
    ctx.putImageData(last.image, 0, 0);
    render();
    buildThumb(last.frame);
    setRedoStack(r.slice(0, -1));
    setHistory((h) => [...h, { ...last, image: cur }]);
    setHistoryLabels((ls) => [...ls, last.label]);
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
    if (t === "select" || t === "lasso") return "crosshair";
    if (t === "eyedropper") return "crosshair";
    if (t === "text") return "text";
    return "none";
  };
  const shouldShowBrushCursor = (t: Tool) => {
    return !["move", "select", "lasso", "eyedropper", "bucket", "text"].includes(t);
  };

  // ------------- Text tool helpers -------------
  const fontString = () =>
    `${textItalic ? "italic " : ""}${textBold ? "700 " : "400 "}${textSize}px "${textFont}", sans-serif`;

  const commitText = useCallback(() => {
    const te = textEditing;
    if (!te || !te.value) { setTextEditing(null); return; }
    const frame = framesRef.current[currentRef.current];
    const layer = frame?.layers[frame.activeLayer];
    if (!layer || layer.locked) { setTextEditing(null); return; }
    pushHistoryRef.current?.("Text");
    const ctx = layer.canvas.getContext("2d")!;
    ctx.save();
    ctx.globalAlpha = textOpacity;
    ctx.font = fontString();
    ctx.textBaseline = "top";
    ctx.textAlign = textAlign;

    const lines = te.value.split("\n");
    const lineH = textSize * textLineHeight;

    // Measure widths (with letter-spacing)
    const measure = (s: string) => {
      const base = ctx.measureText(s).width;
      const extra = textLetterSpacing * Math.max(0, s.length - 1);
      return base + extra;
    };

    // Background pill
    if (textBgOn) {
      const maxW = Math.max(1, ...lines.map(measure));
      const totalH = lineH * lines.length;
      let bgX = te.canvasX;
      if (textAlign === "center") bgX -= maxW / 2;
      else if (textAlign === "right") bgX -= maxW;
      ctx.fillStyle = textBgColor;
      ctx.fillRect(bgX - textBgPadding, te.canvasY - textBgPadding, maxW + textBgPadding * 2, totalH + textBgPadding * 2);
    }

    // Shadow via canvas shadow
    if (textShadowOn) {
      ctx.shadowColor = textShadowColor;
      ctx.shadowOffsetX = textShadowX;
      ctx.shadowOffsetY = textShadowY;
      ctx.shadowBlur = textShadowBlur;
    }

    lines.forEach((line, i) => {
      const y = te.canvasY + i * lineH;
      if (textLetterSpacing === 0) {
        if (textOutlineOn && textOutlineWidth > 0) {
          ctx.lineJoin = "round";
          ctx.strokeStyle = textOutlineColor;
          ctx.lineWidth = textOutlineWidth * 2;
          ctx.strokeText(line, te.canvasX, y);
        }
        ctx.fillStyle = textColor;
        ctx.fillText(line, te.canvasX, y);
        if (textUnderline) {
          const w = measure(line);
          let ux = te.canvasX;
          if (textAlign === "center") ux -= w / 2;
          else if (textAlign === "right") ux -= w;
          ctx.fillRect(ux, y + textSize * 0.95, w, Math.max(1, textSize * 0.06));
        }
      } else {
        // Manual letter-spacing: advance per char
        const w = measure(line);
        let x = te.canvasX;
        if (textAlign === "center") x -= w / 2;
        else if (textAlign === "right") x -= w;
        ctx.textAlign = "left";
        for (const ch of line) {
          if (textOutlineOn && textOutlineWidth > 0) {
            ctx.lineJoin = "round";
            ctx.strokeStyle = textOutlineColor;
            ctx.lineWidth = textOutlineWidth * 2;
            ctx.strokeText(ch, x, y);
          }
          ctx.fillStyle = textColor;
          ctx.fillText(ch, x, y);
          x += ctx.measureText(ch).width + textLetterSpacing;
        }
        if (textUnderline) {
          ctx.fillRect(te.canvasX + (textAlign === "center" ? -w / 2 : textAlign === "right" ? -w : 0), y + textSize * 0.95, w, Math.max(1, textSize * 0.06));
        }
        ctx.textAlign = textAlign;
      }
    });

    ctx.restore();
    setTextEditing(null);
    buildThumbRef.current?.(currentRef.current);
    render();
  }, [textEditing, textOpacity, textAlign, textLetterSpacing, textLineHeight, textBgOn, textBgColor, textBgPadding, textShadowOn, textShadowColor, textShadowX, textShadowY, textShadowBlur, textOutlineOn, textOutlineColor, textOutlineWidth, textColor, textUnderline, textSize, textFont, textBold, textItalic, render]);

  const commitTextRef = useRef(commitText);
  useEffect(() => { commitTextRef.current = commitText; }, [commitText]);


  // ------------- Selection helpers -------------
  const pointInPolygon = (x: number, y: number, pts: { x: number; y: number }[]) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-9) + xi)) inside = !inside;
    }
    return inside;
  };
  const buildSelPath = (ctx: CanvasRenderingContext2D, s: Selection, dx = 0, dy = 0) => {
    ctx.beginPath();
    if (s.kind === "rect") ctx.rect(s.x + dx, s.y + dy, s.w, s.h);
    else if (s.kind === "mask") ctx.rect(s.bbox.x + dx, s.bbox.y + dy, s.bbox.w, s.bbox.h);
    else {
      const p = s.points;
      if (!p.length) return;
      ctx.moveTo(p[0].x + dx, p[0].y + dy);
      for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x + dx, p[i].y + dy);
      ctx.closePath();
    }
  };
  const selBBox = (s: Selection) => (s.kind === "rect" ? { x: s.x, y: s.y, w: s.w, h: s.h } : s.bbox);
  /** Rasterise any selection into a full-canvas alpha mask. */
  const selMask = (s: Selection): HTMLCanvasElement => {
    if (s.kind === "mask") return s.mask;
    return maskFromPath(dims.w, dims.h, (c) => buildSelPath(c, s));
  };
  const selectionInside = (s: Selection, x: number, y: number) => {
    const b = selBBox(s);
    if (x < b.x || y < b.y || x > b.x + b.w || y > b.y + b.h) return false;
    if (s.kind === "rect") return true;
    if (s.kind === "mask") {
      const d = s.mask.getContext("2d", { willReadFrequently: true })!.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
      return d[3] > 8;
    }
    return pointInPolygon(x, y, s.points);
  };
  const commitFloating = () => {
    const f = floatingRef.current;
    if (!f) return;
    const frame = framesRef.current[currentRef.current];
    const layer = frame?.layers[frame.activeLayer];
    if (layer && !layer.locked) {
      const ctx = layer.canvas.getContext("2d")!;
      ctx.drawImage(f.canvas, f.x, f.y);
      buildThumb(currentRef.current);
    }
    floatingRef.current = null;
    setFloating(null);
    render();
  };
  const clampBox = (bbox: { x: number; y: number; w: number; h: number }, c: HTMLCanvasElement) => {
    const bx = Math.max(0, Math.floor(bbox.x));
    const by = Math.max(0, Math.floor(bbox.y));
    return {
      bx, by,
      bw: Math.max(1, Math.floor(Math.min(bbox.w, c.width - bx))),
      bh: Math.max(1, Math.floor(Math.min(bbox.h, c.height - by))),
    };
  };
  /** Copy the selected pixels of `layer` into a standalone canvas. */
  const cutoutFromLayer = (sel: Selection, layerCanvas: HTMLCanvasElement) => {
    const { bx, by, bw, bh } = clampBox(selBBox(sel), layerCanvas);
    const mask = selMask(sel);
    const tmp = makeCanvas(bw, bh);
    const tctx = tmp.getContext("2d")!;
    tctx.drawImage(layerCanvas, -bx, -by);
    tctx.globalCompositeOperation = "destination-in";
    tctx.drawImage(mask, -bx, -by);
    tctx.globalCompositeOperation = "source-over";
    return { canvas: tmp, x: bx, y: by, mask };
  };
  const eraseSelectionFromLayer = (sel: Selection, layerCanvas: HTMLCanvasElement) => {
    const ctx = layerCanvas.getContext("2d")!;
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(selMask(sel), 0, 0);
    ctx.restore();
  };
  const extractSelectionToFloating = (sel: Selection): Floating | null => {
    const frame = framesRef.current[currentRef.current];
    const layer = frame?.layers[frame.activeLayer];
    if (!layer || layer.locked) return null;
    pushHistory("Move selection");
    const cut = cutoutFromLayer(sel, layer.canvas);
    eraseSelectionFromLayer(sel, layer.canvas);
    buildThumb(currentRef.current);
    return { canvas: cut.canvas, x: cut.x, y: cut.y };
  };
  const deleteSelection = () => {
    if (floatingRef.current) {
      floatingRef.current = null;
      setFloating(null);
      render();
      return;
    }
    const sel = selectionRef.current;
    if (!sel) return;
    const frame = framesRef.current[currentRef.current];
    const layer = frame?.layers[frame.activeLayer];
    if (!layer || layer.locked) return;
    pushHistory("Delete selection");
    eraseSelectionFromLayer(sel, layer.canvas);
    buildThumb(currentRef.current);
    render();
  };
  const copySelection = (cut: boolean) => {
    const sel = selectionRef.current;
    const f = floatingRef.current;
    if (f) {
      const clip = makeCanvas(f.canvas.width, f.canvas.height);
      clip.getContext("2d")!.drawImage(f.canvas, 0, 0);
      clipboardRef.current = clip;
      clipOriginRef.current = { x: f.x, y: f.y };
      try { setClipThumb(clip.toDataURL("image/png")); } catch { setClipThumb(null); }
      if (cut) { floatingRef.current = null; setFloating(null); render(); }
      return;
    }
    if (!sel) return;
    const frame = framesRef.current[currentRef.current];
    const layer = frame?.layers[frame.activeLayer];
    if (!layer) return;
    const out = cutoutFromLayer(sel, layer.canvas);
    clipboardRef.current = out.canvas;
    clipOriginRef.current = { x: out.x, y: out.y };
    try { setClipThumb(out.canvas.toDataURL("image/png")); } catch { setClipThumb(null); }
    if (cut) deleteSelection();
  };
  const pasteClipboard = () => {
    const cb = clipboardRef.current;
    if (!cb) return;
    commitFloating();
    const o = clipOriginRef.current;
    const onScreen = o.x < dims.w && o.y < dims.h && o.x + cb.width > 0 && o.y + cb.height > 0;
    const fl: Floating = {
      canvas: cb,
      x: onScreen ? o.x : (dims.w - cb.width) / 2,
      y: onScreen ? o.y : (dims.h - cb.height) / 2,
    };
    floatingRef.current = fl;
    setFloating(fl);
    setSelection(null);
    selectionRef.current = null;
  };
  const escapeSelection = () => {
    if (floatingRef.current) commitFloating();
    if (selectionRef.current) { selectionRef.current = null; setSelection(null); render(); }
  };

  // Marching-ants animation
  useEffect(() => {
    if (!selection && !floating) return;
    let raf = 0;
    const tick = () => {
      dashOffsetRef.current = (dashOffsetRef.current + 0.4) % 100;
      render();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [selection, floating, render]);


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

  const drawNatureStamp = (ctx: CanvasRenderingContext2D, t: Tool, x: number, y: number) => {
    const s = Math.max(2, size);
    const a = Math.max(0, Math.min(1, opacity));
    const jitter = (amount: number) => (Math.random() - 0.5) * amount;
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (t === "grass") {
      const blades = 5 + Math.floor(Math.random() * 11);
      const scale = Math.max(0.25, s / 8);
      const groundWidth = Math.max(2, s * 0.8);
      const baseY = y + s * 0.06;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(0.75, s * 0.045);
      ctx.globalAlpha = a;
      for (let i = 0; i < blades; i++) {
        const bx = x + (i / Math.max(1, blades - 1) - 0.5) * groundWidth;
        const height = (10 + Math.random() * 20) * scale;
        const lean = jitter(Math.max(2, s * 0.55));
        const curve = jitter(Math.max(1, s * 0.3));
        ctx.beginPath();
        ctx.moveTo(bx, baseY);
        ctx.quadraticCurveTo(bx + curve, baseY - height * 0.52, bx + lean, baseY - height);
        ctx.stroke();
      }
    } else if (t === "tree") {
      const scale = 0.9 + Math.random() * 0.2;
      const trunk = mixHex(color, "#26170f", 0.45);
      const leaf = color;
      ctx.globalAlpha = a;
      ctx.fillStyle = trunk;
      ctx.beginPath();
      ctx.moveTo(x - s * 0.08 * scale, y + s * 0.5 * scale);
      ctx.lineTo(x - s * 0.16 * scale, y - s * 0.08 * scale);
      ctx.lineTo(x - s * 0.05 * scale, y - s * 0.08 * scale);
      ctx.lineTo(x + s * 0.12 * scale, y + s * 0.5 * scale);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = trunk;
      ctx.lineWidth = Math.max(1, s * 0.065 * scale);
      [[0, -0.05, -0.3, -0.45], [0, -0.12, 0.28, -0.4], [-0.02, -0.28, -0.2, -0.62], [0.04, -0.25, 0.2, -0.64]].forEach(([sx, sy, ex, ey]) => {
        ctx.beginPath(); ctx.moveTo(x + sx * s, y + sy * s); ctx.lineTo(x + ex * s, y + ey * s); ctx.stroke();
      });
      ctx.fillStyle = leaf;
      [[-0.25, -0.5, 0.28], [0.12, -0.55, 0.34], [-0.02, -0.8, 0.34], [0.3, -0.75, 0.23], [-0.3, -0.77, 0.22]].forEach(([dx, dy, r]) => {
        ctx.beginPath(); ctx.arc(x + dx * s * scale, y + dy * s * scale, r * s * scale, 0, Math.PI * 2); ctx.fill();
      });
    } else if (t === "flower") {
      const count = Math.max(2, Math.round(s / 8));
      const petal = color;
      const center = mixHex(color, "#241b10", 0.35);
      ctx.globalAlpha = a * 0.9;
      for (let i = 0; i < count; i++) {
        const fx = x + jitter(s * 0.9), fy = y + jitter(s * 0.7);
        const r = Math.max(1.5, s * (0.1 + Math.random() * 0.08));
        const rot = Math.random() * Math.PI * 2;
        ctx.save(); ctx.translate(fx, fy); ctx.rotate(rot); ctx.fillStyle = petal;
        for (let p = 0; p < 5; p++) {
          const pa = p * Math.PI * 2 / 5;
          ctx.beginPath(); ctx.ellipse(Math.cos(pa) * r * 0.72, Math.sin(pa) * r * 0.72, r * 0.65, r * 0.38, pa, 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = center; ctx.beginPath(); ctx.arc(0, 0, r * 0.34, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    } else if (t === "cloud" || t === "smoke") {
      const cloudColor = t === "cloud" ? mixHex(color, "#ffffff", 0.72) : "#a7a9b5";
      const cloudAlpha = t === "cloud" ? a * 0.36 : a * 0.22;
      const puffs = t === "cloud" ? 5 : 4;
      for (let i = 0; i < puffs; i++) {
        const px = x + jitter(s * 0.75), py = y + jitter(s * 0.38);
        const r = s * (0.28 + Math.random() * 0.28);
        const grad = ctx.createRadialGradient(px, py, 0, px, py, r);
        grad.addColorStop(0, rgba(cloudColor, cloudAlpha));
        grad.addColorStop(0.65, rgba(cloudColor, cloudAlpha * 0.6));
        grad.addColorStop(1, rgba(cloudColor, 0));
        ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
      }
    } else if (t === "snow") {
      const count = Math.max(2, Math.round(s / 10));
      ctx.strokeStyle = mixHex("#ffffff", "#bceaff", 0.5);
      ctx.lineWidth = Math.max(1, s * 0.035);
      ctx.globalAlpha = a * 0.75;
      for (let i = 0; i < count; i++) {
        const sx = x + jitter(s), sy = y + jitter(s);
        const r = s * (0.08 + Math.random() * 0.1);
        const rot = Math.random() * Math.PI / 3;
        for (let ray = 0; ray < 6; ray++) {
          const ang = rot + ray * Math.PI / 3;
          ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + Math.cos(ang) * r, sy + Math.sin(ang) * r); ctx.stroke();
        }
      }
    } else if (t === "rain") {
      ctx.strokeStyle = "#9ddcff";
      ctx.lineWidth = Math.max(1, s * 0.035);
      ctx.globalAlpha = a * 0.42;
      const count = Math.max(3, Math.round(s / 5));
      const angle = (72 + Math.random() * 8) * Math.PI / 180;
      for (let i = 0; i < count; i++) {
        const rx = x + jitter(s), ry = y + jitter(s);
        const len = s * (0.55 + Math.random() * 0.65);
        ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(rx + Math.cos(angle) * len, ry + Math.sin(angle) * len); ctx.stroke();
      }
    } else if (t === "fire") {
      const h = s * (0.8 + Math.random() * 0.65);
      const w = s * (0.38 + Math.random() * 0.25);
      const grad = ctx.createLinearGradient(x, y + h * 0.45, x, y - h);
      grad.addColorStop(0, rgba("#ff2d18", a * 0.62));
      grad.addColorStop(0.55, rgba("#ff8a00", a * 0.78));
      grad.addColorStop(1, rgba("#ffe45c", a * 0.24));
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.moveTo(x - w, y + h * 0.45); ctx.quadraticCurveTo(x - w * 0.78, y - h * 0.1, x - w * 0.1, y - h * 0.35); ctx.quadraticCurveTo(x - w * 0.16, y - h * 0.78, x + w * 0.1, y - h); ctx.quadraticCurveTo(x + w * 0.2, y - h * 0.45, x + w * 0.8, y - h * 0.62); ctx.quadraticCurveTo(x + w * 0.72, y - h * 0.08, x + w, y + h * 0.45); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  };

  const isNatureTool = (t: Tool) => ["grass", "tree", "flower", "cloud", "snow", "rain", "fire", "smoke"].includes(t);

  const drawStrokeSegment = (
    ctx: CanvasRenderingContext2D, t: Tool, x0: number, y0: number, x1: number, y1: number, pressure: number
  ) => {
    if (isNatureTool(t)) {
      const d = Math.hypot(x1 - x0, y1 - y0);
      const spacing = Math.max(3, size * (t === "tree" ? 1.15 : t === "flower" ? 0.45 : 0.35));
      const steps = Math.max(1, Math.ceil(d / spacing));
      for (let i = 0; i <= steps; i++) drawNatureStamp(ctx, t, x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps);
      return;
    }
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
    let variants: [number, number, number, number][] = [[x0, y0, x1, y1]];
    if (symmetry === "h" || symmetry === "both") variants.push([2 * cx - x0, y0, 2 * cx - x1, y1]);
    if (symmetry === "v" || symmetry === "both") variants.push([x0, 2 * cy - y0, x1, 2 * cy - y1]);
    if (symmetry === "both") variants.push([2 * cx - x0, 2 * cy - y0, 2 * cx - x1, 2 * cy - y1]);
    // Ruler mirror: reflect across the guide's local axes
    if (ruler.type !== "none" && ruler.mirror !== "none") {
      const modes: ("h" | "v" | "both")[] = ruler.mirror === "both" ? ["h", "v", "both"] : [ruler.mirror];
      const extra: [number, number, number, number][] = [];
      variants.forEach(([a, b, c, d]) => {
        modes.forEach((m) => {
          const p0 = mirrorAcrossRuler(ruler, a, b, m);
          const p1 = mirrorAcrossRuler(ruler, c, d, m);
          extra.push([p0.x, p0.y, p1.x, p1.y]);
        });
      });
      variants = variants.concat(extra);
    }
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
    // Palm rejection: ignore very large touch contacts (palm resting on screen)
    if (e.pointerType === "touch" && (e.width > 45 || e.height > 45)) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointer not active — non-fatal */ }
    const cssP = eventToCss(e);
    setCursorPos({ x: cssP.x, y: cssP.y, visible: true });
    if (isMobile) setToolPopup(null);

    // Track active pointers (for two-finger ruler gestures)
    {
      const p0 = eventToCanvas(e);
      pointersRef.current.set(e.pointerId, { x: p0.x, y: p0.y });
      if (e.pointerType === "touch") touchPtsRef.current.set(e.pointerId, { x: cssP.x, y: cssP.y });
      if (pointersRef.current.size === 2 && ruler.type !== "none" && !ruler.locked) {
        const [a, b] = Array.from(pointersRef.current.values());
        gestureRef.current = {
          active: true,
          dist: Math.hypot(b.x - a.x, b.y - a.y) || 1,
          angle: Math.atan2(b.y - a.y, b.x - a.x),
          orig: { ...ruler },
        };
        drawingRef.current.active = false;
        rulerActionRef.current = { mode: null, startX: 0, startY: 0, orig: ruler };
        return;
      }
      // Two-finger pinch-zoom / pan of the view
      if (touchPtsRef.current.size === 2) {
        const [a, b] = Array.from(touchPtsRef.current.values());
        const v = viewRef.current;
        viewGestureRef.current = {
          active: true,
          dist: Math.hypot(b.x - a.x, b.y - a.y) || 1,
          cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2,
          zoom, offX: v.offX, offY: v.offY, scale: v.scale,
        };
        drawingRef.current.active = false;
        panModeRef.current = false;
        return;
      }
    }


    // Pan: space-hold, middle-mouse, or move tool
    const isPan = spaceDownRef.current || e.button === 1 || tool === "move";
    if (isPan) {
      panModeRef.current = true;
      drawingRef.current = { active: true, lastX: e.clientX, lastY: e.clientY, startX: e.clientX, startY: e.clientY, pts: [] };
      return;
    }

    // eslint-disable-next-line prefer-const
    let { x, y } = eventToCanvas(e);

    // ---- Ruler manipulation (handles / move) ----
    if (ruler.type !== "none" && !ruler.locked) {
      const tol = 14 / (viewRef.current.scale || 1);
      const hit = rulerHandles(ruler).find(h => Math.hypot(x - h.x, y - h.y) <= tol);
      if (hit) {
        rulerActionRef.current = { mode: hit.id, startX: x, startY: y, orig: { ...ruler } };
        drawingRef.current = { active: true, lastX: x, lastY: y, startX: x, startY: y, pts: [] };
        return;
      }
      if (Math.hypot(x - ruler.cx, y - ruler.cy) <= tol * 1.4) {
        rulerActionRef.current = { mode: "move", startX: x, startY: y, orig: { ...ruler } };
        drawingRef.current = { active: true, lastX: x, lastY: y, startX: x, startY: y, pts: [] };
        return;
      }
    }

    const frame = frames[currentFrame];
    if (!frame) return;
    const layer = frame.layers[frame.activeLayer];
    if (!layer) return;


    // ---- Magic wand ----
    if (tool === "magicwand") {
      commitFloating();
      const mask = magicWandMask(layer.canvas, Math.floor(x), Math.floor(y), wandTolerance, wandContiguous);
      const bb = mask ? maskBBox(mask) : null;
      if (!mask || !bb) { setSelection(null); selectionRef.current = null; toast("Nothing selected"); return; }
      const sel: Selection = { kind: "mask", mask, bbox: bb };
      selectionRef.current = sel;
      setSelection(sel);
      focusAreaRef.current = "canvas";
      render();
      return;
    }

    // ---- Selection / Lasso ----
    if (tool === "select" || tool === "lasso") {
      // If clicking inside floating -> start moving it
      if (floatingRef.current) {
        const f = floatingRef.current;
        if (x >= f.x && y >= f.y && x <= f.x + f.canvas.width && y <= f.y + f.canvas.height) {
          selActionRef.current = { mode: "move-floating", startX: x, startY: y, origFloatX: f.x, origFloatY: f.y };
          drawingRef.current = { active: true, lastX: x, lastY: y, startX: x, startY: y, pts: [] };
          return;
        }
        commitFloating();
      }
      // If existing selection and click inside -> cut to floating and start moving
      if (selectionRef.current && selectionInside(selectionRef.current, x, y)) {
        const fl = extractSelectionToFloating(selectionRef.current);
        if (fl) {
          floatingRef.current = fl; setFloating(fl);
          selectionRef.current = null; setSelection(null);
          selActionRef.current = { mode: "move-floating", startX: x, startY: y, origFloatX: fl.x, origFloatY: fl.y };
          drawingRef.current = { active: true, lastX: x, lastY: y, startX: x, startY: y, pts: [] };
          return;
        }
      }
      // Click outside any selection -> clear and start new
      if (selectionRef.current) { selectionRef.current = null; setSelection(null); }
      if (tool === "select") {
        const sel: Selection = { kind: "rect", x, y, w: 0, h: 0 };
        selectionRef.current = sel; setSelection(sel);
        selActionRef.current = { mode: "new-rect", startX: x, startY: y };
      } else {
        const pts = [{ x, y }];
        const sel: Selection = { kind: "lasso", points: pts, bbox: { x, y, w: 0, h: 0 } };
        selectionRef.current = sel; setSelection(sel);
        selActionRef.current = { mode: "new-lasso", startX: x, startY: y, pts };
      }
      drawingRef.current = { active: true, lastX: x, lastY: y, startX: x, startY: y, pts: [] };
      return;
    }


    if (tool === "eyedropper") {
      const ctx = layer.canvas.getContext("2d")!;
      if (x >= 0 && y >= 0 && x < layer.canvas.width && y < layer.canvas.height) {
        const data = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
        if (data[3] > 0) updateColor(rgbToHex(data[0], data[1], data[2]));
      }
      return;
    }
    if (tool === "text") {
      // If already editing, commit first, then place new cursor at click.
      if (textEditing) commitTextRef.current?.();
      setTextEditing({ canvasX: x, canvasY: y, value: "" });
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
    if (ruler.type !== "none" && ruler.type !== "perspective") {
      const sp = snapToRuler(ruler, x, y, x, y);
      x = sp.x; y = sp.y;
    }
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

    if (pointersRef.current.has(e.pointerId)) {
      const pc = eventToCanvas(e);
      pointersRef.current.set(e.pointerId, { x: pc.x, y: pc.y });
    }
    if (touchPtsRef.current.has(e.pointerId)) touchPtsRef.current.set(e.pointerId, { x: cssP.x, y: cssP.y });

    // Two-finger pinch-zoom + pan of the canvas view
    const vg = viewGestureRef.current;
    if (vg.active && touchPtsRef.current.size >= 2) {
      const [a, b] = Array.from(touchPtsRef.current.values()).slice(0, 2);
      const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const v = viewRef.current;
      const newZoom = Math.max(0.05, Math.min(20, vg.zoom * (dist / vg.dist)));
      const fitScale = Math.min(v.cssW / dims.w, v.cssH / dims.h);
      const newScale = fitScale * newZoom;
      const worldX = (vg.cx - vg.offX) / vg.scale;
      const worldY = (vg.cy - vg.offY) / vg.scale;
      const newOffX = mx - worldX * newScale;
      const newOffY = my - worldY * newScale;
      setZoom(newZoom);
      setPan({ x: newOffX - (v.cssW - dims.w * newScale) / 2, y: newOffY - (v.cssH - dims.h * newScale) / 2 });
      return;
    }



    // Two-finger gesture: rotate + pinch-scale the ruler
    const g = gestureRef.current;
    if (g.active && pointersRef.current.size >= 2) {
      const [a, b] = Array.from(pointersRef.current.values()).slice(0, 2);
      const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const k = Math.max(0.2, Math.min(6, dist / g.dist));
      setRuler({
        ...g.orig,
        angle: g.orig.angle + (ang - g.angle),
        w: Math.max(20, g.orig.w * k),
        h: Math.max(20, g.orig.h * k),
      });
      render();
      return;
    }

    const d = drawingRef.current;
    if (!d.active) return;

    if (panModeRef.current) {
      setPan((p) => ({ x: p.x + (e.clientX - d.lastX), y: p.y + (e.clientY - d.lastY) }));
      drawingRef.current.lastX = e.clientX;
      drawingRef.current.lastY = e.clientY;
      return;
    }

    // Ruler handle drag
    if (rulerActionRef.current.mode) {
      const { x: gx, y: gy } = eventToCanvas(e);
      const a = rulerActionRef.current;
      const o = a.orig;
      if (a.mode === "move" || a.mode === "vp") {
        setRuler({ ...o, cx: o.cx + (gx - a.startX), cy: o.cy + (gy - a.startY) });
      } else if (a.mode === "rot") {
        setRuler({ ...o, angle: Math.atan2(gy - o.cy, gx - o.cx) + Math.PI / 2 });
      } else if (a.mode === "start" || a.mode === "end") {
        const fixedLocalX = a.mode === "start" ? o.w / 2 : -o.w / 2;
        const fixed = rulerToWorld(o, fixedLocalX, 0);
        const ncx = (fixed.x + gx) / 2, ncy = (fixed.y + gy) / 2;
        const len = Math.hypot(gx - fixed.x, gy - fixed.y);
        const ang = a.mode === "end"
          ? Math.atan2(gy - fixed.y, gx - fixed.x)
          : Math.atan2(fixed.y - gy, fixed.x - gx);
        setRuler({ ...o, cx: ncx, cy: ncy, w: Math.max(10, len), angle: ang });
      } else {
        const p = rulerToLocal(o, gx, gy);
        setRuler({ ...o, w: Math.max(20, Math.abs(p.x) * 2), h: Math.max(20, Math.abs(p.y) * 2) });
      }
      render();
      return;
    }



    // Selection drag update
    if (selActionRef.current.mode) {
      const { x: cx, y: cy } = eventToCanvas(e);
      const s = selActionRef.current;
      if (s.mode === "new-rect") {
        const nx = Math.min(s.startX, cx), ny = Math.min(s.startY, cy);
        const nw = Math.abs(cx - s.startX), nh = Math.abs(cy - s.startY);
        const sel: Selection = { kind: "rect", x: nx, y: ny, w: nw, h: nh };
        selectionRef.current = sel; setSelection(sel);
      } else if (s.mode === "new-lasso" && s.pts) {
        const last = s.pts[s.pts.length - 1];
        if (Math.hypot(cx - last.x, cy - last.y) > 1) {
          s.pts.push({ x: cx, y: cy });
          const xs = s.pts.map(p => p.x), ys = s.pts.map(p => p.y);
          const bx = Math.min(...xs), by = Math.min(...ys);
          const sel: Selection = { kind: "lasso", points: s.pts.slice(), bbox: { x: bx, y: by, w: Math.max(...xs) - bx, h: Math.max(...ys) - by } };
          selectionRef.current = sel; setSelection(sel);
        }
      } else if (s.mode === "move-floating" && floatingRef.current) {
        const dx = cx - s.startX, dy = cy - s.startY;
        const nf: Floating = { canvas: floatingRef.current.canvas, x: (s.origFloatX ?? 0) + dx, y: (s.origFloatY ?? 0) + dy };
        floatingRef.current = nf; setFloating(nf);
      }
      return;
    }


    const frame = frames[currentFrame];
    if (!frame) return;
    const layer = frame.layers[frame.activeLayer];
    if (!layer || layer.locked) return;

    const raw = eventToCanvas(e);
    let x = raw.x, y = raw.y;
    const guided = ruler.type !== "none" && !isShapeTool(tool);
    if (guided) {
      const sp = snapToRuler(ruler, x, y, d.startX, d.startY);
      x = sp.x; y = sp.y;
    }
    const ctx = layer.canvas.getContext("2d")!;
    drawingRef.current.curX = x; drawingRef.current.curY = y;

    if (isShapeTool(tool)) {
      if (d.snapshot) ctx.putImageData(d.snapshot, 0, 0);
      drawShape(ctx, tool, d.startX, d.startY, x, y, e.shiftKey, e.altKey);
      render();
      return;
    }

    let nx = x, ny = y;
    if (smoothing > 0 && !guided) {
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
    pointersRef.current.delete(e.pointerId);
    touchPtsRef.current.delete(e.pointerId);
    if (viewGestureRef.current.active && touchPtsRef.current.size < 2) {
      viewGestureRef.current.active = false;
      drawingRef.current.active = false;
    }
    if (gestureRef.current.active && pointersRef.current.size < 2) {
      gestureRef.current = { active: false, dist: 1, angle: 0, orig: ruler };
    }

    if (rulerActionRef.current.mode) {
      rulerActionRef.current = { mode: null, startX: 0, startY: 0, orig: ruler };
      drawingRef.current.active = false;
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* noop */ }
      render();
      return;
    }
    if (!drawingRef.current.active) return;
    drawingRef.current.active = false;
    panModeRef.current = false;
    if (airbrushTimerRef.current) { window.clearInterval(airbrushTimerRef.current); airbrushTimerRef.current = null; }
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    // Finalize selection actions
    if (selActionRef.current.mode) {
      const m = selActionRef.current.mode;
      if (m === "new-rect" && selectionRef.current?.kind === "rect") {
        if (selectionRef.current.w < 2 || selectionRef.current.h < 2) { selectionRef.current = null; setSelection(null); }
      }
      if (m === "new-lasso" && selectionRef.current?.kind === "lasso") {
        if (selectionRef.current.points.length < 3) { selectionRef.current = null; setSelection(null); }
      }
      selActionRef.current = { mode: null, startX: 0, startY: 0 };
      render();
      return;
    }
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


  // ------------- Frame selection, frame clipboard, layer & art clipboard ops -------------
  const rebuildAllThumbs = () => {
    setThumbs({});
    setTimeout(() => { framesRef.current.forEach((_, i) => buildThumb(i)); }, 30);
  };
  const selectFrameAt = (i: number, ctrl: boolean, shift: boolean) => {
    focusAreaRef.current = "timeline";
    setSelectedFrames(prev => {
      if (ctrl) return prev.includes(i) ? prev.filter(x => x !== i) : [...prev, i].sort((a, b) => a - b);
      if (shift) {
        const anchor = prev.length ? prev[0] : currentRef.current;
        const a = Math.min(anchor, i), b = Math.max(anchor, i);
        const out: number[] = [];
        for (let j = a; j <= b; j++) out.push(j);
        return out;
      }
      return [i];
    });
    setCurrentFrame(i);
  };
  const selectAllFrames = () => { focusAreaRef.current = "timeline"; setSelectedFrames(framesRef.current.map((_, i) => i)); };
  const insertFramesAt = (at: number, newFrames: Frame[]) => {
    if (!newFrames.length) return;
    const pos = Math.max(0, Math.min(at, framesRef.current.length));
    setFrames(fs => { const arr = [...fs]; arr.splice(pos, 0, ...newFrames); return arr; });
    setCurrentFrame(pos + newFrames.length - 1);
    setSelectedFrames(newFrames.map((_, k) => pos + k));
    rebuildAllThumbs();
  };
  const deleteFrames = (idxs: number[], silent = false) => {
    const list = (idxs.length ? idxs : [currentRef.current]).slice().sort((a, b) => a - b);
    const remaining = framesRef.current.length - list.length;
    if (remaining < 1) { if (!silent) toast("Can't delete every frame"); return; }
    setFrames(fs => fs.filter((_, i) => !list.includes(i)));
    const next = Math.max(0, Math.min(list[0], remaining - 1));
    setCurrentFrame(next);
    setSelectedFrames([next]);
    rebuildAllThumbs();
    if (!silent) toast("Frame deleted");
  };
  const copyFrames = (idxs: number[], cut: boolean) => {
    const list = (idxs.length ? idxs : [currentRef.current]).slice().sort((a, b) => a - b);
    frameClipRef.current = list.map(i => framesRef.current[i]).filter(Boolean).map(f => cloneFrame(f, dims.w, dims.h));
    setFrameClipCount(frameClipRef.current.length);
    toast(cut ? "Frame cut!" : "Frame copied!");
    if (cut) deleteFrames(list, true);
  };
  const pasteFrames = (inPlace: boolean) => {
    const clip = frameClipRef.current;
    if (!clip.length) { toast("Frame clipboard empty"); return; }
    const copies = clip.map(f => cloneFrame(f, dims.w, dims.h));
    insertFramesAt(inPlace ? currentRef.current : currentRef.current + 1, copies);
    toast("Frame pasted!");
  };
  const duplicateFrames = (idxs: number[]) => {
    const list = (idxs.length ? idxs : [currentRef.current]).slice().sort((a, b) => a - b);
    const copies = list.map(i => framesRef.current[i]).filter(Boolean).map(f => cloneFrame(f, dims.w, dims.h));
    insertFramesAt(list[list.length - 1] + 1, copies);
    toast("Duplicated!");
  };
  const insertBlankFrame = (before: boolean) => {
    insertFramesAt(before ? currentRef.current : currentRef.current + 1, [makeFrame(dims.w, dims.h)]);
    toast("Blank frame inserted");
  };
  const reverseSelectedFrames = () => {
    const list = selectedFramesRef.current.slice().sort((a, b) => a - b);
    if (list.length < 2) { toast("Select 2+ frames first"); return; }
    setFrames(fs => {
      const arr = [...fs];
      const picked = list.map(i => arr[i]).reverse();
      list.forEach((idx, k) => { arr[idx] = picked[k]; });
      return arr;
    });
    rebuildAllThumbs();
    toast("Frames reversed");
  };
  const moveFrameBy = (delta: number) => {
    const from = currentRef.current;
    const to = from + delta;
    if (to < 0 || to >= framesRef.current.length) return;
    moveFrame(from, to);
    setSelectedFrames([to]);
  };

  // ---------- Layer operations ----------
  const layerToCanvas = (l: Layer) => {
    const c = makeCanvas(dims.w, dims.h);
    c.getContext("2d")!.drawImage(l.canvas, 0, 0);
    return c;
  };
  const setClipCanvas = (c: HTMLCanvasElement) => {
    clipboardRef.current = c;
    clipOriginRef.current = { x: 0, y: 0 };
    try { setClipThumb(c.toDataURL("image/png")); } catch { setClipThumb(null); }
  };
  const copyLayerContents = (idx: number) => {
    const f = framesRef.current[currentRef.current];
    const l = f?.layers[idx];
    if (!l) return;
    setClipCanvas(layerToCanvas(l));
    toast("Layer copied!");
  };
  const pasteAsNewLayer = () => {
    const cb = clipboardRef.current;
    if (!cb) { toast("Clipboard empty"); return; }
    setFrames(fs => fs.map((f, i) => {
      if (i !== currentRef.current) return f;
      const nl = makeLayer(dims.w, dims.h, `Layer ${f.layers.length + 1}`);
      nl.canvas.getContext("2d")!.drawImage(cb, clipOriginRef.current.x, clipOriginRef.current.y);
      return { ...f, layers: [...f.layers, nl], activeLayer: f.layers.length };
    }));
    setTimeout(() => buildThumb(currentRef.current), 30);
    toast("Pasted!");
  };
  const mergeDown = (idx: number) => {
    if (idx <= 0) { toast("No layer below"); return; }
    pushHistory("Merge down");
    setFrames(fs => fs.map((f, i) => {
      if (i !== currentRef.current) return f;
      const below = f.layers[idx - 1], top = f.layers[idx];
      if (!below || !top) return f;
      const ctx = below.canvas.getContext("2d")!;
      ctx.save();
      ctx.globalAlpha = top.opacity;
      ctx.globalCompositeOperation = blendCss(top.blend);
      ctx.drawImage(top.canvas, 0, 0);
      ctx.restore();
      const layers = f.layers.filter((_, j) => j !== idx);
      return { ...f, layers, activeLayer: Math.max(0, idx - 1) };
    }));
    setTimeout(() => buildThumb(currentRef.current), 30);
    toast("Layers merged");
  };
  const flattenInto = (onlyVisible: boolean) => {
    pushHistory(onlyVisible ? "Merge visible" : "Flatten");
    setFrames(fs => fs.map((f, i) => {
      if (i !== currentRef.current) return f;
      const merged = makeLayer(dims.w, dims.h, onlyVisible ? "Merged" : "Flattened");
      const ctx = merged.canvas.getContext("2d")!;
      f.layers.forEach(l => {
        if (onlyVisible && !l.visible) return;
        ctx.save();
        ctx.globalAlpha = l.opacity;
        ctx.globalCompositeOperation = blendCss(l.blend);
        ctx.drawImage(l.canvas, 0, 0);
        ctx.restore();
      });
      const kept = onlyVisible ? f.layers.filter(l => !l.visible) : [];
      return { ...f, layers: [...kept, merged], activeLayer: kept.length };
    }));
    setTimeout(() => buildThumb(currentRef.current), 30);
    toast(onlyVisible ? "Visible layers merged" : "Flattened");
  };
  const mergeVisible = () => flattenInto(true);
  const flattenAll = () => flattenInto(false);
  const clearLayer = (idx: number) => {
    const f = framesRef.current[currentRef.current];
    const l = f?.layers[idx];
    if (!l) return;
    pushHistory("Clear layer");
    l.canvas.getContext("2d")!.clearRect(0, 0, dims.w, dims.h);
    buildThumb(currentRef.current);
    render();
    toast("Layer cleared");
  };

  // ---------- Art selection operations ----------
  const applySelection = (sel: Selection | null) => {
    selectionRef.current = sel;
    setSelection(sel);
    render();
  };
  const selectAllLayer = () => {
    commitFloating();
    applySelection({ kind: "rect", x: 0, y: 0, w: dims.w, h: dims.h });
    toast("Selected all");
  };
  const deselect = () => { escapeSelection(); };
  const invertSelection = () => {
    const sel = selectionRef.current;
    if (!sel) return;
    const inv = invertMask(selMask(sel));
    const bbox = maskBBox(inv);
    if (!bbox) return;
    applySelection({ kind: "mask", mask: inv, bbox });
  };
  const modifySelection = (op: "expand" | "contract" | "border" | "feather", px: number) => {
    const sel = selectionRef.current;
    if (!sel) return;
    const base = selMask(sel);
    const out = op === "expand" ? expandMask(base, px)
      : op === "contract" ? contractMask(base, px)
      : op === "border" ? borderMask(base, px)
      : featherMask(base, px);
    const bbox = maskBBox(out);
    if (!bbox) return;
    applySelection({ kind: "mask", mask: out, bbox });
  };
  const fillSelection = () => {
    const sel = selectionRef.current;
    const frame = framesRef.current[currentRef.current];
    const l = frame?.layers[frame.activeLayer];
    if (!sel || !l || l.locked) return;
    pushHistory("Fill selection");
    const mask = selMask(sel);
    const tmp = makeCanvas(dims.w, dims.h);
    const tctx = tmp.getContext("2d")!;
    tctx.fillStyle = color;
    tctx.fillRect(0, 0, dims.w, dims.h);
    tctx.globalCompositeOperation = "destination-in";
    tctx.drawImage(mask, 0, 0);
    l.canvas.getContext("2d")!.drawImage(tmp, 0, 0);
    buildThumb(currentRef.current);
    render();
  };
  const ensureFloating = (): Floating | null => {
    if (floatingRef.current) return floatingRef.current;
    const sel = selectionRef.current;
    if (!sel) return null;
    const fl = extractSelectionToFloating(sel);
    if (fl) { floatingRef.current = fl; setFloating(fl); applySelection(null); }
    return fl;
  };
  const replaceFloating = (canvas: HTMLCanvasElement, x: number, y: number) => {
    const fl: Floating = { canvas, x, y };
    floatingRef.current = fl;
    setFloating(fl);
    render();
  };
  const flipSelection = (axis: "h" | "v") => {
    const fl = ensureFloating();
    if (!fl) return;
    const out = makeCanvas(fl.canvas.width, fl.canvas.height);
    const ctx = out.getContext("2d")!;
    ctx.translate(axis === "h" ? out.width : 0, axis === "v" ? out.height : 0);
    ctx.scale(axis === "h" ? -1 : 1, axis === "v" ? -1 : 1);
    ctx.drawImage(fl.canvas, 0, 0);
    replaceFloating(out, fl.x, fl.y);
  };
  const rotateSelection = (deg: number) => {
    const fl = ensureFloating();
    if (!fl) return;
    const rad = (deg * Math.PI) / 180;
    const w = fl.canvas.width, h = fl.canvas.height;
    const nw = Math.abs(Math.cos(rad)) * w + Math.abs(Math.sin(rad)) * h;
    const nh = Math.abs(Math.sin(rad)) * w + Math.abs(Math.cos(rad)) * h;
    const out = makeCanvas(Math.ceil(nw), Math.ceil(nh));
    const ctx = out.getContext("2d")!;
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(rad);
    ctx.drawImage(fl.canvas, -w / 2, -h / 2);
    replaceFloating(out, fl.x + (w - out.width) / 2, fl.y + (h - out.height) / 2);
  };
  const scaleFloatingBy = (factor: number) => {
    const fl = ensureFloating();
    if (!fl) return;
    const nw = Math.max(1, Math.round(fl.canvas.width * factor));
    const nh = Math.max(1, Math.round(fl.canvas.height * factor));
    const out = makeCanvas(nw, nh);
    const ctx = out.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(fl.canvas, 0, 0, nw, nh);
    replaceFloating(out, fl.x + (fl.canvas.width - nw) / 2, fl.y + (fl.canvas.height - nh) / 2);
  };
  const nudgeSelection = (dx: number, dy: number) => {
    if (floatingRef.current) {
      const f = floatingRef.current;
      replaceFloating(f.canvas, f.x + dx, f.y + dy);
      return true;
    }
    const sel = selectionRef.current;
    if (!sel) return false;
    const fl = ensureFloating();
    if (!fl) return false;
    replaceFloating(fl.canvas, fl.x + dx, fl.y + dy);
    return true;
  };
  const pasteInPlace = () => {
    const cb = clipboardRef.current;
    if (!cb) { toast("Clipboard empty"); return; }
    commitFloating();
    const o = clipOriginRef.current;
    const fitsOnCanvas = o.x < dims.w && o.y < dims.h && o.x + cb.width > 0 && o.y + cb.height > 0;
    const x = fitsOnCanvas ? o.x : (dims.w - cb.width) / 2;
    const y = fitsOnCanvas ? o.y : (dims.h - cb.height) / 2;
    replaceFloating(cb, x, y);
    applySelection(null);
    toast("Pasted!");
  };
  const duplicateInPlace = () => {
    const sel = selectionRef.current;
    const fl = floatingRef.current;
    if (fl) {
      const copy = makeCanvas(fl.canvas.width, fl.canvas.height);
      copy.getContext("2d")!.drawImage(fl.canvas, 0, 0);
      commitFloating();
      replaceFloating(copy, fl.x, fl.y);
      toast("Duplicated!");
      return;
    }
    if (!sel) { toast("Nothing selected"); return; }
    copySelection(false);
    const cb = clipboardRef.current;
    if (!cb) return;
    const bbox = selBBox(sel);
    replaceFloating(cb, bbox.x, bbox.y);
    applySelection(null);
    toast("Duplicated!");
  };
  const pasteToFrames = (indices: number[]) => {
    const cb = clipboardRef.current;
    if (!cb) { toast("Clipboard empty"); return; }
    const o = clipOriginRef.current;
    indices.forEach(i => {
      const f = framesRef.current[i];
      const l = f?.layers[Math.min(f.activeLayer, f.layers.length - 1)];
      if (!l || l.locked) return;
      l.canvas.getContext("2d")!.drawImage(cb, o.x, o.y);
    });
    rebuildAllThumbs();
    render();
    toast(`Pasted to ${indices.length} frame(s)`);
  };

  // ---------- Long-press helper (mobile context menus) ----------
  const startLongPress = (e: React.PointerEvent, fn: () => void) => {
    if (e.pointerType === "mouse") return;
    cancelLongPress();
    longPressRef.current = window.setTimeout(() => {
      longPressRef.current = null;
      if (typeof navigator !== "undefined" && navigator.vibrate) { try { navigator.vibrate(15); } catch { /* ignore */ } }
      fn();
    }, 500);
  };
  const cancelLongPress = () => {
    if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null; }
  };

  kbRef.current = {
    selectedFrames: () => selectedFramesRef.current,
    copyFrames, pasteFrames, duplicateFrames, deleteFrames, selectAllFrames,
    selectAllLayer, deselect, invertSelection, duplicateInPlace, pasteInPlace,
    nudge: nudgeSelection, toast,
  };

  // ------------- Keyboard -------------
  // Keep imperative refs in sync so document listeners never see stale closures.
  undoRef.current = undo;
  redoRef.current = redo;
  deleteSelRef.current = deleteSelection;
  copySelRef.current = copySelection;
  pasteRef.current = pasteClipboard;
  commitFloatRef.current = commitFloating;
  escapeRef.current = escapeSelection;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      const inField = tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || (tgt as HTMLElement).isContentEditable);
      if (e.key === " " && !inField) { e.preventDefault(); if (!spaceDownRef.current) { spaceDownRef.current = true; setSpaceDown(true); } return; }
      // Undo/Redo must work even in fields for common expectation? Keep out of fields.
      if (inField) return;
      const kb = kbRef.current;
      if (!kb) return;
      const frameCtx = focusAreaRef.current === "timeline";
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === "z" && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); undoRef.current(); return; }
        if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); e.stopPropagation(); redoRef.current(); return; }
        if (k === "c") { e.preventDefault(); if (frameCtx) kb.copyFrames(kb.selectedFrames(), false); else { copySelRef.current(false); kb.toast("Art copied!"); } return; }
        if (k === "x") { e.preventDefault(); if (frameCtx) kb.copyFrames(kb.selectedFrames(), true); else { copySelRef.current(true); kb.toast("Art cut!"); } return; }
        if (k === "v") {
          e.preventDefault();
          if (frameCtx) kb.pasteFrames(false);
          else if (e.shiftKey) kb.pasteInPlace();
          else { pasteRef.current(); kb.toast("Pasted!"); }
          return;
        }
        if (k === "d") { e.preventDefault(); if (frameCtx) kb.duplicateFrames(kb.selectedFrames()); else kb.deselect(); return; }
        if (k === "j") { e.preventDefault(); kb.duplicateInPlace(); return; }
        if (k === "a") { e.preventDefault(); if (frameCtx) kb.selectAllFrames(); else kb.selectAllLayer(); return; }
        if (k === "i" && e.shiftKey) { e.preventDefault(); kb.invertSelection(); return; }
        if (k === "s") { e.preventDefault(); saveNowRef.current?.(); return; }
        if (k === "n") { e.preventDefault(); setShowNew(true); return; }
        if (e.key === "=" || e.key === "+") { e.preventDefault(); setZoom(z => Math.min(20, z * 1.2)); return; }
        if (e.key === "-" || e.key === "_") { e.preventDefault(); setZoom(z => Math.max(0.05, z / 1.2)); return; }
        if (e.key === "0") { e.preventDefault(); setZoom(1); setPan({ x: 0, y: 0 }); return; }
        if (k === "f" && e.shiftKey) { e.preventDefault(); fitToScreen(); return; }
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (frameCtx) kb.deleteFrames(kb.selectedFrames()); else deleteSelRef.current();
        return;
      }
      if (e.key.startsWith("Arrow") && !frameCtx) {
        const step = e.shiftKey ? 10 : 1;
        const d = e.key === "ArrowLeft" ? [-step, 0] : e.key === "ArrowRight" ? [step, 0] : e.key === "ArrowUp" ? [0, -step] : [0, step];
        if (selectionRef.current || floatingRef.current) { e.preventDefault(); kb.nudge(d[0], d[1]); return; }
      }
      if (e.key === "Escape") { e.preventDefault(); escapeRef.current(); return; }
      if (e.key === "Enter") { commitFloatRef.current(); return; }
      const k = e.key.toLowerCase();
      if (k === "r") { toggleRulerRef.current?.(); return; }
      const map: Record<string, Tool> = {
        p: "pen", n: "pencil", b: "brush", m: "magicwand", y: "marker", a: "airbrush", i: "ink", c: "crayon", h: "charcoal",
        e: "eraserHard", g: "bucket", k: "rect", o: "ellipse", l: "lasso", s: "select", v: "move", t: "text",
      };
      if (map[k]) { focusAreaRef.current = "canvas"; setTool(map[k]); return; }
      if (e.key === "[") setSize(s => Math.max(1, s - 2));
      if (e.key === "]") setSize(s => Math.min(200, s + 2));
      if (!e.shiftKey && !e.altKey && /^[0-9]$/.test(e.key)) {
        const n = parseInt(e.key, 10);
        setOpacity(n === 0 ? 1 : n / 10);
        return;
      }
      if (e.altKey) setTool("eyedropper");
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === " ") { spaceDownRef.current = false; setSpaceDown(false); }
    };
    document.addEventListener("keydown", onKey, { capture: true });
    document.addEventListener("keyup", onKeyUp, { capture: true });
    return () => {
      document.removeEventListener("keydown", onKey, { capture: true } as unknown as EventListenerOptions);
      document.removeEventListener("keyup", onKeyUp, { capture: true } as unknown as EventListenerOptions);
    };
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
    <div className={"toonvo " + bp}>
      {/* Top bar */}
      <header className="topbar">
        {isTouchLayout && (
          <button className="tv-hamburger" aria-label="Menu" onClick={() => setDrawerOpen(o => !o)}>☰</button>
        )}
        <div className="brand">
          <span className="logo">●</span> TOONVO
        </div>
        {isTouchLayout && (
          <div className="tv-mobtop">
            <button onClick={undo} disabled={history.length === 0} title="Undo">↩</button>
            <button onClick={redo} disabled={redoStack.length === 0} title="Redo">↪</button>
            <button onClick={saveNow} title="Save">💾</button>
            <button
              className="tv-topswatch"
              style={{ background: color }}
              title={`Current color ${color}`}
              aria-label={`Current color ${color}, open color picker`}
              onClick={() => setColorPopup(v => !v)}
            />
            {isTablet && <button className="primary" onClick={() => setShowExport(true)} title="Export">⬆ Export</button>}
            <button onClick={() => setMobileMore(v => !v)} title="More">⋮</button>
          </div>
        )}
        {(clipThumb || frameClipCount > 0) && (
          <button
            className="tv-clipind"
            title="Clipboard"
            onClick={() => setShowClipInfo(v => !v)}
            onMouseEnter={() => setShowClipInfo(true)}
          >
            📋{clipThumb && <img src={clipThumb} alt="Clipboard preview" />}{frameClipCount > 0 && <span className="tv-clipcount">{frameClipCount}f</span>}
          </button>
        )}
        <div className="filemenu">
          <button onClick={() => setShowNew(true)}>New</button>
          <button onClick={async () => { setSavedList(await listProjects()); setShowProjects(true); }}>Open</button>
          <button onClick={saveNow}>Save</button>
          <button className="primary" onClick={() => setShowExport(true)} title="Export MP4 / GIF / Sprite / PNG">⬆ Export</button>
          <button onClick={exportToonvo} title="Download project file">.toonvo</button>
          <button onClick={() => bgFileRef.current?.click()} title="Import Background Image">🖼️＋ BG</button>
          <button onClick={() => refFileRef.current?.click()} title="Import Reference Image" disabled={refImages.length >= 3}>👁 Ref</button>
          <button onClick={() => audioFileRef.current?.click()} title="Import Audio" disabled={audioTracks.length >= 3}>🎵 Audio</button>
          <input ref={bgFileRef} type="file" accept="image/jpeg,image/jpg,image/png,image/webp,image/gif" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) importBgImage(f); e.target.value = ""; }} />
          <input ref={refFileRef} type="file" accept="image/jpeg,image/jpg,image/png,image/webp" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) importRefImage(f); e.target.value = ""; }} />
          <input ref={audioFileRef} type="file" accept="audio/mpeg,audio/mp3,audio/wav,audio/aac,audio/ogg,audio/mp4,audio/x-m4a,.m4a" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) importAudio(f); e.target.value = ""; }} />
        </div>
        <div className="toolopts">
          <span style={{ fontSize: 11, color: "#8b8ba8", textTransform: "uppercase", letterSpacing: 1 }}>
            {TOOL_GROUPS.flatMap(g => g.tools).find(t => t.id === tool)?.label ?? tool}
          </span>
          {tool === "magicwand" && (
            <>
              <label>Tolerance <input type="range" min={0} max={100} value={wandTolerance} onChange={e => setWandTolerance(+e.target.value)} /><span style={{ minWidth: 28 }}>{wandTolerance}</span></label>
              <label><input type="checkbox" checked={wandContiguous} onChange={e => setWandContiguous(e.target.checked)} /> Contiguous</label>
            </>
          )}
          {["pen","pencil","brush","marker","airbrush","ink","crayon","charcoal","eraserHard","eraserSoft","bucket"].includes(tool) && (
            <>
              <label>Size <input type="range" min={1} max={300} value={size} onChange={e => setSize(+e.target.value)} /><input className="num" type="number" value={size} onChange={e => setSize(+e.target.value)} /></label>
              <label>Opacity <input type="range" min={0} max={100} value={Math.round(opacity*100)} onChange={e => setOpacity(+e.target.value/100)} /><span style={{ minWidth: 30 }}>{Math.round(opacity*100)}%</span></label>
              {tool !== "bucket" && <label>Smooth <input type="range" min={0} max={10} value={smoothing} onChange={e => setSmoothing(+e.target.value)} /></label>}
              {(tool === "airbrush" || tool === "brush") && <label>Hard <input type="range" min={0} max={100} value={Math.round(hardness*100)} onChange={e => setHardness(+e.target.value/100)} /></label>}
              {(tool === "airbrush" || tool === "brush" || tool === "marker") && <label>Flow <input type="range" min={1} max={100} value={Math.round(flow*100)} onChange={e => setFlow(+e.target.value/100)} /></label>}
            </>
          )}
          {isShapeTool(tool) && (
            <>
              <label>Stroke <input type="range" min={0} max={50} value={size} onChange={e => setSize(+e.target.value)} /><span style={{ minWidth: 24 }}>{size}px</span></label>
              <label>Opacity <input type="range" min={0} max={100} value={Math.round(opacity*100)} onChange={e => setOpacity(+e.target.value/100)} /><span style={{ minWidth: 30 }}>{Math.round(opacity*100)}%</span></label>
              <label>Stroke <input type="color" value={color} onChange={e => setColor(e.target.value)} /></label>
              {tool !== "line" && <label>Fill <input type="color" value={shapeFill} onChange={e => setShapeFill(e.target.value)} /></label>}
              {tool !== "line" && (
                <label>Style
                  <select value={shapeStyle} onChange={e => setShapeStyle(e.target.value as "fill" | "stroke" | "both")}>
                    <option value="stroke">Outline</option>
                    <option value="fill">Filled</option>
                    <option value="both">Filled + Outline</option>
                  </select>
                </label>
              )}
              {tool === "rect" && <label>Corner <input type="range" min={0} max={200} value={cornerRadius} onChange={e => setCornerRadius(+e.target.value)} /><span style={{ minWidth: 24 }}>{cornerRadius}</span></label>}
              {tool === "polygon" && <label>Sides <input type="range" min={3} max={20} value={polygonSides} onChange={e => setPolygonSides(+e.target.value)} /><span style={{ minWidth: 18 }}>{polygonSides}</span></label>}
              {tool === "star" && <label>Points <input type="range" min={3} max={12} value={starPoints} onChange={e => setStarPoints(+e.target.value)} /><span style={{ minWidth: 18 }}>{starPoints}</span></label>}
              {tool === "star" && <label>Inner <input type="range" min={10} max={95} value={Math.round(starInnerRatio*100)} onChange={e => setStarInnerRatio(+e.target.value/100)} /></label>}
              <span style={{ fontSize: 10, color: "#8b8ba8" }}>Shift=constrain · Alt=from center</span>
            </>
          )}
          {tool === "text" && (
            <>
              <label>Font
                <select value={textFont} onChange={e => setTextFont(e.target.value)} style={{ maxWidth: 130 }}>
                  {FONT_FAMILIES.map(f => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
                </select>
              </label>
              <label>Size <input type="number" min={1} max={500} value={textSize} onChange={e => setTextSize(Math.max(1, Math.min(500, +e.target.value || 1)))} style={{ width: 52 }} /></label>
              <button onClick={() => setTextBold(v => !v)} title="Bold" style={{ fontWeight: 700, background: textBold ? "#6c63ff" : undefined }}>B</button>
              <button onClick={() => setTextItalic(v => !v)} title="Italic" style={{ fontStyle: "italic", background: textItalic ? "#6c63ff" : undefined }}>I</button>
              <button onClick={() => setTextUnderline(v => !v)} title="Underline" style={{ textDecoration: "underline", background: textUnderline ? "#6c63ff" : undefined }}>U</button>
              <label>Color <input type="color" value={textColor} onChange={e => setTextColor(e.target.value)} /></label>
              <label>Opacity <input type="range" min={0} max={100} value={Math.round(textOpacity * 100)} onChange={e => setTextOpacity(+e.target.value / 100)} /><span style={{ minWidth: 30 }}>{Math.round(textOpacity * 100)}%</span></label>
              <label>Align
                <select value={textAlign} onChange={e => setTextAlign(e.target.value as "left" | "center" | "right")}>
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                  <option value="right">Right</option>
                </select>
              </label>
              <label title="Letter spacing">L-Sp <input type="range" min={-10} max={40} value={textLetterSpacing} onChange={e => setTextLetterSpacing(+e.target.value)} style={{ width: 60 }} /></label>
              <label title="Line height">Line <input type="range" min={80} max={250} value={Math.round(textLineHeight * 100)} onChange={e => setTextLineHeight(+e.target.value / 100)} style={{ width: 60 }} /></label>
              <button onClick={() => setTextOutlineOn(v => !v)} style={{ background: textOutlineOn ? "#6c63ff" : undefined }} title="Outline">◌ Out</button>
              {textOutlineOn && <>
                <input type="color" value={textOutlineColor} onChange={e => setTextOutlineColor(e.target.value)} title="Outline color" />
                <input type="range" min={1} max={20} value={textOutlineWidth} onChange={e => setTextOutlineWidth(+e.target.value)} title="Outline width" style={{ width: 60 }} />
              </>}
              <button onClick={() => setTextShadowOn(v => !v)} style={{ background: textShadowOn ? "#6c63ff" : undefined }} title="Shadow">◐ Shd</button>
              {textShadowOn && <>
                <input type="color" value={textShadowColor} onChange={e => setTextShadowColor(e.target.value)} title="Shadow color" />
                <label title="Shadow X">X <input type="range" min={-30} max={30} value={textShadowX} onChange={e => setTextShadowX(+e.target.value)} style={{ width: 50 }} /></label>
                <label title="Shadow Y">Y <input type="range" min={-30} max={30} value={textShadowY} onChange={e => setTextShadowY(+e.target.value)} style={{ width: 50 }} /></label>
                <label title="Shadow blur">Blur <input type="range" min={0} max={40} value={textShadowBlur} onChange={e => setTextShadowBlur(+e.target.value)} style={{ width: 50 }} /></label>
              </>}
              <button onClick={() => setTextBgOn(v => !v)} style={{ background: textBgOn ? "#6c63ff" : undefined }} title="Background highlight">▮ BG</button>
              {textBgOn && <>
                <input type="color" value={textBgColor} onChange={e => setTextBgColor(e.target.value)} title="Background color" />
                <input type="range" min={0} max={40} value={textBgPadding} onChange={e => setTextBgPadding(+e.target.value)} title="Background padding" style={{ width: 50 }} />
              </>}
              {textEditing && <button onClick={() => commitTextRef.current?.()} title="Confirm (Esc)" style={{ background: "#3aa856" }}>✓ Apply</button>}
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
                    onClick={() => { setTool(t.id); if (isTablet) showToolPopup(t.id); }}
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
              <button className={"toolbtn " + (ruler.type !== "none" ? "active" : "")} title="Ruler / Guide (R)" onClick={() => toggleRuler()}><span className="ticon">📐</span><span className="tlabel">Ruler</span></button>
            </div>
          </div>
          {ruler.type !== "none" && (
            <div className="onionopts">
              <label>Guide
                <select value={ruler.type} onChange={e => setRulerType(e.target.value as RulerType)}>
                  <option value="line">Straight Line</option>
                  <option value="ellipse">Circle / Oval</option>
                  <option value="rect">Rectangle</option>
                  <option value="perspective">Perspective</option>
                </select>
              </label>
              <button
                className={ruler.mirror !== "none" ? "active" : ""}
                title="Mirror / symmetry across the guide"
                onClick={() => setRuler(r => ({ ...r, mirror: r.mirror === "none" ? "h" : r.mirror === "h" ? "v" : r.mirror === "v" ? "both" : "none" }))}
              >Mirror: {ruler.mirror}</button>
              <button
                className={ruler.locked ? "active" : ""}
                title="Lock guide position"
                onClick={() => setRuler(r => ({ ...r, locked: !r.locked }))}
              >{ruler.locked ? "🔒 Locked" : "🔓 Unlocked"}</button>
              <button onClick={() => setRulerType(ruler.type)}>Reset Position</button>
              <button onClick={() => setRuler(r => ({ ...r, type: "none" }))}>Turn Off</button>
            </div>
          )}
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
            {textEditing && (() => {
              const v = viewRef.current;
              const sx = textEditing.canvasX * v.scale + v.offX;
              const sy = textEditing.canvasY * v.scale + v.offY;
              const displaySize = textSize * v.scale;
              return (
                <textarea
                  autoFocus
                  value={textEditing.value}
                  onChange={e => setTextEditing(te => te ? { ...te, value: e.target.value } : te)}
                  onKeyDown={e => {
                    if (e.key === "Escape") { e.preventDefault(); commitTextRef.current?.(); }
                    // Enter inserts newline (default). Ctrl+Enter also commits.
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitTextRef.current?.(); }
                  }}
                  onBlur={() => commitTextRef.current?.()}
                  placeholder="Type text…"
                  style={{
                    position: "absolute",
                    left: sx, top: sy,
                    transform: textAlign === "center" ? "translateX(-50%)" : textAlign === "right" ? "translateX(-100%)" : undefined,
                    minWidth: Math.max(80, displaySize * 4),
                    minHeight: displaySize * textLineHeight,
                    padding: 2,
                    margin: 0,
                    background: textBgOn ? textBgColor : "rgba(0,0,0,0.08)",
                    color: textColor,
                    opacity: textOpacity,
                    fontFamily: `"${textFont}", sans-serif`,
                    fontSize: displaySize,
                    fontWeight: textBold ? 700 : 400,
                    fontStyle: textItalic ? "italic" : "normal",
                    textDecoration: textUnderline ? "underline" : "none",
                    textAlign,
                    letterSpacing: textLetterSpacing * v.scale,
                    lineHeight: textLineHeight,
                    border: "1px dashed #6c63ff",
                    outline: "none",
                    resize: "none",
                    overflow: "hidden",
                    whiteSpace: "pre",
                    caretColor: textColor,
                    textShadow: textShadowOn ? `${textShadowX * v.scale}px ${textShadowY * v.scale}px ${textShadowBlur * v.scale}px ${textShadowColor}` : undefined,
                    WebkitTextStroke: textOutlineOn ? `${textOutlineWidth * v.scale}px ${textOutlineColor}` : undefined,
                    boxSizing: "content-box",
                  }}
                />
              );
            })()}
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
          <div className={"timeline" + (isTouchLayout ? " tv-mobtimeline" : "")}>
            <div className="playbar">
              {isTouchLayout ? (
                <>
                  <button onClick={undo} disabled={history.length === 0} title="Undo" aria-label="Undo">↩</button>
                  <button onClick={redo} disabled={redoStack.length === 0} title="Redo" aria-label="Redo">↪</button>
                  <button onClick={() => setPlaying(p => !p)} aria-label="Play/Pause">{playing ? "❚❚" : "▶"}</button>
                  <button onClick={() => { setPlaying(false); setCurrentFrame(0); }} aria-label="Stop">■</button>
                </>
              ) : (
                <>
                  <button onClick={undo} disabled={history.length === 0} title="Undo (Ctrl+Z)" style={{ opacity: history.length === 0 ? 0.4 : 1 }}>↶ Undo{history.length > 0 ? ` ${history.length}` : ""}</button>
                  <button onClick={redo} disabled={redoStack.length === 0} title="Redo (Ctrl+Y)" style={{ opacity: redoStack.length === 0 ? 0.4 : 1 }}>↷ Redo{redoStack.length > 0 ? ` ${redoStack.length}` : ""}</button>
                  <span style={{ width: 1, height: 20, background: "var(--line)", margin: "0 4px" }} />
                  <button onClick={() => setPlaying(p => !p)} title="Play/Pause (Space)">{playing ? "❚❚" : "▶"}</button>
                  <button onClick={() => { setPlaying(false); setCurrentFrame(0); }}>■</button>
                  <button className={loop ? "active" : ""} onClick={() => setLoop(l => !l)}>↻</button>
                  <span className="counter">{currentFrame + 1} / {frames.length}</span>
                  <span className="counter">{fps} fps</span>
                  <div className="grow" />
                  <button onClick={() => addFrame(false)}>+ Frame</button>
                  <button onClick={() => addFrame(true)}>Duplicate</button>
                  <button onClick={() => deleteFrame(currentFrame)}>Delete</button>
                </>
              )}
            </div>

            <div className="frames" onPointerDown={() => { focusAreaRef.current = "timeline"; }}>
              {frames.map((f, i) => (
                <div
                  key={i}
                  className={"frameitem " + (i === currentFrame ? "active" : "") + (selectedFrames.includes(i) ? " selected" : "")}
                  onClick={(e) => selectFrameAt(i, e.ctrlKey || e.metaKey, e.shiftKey)}
                  onContextMenu={(e) => { e.preventDefault(); focusAreaRef.current = "timeline"; if (!selectedFramesRef.current.includes(i)) selectFrameAt(i, false, false); setFrameMenu({ x: e.clientX, y: e.clientY, index: i }); }}
                  onPointerDown={(e) => startLongPress(e, () => { focusAreaRef.current = "timeline"; if (!selectedFramesRef.current.includes(i)) selectFrameAt(i, false, false); setFrameMenu({ x: e.clientX, y: e.clientY, index: i }); })}
                  onPointerUp={cancelLongPress}
                  onPointerLeave={cancelLongPress}
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
            {isTouchLayout && (
              <div className="tv-mobframeright">
                <span className="counter">{currentFrame + 1}/{frames.length}</span>
                <button onClick={() => addFrame(false)} aria-label="Add frame">＋</button>
              </div>
            )}
          </div>

        </div>

        {/* Right sidebar */}
        <aside className={"right" + (isTouchLayout && drawerOpen ? " open" : "") + (isMobile ? " tv-drawerleft" : "")}>
          {isTouchLayout && (
            <div className="tv-drawerhead">
              <strong>TOONVO</strong>
              <button aria-label="Close menu" onClick={() => setDrawerOpen(false)}>✕</button>
            </div>
          )}
          {isMobile && (
            <>
              <section className="panel">
                <h3>📁 Project</h3>
                <div className="tv-menugrid">
                  <button onClick={() => { setDrawerOpen(false); setShowNew(true); }}>New project</button>
                  <button onClick={async () => { setSavedList(await listProjects()); setDrawerOpen(false); setShowProjects(true); }}>Open project</button>
                  <button onClick={() => { saveNow(); setDrawerOpen(false); }}>Save</button>
                  <button className="primary" onClick={() => { setDrawerOpen(false); setShowExport(true); }}>Export GIF / MP4 / PNG</button>
                  <button onClick={exportToonvo}>Download .toonvo</button>
                  <button onClick={() => bgFileRef.current?.click()}>Import background</button>
                  <button onClick={() => refFileRef.current?.click()} disabled={refImages.length >= 3}>Import reference</button>
                  <button onClick={() => audioFileRef.current?.click()} disabled={audioTracks.length >= 3}>Import audio</button>
                </div>
              </section>
              <section className="panel">
                <h3>🖊 Tool options</h3>
                <label className="tv-bigslider">Size <b>{size}px</b>
                  <input type="range" min={1} max={300} value={size} onChange={e => setSize(+e.target.value)} />
                </label>
                <label className="tv-bigslider">Opacity <b>{Math.round(opacity * 100)}%</b>
                  <input type="range" min={1} max={100} value={Math.round(opacity * 100)} onChange={e => setOpacity(+e.target.value / 100)} />
                </label>
                <label className="tv-bigslider">Smoothing <b>{smoothing}</b>
                  <input type="range" min={0} max={10} value={smoothing} onChange={e => setSmoothing(+e.target.value)} />
                </label>
                <label className="tv-bigslider">Hardness <b>{Math.round(hardness * 100)}%</b>
                  <input type="range" min={0} max={100} value={Math.round(hardness * 100)} onChange={e => setHardness(+e.target.value / 100)} />
                </label>
                <label className="tv-bigslider">Flow <b>{Math.round(flow * 100)}%</b>
                  <input type="range" min={1} max={100} value={Math.round(flow * 100)} onChange={e => setFlow(+e.target.value / 100)} />
                </label>
              </section>
              <section className="panel">
                <h3>🎬 Canvas</h3>
                <div className="tv-menugrid">
                  <button className={showGrid ? "active" : ""} onClick={() => setShowGrid(g => !g)}>Grid</button>
                  <button className={onion ? "active" : ""} onClick={() => setOnion(o => !o)}>Onion skin</button>
                  <button className={ruler.type !== "none" ? "active" : ""} onClick={() => toggleRuler()}>Ruler</button>
                  <button onClick={() => setSymmetry(s => s === "none" ? "h" : s === "h" ? "v" : s === "v" ? "both" : "none")}>Symmetry: {symmetry}</button>
                  <button onClick={fitToScreen}>Fit to screen</button>
                  <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>Zoom 1:1</button>
                </div>
                <label className="tv-bigslider">FPS <b>{fps}</b>
                  <input type="range" min={1} max={60} value={fps} onChange={e => setFps(+e.target.value)} />
                </label>
                {onion && (
                  <>
                    <label className="tv-bigslider">Onion before <b>{onionBefore}</b><input type="range" min={0} max={3} value={onionBefore} onChange={e => setOnionBefore(+e.target.value)} /></label>
                    <label className="tv-bigslider">Onion after <b>{onionAfter}</b><input type="range" min={0} max={3} value={onionAfter} onChange={e => setOnionAfter(+e.target.value)} /></label>
                  </>
                )}
                <div className="tv-menugrid" style={{ marginTop: 8 }}>
                  <button onClick={() => setFrameBg("#ffffff")}>BG white</button>
                  <button onClick={() => setFrameBg("#000000")}>BG black</button>
                  <button onClick={() => setFrameBg(null)}>BG transparent</button>
                  <span className="muted" style={{ alignSelf: "center", fontSize: 11 }}>{dims.w}×{dims.h}</span>
                </div>
              </section>
            </>
          )}
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
                  <div
                    key={l.id}
                    className={"layeritem " + (active ? "active" : "")}
                    onClick={() => setFrames(fs => fs.map((f, i) => i === currentFrame ? { ...f, activeLayer: idx } : f))}
                    onContextMenu={(e) => { e.preventDefault(); setFrames(fs => fs.map((f, i) => i === currentFrame ? { ...f, activeLayer: idx } : f)); setLayerMenu({ x: e.clientX, y: e.clientY, index: idx }); }}
                    onPointerDown={(e) => startLongPress(e, () => setLayerMenu({ x: e.clientX, y: e.clientY, index: idx }))}
                    onPointerUp={cancelLongPress}
                    onPointerLeave={cancelLongPress}
                  >
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

          {/* Effects */}
          <section className="panel">
            <h3>Effects</h3>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={dreamyBlurEnabled}
                  onChange={(e) => setDreamyBlurEnabled(e.target.checked)}
                />
                <span>Dreamy Blur</span>
              </label>
            </div>
            {dreamyBlurEnabled && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <label>
                  Blur Radius <span>{blurRadius}px</span>
                  <input
                    type="range"
                    min={0}
                    max={30}
                    value={blurRadius}
                    onChange={(e) => setBlurRadius(+e.target.value)}
                  />
                </label>
                <label>
                  Glow Intensity <span>{glowIntensity}%</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={glowIntensity}
                    onChange={(e) => setGlowIntensity(+e.target.value)}
                  />
                </label>
                <label>
                  Haze Opacity <span>{hazeOpacity}%</span>
                  <input
                    type="range"
                    min={0}
                    max={80}
                    value={hazeOpacity}
                    onChange={(e) => setHazeOpacity(+e.target.value)}
                  />
                </label>
                <label>
                  Warmth <span>{warmth > 0 ? `+${warmth}` : warmth}</span>
                  <input
                    type="range"
                    min={-50}
                    max={50}
                    value={warmth}
                    onChange={(e) => setWarmth(+e.target.value)}
                  />
                </label>
                <label>
                  Vignette <span>{vignette}%</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={vignette}
                    onChange={(e) => setVignette(+e.target.value)}
                  />
                </label>
              </div>
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
      {showExport && (
        <ExportModal
          frames={frames}
          dims={dims}
          fps={fps}
          projectName={projectName}
          audio={audioTracks}
          onClose={() => setShowExport(false)}
        />
      )}

      {/* ---------- Mobile / tablet chrome ---------- */}
      {isTouchLayout && drawerOpen && <div className="tv-scrim" onClick={() => setDrawerOpen(false)} />}
      {isTouchLayout && (
        <>
          {/* Bottom tool strip (mobile only; tablet keeps the narrow left rail) */}
          {isMobile && (
          <nav className="tv-toolstrip" aria-label="Tools">
            {MOBILE_TOOLS.map(t => (
              <button
                key={t.id}
                className={"tv-tool" + (tool === t.id ? " active" : "")}
                title={t.label}
                aria-label={t.label}
                onClick={() => { setTool(t.id); showToolPopup(t.id); }}
                onPointerDown={(e) => startLongPress(e, () => showToolPopup(t.id))}
                onPointerUp={cancelLongPress}
                onPointerLeave={cancelLongPress}
              >
                <span className="tv-toolicon">{t.icon}</span>
              </button>
            ))}
            <button className={"tv-tool" + (ruler.type !== "none" ? " active" : "")} title="Ruler" aria-label="Ruler" onClick={() => toggleRuler()}>
              <span className="tv-toolicon">📐</span>
            </button>
          </nav>
          )}

          {/* Tool options popup above the strip */}
          {toolPopup && (
            <div className="tv-toolpop">
              <div className="tv-toolpopname">{MOBILE_TOOLS.find(t => t.id === toolPopup)?.label ?? TOOL_GROUPS.flatMap(g => g.tools).find(t => t.id === toolPopup)?.label ?? toolPopup}</div>
              <label className="tv-bigslider">Size <b>{size}px</b>
                <input type="range" min={1} max={300} value={size} onChange={e => { setSize(+e.target.value); showToolPopup(toolPopup); }} />
              </label>
              <label className="tv-bigslider">Opacity <b>{Math.round(opacity * 100)}%</b>
                <input type="range" min={1} max={100} value={Math.round(opacity * 100)} onChange={e => { setOpacity(+e.target.value / 100); showToolPopup(toolPopup); }} />
              </label>
              {toolPopup === "magicwand" && (
                <label className="tv-bigslider">Tolerance <b>{wandTolerance}</b>
                  <input type="range" min={0} max={100} value={wandTolerance} onChange={e => { setWandTolerance(+e.target.value); showToolPopup(toolPopup); }} />
                </label>
              )}
              {(toolPopup === "brush" || toolPopup === "airbrush") && (
                <label className="tv-bigslider">Hardness <b>{Math.round(hardness * 100)}%</b>
                  <input type="range" min={0} max={100} value={Math.round(hardness * 100)} onChange={e => { setHardness(+e.target.value / 100); showToolPopup(toolPopup); }} />
                </label>
              )}
            </div>
          )}

          {/* More options menu */}
          {mobileMore && (
            <>
              <div className="tv-scrim" onClick={() => setMobileMore(false)} />
              <div className="tv-moremenu">
                <button onClick={() => { setMobileMore(false); setShowExport(true); }}>⬆ Export (GIF / MP4 / PNG)</button>
                <button onClick={() => { setMobileMore(false); exportToonvo(); }}>💾 Download .toonvo</button>
                <button onClick={() => { setMobileMore(false); addFrame(true); }}>⧉ Duplicate frame</button>
                <button onClick={() => { setMobileMore(false); deleteFrame(currentFrame); }}>🗑 Delete frame</button>
                <button onClick={() => { setMobileMore(false); fitToScreen(); }}>⛶ Fit to screen</button>
                <button onClick={() => { setMobileMore(false); setDrawerOpen(true); }}>☰ Full menu</button>
              </div>
            </>
          )}
        </>
      )}
      {isTouchLayout && (

        <>
          <button
            className="tv-fab"
            style={{ background: color }}
            title="Color"
            aria-label="Color picker"
            onClick={() => setColorPopup(v => !v)}
          />
          {colorPopup && (
            <>
              <div className="tv-colorscrim" onClick={() => setColorPopup(false)} />
              <div className="tv-colorpop" role="dialog" aria-label="Color picker">
                <div className="tv-cphead">
                  <span>Color</span>
                  <button className="tv-x" aria-label="Close color picker" onClick={() => setColorPopup(false)}>✕</button>
                </div>
                <div className="tv-cpwheelrow">
                  <ColorWheel color={color} onChange={updateColor} size={200} />
                </div>
                <div className="tv-cpswaprow">
                  <div className="sw" style={{ background: color }} title="Foreground" />
                  <button onClick={() => { const t = color; setColor(bgColor); setBgColor(t); }} title="Swap foreground/background">⇄</button>
                  <div className="sw" style={{ background: bgColor }} title="Background" onClick={() => updateColor(bgColor)} />
                  <input
                    type="text" className="hex" value={color}
                    onChange={e => /^#[0-9a-fA-F]{6}$/.test(e.target.value) && updateColor(e.target.value)}
                  />
                </div>
                <div className="rgb">
                  {(["r", "g", "b"] as const).map((ch, i) => {
                    const rgb = hexToRgb(color);
                    return (
                      <label key={ch}>{ch.toUpperCase()} <b>{rgb[i]}</b>
                        <input type="range" min={0} max={255} value={rgb[i]} onChange={e => {
                          const rr = hexToRgb(color); rr[i] = +e.target.value;
                          updateColor(rgbToHex(rr[0], rr[1], rr[2]));
                        }} />
                      </label>
                    );
                  })}
                  <label>Opacity <b>{Math.round(opacity * 100)}%</b>
                    <input type="range" min={5} max={100} value={Math.round(opacity * 100)} onChange={e => setOpacity(+e.target.value / 100)} />
                  </label>
                </div>
                {recentColors.length > 0 && (
                  <div className="tv-cpsection">
                    <div className="palname">Recent</div>
                    <div className="tv-cprecent">
                      {recentColors.slice(0, 10).map((c, i) => (
                        <button key={i} className="tv-cpdot" style={{ background: c }} aria-label={`Recent color ${c}`} onClick={() => updateColor(c)} />
                      ))}
                    </div>
                  </div>
                )}
                <div className="tv-cpsection tv-cppalettes">
                  {Object.entries(PALETTES).map(([name, cols]) => (
                    <div key={name} className="pal">
                      <div className="palname">{name}</div>
                      <div className="tv-cprecent">
                        {cols.map(c => (
                          <button key={c} className="tv-cpdot sm" style={{ background: c }} aria-label={`${name} ${c}`} onClick={() => updateColor(c)} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </>
      )}

      {/* ---------- Selection operations toolbar ---------- */}
      {(selection || floating) && (
        <div className={"tv-seltools" + (isTouchLayout ? " touch" : "")}>
          <button onClick={() => { copySelection(true); toast("Art cut!"); }} title="Cut (Ctrl+X)">✂️</button>
          <button onClick={() => { copySelection(false); toast("Art copied!"); }} title="Copy (Ctrl+C)">📋</button>
          <button onClick={() => { pasteClipboard(); toast("Pasted!"); }} title="Paste (Ctrl+V)">📌</button>
          <button onClick={deleteSelection} title="Delete (Del)">🗑️</button>
          <button onClick={() => flipSelection("h")} title="Flip horizontal">↔️</button>
          <button onClick={() => flipSelection("v")} title="Flip vertical">↕️</button>
          {!isTouchLayout && (
            <>
              <button onClick={fillSelection} title="Fill with foreground colour">🎨 Fill</button>
              <button onClick={() => rotateSelection(90)} title="Rotate 90°">⟳</button>
              <button onClick={() => scaleFloatingBy(1.1)} title="Scale up">＋</button>
              <button onClick={() => scaleFloatingBy(0.9)} title="Scale down">－</button>
              <button onClick={invertSelection} title="Invert selection (Ctrl+Shift+I)">Invert</button>
              <label title="Feather edge">Feather
                <input type="range" min={0} max={50} value={featherPx} onChange={e => { setFeatherPx(+e.target.value); modifySelection("feather", +e.target.value); }} />
              </label>
              <label title="Grow / shrink amount">±px
                <input type="number" className="num" value={growPx} min={1} max={100} onChange={e => setGrowPx(+e.target.value)} />
              </label>
              <button onClick={() => modifySelection("expand", growPx)} title="Expand selection">Expand</button>
              <button onClick={() => modifySelection("contract", growPx)} title="Contract selection">Contract</button>
              <button onClick={() => modifySelection("border", growPx)} title="Border selection">Border</button>
              <button onClick={() => setPasteTargetMenu(true)} title="Paste to other frames">Paste to…</button>
            </>
          )}
          <button onClick={escapeSelection} title="Deselect (Ctrl+D)">✕</button>
        </div>
      )}

      {pasteTargetMenu && (
        <div className="modal" onClick={() => setPasteTargetMenu(false)}>
          <div className="modalbox" onClick={e => e.stopPropagation()}>
            <h2>Paste art to…</h2>
            <button onClick={() => { pasteToFrames(frames.map((_, i) => i)); setPasteTargetMenu(false); }}>All frames</button>
            <button onClick={() => { pasteToFrames(selectedFrames); setPasteTargetMenu(false); }}>Selected frames ({selectedFrames.length})</button>
            <div className="modalactions"><button onClick={() => setPasteTargetMenu(false)}>Cancel</button></div>
          </div>
        </div>
      )}

      {/* ---------- Frame context menu / mobile bottom sheet ---------- */}
      {frameMenu && (
        <>
          <div className="tv-menuscrim" onClick={() => setFrameMenu(null)} />
          <div
            className={isTouchLayout ? "tv-sheet" : "tv-menu"}
            style={isTouchLayout ? undefined : { left: Math.min(frameMenu.x, (typeof window !== "undefined" ? window.innerWidth : 1200) - 230), top: Math.max(8, frameMenu.y - 380) }}
          >
            {isTouchLayout && <div className="tv-sheet-title">Frame {frameMenu.index + 1}</div>}
            <button onClick={() => { copyFrames(selectedFramesRef.current, true); setFrameMenu(null); }}>✂️ Cut frame(s) <span>Ctrl+X</span></button>
            <button onClick={() => { copyFrames(selectedFramesRef.current, false); setFrameMenu(null); }}>📋 Copy frame(s) <span>Ctrl+C</span></button>
            <button onClick={() => { pasteFrames(false); setFrameMenu(null); }}>📌 Paste frame <span>Ctrl+V</span></button>
            <button onClick={() => { pasteFrames(true); setFrameMenu(null); }}>📍 Paste in place</button>
            <button onClick={() => { duplicateFrames(selectedFramesRef.current); setFrameMenu(null); }}>⎘ Duplicate <span>Ctrl+D</span></button>
            <button onClick={() => { deleteFrames(selectedFramesRef.current); setFrameMenu(null); }}>🗑️ Delete <span>Del</span></button>
            <button onClick={() => { insertBlankFrame(true); setFrameMenu(null); }}>⬅ Insert blank before</button>
            <button onClick={() => { insertBlankFrame(false); setFrameMenu(null); }}>➡ Insert blank after</button>
            <button onClick={() => { selectAllFrames(); setFrameMenu(null); }}>▦ Select all frames <span>Ctrl+A</span></button>
            <button onClick={() => { reverseSelectedFrames(); setFrameMenu(null); }}>⇄ Reverse selected</button>
            <button onClick={() => { moveFrameBy(-1); setFrameMenu(null); }}>◀ Move left</button>
            <button onClick={() => { moveFrameBy(1); setFrameMenu(null); }}>▶ Move right</button>
            {isTouchLayout && <button onClick={() => setFrameMenu(null)}>Cancel</button>}
          </div>
        </>
      )}

      {/* ---------- Layer context menu ---------- */}
      {layerMenu && (
        <>
          <div className="tv-menuscrim" onClick={() => setLayerMenu(null)} />
          <div
            className={isTouchLayout ? "tv-sheet" : "tv-menu"}
            style={isTouchLayout ? undefined : { left: Math.min(layerMenu.x, (typeof window !== "undefined" ? window.innerWidth : 1200) - 230), top: layerMenu.y }}
          >
            <button onClick={() => { copyLayerContents(layerMenu.index); setLayerMenu(null); }}>📋 Copy layer contents</button>
            <button onClick={() => { pasteAsNewLayer(); setLayerMenu(null); }}>📌 Paste as new layer</button>
            <button onClick={() => { duplicateLayer(layerMenu.index); setLayerMenu(null); toast("Duplicated!"); }}>⎘ Duplicate layer</button>
            <button onClick={() => { mergeDown(layerMenu.index); setLayerMenu(null); }}>⇩ Merge with layer below</button>
            <button onClick={() => { mergeVisible(); setLayerMenu(null); }}>⊕ Merge visible layers</button>
            <button onClick={() => { flattenAll(); setLayerMenu(null); }}>▤ Flatten all layers</button>
            <button onClick={() => { clearLayer(layerMenu.index); setLayerMenu(null); }}>🧹 Clear layer</button>
            {isTouchLayout && <button onClick={() => setLayerMenu(null)}>Cancel</button>}
          </div>
        </>
      )}

      {/* ---------- Clipboard inspector ---------- */}
      {showClipInfo && (
        <div className="tv-clippop" onMouseLeave={() => setShowClipInfo(false)}>
          <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1 }}>Clipboard</div>
          {clipThumb && <img src={clipThumb} alt="Copied art preview" style={{ width: "100%", maxHeight: 90, objectFit: "contain", background: "#0a0a14", borderRadius: 4 }} />}
          <div style={{ fontSize: 11 }}>{clipThumb ? "Art clip ready" : "No art clip"}</div>
          <div style={{ fontSize: 11 }}>{frameClipCount > 0 ? `${frameClipCount} frame(s) in clipboard` : "No frame clip"}</div>
          <div style={{ display: "flex", gap: 4 }}>
            <button style={{ flex: 1 }} onClick={() => { clipboardRef.current = null; frameClipRef.current = []; setClipThumb(null); setFrameClipCount(0); setShowClipInfo(false); }}>Clear</button>
            <button style={{ flex: 1 }} onClick={() => setShowClipInfo(false)}>Close</button>
          </div>
        </div>
      )}

      {/* ---------- Toasts ---------- */}
      <div className="tv-toasts">
        {toasts.map(t => <div key={t.id} className="tv-toast">{t.msg}</div>)}
      </div>
    </div>
  );
}

function ReferencePanel({ data, onChange, onClose }: { data: RefImage; onChange: (p: Partial<RefImage>) => void; onClose: () => void }) {
  const dragRef = useRef<{ mode: "move" | "resize"; sx: number; sy: number; x: number; y: number; w: number; h: number } | null>(null);
  const onPointerDown = (mode: "move" | "resize") => (e: React.PointerEvent) => {
    e.preventDefault();
    try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* non-fatal */ }
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
