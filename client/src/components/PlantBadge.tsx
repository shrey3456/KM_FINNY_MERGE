import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";

interface PlantBadgeProps {
  plant: string | null | undefined;
  /** Short display label; the full plant name remains available as a tooltip. */
  label?: string;
  className?: string;
  onClick?: React.MouseEventHandler<HTMLSpanElement>;
}

type PlantColor = { name: string; bgColor: string; textColor: string; borderColor: string };

export function PlantBadge({ plant, label, className, onClick }: PlantBadgeProps) {
  // Colors come straight from Plant Management (the plants table) — no hardcoded per-name map, so
  // whatever an admin configures there is exactly what shows here. Shared/cached query key.
  const { data: plants } = useQuery<PlantColor[]>({
    queryKey: ['/api/plants'],
    queryFn: () => apiRequest('GET', '/api/plants').then((r) => r.json()),
    staleTime: 60_000,
  });

  if (!plant) return <span className="text-muted">N/A</span>;

  const cfg = (plants ?? []).find((p) => p.name.toUpperCase() === plant.toUpperCase());

  return (
    <span
      className={cn(
        "inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-xs font-medium border",
        // Neutral fallback only while the plants list is loading or the plant isn't configured.
        !cfg && "bg-gray-100 text-gray-800 border-gray-500",
        className
      )}
      style={cfg ? { backgroundColor: cfg.bgColor, color: cfg.textColor, borderColor: cfg.borderColor } : undefined}
      onClick={onClick}
      title={plant.toUpperCase()}
    >
      {label ?? plant.toUpperCase()}
    </span>
  );
}
