import { Request, Response, NextFunction } from "express";

const WRITE_ADMIN_ROLES = ["admin", "super-admin", "superadmin", "super_admin", "super admin"];

// Generic write-access gate, reusable across any page key from CONTROLLABLE_PAGES
// (client/src/pages/Users.tsx). Admin/super-admin always pass. Anyone else passes only if
// admin has explicitly granted them write access to this specific page via pageWriteAccess
// on the Users page. Used for routes that previously had NO server-side check at all —
// this is a NEW restriction there (not a role-check swap), so it's applied deliberately,
// page by page, rather than globally.
export function requirePageWrite(pageKey: string | string[]) {
  const pageKeys = Array.isArray(pageKey) ? pageKey : [pageKey];
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    const user = req.user as any;
    const role = (user?.role ?? "").toString().toLowerCase();
    if (WRITE_ADMIN_ROLES.includes(role)) return next();
    let writable: string[] = [];
    try { writable = JSON.parse(user?.pageWriteAccess || "[]"); } catch { /* default [] */ }
    if (pageKeys.some((key) => writable.includes(key))) return next();
    return res.status(403).json({ message: "Write access required" });
  };
}
