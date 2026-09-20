import { cn } from "@/lib/utils";

// Shared loading placeholders — the grey shapes shown while data is on its way, instead of a spinner.
// A soft light sweep runs across them (the .skeleton-shimmer class in index.css) rather than a blink,
// and the shapes roughly match what's about to appear, so the page doesn't jump when it lands.
// Button spinners ("Saving…", "Importing…") are deliberately NOT replaced by these: those show that
// an action is running, not that content is loading.

const LINE_WIDTHS = ["w-11/12", "w-3/4", "w-5/6", "w-2/3", "w-4/5", "w-1/2"];

export function SkeletonBar({ className }: { className?: string }) {
  return <div className={cn("skeleton-shimmer h-3 rounded-md", className)} />;
}

/** A few stacked lines — for a panel, a drill-down or a small list that's loading. */
export function SectionSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("space-y-2.5 p-3", className)} role="status" aria-live="polite">
      {Array.from({ length: Math.max(1, lines) }).map((_, i) => (
        <SkeletonBar key={i} className={i === 0 ? "h-4 w-1/3" : LINE_WIDTHS[i % LINE_WIDTHS.length]} />
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}

/** Table-shaped placeholder: a header strip and rows of cells. */
export function TableSkeleton({
  columns = 5,
  rows = 6,
  className,
}: {
  columns?: number;
  rows?: number;
  className?: string;
}) {
  // Past ~8 columns the cells get too thin to read as a table; the shape matters, not the count.
  const cols = Math.max(1, Math.min(columns, 8));
  return (
    <div className={cn("overflow-hidden rounded-md border border-gray-200 bg-white", className)} role="status" aria-live="polite">
      <div className="flex gap-3 bg-[#001d6e] px-3 py-3">
        {Array.from({ length: cols }).map((_, c) => (
          <div key={c} className="h-3 flex-1 rounded bg-white/20" />
        ))}
      </div>
      <div className="divide-y divide-gray-100">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="flex items-center gap-3 px-3 py-3.5">
            {Array.from({ length: cols }).map((_, c) => (
              // A few shorter cells so the rows don't look like one solid block.
              <div key={c} className="flex-1">
                <SkeletonBar className={cn(c === 0 ? "h-3.5" : "h-3", (r + c) % 3 === 0 ? "w-2/3" : "w-full")} />
              </div>
            ))}
          </div>
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}

/** Whole-page placeholder: title, a row of tiles, then a table. */
export function PageSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("w-full space-y-4 p-4 lg:p-6", className)} role="status" aria-live="polite">
      <div className="flex items-center gap-3">
        <div className="skeleton-shimmer h-9 w-9 rounded-lg" />
        <div className="flex-1 space-y-2">
          <SkeletonBar className="h-5 w-48 max-w-full" />
          <SkeletonBar className="h-3 w-72 max-w-full" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="skeleton-shimmer h-20 rounded-xl" />
        ))}
      </div>
      <TableSkeleton columns={6} rows={6} />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
