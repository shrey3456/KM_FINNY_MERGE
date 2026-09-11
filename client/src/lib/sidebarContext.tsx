import { createContext, useContext } from "react";

// Lets a page reach the app's own sidebar without any prop drilling — needed by kiosk-rotate
// views (Loading/Unloading/Scan's scan pages), whose rotated content is a fixed, full-viewport
// overlay that sits on top of Layout's own sidebar toggle, making it unreachable by any normal
// click. A floating button inside the rotated container (same trick the rotate button itself
// uses — fixed-positioned inside the rotation, so it turns with the content and stays reachable)
// calls BOTH of these to reopen a path back to real navigation, regardless of the raw (unrotated)
// window width Layout's own responsive split reacts to:
//   - openMobileMenu(): opens the `lg:hidden` mobile drawer — the only one that exists below lg.
//   - openSidebar(): shows the persistent `hidden lg:block` desktop sidebar — the one that
//     actually exists at lg+, which most real kiosk hardware (a tablet or monitor, not a phone)
//     reports as its raw width even while rotated. openMobileMenu() alone did nothing there,
//     since the drawer it opens is itself hidden by that same lg breakpoint.
// setKioskRotateClass lets the active page tell Layout its current kiosk-rotate CSS class (e.g.
// "kiosk-rotate-90", or "" when not rotated) so the sidebar — once opened via openSidebar/
// openMobileMenu above — turns WITH the rest of the rotated content instead of popping up
// unrotated on top of it. Applying the exact same class Loading/Unloading/Scan already use for
// their own rotated content works here too: it's just a fixed, full-viewport, rotated box, and
// the sidebar's own fixed-width column simply keeps its normal top-left position inside that
// box, same as any other rotated content.
// Provided by Layout.tsx; defaults to no-ops so a page rendered outside Layout (tests, storybook)
// doesn't crash calling it.
export const SidebarContext = createContext<{
  openMobileMenu: () => void;
  openSidebar: () => void;
  setKioskRotateClass: (cls: string) => void;
}>({
  openMobileMenu: () => {},
  openSidebar: () => {},
  setKioskRotateClass: () => {},
});

export function useSidebarContext() {
  return useContext(SidebarContext);
}
