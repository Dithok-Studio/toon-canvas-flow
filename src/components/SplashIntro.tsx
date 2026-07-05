import { useEffect, useMemo, useState } from "react";

/**
 * TOONVO animated splash intro.
 * JS-driven timings via setTimeout (not CSS animation-duration).
 * Total ~5s, then fades out and unmounts.
 */

const INTRO_DURATION = 5000; // 5 seconds total
const PARTICLE_START = 300;  // 0.3s
const LOGO_START = 800;      // 0.8s
const TAGLINE_START = 1500;  // 1.5s
const BAR_START = 2200;      // 2.2s
const HOLD_TIME = 3500;      // 3.5s
const FADE_START = 4000;     // 4.0s
const APP_SHOW = 5000;       // 5.0s
const SKIP_SHOW = 600;       // 0.6s

export default function SplashIntro({ onDone }: { onDone: () => void }) {
  const [showParticles, setShowParticles] = useState(false);
  const [showLogo, setShowLogo] = useState(false);
  const [showTagline, setShowTagline] = useState(false);
  const [showBar, setShowBar] = useState(false);
  const [showSkip, setShowSkip] = useState(false);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    console.log("Intro started", Date.now());
    const timers: number[] = [];
    timers.push(window.setTimeout(() => setShowParticles(true), PARTICLE_START));
    timers.push(window.setTimeout(() => setShowSkip(true), SKIP_SHOW));
    timers.push(window.setTimeout(() => {
      setShowLogo(true);
      console.log("Logo shown at", Date.now());
    }, LOGO_START));
    timers.push(window.setTimeout(() => {
      setShowTagline(true);
      console.log("Tagline shown at", Date.now());
    }, TAGLINE_START));
    timers.push(window.setTimeout(() => setShowBar(true), BAR_START));
    timers.push(window.setTimeout(() => {
      // brief hold before fade
    }, HOLD_TIME));
    timers.push(window.setTimeout(() => setFading(true), FADE_START));
    timers.push(window.setTimeout(() => {
      console.log("Intro done at", Date.now());
      onDone();
    }, APP_SHOW));

    // Suppress unused-const warnings for reference values.
    void INTRO_DURATION;
    void HOLD_TIME;

    return () => { timers.forEach((t) => clearTimeout(t)); };
  }, [onDone]);

  const particles = useMemo(
    () => Array.from({ length: 20 }).map((_, i) => ({
      left: Math.round((i * 53 + 17) % 100),
      delay: (i % 10) * 0.08,
      dur: 2.2 + ((i * 7) % 10) * 0.15,
      size: 2 + (i % 4),
    })),
    []
  );

  const skip = () => {
    console.log("Intro skipped at", Date.now());
    onDone();
  };

  return (
    <div className={"tv-splash" + (fading ? " tv-splash-out" : "")} role="dialog" aria-label="TOONVO loading">
      {showSkip && (
        <button className="tv-splash-skip" onClick={skip} aria-label="Skip intro">Skip →</button>
      )}

      {showParticles && (
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
      )}

      <div className="tv-splash-center">
        <div className={"tv-splash-logo" + (showLogo ? " is-in" : "")}>
          <span className="tv-splash-icon" aria-hidden>▦</span>
          <span className="tv-splash-word">TOONVO</span>
        </div>
        <div className={"tv-splash-tag" + (showTagline ? " is-in" : "")}>
          Draw&nbsp;&nbsp;·&nbsp;&nbsp;Animate&nbsp;&nbsp;·&nbsp;&nbsp;Create
        </div>
      </div>

      <div className="tv-splash-progress" aria-hidden>
        <div className="tv-splash-progress-fill" style={{ width: showBar ? "100%" : "0%" }} />
      </div>

      <style>{`
        .tv-splash {
          position: fixed; inset: 0; z-index: 9999;
          background: #0d0d1a;
          display: flex; align-items: center; justify-content: center;
          overflow: hidden;
          opacity: 1;
          transition: opacity 0.5s ease;
        }
        .tv-splash-out { opacity: 0; }

        .tv-splash-skip {
          position: fixed; top: 24px; right: 24px;
          background: rgba(26,26,46,0.8);
          border: 1px solid #6c63ff;
          color: rgba(255,255,255,0.9);
          font: 500 13px/1 system-ui, -apple-system, sans-serif;
          cursor: pointer; padding: 8px 16px;
          border-radius: 20px;
          z-index: 10000;
          transition: background 0.15s, color 0.15s;
        }
        .tv-splash-skip:hover { background: #6c63ff; color: #fff; }

        .tv-splash-particles { position: absolute; inset: 0; pointer-events: none; }
        .tv-splash-particle {
          position: absolute; bottom: -8px;
          border-radius: 50%;
          background: rgba(168,85,247,0.55);
          box-shadow: 0 0 8px rgba(108,99,255,0.45);
          animation-name: tv-splash-float;
          animation-timing-function: ease-out;
          animation-iteration-count: infinite;
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
          transition: opacity 0.6s ease, transform 0.6s ease;
          filter: drop-shadow(0 0 30px rgba(108,99,255,0.5));
        }
        .tv-splash-logo.is-in { opacity: 1; transform: scale(1); }
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
          transition: opacity 0.5s ease, transform 0.5s ease;
        }
        .tv-splash-tag.is-in { opacity: 1; transform: translateY(0); }

        .tv-splash-progress {
          position: absolute; left: 0; right: 0; bottom: 0;
          height: 2px; background: rgba(255,255,255,0.05);
        }
        .tv-splash-progress-fill {
          width: 0%; height: 100%;
          background: linear-gradient(90deg, #6c63ff, #a855f7);
          transition: width 0.8s ease-in-out;
          box-shadow: 0 0 8px rgba(108,99,255,0.6);
        }
      `}</style>
    </div>
  );
}
