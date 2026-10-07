// The pages an admin can grant on the User Management page.
//
// Same list, same names, same order as the sidebar (client/src/components/Sidebar.tsx) — when a
// page is called "Load Operations" in the sidebar it has to be called "Load Operations" here too,
// or granting it is guesswork. It used to hold BOTH the current Load Operations page (key
// "loading", listed as "Loading") and a retired one (key "load-operations", listed as "Load
// Operations"), so ticking the obvious name granted a page that is not in the sidebar at all and
// nothing appeared. The retired page is no longer grantable.
export const CONTROLLABLE_PAGES = [
  // OPERATIONS
  { key: "print-operations", label: "Print Operations" },
  { key: "sort-slip", label: "Sort Slip" },
  { key: "loading", label: "Load Operations" },
  { key: "loading-overview", label: "Loading Overview" },
  { key: "unloading", label: "Unload Operations" },
  { key: "scan-order", label: "Scan Operations" },
  { key: "scan-viewer", label: "Overall Scan Ops" },
  { key: "scan-history", label: "Scan History" },
  { key: "overall-stock", label: "Stock Overview" },
  { key: "daily-reports", label: "Reports" },
  // SALES
  { key: "dispatch", label: "Dispatch" },
  { key: "proforma", label: "Proforma Slips" },
  { key: "adjust-exchange", label: "Adjust Exchange Extra" },
  { key: "order-import", label: "Order Management" },
  // INVENTORY
  { key: "notion-inventory", label: "Product Master" },
  { key: "plant-management", label: "Plant Master" },
  { key: "vehicle-master", label: "Vehicle Master" },
  { key: "vehicle-planning", label: "Vehicle Planning" },
  { key: "purchases", label: "Purchases" },
  // STEER
  { key: "expense-voucher", label: "Expense Voucher" },
  { key: "toll-voucher", label: "Toll Voucher" }
] as const;
// "Edit Order Import CSV" used to be listed here as a page of its own ("order-import-edit").
// It isn't a page — it is the Edit button inside Order Management — and granting it needed two
// ticks that had to agree. It now rides on Order Management itself: the page grant shows the
// button, write access on that page allows the save. Nothing is lost, since that was exactly the
// old key's own view/write split.

export type PageKey = (typeof CONTROLLABLE_PAGES)[number]["key"];
