import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

// Drop-in replacement for useState for a single filter/view value that should survive leaving
// the page and coming back.
//
// sessionStorage, matching the "<page>:filters" bundles already used by Proforma Slips / Overall
// Stock / Scan History / Scan Viewer: a filter is working context for the current sitting, not a
// preference that should still be applied when the app is opened fresh tomorrow. (Column
// visibility/order is the opposite case and stays in localStorage where those pages put it.)
//
// Use one key per page per value, e.g. "unloading:plantFilter". Keys are page-scoped by
// convention — reusing one across two pages makes them share the value, which is the bug
// DateRangeFilter's global keys already have.
export function usePersistentFilter<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(key);
      // Absent is different from a stored falsy value — "" is a real choice for a date ("all
      // dates") and false is a real choice for a toggle, so only a missing key falls back.
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      // Corrupt, or storage throws outright (private mode) — start from the default rather
      // than break the page.
      return initial;
    }
  });

  // Skips the first run: writing back the value we just read is pointless, and on a page whose
  // default is a live value (today's date, say) it would also overwrite a real saved choice
  // before any restore-validating effect has had a chance to run.
  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) { hydrated.current = true; return; }
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage unavailable — the filter just won't outlive the page.
    }
  }, [key, value]);

  return [value, setValue];
}
