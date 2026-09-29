import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

// The one photo shown for a product across the scanning pages (Scan Operations, Loading,
// Unloading) — box shot preferred, product shot as the fallback, in that order, then nothing.
// Sort Slip's own item table does this too, but knows in advance whether a box image exists (it
// already has the full product row loaded) and so never needs a failed request to find out. Here
// the caller usually has only an id or a bare name — so instead this tries each URL in turn and
// falls through on a 404, cheapest-first:
//   box-image-by-id  →  image-by-id  →  box-image-by-name  →  image-by-name  →  nothing
// An id-based pair is tried before the name-based pair whenever an id is given, since the id
// lookup is immune to a product being renamed; the name pair only runs at all once the id pair
// (if there was an id) has already failed.
const SOURCES = ["boxById", "imageById", "boxByName", "imageByName"] as const;
type Source = (typeof SOURCES)[number];

function urlFor(source: Source, productId: number | null | undefined, name: string | null | undefined): string | null {
  if ((source === "boxById" || source === "imageById") && productId == null) return null;
  if ((source === "boxByName" || source === "imageByName") && !name) return null;
  switch (source) {
    case "boxById": return `/api/products/box-image-by-id?id=${productId}`;
    case "imageById": return `/api/products/image-by-id?id=${productId}`;
    case "boxByName": return `/api/products/box-image-by-name?name=${encodeURIComponent(name!)}`;
    case "imageByName": return `/api/products/image-by-name?name=${encodeURIComponent(name!)}`;
  }
}

// Click-to-enlarge popup for a product picture — the small thumbnails/cards are hard to read on a
// phone or a wall-mounted screen, so tapping one opens it big in a dialog.
export function ImageLightbox({ src, title, open, onClose }: { src: string; title?: string | null; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="flex max-h-[92vh] w-[calc(100vw-1rem)] max-w-3xl flex-col items-center gap-3 overflow-hidden p-4">
        <DialogHeader className="w-full text-left">
          <DialogTitle className="break-words pr-6 text-base text-[#001d6e]">{title || "Product image"}</DialogTitle>
          <DialogDescription className="sr-only">Enlarged product image</DialogDescription>
        </DialogHeader>
        <img src={src} alt={title ?? ""} className="max-h-[75vh] w-full min-h-0 rounded-md bg-gray-50 object-contain" />
      </DialogContent>
    </Dialog>
  );
}

// A plain <img> that opens in the lightbox when clicked (used where the image URL is already known).
export function ZoomableImg({ src, alt = "", title, className, style, onError }: {
  src: string; alt?: string; title?: string | null; className?: string; style?: React.CSSProperties; onError?: React.ReactEventHandler<HTMLImageElement>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <img
        src={src}
        alt={alt}
        loading="lazy"
        className={`${className ?? ""} cursor-zoom-in`}
        style={style}
        onError={onError}
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
      />
      <ImageLightbox src={src} title={title ?? alt} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function ProductPhoto({
  productId, name, className, style, alt = "", onLoadState, zoomable = false,
}: {
  productId?: number | null;
  name?: string | null;
  className?: string;
  style?: React.CSSProperties;
  alt?: string;
  /** Told whenever every source has been tried and none loaded, or a source starts loading again
   *  (e.g. the caller wants to reflow layout instead of leaving a blank gap — see the callers'
   *  own former imageFailed state, which this replaces). */
  onLoadState?: (failed: boolean) => void;
  /** Clicking the picture opens it enlarged in a popup. */
  zoomable?: boolean;
}) {
  const [sourceIndex, setSourceIndex] = useState(0);
  const [zoomOpen, setZoomOpen] = useState(false);

  // A different product (id or name changed) starts the cascade over from the top. Straight to
  // "failed" when there's nothing at all to try (neither an id nor a name given) — otherwise the
  // caller would never be told, since no request (and so no onError) ever fires in that case.
  useEffect(() => {
    setSourceIndex(0);
    onLoadState?.(productId == null && !name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, name]);

  // Skip straight past any tier that has nothing to try (no id given at all, or no name given at
  // all) instead of firing a request that can only ever 404.
  let index = sourceIndex;
  while (index < SOURCES.length && !urlFor(SOURCES[index], productId, name)) index++;

  if (index >= SOURCES.length) return null;
  const src = urlFor(SOURCES[index], productId, name)!;

  return (
    <>
      <img
        key={`${productId ?? ""}:${name ?? ""}`}
        src={src}
        alt={alt}
        loading="lazy"
        className={zoomable ? `${className ?? ""} cursor-zoom-in` : className}
        style={style}
        onClick={zoomable ? (e) => { e.stopPropagation(); setZoomOpen(true); } : undefined}
        onError={() => {
          const next = index + 1;
          if (next >= SOURCES.length) onLoadState?.(true);
          setSourceIndex(next);
        }}
      />
      {zoomable && <ImageLightbox src={src} title={name ?? alt} open={zoomOpen} onClose={() => setZoomOpen(false)} />}
    </>
  );
}
