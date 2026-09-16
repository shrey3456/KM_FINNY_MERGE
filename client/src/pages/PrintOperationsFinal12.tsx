import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Card, CardContent } from '../components/ui/card';
import { CardHeader } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { useQuery } from '@tanstack/react-query';
import { toast } from '../hooks/use-toast';
import { Search, PrinterCheck, FileDown, Factory } from 'lucide-react';
import axios from 'axios';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import JsBarcode from 'jsbarcode';
import { useLocation } from 'wouter';
import { hasPageWriteAccess } from '../lib/permissions';

// Renders a Code128 barcode (readable by virtually every 1D scanner gun, unlike a QR code which
// needs a 2D imager) for the given text into an offscreen canvas and returns it as a PNG data
// URL — a plain string that works both as a live <img> in the on-screen preview and, embedded
// directly into the print template's HTML string, in the printed slip itself. Neither consumer
// needs to load jsbarcode itself; they just display an already-rendered image.
function generateBarcodeDataUrl(text: string): string {
  const canvas = document.createElement('canvas');
  JsBarcode(canvas, text, { format: 'CODE128', displayValue: false, margin: 4, height: 40 });
  return canvas.toDataURL('image/png');
}

// Order-number barcode on the proforma slip (under #orderNumber, in both the on-screen preview and
// every printed copy). Switched OFF for now at the user's request — all of its code is kept as is,
// so turning it back on is only changing this to true.
const SHOW_ORDER_BARCODE = false;

// The vehicle circle is a fixed 45px. At the old fixed 16pt, a longer code ("T-01", "MH-46") spilled
// out of it and wrapped onto two lines; the font now steps down with the code's length so it always
// sits on one line inside the circle. Short codes keep the original 16pt.
function vehicleCircleFontPt(text: string | null | undefined): number {
  const len = String(text ?? '').trim().length;
  return len <= 2 ? 16 : len === 3 ? 12 : len === 4 ? 10 : 8;
}

// Product/order interfaces
interface ProformaSlipItem {
  id: number;
  barcode: string | null;
  srNo: string | null;
  productId: number;
  itemName: string | null;
  quantity: number;
  price?: number;
  sku: string | null;
  unit?: string;
  loaded?: boolean;
  itemsPerPallet?: number;
}

interface ProformaSlip {
  id: number;
  orderNumber: string;
  orderDate: string | Date;
  plant: string;
  partyName: string;
  vehicleNumber: string | null;
  driverName: string | null;
  totalQuantity?: number;
  totalVolume?: string | number;
  notes?: string;
  // NEW: print lock + audit
  isPrintLocked?: boolean;
  printedByCode?: string | null;
  printedAt?: string | Date | null;
  printCount?: number;
}

interface ProformaResponse {
  slip: ProformaSlip;
  items: ProformaSlipItem[];
}

