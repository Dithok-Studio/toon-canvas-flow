import { useEffect, useState } from "react";

export type Breakpoint = "mobile" | "tablet" | "desktop";

export function bpFromWidth(w: number): Breakpoint {
  if (w >= 1024) return "desktop";
  if (w >= 768) return "tablet";
  return "mobile";
}

/**
 * Live breakpoint. Starts as "desktop" during SSR / first paint so the existing
 * desktop layout is never disturbed, then syncs on mount and on resize.
 */
export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>("desktop");
  useEffect(() => {
    const update = () => setBp(bpFromWidth(window.innerWidth));
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);
  return bp;
}
