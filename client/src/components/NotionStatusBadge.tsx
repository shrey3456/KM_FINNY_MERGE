import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";

// Notion's own pill colours (light mode) for each colour name a status option can have.
const NOTION_PILL: Record<string, { bg: string; fg: string }> = {
  default: { bg: "#E3E2E0", fg: "#32302C" },
  gray: { bg: "#E3E2E0", fg: "#32302C" },
  brown: { bg: "#EEE0DA", fg: "#603B2C" },
  orange: { bg: "#FADEC9", fg: "#854C1D" },
  yellow: { bg: "#FDECC8", fg: "#89632A" },
  green: { bg: "#DBEDDB", fg: "#1C3829" },
  blue: { bg: "#D3E5EF", fg: "#183347" },
  purple: { bg: "#E8DEEE", fg: "#412454" },
  pink: { bg: "#F5E0E9", fg: "#5E2C45" },
  red: { bg: "#FFE2DD", fg: "#5D1715" },
};

// What Notion's "Finny Status :" colours were when this was written — shown until (or if) the live
// list from /api/notion-status-options is available, so a badge never flashes grey on first paint.
const FALLBACK_COLORS: Record<string, string> = {
  "ORDER≈GENR": "yellow", "HI-PRIORITY": "red", "VEHI≈ASSGN": "orange", "VEHI≈ARRIV": "green",
  "ON HOLD": "red", "IN-PROCESS": "green", "SORTING": "pink", "READY≈LOAD": "blue",
  "LOADING": "green", "UNLOADING": "orange", "SHORTAGE": "blue", "CANCELLED": "red",
  "READY≈DESP": "brown", "DISPATCHED": "purple", "DELIVERED": "default",
};

type StatusOption = { name: string; color: string };

export function useNotionStatusColors() {
  const { data } = useQuery<{ options: StatusOption[] }>({
    queryKey: ['/api/notion-status-options'],
    queryFn: () => apiRequest('GET', '/api/notion-status-options').then((r) => r.json()),
    staleTime: 10 * 60_000,
  });
  return (status: string | null | undefined): { bg: string; fg: string } | null => {
    const key = String(status ?? "").trim().toUpperCase();
    if (!key) return null;
    const live = (data?.options ?? []).find((o) => o.name.trim().toUpperCase() === key)?.color;
    const color = live ?? FALLBACK_COLORS[key];
    return color ? (NOTION_PILL[color] ?? NOTION_PILL.default) : null;
  };
}

interface NotionStatusBadgeProps {
  status: string | null | undefined;
  /** Text to show when it should differ from the status name. */
  label?: string;
  className?: string;
}

export function NotionStatusBadge({ status, label, className }: NotionStatusBadgeProps) {
  const colorOf = useNotionStatusColors();
  const text = String(label ?? status ?? "").trim();
  if (!text) return null;
  const pill = colorOf(status);
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium",
        // Unknown status (not one of Notion's options): neutral grey.
        !pill && "bg-gray-100 text-gray-700",
        className,
      )}
      style={pill ? { backgroundColor: pill.bg, color: pill.fg } : undefined}
    >
      {text}
    </span>
  );
}
