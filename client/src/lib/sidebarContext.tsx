import { createContext, useContext } from "react";

// Lets a page reach the app's own mobile sidebar drawer without any prop drilling — needed by
// kiosk-rotate views (Loading/Unloading's scan pages), whose rotated content is a fixed,
// full-viewport overlay that sits on top of Layout's own sidebar toggle, making it unreachable
// by any normal click. A floating button inside the rotated container (same trick the rotate
// button itself uses — fixed-positioned inside the rotation, so it turns with the content and
// stays reachable) calls openMobileMenu() to reopen a path back to real navigation.
// Provided by Layout.tsx; defaults to a no-op so a page rendered outside Layout (tests, storybook)
// doesn't crash calling it.
export const SidebarContext = createContext<{ openMobileMenu: () => void }>({
  openMobileMenu: () => {},
});

export function useSidebarContext() {
  return useContext(SidebarContext);
}
