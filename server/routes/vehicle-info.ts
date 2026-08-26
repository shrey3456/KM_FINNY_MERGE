import { Router, Request, Response } from 'express';
import { ZodError } from 'zod';
import { storage } from '../storage';
import { insertVehicleInfoSchema } from '@shared/schema';
import { requirePageAccess, requirePageWrite, requireAdminRole } from '../lib/pageAccess';
import {
  detectVehicleChangesFromNotion, applyPendingVehicleChanges, fullSyncVehiclesFromNotion,
  getPendingReport, getSyncStatus, getSyncHistory, getAutoApplyEnabled, setAutoApplyEnabled,
  getLastConflicts,
} from '../services/notionVehicleSync';

const router = Router();

function actor(req: Request): { userCode?: string; userName?: string } {
  const u = req.user as any;
  return { userCode: u?.userCode, userName: u?.name || u?.username || u?.userCode };
}

// Every row's lastEditedByCode is a userCode — resolve it to a display name for the response
// instead of leaving the raw code for the client to look up itself. (This is the same
// enrichment the old, orphaned handlers here always tried and always failed at, because they
// read a lastEditedById field that never existed on this table — see lastEditedByCode instead.)
async function withEditorNames<T extends { lastEditedByCode: string | null; createdByCode: string | null }>(
  rows: T[],
): Promise<(T & { lastEditedByName: string | null; createdByName: string | null })[]> {
  const codes = new Set<string>();
  rows.forEach((r) => {
    if (r.lastEditedByCode) codes.add(r.lastEditedByCode);
    if (r.createdByCode) codes.add(r.createdByCode);
  });
  const nameByCode = new Map<string, string>();
  await Promise.all([...codes].map(async (code) => {
    const user = await storage.getUserByUserCode(code);
    if (user) nameByCode.set(code, user.name || user.username || code);
  }));
  return rows.map((r) => ({
    ...r,
    lastEditedByName: r.lastEditedByCode ? (nameByCode.get(r.lastEditedByCode) ?? r.lastEditedByCode) : null,
    createdByName: r.createdByCode ? (nameByCode.get(r.createdByCode) ?? r.createdByCode) : null,
  }));
}

// ─── CRUD ──────────────────────────────────────────────────────────────────

router.get('/vehicle-info', requirePageAccess('vehicle-master'), async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
    const offset = req.query.offset ? parseInt(req.query.offset as string) : 0;
    const vehicles = await storage.listVehicleInfo(limit, offset);
    res.json(await withEditorNames(vehicles));
  } catch (error) {
    console.error('Error fetching vehicle info:', error);
    res.status(500).json({ message: 'Failed to fetch vehicle info' });
  }
});

router.get('/vehicle-info/:id', requirePageAccess('vehicle-master'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Invalid vehicle ID' });
    const vehicle = await storage.getVehicleInfo(id);
    if (!vehicle) return res.status(404).json({ message: 'Vehicle info not found' });
    const [enriched] = await withEditorNames([vehicle]);
    res.json(enriched);
  } catch (error) {
    console.error('Error fetching vehicle info:', error);
    res.status(500).json({ message: 'Failed to fetch vehicle info' });
  }
});

router.get('/vehicle-info/number/:vehicleNumber', requirePageAccess('vehicle-master'), async (req: Request, res: Response) => {
  try {
    const vehicle = await storage.getVehicleInfoByVehicleNumber(req.params.vehicleNumber);
    if (!vehicle) return res.status(404).json({ message: 'Vehicle info not found' });
    const [enriched] = await withEditorNames([vehicle]);
    res.json(enriched);
  } catch (error) {
    console.error('Error fetching vehicle info by number:', error);
    res.status(500).json({ message: 'Failed to fetch vehicle info' });
  }
});

router.post('/vehicle-info', requirePageWrite('vehicle-master'), async (req: Request, res: Response) => {
  try {
    const { userCode, userName } = actor(req);
    const vehicleData = insertVehicleInfoSchema.parse({
      ...req.body,
      createdByCode: userCode ?? null,
      lastEditedByCode: userCode ?? null,
    });
    const vehicle = await storage.createVehicleInfo(vehicleData);

    if (userCode) {
      await storage.logActivity({
        pageName: 'VehicleMaster', action: 'create', entityType: 'vehicle', entityId: vehicle.id,
        details: `Vehicle ${vehicle.vehicleNumber} added by ${userName ?? userCode}`,
        userCode, userName,
      });
    }

    res.status(201).json(vehicle);
  } catch (error) {
    console.error('Error creating vehicle info:', error);
    if (error instanceof ZodError) {
      return res.status(400).json({ message: 'Invalid vehicle data', errors: error.format() });
    }
    res.status(500).json({ message: 'Failed to create vehicle info' });
  }
});

