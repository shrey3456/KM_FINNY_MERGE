import { ChevronUp, ChevronDown } from "lucide-react";

// Layout.tsx's <main className="flex-1 overflow-y-auto ..."> is the one real scroll owner on
// every page in this app — the same fact this app's own position:sticky decisions already rely
// on. Earlier this walked UP the button's own DOM ancestors looking for something with
// overflow-y:auto AND scrollHeight > clientHeight — that second condition is the bug: on a page
// whose <main> doesn't happen to overflow at the exact moment you click (a Loading slip is
// mostly its own item table, which scrolls internally; the surrounding page content can be short
// enough to fit without <main> itself overflowing yet), the walk found nothing to scroll and the
// buttons did nothing. Targeting <main> directly, unconditionally, fixes that — scrollBy on an
// element that isn't currently overflowing is simply a harmless no-op, never an error.
function scrollTarget(): Element {
  return document.querySelector("main") ?? document.scrollingElement ?? document.documentElement;
}

/**
 * Floating Up / Down pill (same look as the Order Scan / Unloading kiosk scroll buttons) that
 * scrolls the page a screenful at a time — for small screens and touch kiosks where dragging a long
 * page is awkward. Render it once anywhere inside the page; it is fixed to the bottom-right corner
 * above the rotate button.
 */
export function PageScrollButtons({ amount = 360 }: { amount?: number }) {
  const nudge = (dir: 1 | -1) => scrollTarget().scrollBy({ top: dir * amount, behavior: "smooth" });
  const btn = "rounded-2xl bg-white/10 p-2.5 text-white transition hover:bg-white/20 active:scale-95";
  return (
    <div className="fixed bottom-24 right-4 z-[60] flex flex-col items-center gap-2 rounded-3xl bg-[#001d6e] px-2 py-2.5 text-white shadow-xl ring-1 ring-white/10">
      <button type="button" onClick={() => nudge(-1)} aria-label="Scroll up" title="Scroll up" className={btn}>
        <ChevronUp className="h-6 w-6" />
      </button>
      <button type="button" onClick={() => nudge(1)} aria-label="Scroll down" title="Scroll down" className={btn}>
        <ChevronDown className="h-6 w-6" />
      </button>
    </div>
  );
}
