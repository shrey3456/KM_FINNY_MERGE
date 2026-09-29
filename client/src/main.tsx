import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Service worker registration — register ONCE per load and let the browser's own update
// algorithm do the rest, instead of unregistering + re-registering from scratch every time the
// app opens (the old behavior here). That old pattern is what made deploys look like a brand-new
// app to Android rather than an in-place update: killing and recreating the registration on every
// load fights the browser's normal "fetch /sw.js in the background, diff it, swap in the new one
// once nothing is using the old one" flow, so updates never landed cleanly and the user eventually
// had to reinstall the PWA to get anything new — icon included.
//
// The flow below is the standard one: register, and when a new worker finishes installing while
// an old one is already controlling the page, tell it to take over immediately (skipWaiting) and
// reload once when it does. First-ever install (no controller yet) needs no reload — there's
// nothing showing yet to refresh.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("/sw.js", {
        scope: "/",
        updateViaCache: "none", // always revalidate sw.js itself against the network
      });

      const promoteWaitingWorker = (worker: ServiceWorker | null) => {
        if (!worker) return;
        if (worker.state === "installed" && navigator.serviceWorker.controller) {
          worker.postMessage({ action: "skipWaiting" });
        } else {
          worker.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              worker.postMessage({ action: "skipWaiting" });
            }
          });
        }
      };

      // Already-waiting worker from a previous visit that never got promoted.
      promoteWaitingWorker(registration.waiting);
      registration.addEventListener("updatefound", () => promoteWaitingWorker(registration.installing));

      // Ask once now, then again roughly every 30 minutes the app stays open, so a long-running
      // tab (e.g. a wall-mounted kiosk) still picks up a deploy without the operator restarting it.
      registration.update().catch(() => {});
      setInterval(() => registration.update().catch(() => {}), 30 * 60 * 1000);
    } catch (error) {
      console.error("Service Worker registration failed:", error);
    }
  });

  // The freshly-promoted worker above becomes the controller once every open tab has dropped the
  // old one — that's this event. One reload picks up the new build; the guard against a second,
  // unrelated controllerchange (rare, but possible) keeps this from ever reloading twice.
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
}

createRoot(document.getElementById("root")!).render(<App />);
