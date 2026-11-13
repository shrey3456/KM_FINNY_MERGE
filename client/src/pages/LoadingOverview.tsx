import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { LoadingViewerSection } from "./ScanViewerLoading";

// Load Master — every proforma slip of a plant and date (each opening in Load Operations) and every
// product those orders need, with each party's share, plus an order-number lookup that narrows the page
// to that one order. Its own page (access grant "loading-overview"). Plant-restricted: an admin sees
// every plant, everyone else only the plant(s) assigned to them — the server enforces the same rule,
// this just keeps the picker honest.
type Plant = { id: number; name: string; bgColor?: string | null; textColor?: string | null; borderColor?: string | null };

export default function LoadingOverview() {
  const { user } = useAuth();
  const isAdmin = ["admin", "super-admin"].includes(String((user as any)?.role ?? "").toLowerCase());
  const myPlants: string[] = (() => {
    try {
      const parsed = JSON.parse((user as any)?.plants ?? "[]");
      return Array.isArray(parsed) ? parsed.map((p: any) => String(p).trim().toUpperCase()).filter(Boolean) : [];
    } catch { return []; }
  })();

  const { data: allPlants } = useQuery<Plant[]>({
    queryKey: ["/api/plants", "loading-overview"],
    queryFn: () => apiRequest("GET", "/api/plants").then((r) => r.json()),
    staleTime: 60000,
  });
  const plantOptions = (allPlants ?? [])
    .map((p) => p.name)
    .filter((n) => isAdmin || myPlants.includes(n.trim().toUpperCase()))
    .sort((a, b) => a.localeCompare(b));
  const getPlantColorCfg = (plantName: string | null | undefined) => {
    const name = (plantName ?? "").trim().toUpperCase();
    if (!name || !allPlants) return null;
    return allPlants.find((p) => String(p.name ?? "").trim().toUpperCase() === name) ?? null;
  };

  return (
    <div className="mx-auto w-full max-w-[1800px] space-y-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold text-[#001d6e]">Load Master</h1>
        {!isAdmin && myPlants.length > 0 && (
          <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-semibold text-gray-600" title="Plants your account is allowed to see">
            Your plants: {myPlants.join(", ")}
          </span>
        )}
      </div>
      {!isAdmin && myPlants.length === 0 ? (
        <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-6 text-base text-amber-800">
          <ShieldAlert className="h-5 w-5 shrink-0" />
          No plant is assigned to your account, so there is nothing you can open here. Ask an admin to assign a plant.
        </div>
      ) : (
        <LoadingViewerSection plantOptions={plantOptions} getPlantColorCfg={getPlantColorCfg} />
      )}
    </div>
  );
}
