import { Router, type Request, type Response } from 'express';
import { storage } from '../storage';
import { requirePageAccess, requirePageWrite } from '../lib/pageAccess';
import { listLocalDrivers, syncDriversFromNotion } from '../services/driverMasterSync';

// Driver Master: the drivers of the Notion driver database, kept in our own table. The page lists them; "Sync from Notion" is the only thing that reads Notion.
// Vehicle Planning and the Vehicle Master driver box take their driver list from here (GET /driver-master/options).

const router = Router();
let syncing = false;

router.get('/driver-master', requirePageAccess('driver-master'), async (_req: Request, res: Response) => {
  try {
    const drivers = await listLocalDrivers();
    const lastSyncedAt = drivers.reduce((m: string | null, d) => (d.syncedAt && (!m || d.syncedAt > m) ? d.syncedAt : m), null as string | null);
    res.json({ drivers, lastSyncedAt, syncing });
  } catch (error) {
    console.error('Error listing the drivers:', error);
    res.status(500).json({ message: 'Failed to load the drivers' });
  }
});

// The light list the pickers use: Notion page id (what Notion's "Driver :" relation needs), name and company. Drivers no longer in Notion are left out.
router.get('/driver-master/options', requirePageAccess(['driver-master', 'vehicle-master', 'vehicle-planning']), async (_req: Request, res: Response) => {
  try {
    const drivers = await listLocalDrivers({ onlyInNotion: true });
    res.json({ drivers: drivers.map((d) => ({ id: d.notionPageId, name: d.name, company: d.company })) });
  } catch (error) {
    console.error('Error listing the driver options:', error);
    res.status(500).json({ message: 'Failed to load the drivers' });
  }
});

router.post('/driver-master/sync', requirePageWrite('driver-master'), async (req: Request, res: Response) => {
  if (syncing) return res.status(409).json({ message: 'A driver sync is already running.' });
  syncing = true;
  try {
    const result = await syncDriversFromNotion();
    const u = req.user as any;
    const userCode = u?.userCode ?? undefined, userName = u?.name ?? u?.username ?? undefined;
    if (userCode) await storage.logActivity({ pageName: 'Driver Master', action: 'update', entityType: 'driver_master_sync', entityId: 'sync', details: `Drivers synced from Notion by ${userName ?? userCode}: ${result.total} read, ${result.created} new, ${result.changed} changed, ${result.removed} no longer in Notion`, userCode, userName });
    res.json(result);
  } catch (error) {
    console.error('Error syncing the drivers from Notion:', error);
    res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to sync the drivers from Notion' });
  } finally {
    syncing = false;
  }
});

export default router;