// Main component
const PrintOperations: React.FC = () => {
  // CHANGED: Add navigate from useLocation
  const [, navigate] = useLocation();
  
  // CHANGED: Split state into input value and actve order number
  const [inputValue, setInputValue] = useState('');
  const [activeOrderNumber, setActiveOrderNumber] = useState('');
  
  const [showPreview, setShowPreview] = useState(false);
  
  // Track if the current displayed slip has been successfully printed in this session
  // This allows us to lock it only when moving to the next slip
  const [hasPrintedCurrentSlip, setHasPrintedCurrentSlip] = useState(false);

  // Fetch fresh user data to ensure permissions are up to date
  const { data: remoteUser } = useQuery<any>({
    queryKey: ['/api/user'],
    queryFn: async () => {
      try {
        const res = await fetch('/api/user');
        if (res.ok) return await res.json();
        return null; 
      } catch (e) {
        return null;
      }
    },
    staleTime: 60000 
  });
  
  const currentUser = (() => {
    if (remoteUser && (remoteUser.id || remoteUser.userCode)) return remoteUser;
    
    try {
      const raw = localStorage.getItem('km-user') || localStorage.getItem('currentUser');
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  })();
  const currentUserRole = String(currentUser?.role || '').toLowerCase();
  const isAdminOrSuper = ['admin', 'super-admin', 'super admin', 'super_admin'].includes(currentUserRole);
  // Write access to Print Operations is granted per-page by admin (Allowed Pages /
  // Write Access on the User Management page) rather than the old global role string.
  const isread = !hasPageWriteAccess("print-operations") && !isAdminOrSuper;

  const rawDepartment = String(currentUser?.department || '').trim().toLowerCase();
  const rawDesignation = String(currentUser?.designation || '').trim().toLowerCase();

  // Matches the server's actual rule (proforma-api.ts's unlock route: requirePageWrite both
  // 'print-operations' AND 'proforma') — a user with only one of the two would otherwise see
  // a fully clickable Unlock button that 403s on click.
  const canUnlockSlips = isAdminOrSuper || (hasPageWriteAccess("print-operations") && hasPageWriteAccess("proforma"));

  // NEW: Get current user info and time for use in both print function and preview
  // CHANGED: Use Name instead of Role
  const printUser = currentUser?.name;
  const printTime = new Date().toLocaleString('en-IN', { 
      day: '2-digit', month: '2-digit', year: '2-digit', 
      hour: '2-digit', minute: '2-digit', hour12: true 
  });
  console.log(currentUser?.name, currentUser?.username, currentUser?.userCode);

  // Add debug console log
  console.log('🔍 Debug Print Operations:', {
    source: remoteUser ? 'remote' : 'local',
    role: currentUserRole, 
    dept: rawDepartment,
    desig: rawDesignation, 
    isAdminOrSuper, 
    canUnlockSlips,
    rawUser: currentUser 
  });

  // Query to fetch proforma data by activeOrderNumber (NOT inputValue)
  const { data: proformaData, refetch, isLoading, error } = useQuery<ProformaResponse>({
    queryKey: ['proforma', activeOrderNumber],
    queryFn: async () => {
      if (!activeOrderNumber.trim()) {
        return null as any;
      }
      // encodeURIComponent: order numbers can contain "/" (e.g. "958/8"). Unencoded, that split the
      // address into extra path segments, matched no API route, and the app's own HTML page came back
      // instead of slip data — which the preview then tried to read `.slip.plant` from and crashed.
      const response = await axios.get(`/api/proforma-slips/order/${encodeURIComponent(activeOrderNumber.trim())}`);
      // Anything that isn't a real slip (not found, an HTML page, an error body) is an error here, so
      // the page shows "not found" instead of rendering a preview with no slip in it.
      if (!response.data || typeof response.data !== 'object' || !response.data.slip) {
        throw new Error(`No proforma slip found for order "${activeOrderNumber.trim()}"`);
      }
      return response.data;
    },
    enabled: false, // Don't run the query automatically
  });

  // Computed once per order number, then reused as-is by both the on-screen preview (as an
  // <img>) and handlePrint's own HTML-string template (embedded the same way) — so scanning
  // either the preview or the printed slip with a gun reads the exact same order number back.
  const barcodeDataUrl = useMemo(
    () => (SHOW_ORDER_BARCODE && proformaData?.slip?.orderNumber ? generateBarcodeDataUrl(proformaData.slip.orderNumber) : ''),
    [proformaData?.slip?.orderNumber],
  );
  
  // Reset local print tracker when data changes
  useEffect(() => {
    if (proformaData) {
      setHasPrintedCurrentSlip(false);
    }
  }, [proformaData?.slip?.orderNumber]);

  // Fetch plant config for current slip
  const { data: plantConfig, refetch: refetchPlantConfig } = useQuery<any>({
    queryKey: ['plant', proformaData?.slip?.plant],
    queryFn: async () => {
      if (!proformaData?.slip?.plant) return null;
      const res = await axios.get(`/api/plants/by-name/${encodeURIComponent(proformaData.slip.plant)}`);
      return res.data?.plant || null;
    },
    enabled: !!proformaData?.slip?.plant,
    staleTime: 0, // Always fetch fresh data - ensures admin changes are immediately reflected
    refetchOnMount: 'always', // Refetch every time the component mounts
  });

  // Check if locking is enabled for this plant
  const isLockingEnabled = plantConfig?.isLockingEnabled ?? true; // default true
  
  // Check if page splitting is enabled for this plant  
  const isSplitPagesEnabled = plantConfig?.isSplitPagesEnabled ?? false; // default false
  
  // Helper function to split items into chunks (pages)
  const ITEMS_PER_PAGE = 32;
  const splitItemsIntoPages = (items: ProformaSlipItem[]): ProformaSlipItem[][] => {
    if (!isSplitPagesEnabled || items.length <= ITEMS_PER_PAGE) {
      return [items]; // Return all items in single page if split disabled or items fit in one page
    }
    
    const pages: ProformaSlipItem[][] = [];
    for (let i = 0; i < items.length; i += ITEMS_PER_PAGE) {
      pages.push(items.slice(i, i + ITEMS_PER_PAGE));
    }
    return pages;
  };

  // Calculate pallet quantity based on item data
  const calculatePalletQty = (item: ProformaSlipItem): number => {
    if (!item || !item.quantity) return 0;
    
    // Use itemsPerPallet from the item itself (now included in API response)
    const itemsPerPallet = item.itemsPerPallet || 30; // Default to 30 if not available
    
    return item.quantity / itemsPerPallet;
  };
  
  // Format pallet quantity to remove decimal places if they're all zeros
  const formatPalletQty = (value: number): string => {
    const formatted = value.toFixed(2);
    if (formatted.endsWith('.00')) {
      return Math.floor(value).toString();
    }
    return formatted;
  };
  
  // Format date like DD/MM/YY
  const formatDate = (dateString: string | Date): string => {
    try {
      const date = new Date(dateString);
      return `${date.getDate().toString().padStart(2, '0')}/${(date.getMonth() + 1).toString().padStart(2, '0')}/${date.getFullYear().toString().substring(2)}`;
    } catch (e) {
      console.error('Date parsing error:', e);
      return 'N/A';
    }
  };
  
  // Extract gram value from item name (e.g., "25GM*240 TIKHA MITHA MIX" => 25)
  const extractGramValue = (itemName: string | null): number | null => {
    if (!itemName) return null;
    
    const match = itemName.match(/^(\d+)GM/);
    if (match && match[1]) {
      return parseInt(match[1], 10);
    }
    
    return null;
  };
  
  // Format product name to display in a single line with "wafers" shortened to "WAF"
  const formatProductName = (itemName: string | null): string[] => {
    if (!itemName) return [''];
    
    // Replace "wafers" with "WAF" (uppercase)
    let formattedName = itemName.replace(/wafers/gi, 'WAF');
    
    return [formattedName]; // Return as a single line
  };
  
  // Create print content for direct printing in iframe
  const createPrintContent = (pageNumber?: number) => {
    if (!proformaData?.slip) return '';
    
    // IMPORTANT: Get split pages setting directly from plantConfig at render time
    const shouldSplitPages = Boolean(plantConfig?.isSplitPagesEnabled);
    
    // Sort items by srNo first
    const sortedItems = proformaData.items.sort((a, b) => {
      // Sort by srNo - handle null/undefined values
      const aSrNo = a.srNo || '';
      const bSrNo = b.srNo || '';
      return aSrNo.localeCompare(bSrNo, undefined, { numeric: true, sensitivity: 'base' });
    });
    
    // If pageNumber specified, get only items for that page
    let itemsToPrint = sortedItems;
    let currentPageNum = pageNumber || 1;
    let totalPages = 1;
    
    if (shouldSplitPages && sortedItems.length > ITEMS_PER_PAGE) {
      totalPages = Math.ceil(sortedItems.length / ITEMS_PER_PAGE);
      if (pageNumber) {
        const startIdx = (pageNumber - 1) * ITEMS_PER_PAGE;
        const endIdx = startIdx + ITEMS_PER_PAGE;
        itemsToPrint = sortedItems.slice(startIdx, endIdx);
      }
    }
    
    // Get plant-specific colors from database config (fallback to defaults)
    const bgColor = plantConfig?.bgColor || '#e5e7eb'; // gray-200 default
    const textColor = plantConfig?.textColor || '#1a202c'; // gray-900 default
    const borderColor = plantConfig?.borderColor || '#9ca3af'; // gray-400 default

    console.log('🎨 Plant config at print time:', { 
      plant: proformaData.slip.plant, 
      bgColor, 
      textColor, 
      borderColor,
      plantConfig,
      shouldSplitPages,
      plantConfigExists: !!plantConfig,
      pageNumber,
      totalPages,
      itemsToPrint: itemsToPrint.length
    });
    
    console.log('📄 Split Pages Decision:', {
      shouldSplitPages,
      plantConfigValue: plantConfig?.isSplitPagesEnabled,
      plantConfigRaw: plantConfig,
      totalItems: sortedItems.length,
      willCreateMultiplePages: shouldSplitPages && sortedItems.length > 20
    });
    
    // Function to create header HTML
    const createHeaderHTML = () => `
      <div style="text-align: center; font-weight: bold; font-size: 10pt; background-color: ${bgColor}; color: ${textColor}; padding: 2px 0; margin-bottom: 1mm; border-radius: 0; border-bottom: 1px solid ${borderColor};">
        KRUPA MARKETING - ${proformaData.slip.plant?.toUpperCase() || ''}
      </div>

      <div style="margin-bottom: 0.5mm;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5mm;">
          <div style="display: flex; width: 45px; height: 45px; border-radius: 50%; border: 2px solid #000000; background-color: transparent; color: #000000; font-size: ${vehicleCircleFontPt(proformaData.slip.vehicleNumber)}pt; font-weight: bold; line-height: 1; white-space: nowrap; overflow: hidden; text-align: center; align-items: center; justify-content: center; flex-shrink: 0;">${proformaData.slip.vehicleNumber || ''}</div>
          <div style="text-align: center; font-size: 10pt; font-weight: bold; flex: 1; padding: 0 5mm;">
            ${proformaData.slip.partyName}
            <!-- Time box for load start & end time -->
            <div style="margin-top: 3mm; border: 1px solid #000; padding: 2mm; background-color: #ffffff;">
              <div style="display: flex; justify-content: space-between; gap: 2mm;">
                <div style="flex: 1;">
                  <div style="font-size: 7pt; margin-bottom: 1mm;">Start:</div>
                  <div style="height: 12px; width: 100%;"></div>
                </div>
                <div style="flex: 1;">
                  <div style="font-size: 7pt; margin-bottom: 1mm;">End:</div>
                  <div style="height: 12px; width: 100%;"></div>
                </div>
              </div>
            </div>
          </div>
          <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 1mm;">
            <!-- Slip number with its scannable barcode directly beneath it, then the date. -->
            <div style="display: flex; flex-direction: column; align-items: flex-end;">
              <div style="font-size: 14pt; font-weight: bold; text-align: right; color: #a10808; line-height: 1.1;">#${proformaData.slip.orderNumber}</div>
              ${barcodeDataUrl ? `<img src="${barcodeDataUrl}" style="height: 7mm; width: auto; display: block; margin-top: 0.5mm;" alt="Order barcode" />` : ''}
            </div>
            <div style="font-size: 10pt; font-weight: bold; line-height: 1.2; text-align: right;">${formatDate(proformaData.slip.orderDate)}</div>
          </div>
        </div>
      </div>
    `;
    
    // Function to generate item row HTML
    const generateItemRow = (item: ProformaSlipItem, actualIndex: number) => {
      const palletQty = calculatePalletQty(item);
      const gramValue = extractGramValue(item.itemName || '');
      
      // Calculate background color based on GM value
      let itemBgColor = '#ffffff'; // Default white
      let itemTextColor = 'black';  // Default text color
      
      if (gramValue !== null) {
        if (gramValue === 300) {
          itemBgColor = '#000000'; // Black
          itemTextColor = 'white';
        } else if (gramValue === 135) {
          itemBgColor = '#46bdc6'; // Cyan
        } else if (gramValue === 13) {
          itemBgColor = '#FF5733'; // Orange-red
          itemTextColor = 'white';
        } else if (gramValue === 200) {
          itemBgColor = '#49e160'; // Green
        } else if (gramValue === 24) {
          itemBgColor = '#FFF0E0'; // Very light skin color
        } else if (gramValue === 50) {
          itemBgColor = '#85d69a'; // Light Green
        } else if (gramValue === 45) {
          itemBgColor = '#a4c2f4'; // Light Blue
        } else if (gramValue === 65) {
          itemBgColor = '#b4a7d6'; // Lavender
        } else if (gramValue === 20) {
          itemBgColor = '#b7b7b7'; // Grey
        } else if (gramValue === 25) {
          itemBgColor = '#b7e1cd'; // Light Aqua
        } else if (gramValue === 250) {
          itemBgColor = '#c27ba0'; // Pink
        } else if (gramValue === 500) {
          itemBgColor = '#c9daf8'; // Light Sky Blue
        } else if (gramValue === 210) {
          itemBgColor = '#cccccc'; // Silver
        } else if (gramValue === 40) {
          itemBgColor = '#e06666'; // Red
        } else if (gramValue === 15) {
          itemBgColor = '#e6b8af'; // Light Red
        } else if (gramValue === 16) {
          itemBgColor = '#e6b8af'; // Light Red
        } else if (gramValue === 420) {
          itemBgColor = '#ead1dc'; // Pale Pink
        } else if (gramValue === 280) {
          itemBgColor = '#f1c232'; // Gold
        } else if (gramValue === 400) {
          itemBgColor = '#f6b26b'; // Orange
        } else if (gramValue === 30) {
          itemBgColor = '#fff3cd'; // Lighter Yellow
        } else if (gramValue === 240) {
          itemBgColor = '#ff6d01'; // Dark Orange
        } else if (gramValue === 22) {
          itemBgColor = '#fffacd'; // Even Lighter Yellow
        }
      }
      
      // Format product name for printing - single line with wafers -> waf
      const formattedNameHTML = formatProductName(item.itemName || '')[0];
      
      return `
        <tr>
          <td class="sr-col" style="width: 30px; background-color: ${itemBgColor}; color: ${itemTextColor}; text-align: center; padding: 0px 1px; border-bottom: 1px dotted #888;">
            ${item.srNo || `C${String(actualIndex + 1).padStart(3, '0')}`}
          </td>
          <td style="text-align: left; font-size: 10pt; line-height: 1.3; padding: 1mm 1mm 1mm 1mm; word-break: break-word; background-color: ${itemBgColor}; color: ${itemTextColor}; border-bottom: 1px dotted #888;">
            <span style="font-weight: bold;">
              ${formattedNameHTML}
            </span>
          </td>
          <td class="qty-col" style="font-weight: bold; font-size: 13pt; background-color: ${itemBgColor}; color: ${itemTextColor}; text-align: right; padding: 0px 4px 0px 1px; white-space: nowrap; border-bottom: 1px dotted #888;">${item.quantity}.</td>
        </tr>
      `;
    };
    
    let pagesHTML = '';
    
    // Create page indicator header if printing specific page in split mode
    const pageIndicatorHTML = (totalPages > 1 && pageNumber) ? `
      
    ` : '';
    
    if (shouldSplitPages && pageNumber) {
      // PRINT SPECIFIC PAGE ONLY
      console.log('✅ PRINTING SPECIFIC PAGE:', {
        pageNumber,
        totalPages,
        itemsOnThisPage: itemsToPrint.length
      });
      
      pagesHTML = `
        <div class="print-page">
          ${pageIndicatorHTML}
          ${pageNumber === 1 ? createHeaderHTML() : '<div style="height: 5mm;"></div>'}
          
          <div class="print-table-container">
            <table class="print-table" style="width: 100%; border-collapse: collapse;">
              <thead>
                <tr>
                  <th style="width: 30px; padding: 1px 2px; font-size: 7pt; border-bottom: 1px solid #000;">Sr<br/>No</th>
                  <th style="text-align: left; padding: 1px 2px; font-size: 7pt; border-bottom: 1px solid #000;">Product</th>
                  <th class="qty-col" style="width: 30px; padding: 1px 2px; font-size: 7pt; border-bottom: 1px solid #000;">Qty</th>
                </tr>
              </thead>
              <tbody>
      `;
      
      // Add items for this page
      const startIdx = (pageNumber - 1) * ITEMS_PER_PAGE;
      itemsToPrint.forEach((item, idx) => {
        const actualIndex = startIdx + idx;
        pagesHTML += generateItemRow(item, actualIndex);
      });
      
      // Add page totals
      const pageTotal = itemsToPrint.reduce((sum, item) => sum + (item.quantity || 0), 0);
      const grandTotal = sortedItems.reduce((sum, item) => sum + (item.quantity || 0), 0);
      const isLastPage = pageNumber === totalPages;
      
      pagesHTML += `
                <tr>
                </tr>
      `;
      
      // Grand total on last page
      if (isLastPage) {
        pagesHTML += `
                <tr>
                  <td colspan="2" style="text-align: right; font-weight: bold; padding: 0; font-size: 10pt; padding-top: 5px; border-top: 1px solid #000;">
                     Total:${sortedItems.length} | items :
                  </td>
                  <td class="qty-col" style="font-weight: bold; color: #ff0000; padding: 0; font-size: 16pt; padding-top: 5px; padding-right: 8px; border-top: 1px solid #000;">
                    ${grandTotal}
                  </td>
                </tr>
                <tr>
                   <td colspan="3" style="padding-top: 5px; color: #000000ff; font-size: 7pt; font-style: italic;">
                     <div style="display: flex; justify-content: space-between; width: 100%;">
                       <span> ${printUser}</span>
                       <span>${printTime}</span>
                     </div>
                   </td>
                </tr>
        `;
      } else {
        pagesHTML += `
                <tr>
                  <td colspan="3" style="text-align: center; font-weight: bold; font-style: italic; padding-top: 5px; border-top: 1px solid #000; font-size: 9pt;">
                    Continued on next page...
                  </td>
                </tr>
        `;
      }
      
      pagesHTML += `
              </tbody>
            </table>
          </div>
        </div>
      `;
    } else if (shouldSplitPages) {
      // SPLIT PAGES MODE - Print all pages together (when no specific page number)
      const totalPagesCount = Math.ceil(sortedItems.length / ITEMS_PER_PAGE);
      
      console.log('✅ SPLIT PAGES MODE ACTIVE:', {
        itemsPerPage: ITEMS_PER_PAGE,
        totalPages: totalPagesCount,
        totalItems: sortedItems.length
      });
      
      for (let pageNum = 0; pageNum < totalPagesCount; pageNum++) {
        const startIdx = pageNum * ITEMS_PER_PAGE;
        const endIdx = Math.min(startIdx + ITEMS_PER_PAGE, sortedItems.length);
        const pageItems = sortedItems.slice(startIdx, endIdx);
        
        pagesHTML += `
          <div class="print-page ${pageNum > 0 ? 'page-break' : ''}">
            ${pageNum === 0 ? createHeaderHTML() : '<div style="height: 5mm;"></div>'}
            
            <div class="print-table-container">
              <table class="print-table" style="width: 100%; border-collapse: collapse;">
                <thead>
                  <tr>
                    <th style="width: 30px; padding: 1px 2px; font-size: 7pt; border-bottom: 1px solid #000;">Sr<br/>No</th>
                    <th style="text-align: left; padding: 1px 2px; font-size: 7pt; border-bottom: 1px solid #000;">Product</th>
                    <th class="qty-col" style="width: 30px; padding: 1px 2px; font-size: 7pt; border-bottom: 1px solid #000;">Qty</th>
                  </tr>
                </thead>
                <tbody>
        `;
        
        // Add items for this page
        pageItems.forEach((item, idx) => {
          const actualIndex = startIdx + idx;
          pagesHTML += generateItemRow(item, actualIndex);
        });
        
        // Add page totals (show page total and overall total on last page)
        const pageTotal = pageItems.reduce((sum, item) => sum + (item.quantity || 0), 0);
        const isLastPage = pageNum === totalPagesCount - 1; // Fix logic for split pages loop
        
        pagesHTML += `
                  <tr>
                    <td colspan="2" style="text-align: right; font-weight: bold; padding: 0; font-size: 9pt; padding-top: 3px;">
                      ${isLastPage 
                        ? `Items: ${proformaData.items.length} | Total :` 
                        : `Page ${pageNum + 1}/${totalPagesCount} | Subtotal :`}
                    </td>
                    <td class="qty-col" style="font-weight: bold; color: ${isLastPage ? '#ff0000' : '#000000'}; padding: 0; font-size: 14pt; padding-top: 3px; padding-right: 8px;">
                      ${isLastPage 
                        ? proformaData.items.reduce((sum, item) => sum + (item.quantity || 0), 0)
                        : pageTotal}
                    </td>
                  </tr>
        `;

        if (isLastPage) {
           pagesHTML += `
                  <tr>
                     <td colspan="3" style="padding-top: 5px; color: #555; font-size: 7pt; font-style: italic;">
                       <div style="display: flex; justify-content: space-between; width: 100%;">
                         <span>${printUser}</span>
                         <span>${printTime}</span>
                       </div>
                     </td>
                  </tr>
          `;
        }
        
        if (!isLastPage) {
          pagesHTML += `
                  <tr>
                    <td colspan="3" style="text-align: center; font-style: italic; font-size: 8pt; padding-top: 2px;">
                      Continued on next page...
                    </td>
                  </tr>
          `;
        }

        pagesHTML += `
                </tbody>
              </table>
            </div>
          </div>
        `;
      }
    } else {
      // CONTINUOUS MODE: Single continuous table (original behavior)
      console.log('📜 CONTINUOUS MODE ACTIVE (Split Pages Disabled)');
      
      pagesHTML = `
        <div class="print-container">
          ${createHeaderHTML()}
          
          <div class="print-table-container">
            <table class="print-table" style="width: 100%; border-collapse: collapse;">
              <thead>
                <tr>
                  <th style="width: 30px; padding: 1px 2px; font-size: 7pt; border-bottom: 1px solid #000;">Sr<br/>No</th>
                  <th style="text-align: left; padding: 1px 2px; font-size: 7pt; border-bottom: 1px solid #000;">Product</th>
                  <th class="qty-col" style="width: 30px; padding: 1px 2px; font-size: 7pt; border-bottom: 1px solid #000;">Qty</th>
                </tr>
              </thead>
              <tbody>
      `;
        
      // Add all items to single table
      sortedItems.forEach((item, actualIndex) => {
        pagesHTML += generateItemRow(item, actualIndex);
      });
      
      // Add totals at the end of the table
      pagesHTML += `
              <tr>
                <td colspan="2" style="text-align: right; font-weight: bold; padding: 0; font-size: 9pt; padding-top: 3px;">
                  Items: ${proformaData.items.length} | Total :
                </td>
                <td class="qty-col" style="font-weight: bold; color: #ff0000; padding: 0; font-size: 14pt; padding-top: 3px; padding-right: 8px;">
                  ${proformaData.items.reduce((sum, item) => sum + (item.quantity || 0), 0)}
                </td>
              </tr>
              <tr>
                 <td colspan="3" style="padding-top: 5px; color: #555; font-size: 7pt; font-style: italic;">
                   <div style="display: flex; justify-content: space-between; width: 100%">
                     <span>${printUser}</span>
                     <span>${printTime}</span>
                   </div>
                 </td>
              </tr>
              </tbody>
            </table>
          </div>
        </div>
      `;
    }
    
    console.log('📄 Pages HTML length:', pagesHTML.length);
    console.log('📄 Pages HTML preview (first 500 chars):', pagesHTML.substring(0, 500));
    console.log('📄 Number of .print-page divs:', (pagesHTML.match(/class="print-page/g) || []).length);
    console.log('📄 Split mode was:', shouldSplitPages ? 'ENABLED' : 'DISABLED');
    
    // Create print-ready HTML document
    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Print Proforma - ${proformaData.slip.orderNumber}</title>
          <style>
            @page { 
              size: 105mm 287mm; /* Slightly reduced to prevent overflow */
              margin: 3mm 5mm 0mm 5mm;
              orphans: 44;
              widows: 44;
            }
            body { 
              font-family: "Courier New", monospace;
              margin: 0;
              padding: 0;
              font-size: 8pt;
              width: 95mm;
              max-width: 95mm;
              overflow: hidden;
              -webkit-print-color-adjust: exact !important;
              print-color-adjust: exact !important;
            }
            html {
              margin: 0;
              padding: 0;
              overflow: hidden;
            }
            .print-page {
              width: 95mm;
              box-sizing: border-box;
              display: flex;
              flex-direction: column;
              margin: 0;
              padding: 0;
            }
            .print-page.page-break {
              page-break-before: always;
              break-before: page;
            }
            .print-content {
              flex: 1;
              display: flex;
              flex-direction: column;
              margin-bottom: 0;
              padding-bottom: 0;
              padding-top: 0;
              margin-top: 0;
            }
            .print-table-container {
              margin-bottom: 0;
              padding-bottom: 0;
              margin-top: 0;
              padding-top: 0;
            }
            .print-table { 
              width: 100%;
              border-collapse: collapse;
              margin-bottom: 0;
              line-height: 1;
            }
            .print-table th, .print-table td { 
              padding: 0px 1px;
              text-align: left;
            }
            .print-table th { 
              font-weight: bold;
            }
            .qty-col { 
              text-align: right !important;
            }
            .count-col { 
              text-align: center !important;
            }
            .sr-col { 
              text-align: center;
            }
            @media print {
              * {
                -webkit-print-color-adjust: exact !important;
                color-adjust: exact !important;
                print-color-adjust: exact !important;
              }
              @page {
                margin-bottom: 0;
                margin-after: 0;
              }
              body {
                margin-bottom: 0;
              }
              .print-page {
                ${shouldSplitPages ? `
                page-break-inside: avoid !important;
                break-inside: avoid !important;
                page-break-after: avoid !important;
                ` : `
                page-break-inside: auto !important;
                break-inside: auto !important;
                page-break-after: auto !important;
                `}
              }
              .print-page.page-break {
                page-break-before: always !important;
                break-before: page !important;
              }
              .print-page:last-child {
                page-break-after: avoid !important;
              }
              table {
                page-break-inside: ${shouldSplitPages ? 'avoid' : 'auto'} !important;
                break-inside: ${shouldSplitPages ? 'avoid' : 'auto'} !important;
              }
              thead {
                display: table-header-group !important;
              }
              tbody
                page-break-inside: ${isSplitPagesEnabled ? 'avoid' : 'auto'} !important;
                break-inside: ${isSplitPagesEnabled ? 'avoid' : 'auto'} !important;
              }
              tr {
                page-break-inside: avoid !important;
                break-inside: avoid !important;
              }
            }
          </style>
        </head>
        <body>
          ${pagesHTML}
        </body>
      </html>
    `;
  };
  
  // Handle direct print - Simplified to avoid double dialogs
  const handlePrint = async (pageNumber?: number) => {
    if (!proformaData?.slip) return;

    // Refetch plant config before printing to ensure we have the latest locking setting
    await refetchPlantConfig();
    
    // Get the fresh plant config after refetch
    const freshPlantConfig = plantConfig;
    const freshIsLockingEnabled = freshPlantConfig?.isLockingEnabled ?? true;
    
    console.log('🖨️ Print Handler - Plant Config:', {
      plantName: proformaData.slip.plant,
      freshPlantConfig,
      isLockingEnabled: freshIsLockingEnabled,
      isSplitPagesEnabled: freshPlantConfig?.isSplitPagesEnabled,
      splitPagesValue: Boolean(freshPlantConfig?.isSplitPagesEnabled),
      pageNumber: pageNumber || 'all'
    });

    // Block if locked AND locking is enabled for this plant, unless admin
    if (proformaData.slip?.isPrintLocked && freshIsLockingEnabled && !isAdminOrSuper) {
      toast({ title: "Locked", description: "This slip was already printed and is locked.", variant: "destructive" });
      return;
    }
    
    try {
      // Clean up any existing iframes first
      const existingFrames = document.querySelectorAll('iframe.print-frame');
      existingFrames.forEach(frame => frame.remove());

      // Create invisible iframe for direct printing without preview
      const iframe = document.createElement('iframe');
      iframe.className = 'print-frame'; // Class for easy identification/cleanup
      iframe.style.display = 'none';
      document.body.appendChild(iframe);
      
      const iframeDoc = iframe.contentWindow?.document;
      if (!iframeDoc) {
        throw new Error('Unable to access iframe document');
      }
      
      // Define onload BEFORE writing content (safer across browsers)
      iframe.onload = () => {
        setTimeout(() => {
            if (iframe.contentWindow) {
                iframe.contentWindow.focus();
                iframe.contentWindow.print();
                
                // Set logic to lock on next search
                setHasPrintedCurrentSlip(true);
                
                // Cleanup after a delay (enough time for print dialog to initialize)
                setTimeout(() => {
                    if (document.body.contains(iframe)) document.body.removeChild(iframe);
                }, 2000);
            }
        }, 500); 
      };

      // Write content - will trigger onload
      iframeDoc.open();
      iframeDoc.write(createPrintContent(pageNumber));
      iframeDoc.close();
      
    } catch (error) {
      console.error('Print setup error:', error);
      toast({
        title: "Print Error",
        description: "Unable to open print window.",
        variant: "destructive",
      });
    }
  };
  
  // Unlock handler (admin/super only)
  const handleUnlock = async () => {
    if (!proformaData?.slip) return;
    try {
      await axios.post(`/api/proforma-slips/order/${encodeURIComponent(proformaData.slip.orderNumber)}/unlock`);
      await refetch();
      setHasPrintedCurrentSlip(false); // Reset tracking when unlocked
      toast({ title: "Unlocked", description: "Slip unlocked." });
    } catch {
      toast({ title: "Error", description: "Failed to unlock", variant: "destructive" });
    }
  };
  
  // Handle search button click
  const handleSearch = async () => {
    if (!inputValue.trim()) {
      toast({
        title: "Order number required",
        description: "Please enter an order number to search",
        variant: "destructive",
      });
      return;
    }

    // Step 1: Check if the *currently loaded* slip needs locking (only if locking is enabled for that plant)
    if (proformaData?.slip && hasPrintedCurrentSlip && !proformaData.slip.isPrintLocked) {
      // Refetch plant config to get the latest locking setting before deciding to lock
      await refetchPlantConfig();
      const currentIsLockingEnabled = plantConfig?.isLockingEnabled ?? true;
      
      if (currentIsLockingEnabled) {
        try {
          console.log(`Locking previous slip #${proformaData.slip.orderNumber} before searching new one...`);
          await axios.post(`/api/proforma-slips/order/${encodeURIComponent(proformaData.slip.orderNumber)}/lock`, {
            printedByCode: currentUser?.userCode,
            // Tells the server this is the automatic post-print lock, not a deliberate
            // Lock-button click from the Proforma Slips page — that path only needs read
            // access to both pages, not write (see requireLockAccess server-side).
            autoLockFromPrint: true,
          });
          toast({ title: "Locked", description: `Previous slip #${proformaData.slip.orderNumber} locked.` });
        } catch (err: any) {
          // Previously silent (console.error only) — a permission or network failure here
          // meant the slip just never locked with no indication why. Now surfaced so it's
          // never an invisible failure again.
          toast({
            title: "Failed to lock previous slip",
            description: err?.response?.data?.message || err?.message || `Could not lock slip #${proformaData.slip.orderNumber} — it may still be printable by others.`,
            variant: "destructive",
          });
          console.error('Failed to auto-lock previous slip:', err);
        }
      }
    }
    
    // Step 2: Proceed with new search
    const newOrderNumber = inputValue.trim();
    setActiveOrderNumber(newOrderNumber);

    try {
      setTimeout(async () => {
        // Fetch the slip data — and stop here with a clear message when there's no such slip.
        const result = await refetch();
        if (result.isError || !result.data?.slip) {
          const err: any = result.error;
          toast({
            title: "Slip not found",
            description: err?.response?.data?.message || err?.message || `No proforma slip found for order "${newOrderNumber}".`,
            variant: "destructive",
          });
          return;
        }
        
        // NEW: Immediately check the latest lock status after fetching
        const currentData = proformaData;
        if (currentData) {
          try {
            // Fetch fresh slip data to check latest lock status
            const latestSlipResponse = await axios.get(`/api/proforma-slips/order/${encodeURIComponent(newOrderNumber)}`);
            const latestSlip = latestSlipResponse.data?.slip;
            
            // Refetch plant config to get latest locking settings
            await refetchPlantConfig();
            const isLockingEnabledForPlant = plantConfig?.isLockingEnabled ?? true;
            
            console.log('🔍 Latest slip status check:', {
              orderNumber: newOrderNumber,
              isPrintLocked: latestSlip?.isPrintLocked,
              isLockingEnabled: isLockingEnabledForPlant,
              printedBy: latestSlip?.printedByCode,
              printedAt: latestSlip?.printedAt,
              printCount: latestSlip?.printCount
            });
            
            // Show lock status warning if locked and locking is enabled
            if (latestSlip?.isPrintLocked && isLockingEnabledForPlant && !canUnlockSlips) {
              toast({
                title: "⚠️ Slip Locked",
                description: `This slip was printed ${latestSlip.printCount || 1} time(s). Contact admin to unlock.`,
                variant: "destructive",
              });
            } else if (latestSlip?.isPrintLocked && isLockingEnabledForPlant && canUnlockSlips) {
              toast({
                title: "🔒 Slip Locked",
                description: "This slip is locked. You can unlock it using the button below.",
                variant: "default",
              });
            }
          } catch (err) {
            console.error('Failed to fetch latest slip status:', err);
          }
        }
        
        setShowPreview(true);
      }, 0);
    } catch (err) {
      console.error('Error fetching proforma slip:', err);
      toast({
        title: "Error",
        description: "Failed to fetch proforma slip data",
        variant: "destructive",
      });
    }
  };
  
  // Handle Enter key in search input
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };
  
  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="mb-6 text-2xl font-bold text-[#001d6e] flex items-center">
        <PrinterCheck className="mr-2 h-6 w-6 text-[#001d6e]" style={{fill: "#8766e3"}} />
        Print Operations
      </h1>
      
      <div className="flex flex-col md:flex-row gap-6">
        {/* Left side - Preview section */}
        <div className="flex-1">
          {showPreview && proformaData?.slip ? (
            <Card className="overflow-hidden h-full">
              <CardHeader className="pb-0">
                <h3 className="text-lg font-bold">Print Preview</h3>
              </CardHeader>
              
              <CardContent className="pb-0 pt-4">
                <div className="bg-white border rounded-md p-4 mx-auto" style={{ width: '105mm', maxWidth: '100%' }}>
                  <div id="print-content">
                    {(() => {
                      // Get plant-specific colors from database (fallback to defaults)
                      const bgColor = plantConfig?.bgColor || '#e5e7eb'; // gray-200 default
                      const textColor = plantConfig?.textColor || '#1a202c'; // gray-900 default
                      const borderColor = plantConfig?.borderColor || '#9ca3af'; // gray-400 default
                      
                      return (
                        <div style={{ 
                          textAlign: 'center', 
                          fontWeight: 'bold', 
                          fontSize: '10pt',
                          backgroundColor: bgColor,
                          color: textColor,
                          padding: '3px 0',
                          marginBottom: '1mm',
                          borderBottom: `1px solid ${borderColor}`
                        }}>
                          KRUPA MARKETING - {proformaData.slip.plant?.toUpperCase() || ''}
                        </div>
                      );
                    })()}

                    <div style={{ marginBottom: '0.5mm' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '5mm' }}>
                        <div style={{ 
                          display: 'flex',
                          width: '45px', 
                          height: '45px', 
                          borderRadius: '50%', 
                          border: '2px solid #000000',
                          backgroundColor: 'transparent', 
                          color: '#000000', 
                          fontSize: `${vehicleCircleFontPt(proformaData.slip.vehicleNumber)}pt`, 
                          fontWeight: 'bold',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                          lineHeight: 1,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textAlign: 'center'
                        }}>
                          {proformaData.slip.vehicleNumber || ''}
                        </div>
                        <div style={{ textAlign: 'center', fontSize: '10pt', fontWeight: 'bold', flex: 1, padding: '0 5mm' }}>
                          {proformaData.slip.partyName}
                          {/* Time box for load start & end time */}
                          <div style={{ marginTop: '3mm', border: '1px solid #000', padding: '2mm', backgroundColor: '#ffffff' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '2mm' }}>
                              <div style={{ flex: 1 }}>
                                <div style={{ fontSize: '7pt', marginBottom: '1mm' }}>Start:</div>
                                <div style={{ height: '12px', width: '100%' }}></div>
                              </div>
                              <div style={{ flex: 1 }}>
                                <div style={{ fontSize: '7pt', marginBottom: '1mm' }}>End:</div>
                                <div style={{ height: '12px', width: '100%' }}></div>
                              </div>
                            </div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '1mm' }}>
                          {/* Slip number with its scannable barcode directly beneath it, then the date — same as the printed slip. */}
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                            <div style={{ fontSize: '14pt', fontWeight: 'bold', textAlign: 'right', color: '#a10808', lineHeight: '1.1' }}>#{proformaData.slip.orderNumber}</div>
                            {barcodeDataUrl && (
                              <img src={barcodeDataUrl} alt="Order barcode" style={{ height: '7mm', width: 'auto', display: 'block', marginTop: '0.5mm' }} />
                            )}
                          </div>
                          <div style={{ fontSize: '10pt', fontWeight: 'bold', lineHeight: '1.2', textAlign: 'right' }}>{formatDate(proformaData.slip.orderDate)}</div>
                        </div>
                      </div>
                    </div>
                    
                    <table className="print-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr>
                          <th style={{ width: '30px', padding: '1px 2px', fontSize: '7pt', borderBottom: '1px solid #000' }}>Sr<br/>No</th>
                          <th style={{ textAlign: 'left', padding: '1px 2px', fontSize: '7pt', borderBottom: '1px solid #000' }}>Product</th>
                          <th className="qty-col" style={{ width: '30px', padding: '1px 2px', fontSize: '7pt', borderBottom: '1px solid #000' }}>Qty</th>
                        </tr>
                      </thead>
                      
                      <tbody>
                        {proformaData.items
                          .sort((a, b) => {
                            // Sort by srNo - handle null/undefined values
                            const aSrNo = a.srNo || '';
                            const bSrNo = b.srNo || '';
                            return aSrNo.localeCompare(bSrNo, undefined, { numeric: true, sensitivity: 'base' });
                          })
                          .map((item, index) => {
                          const palletQty = calculatePalletQty(item);
                          const gramValue = extractGramValue(item.itemName || '');
                          
                          // Set background color based on GM value
                          let bgColor = '';
                          let textColor = 'black'; // Default text color
                          
                          if (gramValue !== null) {
                            if (gramValue === 300) {
                              bgColor = '#000000'; // Black
                              textColor = 'white';
                            } else if (gramValue === 135) {
                              bgColor = '#46bdc6'; // Cyan
                            } else if (gramValue === 13) {
                              bgColor = '#FF5733'; // Orange-red
                              textColor = 'white';
                            } else if (gramValue === 200) {
                              bgColor = '#49e160'; // Green
                            } else if (gramValue === 24) {
                              bgColor = '#FFF0E0'; // Very light skin color
                            } else if (gramValue === 50) {
                              bgColor = '#85d69a'; // Light Green
                            } else if (gramValue === 45) {
                              bgColor = '#a4c2f4'; // Light Blue
                            } else if (gramValue === 65) {
                              bgColor = '#b4a7d6'; // Lavender
                            } else if (gramValue === 20) {
                              bgColor = '#b7b7b7'; // Grey
                            } else if (gramValue === 25) {
                              bgColor = '#b7e1cd'; // Light Aqua
                            } else if (gramValue === 250) {
                              bgColor = '#c27ba0'; // Pink
                            } else if (gramValue === 500) {
                              bgColor = '#c9daf8'; // Light Sky Blue
                            } else if (gramValue === 210) {
                              bgColor = '#cccccc'; // Silver
                            } else if (gramValue === 40) {
                              bgColor = '#e06666'; // Red
                            } else if (gramValue === 15) {
                              bgColor = '#e6b8af'; // Light Red
                            } else if (gramValue === 16) {
                              bgColor = '#e6b8af'; // Light Red
                            } else if (gramValue === 420) {
                              bgColor = '#ead1dc'; // Pale Pink
                            } else if (gramValue === 280) {
                              bgColor = '#f1c232'; // Gold
                            } else if (gramValue === 400) {
                              bgColor = '#f6b26b'; // Orange
                            } else if (gramValue === 30) {
                              bgColor = '#fff3cd'; // Lighter Yellow
                            } else if (gramValue === 240) {
                              bgColor = '#ff6d01'; // Dark Orange
                            } else if (gramValue === 22) {
                              bgColor = '#fffacd'; // Even Lighter Yellow
                            } else {
                              bgColor = '#ffffff'; // White
                            }
                          }
                          
                          return (
                            <tr key={item.id}>
                              <td className="sr-col" style={{ 
                                width: '30px', 
                                backgroundColor: bgColor, 
                                color: textColor, 
                                WebkitPrintColorAdjust: 'exact',
                                textAlign: 'center',
                                fontSize: '7pt',
                                padding: '0px 1px',
                                borderBottom: '0.5px dotted #888'
                              }}>
                                {item.srNo || `C${String(index + 1).padStart(3, '0')}`}
                              </td>
                              <td style={{ 
                                textAlign: 'left',
                                fontSize: '10pt',
                                lineHeight: '1.4',
                                wordBreak: 'break-word',
                                width: 'auto',
                                backgroundColor: bgColor, 
                                color: textColor,
                                WebkitPrintColorAdjust: 'exact',
                                borderBottom: '0.5px dotted #888',
                                padding: '1mm 1mm 1mm 1mm'
                              }}>
                                <span style={{ fontWeight: 'bold' }}>
                                  {formatProductName(item.itemName)[0]}
                                </span>
                              </td>
                              <td className="qty-col" style={{ 
                                fontWeight: 'bold', 
                                backgroundColor: bgColor,
                                color: textColor, 
                                WebkitPrintColorAdjust: 'exact',
                                textAlign: 'right',
                                fontSize: '13pt',
                                padding: '0px 4px 0px 1px',
                                whiteSpace: 'nowrap',
                                borderBottom: '0.5px dotted #888'
                              }}>{item.quantity}.</td>
                            </tr>
                          );
                        })}
                        
                        <tr>
                          <td colSpan={2} style={{ textAlign: 'right', fontWeight: 'bold', padding: '0', fontSize: '9pt', paddingTop: '3px' }}>
                            Items: {proformaData.items.length} | Total :
                          </td>
                          <td className="qty-col" style={{ fontWeight: 'bold', padding: '0', color: '#ff0000', fontSize: '14pt', paddingTop: '3px', paddingRight: '8px' }}>
                            {proformaData.items.reduce((sum, item) => sum + (item.quantity || 0), 0)}
                          </td>
                        </tr>
                        <tr>
                           <td colSpan={3} style={{ paddingTop: '5px', color: '#555', fontSize: '7pt', fontStyle: 'italic' }}>
                             <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                               <span>Printed by: {printUser}</span>
                               <span>{printTime}</span>
                             </div>
                           </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="flex items-center justify-center h-64 bg-gray-50 border border-dashed border-gray-300 rounded-md">
              <div className="text-center text-gray-500">
                <PrinterCheck className="mx-auto h-12 w-12 text-gray-400" />
                <p className="mt-2">Enter an order number to preview</p>
              </div>
            </div>
          )}
        </div>
        
        {/* Right side - Search & Print controls */}
        <div className="md:w-1/3">
          <Card>
            <CardHeader></CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Order Number</label>
                  {/* CHANGED: Bind to inputValue */}
                  <Input
                    type="text"
                    placeholder="Enter Order Number"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    className="border-[#001d6e] focus:border-[#001d6e] focus:ring-[#001d6e]"
                  />
                </div>
                
                <Button 
                  onClick={handleSearch}
                  disabled={isLoading || !inputValue.trim()}
                  className="w-full bg-[#001d6e] hover:bg-[#001040]"
                >
                  {isLoading ? 'Searching...' : (
                    <>
                      <Search className="mr-2 h-4 w-4" /> Search
                    </>
                  )}
                </Button>
                
                {showPreview && proformaData && (
                  <>
                    {(() => {
                      // Calculate if split pages and how many pages
                      const sortedItems = [...proformaData.items].sort((a, b) => {
                        const aSrNo = a.srNo || '';
                        const bSrNo = b.srNo || '';
                        return aSrNo.localeCompare(bSrNo, undefined, { numeric: true, sensitivity: 'base' });
                      });
                      const pages = splitItemsIntoPages(sortedItems);
                      const totalPages = pages.length;
                      const isPrintLocked = proformaData.slip?.isPrintLocked && isLockingEnabled;
                      // Don't disable button if user has unlock permissions
                      const isButtonDisabled = isPrintLocked && !canUnlockSlips;
                      
                      // If split pages enabled and multiple pages, show individual page print buttons
                      if (isPrintLocked) {
                        return (
                          <div className="space-y-4">
                            <div className="flex flex-col items-center justify-center p-6 bg-red-50 border border-red-200 rounded-lg text-center">
                              <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mb-3">
                                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                              </div>
                              <h3 className="text-lg font-bold text-red-700 mb-1">Print Locked</h3>
                              <p className="text-sm text-red-600 mb-4">
                                This order has already been printed.
                              </p>
                              
                              {canUnlockSlips ? (
                                <Button 
                                  onClick={handleUnlock} 
                                  className="w-full bg-red-600 hover:bg-red-700 text-white"
                                >
                                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mr-2 h-4 w-4"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                                  Unlock Order
                                </Button>
                              ) : (
                                <div className="text-xs text-red-500 italic">
                                  Contact your Admin/Super-Admin to unlock.
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      }

                      if (isSplitPagesEnabled && totalPages > 1) {
                        return (
                          <div className="space-y-2">
                            <div className="text-sm font-medium text-center mb-2">
                              Order splits into {totalPages} pages
                            </div>
                            {Array.from({ length: totalPages }, (_, i) => i + 1).map(pageNum => (
                              <Button 
                                key={pageNum}
                                onClick={() => handlePrint(pageNum)} 
                                className="w-full text-white bg-[#8766e3] hover:bg-[#7656d3]"
                                disabled={isLoading}
                              >
                                <PrinterCheck className="mr-2 h-4 w-4" /> 
                                Print Page {pageNum}
                              </Button>
                            ))}
                          </div>
                        );
                      }
                      
                      // Otherwise show single print button
                      return (
                        <Button 
                          onClick={() => handlePrint()} 
                          className="w-full text-white bg-[#8766e3] hover:bg-[#7656d3]"
                          disabled={isLoading}
                        >
                            <PrinterCheck className="mr-2 h-4 w-4" /> 
                            Print Order
                        </Button>
                      );
                    })()}

                    {/* Show locking status indicator */}
                    {/* {!isLockingEnabled && (
                      <div className="text-xs text-orange-600 text-center mt-1">
                        ⚠️ Unlimited prints (locking disabled for {proformaData.slip.plant})
                      </div>
                    )} */}

                    {/* Show audit + unlock if available */}
                    {/* {(proformaData.slip?.printedAt || proformaData.slip?.printedByCode) && (
                      <div className="text-xs text-muted-foreground text-center mt-1">
                        Last printed {proformaData.slip.printedAt ? new Date(proformaData.slip.printedAt as any).toLocaleString() : ''} 
                        {proformaData.slip.printedByCode ? ` by ${proformaData.slip.printedByCode}` : ''}
                        {typeof proformaData.slip.printCount === 'number' ? ` • Count: ${proformaData.slip.printCount}` : ''}
                      </div>
                    )} */}

                    {/* DEBUG: Show reasons if not showing */
                      <div className="hidden">
                        DEBUG STATUS: 
                        Locked: {String(proformaData.slip?.isPrintLocked)}
                        CanUnlock: {String(canUnlockSlips)}
                      </div>
                    }
                  </>
                )}

                {/* PLANT MANAGEMENT BUTTON - Always visible for testing */}
                <div className="mt-4 pt-4 border-t">
          
                  {isAdminOrSuper ? (
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() => {
                        const plantName = proformaData?.slip?.plant || '';
                        const query = plantName ? `?name=${encodeURIComponent(plantName)}` : '';
                        navigate(`/plant-settings${query}`);
                      }}
                    >
                      <Factory className="mr-2 h-4 w-4" />
                      Plant Management
                    </Button>
                  ) : (
                    <div className="text-xs text-red-500">
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Not Found UI - Shows when order is searched but not found */}
      {activeOrderNumber && !proformaData && !isLoading && error && (
        <div className="mt-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <Card className="border-red-200 shadow-lg bg-white overflow-hidden">
            <div className="h-2 bg-gradient-to-r from-red-500 to-orange-500 w-full"></div>
            <CardContent className="p-12 flex flex-col items-center justify-center text-center">
              <div className="w-24 h-24 bg-gradient-to-br from-red-50 to-orange-50 rounded-full flex items-center justify-center mb-6 shadow-inner">
                <Search className="h-12 w-12 text-red-600" />
              </div>
              
              <h3 className="text-2xl font-bold text-gray-900 mb-3">
                Proforma Slip Not Found
              </h3>
              
              <p className="text-gray-600 max-w-md mb-8 text-lg">
                We couldn't locate a proforma slip for order <span className="font-mono font-bold text-red-600 bg-red-50 px-3 py-1 rounded-md">{activeOrderNumber}</span>
              </p>
              
              <div className="grid gap-4 w-full max-w-lg">
                <div className="bg-blue-50 p-4 rounded-lg border border-blue-100 flex items-start gap-3 text-left">
                  <div className="mt-1 bg-blue-100 p-1.5 rounded">
                    <PrinterCheck className="h-4 w-4 text-blue-600" />
                  </div>
                  <div className="flex-1">
                    <p className="font-semibold text-blue-900 mb-1">Check Order Number</p>
                    <p className="text-sm text-blue-700">Ensure the order number is correct and the slip has been created in the system.</p>
                  </div>
                </div>
                
                <div className="bg-amber-50 p-4 rounded-lg border border-amber-100 flex items-start gap-3 text-left">
                  <div className="mt-1 bg-amber-100 p-1.5 rounded">
                    <FileDown className="h-4 w-4 text-amber-600" />
                  </div>
                  <div className="flex-1">
                    <p className="font-semibold text-amber-900 mb-1">Contact Support</p>
                    <p className="text-sm text-amber-700">If the order exists, please contact your system administrator for assistance.</p>
                  </div>
                </div>
              </div>
              
              <Button
                variant="outline"
                className="mt-8"
                onClick={() => {
                  setInputValue('');
                  setActiveOrderNumber('');
                }}
              >
                <Search className="h-4 w-4 mr-2" />
                Search Another Order
              </Button>
            </CardContent>
          </Card>
        </div>
      )}
      
    </div>
  );
};

export default PrintOperations;
