import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import ToonvoEditor from "@/components/ToonvoEditor";
import SplashIntro from "@/components/SplashIntro";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "TOONVO — Frame-by-frame animation studio" },
      { name: "description", content: "Professional 2D frame-by-frame animation in your browser. Draw, animate, and export — fully offline." },
      { name: "theme-color", content: "#0d0d1a" },
      { property: "og:title", content: "TOONVO" },
      { property: "og:description", content: "Professional 2D frame-by-frame animation in your browser." },
    ],
    links: [
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/icon-192.png" },
    ],
  }),
  component: Index,
});

const SPLASH_KEY = "toonvo-splash-seen";

function Index() {
  // Client-only mount — the editor uses `document`/`localStorage` in refs
  // and file-input buttons that don't hydrate cleanly. Rendering it only
  // after mount avoids SSR/CSR mismatches without changing editor internals.
  const [mounted, setMounted] = useState(false);
  const [showSplash, setShowSplash] = useState(true);

  useEffect(() => {
    setMounted(true);
  }, []);


  if (!mounted) {
    // Same background as splash so the SSR shell blends into the intro.
    return <div style={{ position: "fixed", inset: 0, background: "#0d0d1a" }} />;
  }

  return (
    <>
      <ToonvoEditor />
      {showSplash && <SplashIntro onDone={() => setShowSplash(false)} />}
    </>
  );
}