router.put('/vehicle-info/:id', requirePageWrite('vehicle-master'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Invalid vehicle ID' });

    const existingVehicle = await storage.getVehicleInfo(id);
    if (!existingVehicle) return res.status(404).json({ message: 'Vehicle info not found' });

    const { userCode, userName } = actor(req);
    const vehicleData = insertVehicleInfoSchema.partial().parse({
      ...req.body,
      lastEditedByCode: userCode ?? null,
    });
    const updatedVehicle = await storage.updateVehicleInfo(id, vehicleData);
    if (!updatedVehicle) return res.status(404).json({ message: 'Vehicle info could not be updated' });

    if (userCode) {
      await storage.logActivity({
        pageName: 'VehicleMaster', action: 'update', entityType: 'vehicle', entityId: id,
        details: `Vehicle ${updatedVehicle.vehicleNumber} updated by ${userName ?? userCode}`,
        userCode, userName,
      });
    }

    res.json(updatedVehicle);
  } catch (error) {
    console.error('Error updating vehicle info:', error);
    if (error instanceof ZodError) {
      return res.status(400).json({ message: 'Invalid vehicle data', errors: error.format() });
    }
    res.status(500).json({ message: 'Failed to update vehicle info' });
  }
});

router.delete('/vehicle-info/:id', requirePageWrite('vehicle-master'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Invalid vehicle ID' });

    const vehicle = await storage.getVehicleInfo(id);
    if (!vehicle) return res.status(404).json({ message: 'Vehicle info not found' });

    const success = await storage.deleteVehicleInfo(id);
    if (!success) return res.status(500).json({ message: 'Failed to delete vehicle info' });

    const { userCode, userName } = actor(req);
    if (userCode) {
      await storage.logActivity({
        pageName: 'VehicleMaster', action: 'delete', entityType: 'vehicle', entityId: id,
        details: `Vehicle ${vehicle.vehicleNumber} deleted by ${userName ?? userCode}`,
        userCode, userName,
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting vehicle info:', error);
    res.status(500).json({ message: 'Failed to delete vehicle info' });
  }
});

// ─── Notion sync — admin-only, mirrors /api/notion-inventory-sync/* ─────────

router.post('/notion-vehicle-sync/detect', requireAdminRole, async (req: Request, res: Response) => {
  try {
    const { userName, userCode } = actor(req);
    const report = await detectVehicleChangesFromNotion(userName ?? userCode ?? 'unknown');
    res.json({ success: true, ...report });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = message.includes('already in progress') ? 409 : 500;
    res.status(status).json({ success: false, message });
  }
});

router.get('/notion-vehicle-sync/pending', requireAdminRole, (_req: Request, res: Response) => {
  const report = getPendingReport();
  if (!report) return res.json({ hasPending: false, report: null });
  res.json({ hasPending: report.updated > 0 || report.created > 0, report });
});

router.post('/notion-vehicle-sync/apply', requireAdminRole, async (req: Request, res: Response) => {
  try {
    const { userCode } = actor(req);
    const report = await applyPendingVehicleChanges(userCode ?? null);
    res.json({ success: true, ...report });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = message.includes('No pending') ? 400 : message.includes('already in progress') ? 409 : 500;
    res.status(status).json({ success: false, message });
  }
});

router.post('/notion-vehicle-sync/full-sync', requireAdminRole, async (req: Request, res: Response) => {
  try {
    const { userName, userCode } = actor(req);
    const report = await fullSyncVehiclesFromNotion(userName ?? userCode ?? 'unknown', userCode ?? null);
    res.json({ success: true, ...report });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = message.includes('already in progress') ? 409 : 500;
    res.status(status).json({ success: false, message });
  }
});

router.get('/notion-vehicle-sync/status', requireAdminRole, async (_req: Request, res: Response) => {
  res.json({ ...getSyncStatus(), autoApplyEnabled: await getAutoApplyEnabled() });
});

router.get('/notion-vehicle-sync/history', requireAdminRole, (_req: Request, res: Response) => {
  res.json({ history: getSyncHistory() });
});

// Vehicle-number collisions the last sync run couldn't auto-resolve — needs a human to fix the
// row in Notion. Kept separate from /pending (which clears once Apply runs) since a conflict
// isn't resolved just because the rest of the batch was.
router.get('/notion-vehicle-sync/conflicts', requireAdminRole, (_req: Request, res: Response) => {
  res.json({ conflicts: getLastConflicts() });
});

router.post('/notion-vehicle-sync/auto-apply', requireAdminRole, async (req: Request, res: Response) => {
  const enabled = req.body?.enabled === true;
  const { userCode } = actor(req);
  await setAutoApplyEnabled(enabled, userCode ?? null);
  res.json({ success: true, autoApplyEnabled: enabled });
});

export default router;
