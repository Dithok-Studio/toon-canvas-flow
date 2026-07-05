import { useEffect, useMemo, useState } from "react";

/**
 * TOONVO animated splash intro.
 * ~2.5s sequence, then fades out and unmounts.
 * Callers control mounting via sessionStorage gating.
 */
export default function SplashIntro({ onDone }: { onDone: () => void }) {
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const t1 = window.setTimeout(() => setExiting(true), 2500);
    const t2 = window.setTimeout(() => onDone(), 2850);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [onDone]);

  const particles = useMemo(
    () => Array.from({ length: 20 }).map((_, i) => ({
      left: Math.round((i * 53 + 17) % 100),
      delay: 0.3 + (i % 10) * 0.08,
      dur: 2.2 + ((i * 7) % 10) * 0.15,
      size: 2 + (i % 4),
    })),
    []
  );

  const skip = () => { setExiting(true); window.setTimeout(onDone, 300); };

  return (
    <div className={"tv-splash" + (exiting ? " tv-splash-out" : "")} role="dialog" aria-label="TOONVO loading">
      <button className="tv-splash-skip" onClick={skip} aria-label="Skip intro">Skip →</button>

      <div className="tv-splash-particles" aria-hidden>
        {particles.map((p, i) => (
          <span
            key={i}
            className="tv-splash-particle"
            style={{
              left: `${p.left}%`,
              width: p.size,
              height: p.size,
              animationDelay: `${p.delay}s`,
              animationDuration: `${p.dur}s`,
            }}
          />
        ))}
      </div>

      <div className="tv-splash-center">
        <div className="tv-splash-logo">
          <span className="tv-splash-icon" aria-hidden>▦</span>
          <span className="tv-splash-word">TOONVO</span>
        </div>
        <div className="tv-splash-tag">Draw&nbsp;&nbsp;·&nbsp;&nbsp;Animate&nbsp;&nbsp;·&nbsp;&nbsp;Create</div>
      </div>

      <div className="tv-splash-progress" aria-hidden>
        <div className="tv-splash-progress-fill" />
      </div>

      <style>{`
        .tv-splash {
          position: fixed; inset: 0; z-index: 9999;
          background: #0d0d1a;
          display: flex; align-items: center; justify-content: center;
          overflow: hidden;
          animation: tv-splash-in 0.2s ease-out both;
        }
        .tv-splash-out { animation: tv-splash-out 0.3s ease-in forwards; }
        @keyframes tv-splash-in { from { opacity: 0 } to { opacity: 1 } }
        @keyframes tv-splash-out { from { opacity: 1 } to { opacity: 0 } }

        .tv-splash-skip {
          position: fixed; top: 24px; right: 24px;
          background: rgba(26,26,46,0.8);
          border: 1px solid #6c63ff;
          color: rgba(255,255,255,0.9);
          font: 500 13px/1 system-ui, -apple-system, sans-serif;
          cursor: pointer; padding: 8px 16px;
          border-radius: 20px;
          z-index: 9999;
          opacity: 0; animation: tv-splash-skip-in 0.4s ease-out 0.5s forwards;
          transition: background 0.15s, color 0.15s;
        }
        .tv-splash-skip:hover { background: #6c63ff; color: #fff; }
        @keyframes tv-splash-skip-in { to { opacity: 1 } }


        .tv-splash-particles { position: absolute; inset: 0; pointer-events: none; }
        .tv-splash-particle {
          position: absolute; bottom: -8px;
          border-radius: 50%;
          background: rgba(168,85,247,0.55);
          box-shadow: 0 0 8px rgba(108,99,255,0.45);
          animation-name: tv-splash-float;
          animation-timing-function: ease-out;
          animation-iteration-count: 1;
          animation-fill-mode: both;
          opacity: 0;
        }
        @keyframes tv-splash-float {
          0%   { transform: translateY(0);      opacity: 0; }
          20%  { opacity: 0.9; }
          100% { transform: translateY(-260px); opacity: 0; }
        }

        .tv-splash-center {
          display: flex; flex-direction: column; align-items: center; gap: 14px;
        }
        .tv-splash-logo {
          display: flex; align-items: center; gap: 18px;
          opacity: 0; transform: scale(0.85);
          animation: tv-splash-logo-in 0.6s cubic-bezier(.2,.7,.2,1) 0.7s forwards;
          filter: drop-shadow(0 0 30px rgba(108,99,255,0.5));
        }
        @keyframes tv-splash-logo-in {
          to { opacity: 1; transform: scale(1); }
        }
        .tv-splash-icon {
          display: inline-block;
          font-size: 48px; line-height: 1;
          background: linear-gradient(135deg, #6c63ff, #a855f7);
          -webkit-background-clip: text; background-clip: text;
          -webkit-text-fill-color: transparent; color: transparent;
        }
        @media (min-width: 768px) { .tv-splash-icon { font-size: 60px; } }
        .tv-splash-word {
          font: 900 48px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
          letter-spacing: 0.02em;
          background: linear-gradient(135deg, #6c63ff, #a855f7);
          -webkit-background-clip: text; background-clip: text;
          -webkit-text-fill-color: transparent; color: transparent;
        }
        @media (min-width: 768px) { .tv-splash-word { font-size: 72px; } }

        .tv-splash-tag {
          color: rgba(255,255,255,0.6);
          font: 500 13px/1 system-ui, -apple-system, sans-serif;
          letter-spacing: 0.28em; text-transform: uppercase;
          opacity: 0; transform: translateY(10px);
          animation: tv-splash-tag-in 0.5s ease-out 1.5s forwards;
        }
        @keyframes tv-splash-tag-in {
          to { opacity: 1; transform: translateY(0); }
        }

        .tv-splash-progress {
          position: absolute; left: 0; right: 0; bottom: 0;
          height: 2px; background: rgba(255,255,255,0.05);
          opacity: 0; animation: tv-splash-tag-in 0.3s ease-out 1.9s forwards;
        }
        .tv-splash-progress-fill {
          width: 0%; height: 100%;
          background: linear-gradient(90deg, #6c63ff, #a855f7);
          animation: tv-splash-progress-fill 0.55s ease-out 2s forwards;
          box-shadow: 0 0 8px rgba(108,99,255,0.6);
        }
        @keyframes tv-splash-progress-fill {
          to { width: 100%; }
        }
      `}</style>
    </div>
  );
}
