import { createContext, useContext, type ReactNode } from "react";

// Kiosk-rotate pages (Loading, Unloading, Scan Order, Scan Viewer) turn their content with a
// fixed, rotated overlay (.kiosk-rotate-* in index.css). Radix renders every popup — dialogs,
// dropdowns, popovers, calendars — into document.body, OUTSIDE that overlay, so on its own each
// one opens upright over a rotated page.
//
// Instead of every popup call site adding a compensating rotate class by hand, the active page
// reports its rotation to Layout (useSidebarContext().setPortalRotation), and it's applied in two
// places:
//   - Dialogs (dialog, alert-dialog) read it here via usePortalRotateClass. React context flows
//     through portals, so every dialog under a rotated page picks the turn up.
//   - Popups attached to a trigger (popover, select, dropdown-menu — and so filters and the date
//     picker built on them) are centred and turned by a body-level CSS rule instead; see the
//     data-portal-rotation block in index.css for why rotating them in place doesn't work.

export type PortalRotation = 0 | 90 | 180 | 270;

const PortalRotationContext = createContext<PortalRotation>(0);

export function PortalRotationProvider({ rotation, children }: { rotation: PortalRotation; children: ReactNode }) {
  return <PortalRotationContext.Provider value={rotation}>{children}</PortalRotationContext.Provider>;
}

// For dialogs, which sit at left/top 50% with translate(-50%,-50%): a plain rotate around their
// default centre origin lines them up with the rotated page.
export function usePortalRotateClass(): string {
  const rotation = useContext(PortalRotationContext);
  if (rotation === 0) return "";
  return rotation === 90 ? "rotate-90" : rotation === 180 ? "rotate-180" : "-rotate-90";
}
