import { Router } from 'express';
import { fetchProformaOrdersFromNotion, writeOrderToDb } from '../services/proformaNotionSync';
import { requirePageWrite } from '../lib/pageAccess';

const router = Router();

// Direct "Import from Notion" — fetches every order in [startDate, endDate] from Notion and
// writes it straight to the DB (upsert by order number, no duplicate slips). For a reviewable
// version that shows a diff before writing anything, see /api/proforma-notion-sync/detect
// + /apply (server/routes/proforma-notion-sync.ts), which share the same fetch/write logic
// (server/services/proformaNotionSync.ts).
// Write access to 'proforma' (admins always pass) — the same people the page shows "Import
// Notion" to. This route had no permission check at all, so any logged-in user, read-only ones
// included, could write slips straight into the database by calling it directly.
router.post('/fast-notion-import', requirePageWrite('proforma'), async (req, res) => {
  try {
    console.log('⚡ FAST Notion Import started');

    const { startDate, endDate } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'Start date and end date are required'
      });
    }

    console.log(`⚡ Date range: ${startDate} to ${endDate}`);

    const ordersMap = await fetchProformaOrdersFromNotion(startDate, endDate);
    console.log(`⚡ Fetched ${ordersMap.size} orders from Notion`);

    let slipsCreated = 0;
    let itemsCreated = 0;

    for (const [orderNo, orderData] of Array.from(ordersMap.entries())) {
      try {
        const result = await writeOrderToDb(orderData);
        if (result.created) slipsCreated++;
        itemsCreated += result.itemsCreated;
      } catch (error) {
        console.error(`Error processing order ${orderNo}:`, error);
      }
    }

    return res.status(200).json({
      success: true,
      message: `⚡ Fast import complete! Created ${slipsCreated} new slips, ${itemsCreated} items written (${ordersMap.size} orders processed)`,
      slipsCreated,
      itemsCreated,
    });

  } catch (error: any) {
    console.error('Fast import error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Fast import failed',
      error: error.toString()
    });
  }
});

export default router;
