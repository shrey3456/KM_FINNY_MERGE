/**
 * Shared broadcast module for order-import events.
 * Both order-import.ts (SSE) and order-scan.ts (WebSocket) import from here
 * to avoid a circular dependency.
 */

import type { Response } from 'express';
import type { WebSocket } from 'ws';

// ── SSE clients (admin browsers connected to /api/order-import/stream) ────────
const sseClients = new Set<Response>();

export function addSseClient(res: Response): void    { sseClients.add(res); }
export function removeSseClient(res: Response): void { sseClients.delete(res); }

// ── WebSocket admin clients (OrderImport page users) ─────────────────────────
const wsAdminClients = new Set<WebSocket>();

export function addWsAdminClient(ws: WebSocket): void    { wsAdminClients.add(ws); }
export function removeWsAdminClient(ws: WebSocket): void { wsAdminClients.delete(ws); }

// ── Broadcast to all connected clients (SSE + WS) ────────────────────────────
export function broadcastOrderImportUpdate(): void {
  // SSE push
  const sseFrame = 'data: update\n\n';
  sseClients.forEach((res) => {
    try { res.write(sseFrame); } catch { sseClients.delete(res); }
  });

  // WebSocket push
  const wsFrame = JSON.stringify({ type: 'import-update' });
  wsAdminClients.forEach((ws) => {
    if ((ws as any).readyState === 1 /* OPEN */) {
      try { ws.send(wsFrame); } catch { wsAdminClients.delete(ws); }
    } else {
      wsAdminClients.delete(ws);
    }
  });
}
