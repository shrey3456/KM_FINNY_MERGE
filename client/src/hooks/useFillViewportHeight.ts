import { useEffect, useRef, useState } from "react";

// A block that should reach the bottom of the window: the height from where its top edge sits to the
// bottom of the viewport (less a small gap), re-measured on resize and whenever the page above it changes
// size (a header shown or hidden, the totals card growing). Attach `ref` to the element whose top edge
// marks where the block starts; use `height` as a px string for its min-height and max-height.
// Returns undefined until measured, and when `enabled` is false (so a phone keeps its natural height).
export function useFillViewportHeight<T extends HTMLElement>(enabled = true, bottomGap = 16, minimum = 360) {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState<string | undefined>();

  useEffect(() => {
    if (!enabled) { setHeight(undefined); return; }
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      setHeight(`${Math.max(minimum, Math.floor(window.innerHeight - top - bottomGap))}px`);
    };
    measure();
    const raf = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", measure); ro.disconnect(); };
  });

  return { ref, height };
}
