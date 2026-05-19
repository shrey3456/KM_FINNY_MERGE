import { Client } from '@notionhq/client';
import { LoadingOperation, ProformaSlip, ProformaSlipItem } from '../../shared/schema';

// Initialize Notion client
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID ;

const notion = new Client({ auth: NOTION_API_KEY });

/**
 * Pushes a LoadingOperation to Notion when its status changes to READY≈DESP
 * @param operation - The loading operation that was updated
 * @param proformaSlip - The related proforma slip
 * @param items - The slip items
 * @param creator - The user who created the operation
 */
export async function pushOperationToNotion(
  operation: LoadingOperation,
  proformaSlip: ProformaSlip,
  items: ProformaSlipItem[],
  creator: string
): Promise<void> {
  try {
    // Only push operations with READY≈DESP status
    if (operation.status !== 'READY≈DESP') {
      console.log(`Operation ${operation.id} status is ${operation.status}, not pushing to Notion`);
      return;
    }

    console.log(`Pushing operation ${operation.id} with status ${operation.status} to Notion`);

    // Format date to YYYY-MM-DD
    const orderDate = proformaSlip.orderDate ? 
      new Date(proformaSlip.orderDate).toISOString().split('T')[0] : 
      new Date().toISOString().split('T')[0];

    // Create a Notion page for the main order
    const orderPage = await notion.pages.create({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: {
        'creator (user)': {
          rich_text: [
            {
              text: {
                content: creator || 'N/A'
              }
            }
          ]
        },
        'orderNumber': {
          title: [
            {
              text: {
                content: proformaSlip.orderNumber || operation.referenceNumber || 'Unknown'
              }
            }
          ]
        },
        'status': {
          select: {
            name: operation.status
          }
        },
        'orderDate': {
          date: {
            start: orderDate
          }
        },
        'partyName': {
          rich_text: [
            {
              text: {
                content: proformaSlip.partyName || 'Unknown'
              }
            }
          ]
        },
        'plant': {
          select: {
            name: proformaSlip.plant || 'Unknown'
          }
        },
        'totalVolume': {
          rich_text: [
            {
              text: {
                content: proformaSlip.totalVolume || 'N/A'
              }
            }
          ]
        },
        'vehicleNumber': {
          rich_text: [
            {
              text: {
                content: proformaSlip.vehicleNumber || 'Not Assigned'
              }
            }
          ]
        }
      }
    });
    
    console.log(`Order created in Notion: ${orderPage.id}`);

    // For each item, create a child page matching the CSV structure
    for (const item of items) {
      // Skip items that weren't loaded
      if (!item.loadedQuantity || item.loadedQuantity <= 0) continue;

      // Calculate remaining and extra quantities
      const proformaQty = item.quantity || 0;
      const loadedQty = item.loadedQuantity || 0;
      const remainingQty = Math.max(0, proformaQty - loadedQty);
      const extraQty = loadedQty > proformaQty ? loadedQty - proformaQty : 0;

      await notion.pages.create({
        parent: { database_id: NOTION_DATABASE_ID },
        properties: {
          'orderNumber': {
            title: [
              {
                text: {
                  content: `${proformaSlip.orderNumber || operation.referenceNumber || 'Unknown'}`
                }
              }
            ]
          },
          'creator (user)': {
            rich_text: [
              {
                text: {
                  content: creator || 'N/A'
                }
              }
            ]
          },
          'status': {
            select: {
              name: operation.status
            }
          },
          'productId': {
            number: parseInt(item.productId?.toString() || '0') || 0
          },
          'productSrNo': {
            rich_text: [
              {
                text: {
                  content: item.srNo?.toString() || 'N/A'
                }
              }
            ]
          },
          'productBarcode': {
            rich_text: [
              {
                text: {
                  content: item.barcode || 'N/A'
                }
              }
            ]
          },
          'productName': {
            rich_text: [
              {
                text: {
                  content: item.itemName || 'Unknown'
                }
              }
            ]
          },
          'proforma quantity': {
            number: proformaQty
          },
          'loaded quantity': {
            number: loadedQty
          },
          'remianing quantity': {
            number: remainingQty
          },
          'extra quantity': {
            number: extraQty
          }
        }
      });
    }
    
    console.log(`Pushed operation ${operation.id} with ${items.length} items to Notion successfully`);
  } catch (error) {
    console.error('Error pushing to Notion:', error);
    throw error;
  }
}