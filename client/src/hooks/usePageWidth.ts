import { useLayoutEffect, useRef, useState } from "react";

// The page's own drawn width, kept live via ResizeObserver — used to switch a wide table over to
// stacked cards once the page itself gets too narrow to show every column without a sideways
// scroll. The viewport being "md"/"lg" isn't a reliable enough signal on its own: a phone-shaped
// device view, a page squeezed by a sidebar, or a tablet in portrait (an iPad or a Realme Pad 2,
// say) can all report a wide viewport while the page's own content column is much narrower.
// Originally written for DailyReports.tsx; shared here so any page with the same wide-table-on-
// small-screens problem (AdjustExchange.tsx, etc.) uses the identical mechanism.
export function usePageWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}
