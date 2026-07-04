## Scope

Five large features requested on the existing `ToonvoEditor.tsx` (2,100+ lines). To keep Day 1/2/3A features intact and avoid regressions, I'd like to land them in 2 phases across this turn and the next. Nothing gets rebuilt — only additive edits.

## Phase 1 (this turn)

1. **Fix hydration warning** — the topbar file-import buttons currently mismatch during SSR. Move the editor mount behind a client-only guard on `/` so hydration is clean before we add more UI.
2. **Section 12 — Splash intro** — new `SplashIntro.tsx` overlay (particles → logo → tagline → progress bar → fade out, ~2.5 s), sessionStorage flag so it only shows on fresh load, Skip button. Pure CSS keyframes, 60fps, offline.
3. **Section 14 — Moving watermark** — new `lib/watermark.ts` helper drawing the pill-shaped "● Made with TOONVO" mark with sine-wave drift, opacity pulse (45→65%), safe-zone clamping. Wired into GIF + MP4 720 export paths; fixed corner for PNG/sprite. Free plan flag (default `true`, upgrade note in export modal).
4. **Section 10 — Text tool (core)** — new `text` tool in a `Text` group (`T` key). Click to place a live editable textarea overlay on the canvas; font family/size, B/I/U, color, opacity, alignment, letter-spacing, line-height in the top options bar. Enter = newline, Esc/click-outside = rasterize onto active layer. Outline/shadow/background toggles included. (Corner-handle resizing of the pre-raster text box lands in phase 2 if time-tight.)

## Phase 2 (next turn, after you confirm Phase 1 works)

5. **Section 11 — Warp/Distort tool** — `W` key, modes: free-mesh, bulge, pinch, twirl L/R, wave H/V, perspective. Non-destructive preview canvas, Apply/Reset/Escape, brush size + strength + hardness, scope selector (layer / selection / all visible).
6. **Section 13 — Measure + scale tools** — `U` key measure tool (px/cm/in/mm, angle, ΔX/ΔY, Shift snap 45°), guides drag-from-ruler, delete on double-click, "Set Scale" calibration, grid size presets + custom + color + snap, live dimension label while dragging any shape.

## Why split

Warp (Section 11) alone requires a mesh renderer, per-pixel displacement, and a preview compositing pipeline — it deserves its own turn so I can verify it against Day-3A selection/floating logic without racing four other features. Same for the measure/guides system, which touches ruler rendering and shape draw paths.

## Technical notes

- All new state lives inside `ToonvoEditor` or new sibling components; no changes to `Frame`/`Layer` shape.
- Watermark is a pure draw-time overlay on export ImageBitmap frames; no persisted data.
- Splash is a top-level overlay in `src/routes/index.tsx`, gated by `sessionStorage['toonvo-splash-seen']`.
- Text tool rasterizes via a hidden `<canvas>` using the same font/style so on-canvas pixels match the live preview exactly.
- Plan tier stored in `localStorage['toonvo-plan']` (default `"free"`), read by export functions.

Confirm and I'll execute Phase 1 immediately.
