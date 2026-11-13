import { PlantBadge } from "@/components/PlantBadge";

// The plant of an Unloading batch. Usually one plant badge. When the batch was unloaded for one plant
// (the PURCHASE plant) and its stock added to another (the STOCK plant) it reads "Rajkot → Valsad":
// purchase on the left, where the boxes ended up on the right.
export function PlantRoute({ plant, purchasePlant, className }: { plant: string | null | undefined; purchasePlant?: string | null; className?: string }) {
  if (!plant) return null;
  const differs = !!purchasePlant && purchasePlant.trim().toLowerCase() !== plant.trim().toLowerCase();
  if (!differs) return <PlantBadge plant={plant} className={className} />;
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-x-1 gap-y-0.5" title={`Purchase plant ${purchasePlant} → stock plant ${plant}`}>
      <PlantBadge plant={purchasePlant!} className={`shrink-0 whitespace-nowrap ${className ?? ""}`} />
      <span className="shrink-0 text-gray-400">→</span>
      <PlantBadge plant={plant} className={`shrink-0 whitespace-nowrap ${className ?? ""}`} />
    </span>
  );
}
