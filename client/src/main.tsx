import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Improved service worker registration with better error handling for PWA support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      // Clear any existing registrations to ensure a clean state
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (let registration of registrations) {
        await registration.unregister();
        console.log('Unregistered old service worker');
      }
      
      // Register the updated service worker
      const registration = await navigator.serviceWorker.register('/sw.js', { 
        scope: '/',
        updateViaCache: 'none' // Prevent browser cache issues
      });
      
      console.log('Service Worker registered successfully with scope:', registration.scope);
      
      // Handle updates
      registration.onupdatefound = () => {
        const installingWorker = registration.installing;
        if (installingWorker) {
          installingWorker.onstatechange = () => {
            if (installingWorker.state === 'installed') {
              if (navigator.serviceWorker.controller) {
                // At this point, the updated content has been fetched
                console.log('New content is available; please refresh.');
              } else {
                // At this point, everything has been cached for offline use
                console.log('Content is cached for offline use.');
              }
            }
          };
        }
      };
    } catch (error) {
      console.error('Service Worker registration failed:', error);
    }
  });
  
  // Handle service worker communication
  navigator.serviceWorker.addEventListener('message', (event) => {
    console.log('Received message from service worker:', event.data);
  });
  
  // Handle controller change for immediate take over
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    console.log('Service Worker controller changed');
  });
}

createRoot(document.getElementById("root")!).render(<App />);
