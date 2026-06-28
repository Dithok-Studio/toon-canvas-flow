import { createFileRoute } from "@tanstack/react-router";
import ToonvoEditor from "@/components/ToonvoEditor";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "TOONVO — Frame-by-frame animation studio" },
      { name: "description", content: "Professional 2D frame-by-frame animation in your browser. Draw, animate, and export — fully offline." },
      { name: "theme-color", content: "#1a1a2e" },
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

function Index() {
  return <ToonvoEditor />;
}
