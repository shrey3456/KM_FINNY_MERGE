// State-based SAP codes. A product has one SAP code per state (Product Master: GJ SAP, MP SAP, UP SAP), and a plant belongs to a state
// (plants.state). Wherever a product is searched and added for a plant, the SAP code that counts is the one for THAT plant's state:
//   - searching by SAP matches only that state's code (101826 is an MP code, so it is found for INDORE and not for VALSAD / RAJKOT),
//   - barcode and name searches are not limited by state (a barcode shared by two products shows both),
//   - the SAP column of an added row is filled with that state's code,
//   - a product with no SAP for that state is not added until it is filled in Product Master.

export type SapProduct = {
  name?: string | null;
  barcode?: string | null;
  sapCode?: string | null; // the general SAP column; mirrors the GJ SAP in this data
  gjSap?: string | null;
  mpSap?: string | null;
  upSap?: string | null;
};

type PlantLike = { name?: string | null; state?: string | null };

// "GJ" / "MP" / "UP" for a plant name, or null when the plant is unknown or has no state.
export function stateOfPlant(plant: string | null | undefined, allPlants: PlantLike[] | null | undefined): string | null {
  const wanted = String(plant ?? "").trim().toLowerCase();
  if (!wanted) return null;
  const match = (allPlants ?? []).find((p) => String(p.name ?? "").trim().toLowerCase() === wanted);
  const state = match?.state ? String(match.state).trim().toUpperCase() : "";
  return state || null;
}

const clean = (v: string | null | undefined) => String(v ?? "").trim();

// The product's SAP code for a state ("" when it has none). The general SAP column stands in for GJ (it mirrors it). With no
// known state (a plant that is not set up) there is no state to follow, so any code the product has is used.
export function sapForState(p: SapProduct | null | undefined, state: string | null): string {
  if (!p) return "";
  if (state === "GJ") return clean(p.gjSap) || clean(p.sapCode);
  if (state === "MP") return clean(p.mpSap);
  if (state === "UP") return clean(p.upSap);
  return clean(p.sapCode) || clean(p.gjSap) || clean(p.mpSap) || clean(p.upSap);
}

// Name and barcode match as typed; the SAP code matched is only the state's own.
export function productMatchesSearch(p: SapProduct, query: string, state: string | null): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return (
    clean(p.name).toLowerCase().includes(q) ||
    clean(p.barcode).toLowerCase().includes(q) ||
    sapForState(p, state).toLowerCase().includes(q)
  );
}

// null when the product can be added; otherwise the reason it cannot.
export function sapBlockMessage(p: SapProduct | null | undefined, state: string | null): string | null {
  if (!p) return null;
  if (sapForState(p, state)) return null;
  return `SAP code is empty for ${state ?? "this plant's state"} — fill it in Product Master first, then add.`;
}

// Barcodes that more than one product shares (one per state in this data). A row already in a CSV for such a barcode only
// rules out the product it really is, not its twin.
export function sharedBarcodes(products: SapProduct[]): Set<string> {
  const seen = new Map<string, number>();
  for (const p of products) {
    const b = clean(p.barcode).toLowerCase();
    if (b) seen.set(b, (seen.get(b) ?? 0) + 1);
  }
  return new Set(Array.from(seen.entries()).filter(([, n]) => n > 1).map(([b]) => b));
}
