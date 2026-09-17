import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type StatTone = "navy" | "emerald" | "amber" | "red" | "muted";

const TONES: Record<StatTone, { badge: string; icon: string; value: string }> = {
  navy: { badge: "bg-[#001d6e]/10", icon: "text-[#001d6e]", value: "text-gray-900" },
  emerald: { badge: "bg-emerald-50", icon: "text-emerald-600", value: "text-emerald-600" },
  amber: { badge: "bg-amber-50", icon: "text-amber-500", value: "text-amber-600" },
  red: { badge: "bg-red-50", icon: "text-red-400", value: "text-red-500" },
  muted: { badge: "bg-gray-50", icon: "text-gray-300", value: "text-gray-300" },
};

export interface StatItem {
  icon: LucideIcon;
  /** Big number / short status text. */
  value: ReactNode;
  /** Small caption under the value. */
  label: ReactNode;
  /** Optional smaller, lighter detail under the label — one line, or an array for one fact per line
   *  (e.g. period, pallet count). Always shown in full: lines wrap rather than being cut off. */
  hint?: ReactNode | ReactNode[];
  tone?: StatTone;
  /** Use for short words ("Connected") rather than numbers, so they don't render oversized. */
  isTextValue?: boolean;
}

// A seven-digit total can't be shown at the same size as a two-digit one in a tile that is a
// sixth of the row — it either overflows or crowds the icon. The step down is by character count
// (grouping separators included, since they take space too), so ordinary numbers keep the big
// type and only genuinely long ones shrink, and nothing is ever cut off or abbreviated.
function valueSizeClass(value: ReactNode): string {
  const length = typeof value === "string" || typeof value === "number" ? String(value).length : 0;
  if (length >= 12) return "text-sm sm:text-base";   // 1,234,567,890
  if (length >= 10) return "text-base sm:text-lg";   // 123,456,789
  if (length >= 8) return "text-lg sm:text-xl";      // 2,947,087
  return "text-xl sm:text-2xl";
}

// Static classes only — Tailwind can't see dynamically built class names at build time.
const MD_COLS: Record<number, string> = {
  1: "md:grid-cols-1",
  2: "md:grid-cols-2",
  3: "md:grid-cols-3",
  4: "md:grid-cols-4",
  5: "md:grid-cols-5",
  6: "md:grid-cols-6",
};

interface StatsBarProps {
  stats: StatItem[];
  /** Buttons rendered in a bar beneath the tiles. Omit for a stats-only card. */
  actions?: ReactNode;
  /** Tiles per row on md+ screens. Defaults to the number of stats (capped at 6). */
  columns?: number;
  /** Let long captions wrap onto multiple lines instead of truncating with an ellipsis. */
  wrapLabels?: boolean;
  className?: string;
}

/**
 * Stats tiles (+ optional action bar) in one bordered card — the Product Master
 * header treatment, reusable across modules.
 */
export function StatsBar({ stats, actions, columns, wrapLabels, className }: StatsBarProps) {
  const cols = Math.min(columns ?? stats.length, 6);
  const hasHints = stats.some((stat) => stat.hint != null);

  return (
    <div className={cn("rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden", className)}>
      <div
        className={cn(
          "grid grid-cols-2 divide-x divide-gray-100",
          MD_COLS[cols] ?? "md:grid-cols-4",
          actions && "border-b border-gray-100",
        )}
      >
        {stats.map((stat, i) => {
          const tone = TONES[stat.tone ?? "navy"];
          const Icon = stat.icon;
          return (
            <div
              key={i}
              // Tiles with detail lines can differ in height — top-align them so every big number
              // sits on the same line across the row.
              className={cn("flex gap-2 px-3 py-3 sm:gap-3 sm:px-5 sm:py-4", hasHints ? "items-start" : "items-center")}
            >
              <div
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg sm:h-10 sm:w-10",
                  tone.badge,
                )}
              >
                <Icon className={cn("h-4 w-4 sm:h-5 sm:w-5", tone.icon)} />
              </div>
              <div className="min-w-0">
                <p
                  className={cn(
                    "font-extrabold leading-none",
                    // tabular-nums: every digit the same width, so the figures line up down the
                    // row instead of drifting against each other.
                    stat.isTextValue ? "text-xs sm:text-sm font-bold" : cn("tabular-nums", valueSizeClass(stat.value)),
                    tone.value,
                  )}
                >
                  {stat.value}
                </p>
                {/* text-sm at every width: at sm:text-base a two-word caption ("Expected Purchase")
                    wrapped onto a second line and left the tiles at uneven heights. */}
                <p className={cn("mt-0.5 text-sm font-medium text-gray-500", wrapLabels ? "break-words" : "truncate")}>
                  {stat.label}
                </p>
                {(Array.isArray(stat.hint) ? stat.hint : [stat.hint])
                  .filter((line) => line != null && line !== "" && line !== false)
                  .map((line, lineIndex) => (
                    <p key={lineIndex} className="mt-0.5 break-words text-xs font-medium leading-snug tabular-nums text-gray-400">
                      {line}
                    </p>
                  ))}
              </div>
            </div>
          );
        })}
      </div>

      {actions && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 sm:px-4">{actions}</div>
      )}
    </div>
  );
}
