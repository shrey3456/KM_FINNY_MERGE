
export const CONTROLLABLE_PAGES = [
  { key: "load-operations", label: "Load Operations" },
  { key: "print-operations", label: "Print Operations" },
  { key: "proforma", label: "Proforma Slips" },
  { key: "dispatch", label: "Dispatch" },
  { key: "expense-voucher", label: "Expense Voucher" },
  { key: "toll-voucher", label: "Toll Voucher" },
  { key: "scan-order", label: "Scan Order" },
  { key: "overall-stock", label: "Overall Stock" },
  { key: "scan-history", label: "Scan History" },
  { key: "order-import", label: "Order Import" },
  { key: "notion-inventory", label: "Inventory" },
  { key: "purchases", label: "Purchases" },
  { key: "plant-management", label: "Plant Management" },
  { key: "activities", label: "Activities" },
  // "user-management" and "settings" are deliberately NOT in this list — both
  // pages stay strictly admin-only and can never be granted to a non-admin via
  // Allowed Pages / Write Access.
] as const;

export type PageKey = (typeof CONTROLLABLE_PAGES)[number]["key"];
