import { useEffect, useMemo, useRef, useState } from "react";
import {
  detectFormat,
  formatLabel,
  outputSize,
  drawFrame,
  renderVideo,
  estimateSize,
  humanSize,
  downloadBlob,
  shareOrDownload,
  pickMime,
  type ExportFrameLike,
  type ExportAudioLike,
} from "@/lib/toonvo-video";
import { encodeGif } from "@/lib/toonvo-gif";
import { useBreakpoint } from "@/hooks/use-breakpoint";

import {
  getPlanTier,
  setPlanTier,
  drawWatermark,
  defaultWatermark,
  type PlanTier,
  type WatermarkConfig,
  type WatermarkType,
  type WatermarkPosition,
} from "@/lib/watermark";

type Tab = "mp4" | "gif" | "sprite" | "png";
type Res = 480 | 720 | 1080;
type Quality = "low" | "medium" | "high";

interface Props {
  frames: ExportFrameLike[];
  dims: { w: number; h: number };
  fps: number;
  projectName: string;
  audio: ExportAudioLike[];
  onClose: () => void;
}

export default function ExportModal({ frames, dims, fps, projectName, audio, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("mp4");
  const [plan, setPlan] = useState<PlanTier>("free");
  const [res, setRes] = useState<Res>(720);
  const [customFps, setCustomFps] = useState<number>(fps);
  const [quality, setQuality] = useState<Quality>("medium");
  const [gifScale, setGifScale] = useState(0.5);
  const [spriteCols, setSpriteCols] = useState(Math.min(8, Math.max(1, frames.length)));
  const [pngAll, setPngAll] = useState(false);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ i: 0, n: 0 });
  const [eta, setEta] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [result, setResult] = useState<{ blob: Blob; name: string; url: string; fallback: boolean } | null>(null);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [wm, setWm] = useState<WatermarkConfig>(() => defaultWatermark("mp4"));
  const [customImg, setCustomImg] = useState<HTMLImageElement | null>(null);

  const cancelRef = useRef({ cancelled: false });
  const previewRef = useRef<HTMLCanvasElement>(null);
  const startedRef = useRef(0);

  const isFree = plan === "free";
  const fmt = detectFormat(dims.w, dims.h);
  const mimeInfo = useMemo(() => pickMime(), []);

  useEffect(() => { setPlan(getPlanTier()); }, []);
  useEffect(() => { setWm(w => ({ ...w, enabled: plan === "free" })); }, [plan]);
  useEffect(() => { if (isFree && res === 1080) setRes(720); }, [isFree, res]);

  const wmConfig: WatermarkConfig | null = useMemo(() => {
    if (!wm.enabled) return null;
    if (tab === "mp4" && res === 1080) return isFree ? null : { ...wm, image: customImg, imageAspect: customImg ? customImg.width / customImg.height : 1 };
    return { ...wm, image: !isFree ? customImg : null, imageAspect: customImg ? customImg.width / customImg.height : 1 };
  }, [wm, isFree, customImg, tab, res]);

  // preview of first frame + watermark
  useEffect(() => {
    const c = previewRef.current;
    if (!c || !frames.length) return;
    const pw = 320;
    const ph = Math.max(1, Math.round((pw * dims.h) / dims.w));
    c.width = pw; c.height = ph;
    const ctx = c.getContext("2d")!;
    drawFrame(ctx, frames[0], pw, ph);
    if (wmConfig) drawWatermark(ctx, pw, ph, wmConfig);
  }, [frames, dims, wmConfig]);


  const out = outputSize(dims.w, dims.h, res);
  const durationSec = frames.reduce((a, f) => a + ((f.duration || 100) / 100) / Math.max(1, customFps), 0);
  const estBytes =
    tab === "mp4" ? estimateSize(frames.length, customFps, quality)
      : tab === "gif" ? frames.length * (dims.w * gifScale) * (dims.h * gifScale) * 0.22
        : tab === "sprite" ? dims.w * dims.h * frames.length * 0.25
          : dims.w * dims.h * 0.4 * (pngAll ? frames.length : 1);

  const baseName = (projectName || "toonvo-animation").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "toonvo-animation";

  const clearResult = () => {
    setResult(r => { if (r) URL.revokeObjectURL(r.url); return null; });
  };

  useEffect(() => () => { if (result) URL.revokeObjectURL(result.url); }, [result]);

  const finish = (blob: Blob, name: string, fallback = false) => {
    const url = URL.createObjectURL(blob);
    setResult({ blob, name, url, fallback });
    downloadBlob(blob, name); // auto-download
  };

  // ---------- MP4 ----------
  const runMp4 = async () => {
    clearResult();
    cancelRef.current = { cancelled: false };
    setBusy(true);
    setStatus(null);
    setProgress({ i: 0, n: frames.length });
    startedRef.current = performance.now();
    try {
      const r = await renderVideo({
        frames,
        srcW: dims.w, srcH: dims.h,
        outW: out.w, outH: out.h,
        fps: customFps,
        quality,
        watermark: wmConfig,
        audio,
        signal: cancelRef.current,
        onProgress: (i, n) => {
          setProgress({ i, n });
          const elapsed = (performance.now() - startedRef.current) / 1000;
          const remain = Math.max(0, (durationSec - elapsed));
          setEta(remain > 1 ? `About ${Math.ceil(remain)} seconds remaining…` : "Finishing up…");
        },
      });
      finish(r.blob, `${baseName}-${res}p.${r.ext}`, r.fallback);
      if (r.fallback) setStatus("Using fallback encoder — your browser can't encode MP4 directly, so the file is WebM (plays everywhere except older editors).");
    } catch (e) {
      if ((e as Error).message !== "cancelled") setStatus(`Export failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      setEta(null);
    }
  };

  // ---------- GIF ----------
  const runGif = async () => {
    clearResult();
    cancelRef.current = { cancelled: false };
    setBusy(true); setStatus(null);
    const gw = Math.max(2, Math.round(dims.w * gifScale));
    const gh = Math.max(2, Math.round(dims.h * gifScale));
    const c = document.createElement("canvas");
    c.width = gw; c.height = gh;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    const gifFrames = [];
    for (let i = 0; i < frames.length; i++) {
      if (cancelRef.current.cancelled) { setBusy(false); return; }
      drawFrame(ctx, frames[i], gw, gh);
      if (wmConfig) drawWatermark(ctx, gw, gh, wmConfig);
      gifFrames.push({
        data: ctx.getImageData(0, 0, gw, gh).data,
        delayMs: (1000 / customFps) * ((frames[i].duration || 100) / 100),
      });
      setProgress({ i: i + 1, n: frames.length });
      await new Promise(r => setTimeout(r, 0));
    }
    finish(encodeGif(gw, gh, gifFrames), `${baseName}.gif`);
    setBusy(false);
  };

  // ---------- Sprite sheet ----------
  const runSprite = async () => {
    clearResult();
    setBusy(true); setStatus(null);
    const cols = Math.max(1, spriteCols);
    const rows = Math.ceil(frames.length / cols);
    const c = document.createElement("canvas");
    c.width = dims.w * cols; c.height = dims.h * rows;
    const ctx = c.getContext("2d")!;
    const tile = document.createElement("canvas");
    tile.width = dims.w; tile.height = dims.h;
    const tctx = tile.getContext("2d")!;
    frames.forEach((f, i) => {
      drawFrame(tctx, f, dims.w, dims.h);
      ctx.drawImage(tile, (i % cols) * dims.w, Math.floor(i / cols) * dims.h);
      setProgress({ i: i + 1, n: frames.length });
    });
    if (wmConfig) drawWatermark(ctx, c.width, c.height, wmConfig);
    const blob: Blob = await new Promise(r => c.toBlob(b => r(b!), "image/png")!);
    finish(blob, `${baseName}-sprite-${cols}x${rows}.png`);
    setBusy(false);
  };

  // ---------- PNG ----------
  const runPng = async () => {
    clearResult();
    setBusy(true); setStatus(null);
    const list = pngAll ? frames.map((_, i) => i) : [0];
    const c = document.createElement("canvas");
    c.width = dims.w; c.height = dims.h;
    const ctx = c.getContext("2d")!;
    let last: Blob | null = null;
    let lastName = "";
    for (const i of list) {
      drawFrame(ctx, frames[i], dims.w, dims.h);
      if (wmConfig) drawWatermark(ctx, dims.w, dims.h, wmConfig);
      const blob: Blob = await new Promise(r => c.toBlob(b => r(b!), "image/png")!);
      lastName = `${baseName}-frame-${String(i + 1).padStart(3, "0")}.png`;
      if (pngAll) downloadBlob(blob, lastName);
      last = blob;
      setProgress({ i: i + 1, n: list.length });
      await new Promise(r => setTimeout(r, 0));
    }
    if (last) {
      if (pngAll) {
        const url = URL.createObjectURL(last);
        setResult({ blob: last, name: `${list.length} PNG files`, url, fallback: false });
      } else finish(last, lastName);
    }
    setBusy(false);
  };

  const run = () => {
    if (!frames.length) return;
    if (tab === "mp4") void runMp4();
    else if (tab === "gif") void runGif();
    else if (tab === "sprite") void runSprite();
    else void runPng();
  };

  const cancel = () => {
    cancelRef.current.cancelled = true;
    setBusy(false);
    setStatus("Export cancelled.");
  };

  const pct = progress.n ? Math.round((progress.i / progress.n) * 100) : 0;

  return (
    <div className="modal" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="tv-export" onMouseDown={e => e.stopPropagation()}>
        <button className="tv-x" onClick={() => { if (!busy) onClose(); }} title="Close">✕</button>
        <h2 style={{ margin: 0 }}>Export</h2>

        <div className="tv-tabs">
          {(["mp4", "gif", "sprite", "png"] as Tab[]).map(t => (
            <button key={t} className={tab === t ? "active" : ""} disabled={busy}
              onClick={() => {
                setTab(t); clearResult(); setStatus(null);
                setWm(w => ({ ...w, ...defaultWatermark(t), enabled: w.enabled }));
              }}>
              {t === "mp4" ? "MP4" : t === "gif" ? "GIF" : t === "sprite" ? "Sprite Sheet" : "PNG"}
            </button>
          ))}
        </div>

        {isFree && (
          <div className="tv-notice">
            <strong>Free plan: 720p only + watermark.</strong>
            <button className="tv-linkbtn" onClick={() => setShowUpgrade(true)}>Upgrade to Pro for 1080p + no watermark →</button>
          </div>
        )}

        <div className="tv-exportbody">
          {/* settings */}
          <div className="tv-settings">
            {tab === "mp4" && (
              <>
                <label>Resolution
                  <div className="tv-radios">
                    {([480, 720, 1080] as Res[]).map(r => {
                      const locked = r === 1080 && isFree;
                      return (
                        <button key={r} disabled={busy}
                          className={res === r ? "active" : ""}
                          onClick={() => locked ? setShowUpgrade(true) : setRes(r)}
                          style={locked ? { opacity: .5 } : undefined}>
                          {locked ? "🔒 " : ""}{r}p{r === 480 ? " (low)" : r === 1080 ? " (Pro)" : ""}
                        </button>
                      );
                    })}
                  </div>
                </label>
                <label>Frame rate
                  <select value={customFps} disabled={busy} onChange={e => setCustomFps(+e.target.value)}>
                    <option value={fps}>Match project ({fps} fps)</option>
                    {[8, 12, 24, 30].filter(f => f !== fps).map(f => <option key={f} value={f}>{f} fps</option>)}
                  </select>
                </label>
                <label>Quality
                  <div className="tv-radios">
                    {(["low", "medium", "high"] as Quality[]).map(q => (
                      <button key={q} disabled={busy} className={quality === q ? "active" : ""} onClick={() => setQuality(q)}>
                        {q[0].toUpperCase() + q.slice(1)}
                      </button>
                    ))}
                  </div>
                </label>
                <div className="tv-hint">
                  Output {out.w}×{out.h} • {frames.length} frames • {durationSec.toFixed(1)}s
                  {audio.length > 0 ? ` • ${audio.length} audio track${audio.length > 1 ? "s" : ""} mixed in` : " • silent"}
                  {mimeInfo.fallback ? " • fallback encoder (WebM)" : ""}
                </div>
              </>
            )}

            {tab === "gif" && (
              <>
                <label>Scale
                  <div className="tv-radios">
                    {[0.25, 0.5, 1].map(s => (
                      <button key={s} disabled={busy} className={gifScale === s ? "active" : ""} onClick={() => setGifScale(s)}>{s * 100}%</button>
                    ))}
                  </div>
                </label>
                <label>Frame rate
                  <select value={customFps} disabled={busy} onChange={e => setCustomFps(+e.target.value)}>
                    {[8, 12, 24, 30].map(f => <option key={f} value={f}>{f} fps</option>)}
                  </select>
                </label>
                <div className="tv-hint">Looping GIF at {Math.round(dims.w * gifScale)}×{Math.round(dims.h * gifScale)}.</div>
              </>
            )}

            {tab === "sprite" && (
              <>
                <label>Columns
                  <input type="number" min={1} max={frames.length || 1} value={spriteCols} disabled={busy}
                    onChange={e => setSpriteCols(Math.max(1, Math.min(frames.length || 1, +e.target.value)))} />
                </label>
                <div className="tv-hint">
                  Sheet {dims.w * spriteCols}×{dims.h * Math.ceil(frames.length / Math.max(1, spriteCols))} px
                </div>
              </>
            )}

            {tab === "png" && (
              <>
                <label style={{ flexDirection: "row", alignItems: "center", gap: 8, textTransform: "none" }}>
                  <input type="checkbox" checked={pngAll} disabled={busy} onChange={e => setPngAll(e.target.checked)} />
                  Export every frame as a separate PNG
                </label>
                <div className="tv-hint">{pngAll ? `${frames.length} files` : "First frame only"} at {dims.w}×{dims.h}.</div>
              </>
            )}

            <div className="tv-wm">
              <div className="tv-wmhead">
                <strong>Watermark Settings</strong>
                {!isFree && (
                  <label className="tv-wmtoggle">
                    <input type="checkbox" checked={wm.enabled} disabled={busy}
                      onChange={e => setWm(w => ({ ...w, enabled: e.target.checked }))} />
                    Add my watermark
                  </label>
                )}
              </div>

              {isFree && (
                <div className="tv-hint">Free plan includes a watermark — pick the style and position you prefer.</div>
              )}
              {!isFree && (
                <div className="tv-hint">Pro: watermark is off. Enable it to brand exports with your own logo.</div>
              )}

              {(isFree || wm.enabled) && (
                <>
                  <label>Type
                    <div className="tv-radios">
                      {(["logo", "tiled", "text"] as WatermarkType[]).map(t => (
                        <button key={t} disabled={busy} className={wm.type === t ? "active" : ""}
                          onClick={() => setWm(w => ({ ...w, type: t }))}>
                          {t === "logo" ? "Logo (corner)" : t === "tiled" ? "Tiled pattern" : "Text"}
                        </button>
                      ))}
                    </div>
                  </label>

                  {wm.type !== "tiled" && (
                    <label>Position
                      <div className="tv-radios tv-wmpos">
                        {([["tl", "Top Left"], ["tr", "Top Right"], ["bl", "Bottom Left"], ["br", "Bottom Right"], ["center", "Center"]] as [WatermarkPosition, string][]).map(([p, lbl]) => (
                          <button key={p} disabled={busy} className={wm.position === p ? "active" : ""}
                            onClick={() => setWm(w => ({ ...w, position: p }))}>{lbl}</button>
                        ))}
                      </div>
                    </label>
                  )}

                  {wm.type === "text" && (
                    <label>Text
                      <input type="text" value={wm.text} disabled={busy}
                        onChange={e => setWm(w => ({ ...w, text: e.target.value }))} />
                    </label>
                  )}

                  <label>Opacity — {Math.round(wm.opacity * 100)}%
                    <input type="range" min={20} max={70} step={1} value={Math.round(wm.opacity * 100)} disabled={busy}
                      onChange={e => setWm(w => ({ ...w, opacity: +e.target.value / 100 }))} />
                  </label>

                  <label>Size — {Math.round(wm.size * 100)}% of canvas
                    <input type="range" min={10} max={30} step={1} value={Math.round(wm.size * 100)} disabled={busy}
                      onChange={e => setWm(w => ({ ...w, size: +e.target.value / 100 }))} />
                  </label>

                  {!isFree && (
                    <label>Custom watermark (PNG)
                      <input type="file" accept="image/png,image/*" disabled={busy}
                        onChange={e => {
                          const f = e.target.files?.[0];
                          if (!f) return;
                          const img = new Image();
                          img.onload = () => setCustomImg(img);
                          img.src = URL.createObjectURL(f);
                        }} />
                    </label>
                  )}
                </>
              )}
            </div>
          </div>

          {/* preview */}
          <div className="tv-preview">
            <div className="tv-badge">{formatLabel(fmt)}</div>
            <canvas ref={previewRef} className="tv-prevcanvas" />
            <div className="tv-hint">Estimated size ≈ {humanSize(Math.round(estBytes))}</div>
            {wmConfig && <div className="tv-hint">Watermark preview shown above.</div>}
          </div>
        </div>

        {busy && (
          <div className="tv-prog">
            <div className="tv-progbar"><div style={{ width: `${pct}%` }} /></div>
            <div className="tv-hint">
              Rendering frame {progress.i} of {progress.n}… {pct}%{eta && frames.length >= 50 ? ` — ${eta}` : ""}
            </div>
          </div>
        )}

        {status && <div className="tv-hint" style={{ color: "#ffd76e" }}>{status}</div>}

        {result && !busy && (
          <div className="tv-done">
            <div style={{ fontWeight: 700 }}>✅ {tab === "mp4" ? (result.fallback ? "Video" : "MP4") : tab.toUpperCase()} Ready!</div>
            <div className="tv-hint">{result.name} • {humanSize(result.blob.size)}</div>
            <button className="primary" onClick={() => downloadBlob(result.blob, result.name)}>
              Download {tab === "mp4" ? (result.fallback ? "video" : "MP4") : tab.toUpperCase()}
            </button>
          </div>
        )}

        <div className="modalactions">
          {busy
            ? <button onClick={cancel}>Cancel render</button>
            : <button onClick={onClose}>Cancel</button>}
          <button className="primary tv-bigexport" onClick={run} disabled={busy || !frames.length}>
            {busy ? "Rendering…" : `Export ${tab === "mp4" ? "MP4" : tab === "gif" ? "GIF" : tab === "sprite" ? "Sprite Sheet" : "PNG"}`}
          </button>
        </div>

        {showUpgrade && (
          <div className="tv-upgrade">
            <h3 style={{ margin: 0 }}>Upgrade to Pro</h3>
            <p className="muted" style={{ margin: 0 }}>1080p exports, no watermark, and full-quality audio.</p>
            <div className="modalactions">
              <button onClick={() => setShowUpgrade(false)}>Not now</button>
              <button className="primary" onClick={() => { setPlanTier("pro"); setPlan("pro"); setShowUpgrade(false); }}>Activate Pro</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
