import { useEffect, useRef, useCallback } from "react";

/** Touch-friendly HSB colour wheel: hue around the ring, saturation from centre,
 *  brightness on a separate slider below. */

export function hexToHsv(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = m ? parseInt(m[1], 16) : 0;
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max ? d / max : 0, max];
}

export function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (u: number) => Math.round((u + m) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

interface Props {
  color: string;
  onChange: (hex: string) => void;
  size?: number;
}

export default function ColorWheel({ color, onChange, size = 220 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draggingRef = useRef(false);
  const [h, s, v] = hexToHsv(color);
  const vRef = useRef(v);
  vRef.current = v;

  // Draw wheel (hue/saturation) at the current brightness.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = size * dpr; c.height = size * dpr;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const r = size / 2;
    // hue sweep
    for (let a = 0; a < 360; a++) {
      ctx.beginPath();
      ctx.moveTo(r, r);
      ctx.arc(r, r, r - 1, ((a - 1) * Math.PI) / 180, ((a + 1.5) * Math.PI) / 180);
      ctx.closePath();
      ctx.fillStyle = hsvToHex(a, 1, v || 1);
      ctx.fill();
    }
    // saturation falloff towards centre
    ctx.globalCompositeOperation = "source-atop";
    const g2 = ctx.createRadialGradient(r, r, 0, r, r, r - 1);
    g2.addColorStop(0, "rgba(255,255,255,1)");
    g2.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g2;
    ctx.beginPath(); ctx.arc(r, r, r - 1, 0, Math.PI * 2); ctx.fill();
    if (v < 1) {
      ctx.fillStyle = `rgba(0,0,0,${1 - v})`;
      ctx.beginPath(); ctx.arc(r, r, r - 1, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }, [size, v]);

  const pick = useCallback((clientX: number, clientY: number) => {
    const c = canvasRef.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const r = rect.width / 2;
    let dx = clientX - rect.left - r;
    let dy = clientY - rect.top - r;
    const dist = Math.hypot(dx, dy);
    if (dist > r) { dx *= r / dist; dy *= r / dist; }
    let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (ang < 0) ang += 360;
    const sat = Math.min(1, dist / r);
    onChange(hsvToHex(ang, sat, vRef.current || 1));
  }, [onChange]);

  const r = size / 2;
  const mx = r + Math.cos((h * Math.PI) / 180) * s * (r - 1);
  const my = r + Math.sin((h * Math.PI) / 180) * s * (r - 1);

  return (
    <div className="tv-wheel" style={{ width: size }}>
      <div style={{ position: "relative", width: size, height: size, touchAction: "none" }}>
        <canvas
          ref={canvasRef}
          style={{ width: size, height: size, borderRadius: "50%", display: "block", touchAction: "none" }}
          onPointerDown={(e) => {
            draggingRef.current = true;
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            pick(e.clientX, e.clientY);
          }}
          onPointerMove={(e) => { if (draggingRef.current) pick(e.clientX, e.clientY); }}
          onPointerUp={() => { draggingRef.current = false; }}
          onPointerCancel={() => { draggingRef.current = false; }}
        />
        <div className="tv-wheelknob" style={{ left: mx, top: my, background: color }} />
      </div>
      <label className="tv-wheelbright">
        Brightness <b>{Math.round(v * 100)}%</b>
        <input
          type="range" min={0} max={100} value={Math.round(v * 100)}
          onChange={(e) => onChange(hsvToHex(h, s, +e.target.value / 100))}
        />
      </label>
    </div>
  );
}
