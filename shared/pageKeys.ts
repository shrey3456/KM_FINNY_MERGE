
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
  { key: "order-import", label: "Order Management" },
  { key: "order-master-view", label: "Order Master View" },
  { key: "order-import-edit", label: "Edit Order Import CSV" },
  { key: "notion-inventory", label: "Inventory" },
  { key: "purchases", label: "Purchases" },
  { key: "plant-management", label: "Plant Management" }
] as const;

export type PageKey = (typeof CONTROLLABLE_PAGES)[number]["key"];
