import { Router, Request, Response } from "express";
import { db } from "../db";
import { voucherPrefixes, type VoucherPrefix } from "@shared/schema";
import { eq } from "drizzle-orm";

const router = Router();

// Get all voucher prefixes (public)
router.get("/voucher-prefixes", async (req: Request, res: Response) => {
  try {
    const rows = await db.select().from(voucherPrefixes);
    const result: Record<string, string> = {};
    for (const r of rows) {
      result[r.type] = r.prefix;
    }
    return res.json({ success: true, data: result });
  } catch (error) {
    console.error("Error fetching voucher prefixes:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch prefixes" });
  }
});

// Update a prefix for a given type - restricted to admin/super-admin via session
router.put("/voucher-prefixes/:type", async (req: Request, res: Response) => {
  try {
    // Auth check
    if (!req.isAuthenticated || !req.isAuthenticated()) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }

    const user: any = (req as any).user;
    const role = (user?.role || "").toString().toLowerCase();
    if (!["admin", "super-admin", "superadmin", "super_admin"].includes(role)) {
      return res.status(403).json({ success: false, message: "Forbidden: admin only" });
    }

    const type = req.params.type;
    const { prefix } = req.body;
    if (!type || !prefix) {
      return res.status(400).json({ success: false, message: "Type and prefix are required" });
    }

    // Check if exists
    const existing = await db.select().from(voucherPrefixes).where(eq(voucherPrefixes.type, type)).limit(1);
    let savedRow: any = null;
    if (existing.length) {
      const updated = await db.update(voucherPrefixes).set({ prefix, updatedBy: user.userCode || user.username, updatedAt: new Date() }).where(eq(voucherPrefixes.type, type)).returning();
      savedRow = updated[0];
    } else {
      const inserted = await db.insert(voucherPrefixes).values({ type, prefix, updatedBy: user.userCode || user.username }).returning();
      savedRow = inserted[0];
    }

    // If the new prefix contains a KM####- token, propagate the year token to other prefixes
    // NOTE: intentionally do NOT propagate year tokens to other prefixes.
    // Changing one prefix should only affect that prefix (expense OR toll).

    // After saving, return only the updated prefix for the given type.
    // This avoids unintentionally modifying other prefix values on the client.
    try {
      return res.json({ success: true, data: { [type]: savedRow.prefix } });
    } catch (e) {
      console.warn('Failed to return saved prefix after update:', e);
      return res.json({ success: true, data: { [type]: savedRow.prefix } });
    }
  } catch (error) {
    console.error("Error updating voucher prefix:", error);
    return res.status(500).json({ success: false, message: "Failed to update prefix" });
  }
});

export default router;
