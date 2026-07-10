const ADMIN_ROLES = ["admin", "super-admin", "superadmin", "super_admin", "super admin"];

// Returns the set of plants a user is allowed to see, lowercased for case-insensitive
// matching against the free-text `plant` columns used throughout the schema (scan_sessions,
// order_import_sessions, etc. — plant is stored as a name string, not a foreign key).
//
// null means "no restriction" (admin/super-admin — see every plant). A non-null array,
// including an empty one, means "restrict to exactly these plants" — an empty array is a
// deliberate zero-plants result for a user who hasn't been assigned any yet, not a bug.
//
// This is the first real consumer of users.plants; the field previously existed and was
// set from User Management but nothing on the read side ever filtered by it.
export function getUserPlantFilter(user: any): string[] | null {
  const role = (user?.role ?? "").toString().toLowerCase();
  if (ADMIN_ROLES.includes(role)) return null;

  let plants: string[] = [];
  try {
    plants = JSON.parse(user?.plants || "[]");
  } catch {
    plants = [];
  }
  return plants.map((p) => String(p).toLowerCase());
}
