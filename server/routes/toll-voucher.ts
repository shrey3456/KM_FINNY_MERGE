import { Router } from 'express';
import { requirePageAccess } from '../lib/pageAccess';
import { searchVoucherData, getVoucherDriverName, getVoucherVehicleNumber } from './expense-voucher';

const router = Router();

// The Toll Voucher reads the same Notion voucher records as the Expense Voucher and follows all of its
// rules — optional voucher-date scope, voucher-number or driver-name search, same-driver vouchers merged
// (toll summed across them), different vehicles kept separate, party lines shown only for
// Approved/Adjusted vouchers. That whole search is the Expense Voucher's own (searchVoucherData); this
// route only picks the toll fields out of each resulting voucher.

interface TollFields {
  orderNumber: string;
  driver: string;
  vehicle: string;
  tollTax: number;
  party: string;
  order: string;
  tollTaxInWords: string;
  orderDate: string;
}

function buildTollFields(info: Record<string, string>, searchedFor: string): TollFields {
  // Vehicle can hold a repeated value like "221{GJ-15-AX-6055},221{GJ-15-AX-6055}" — show the first.
  const vehicleRaw = info['Link to Vehicle No. :'] || getVoucherVehicleNumber(info);
  const tollTax = parseFloat(info['Toll Tax :']) || 0;
  const orderDate =
    info['Voucher Date :'] ||
    ['For Ord Date :', 'For Ord Date', 'Order Date', 'Order Date :', 'Date', 'Ord Date', 'Voucher Date']
      .map((k) => info[k])
      .find(Boolean) ||
    '';
  return {
    orderNumber: info['Voucher No. :'] || searchedFor,
    driver: info['Link to Driver :'] || getVoucherDriverName(info),
    vehicle: vehicleRaw.split(',')[0].trim(),
    tollTax,
    party: info['For Party x Ord Date'] || '',
    order: info['Voucher No. :'] || searchedFor,
    tollTaxInWords: numberToWords(tollTax),
    orderDate,
  };
}

// Toll voucher API - Protected
router.post('/toll-voucher', requirePageAccess('toll-voucher'), async (req, res) => {
  try {
    const { orderNumber, driverName, voucherDate } = req.body ?? {};

    if (!orderNumber && !driverName) {
      return res.status(400).json({
        success: false,
        message: 'Voucher number or driver name is required'
      });
    }

    const { status, body } = await searchVoucherData({ orderNumber, driverName, voucherDate });
    if (!body?.success || !body.data) {
      return res.status(status).json(body ?? { success: false, message: 'Failed to fetch toll voucher data' });
    }

    const searchedFor = String(driverName || orderNumber);
    const data = body.data;
    const vehicleOptions = Array.isArray(data.vehicleOptions)
      ? data.vehicleOptions.map((o: any) => ({
          vehicleNumber: o.vehicleNumber,
          mergedVoucherCount: o.mergedVoucherCount,
          ...buildTollFields(o.voucherInfo || {}, searchedFor),
        }))
      : undefined;

    return res.json({
      success: true,
      message: body.message,
      data: {
        plant: data.plant,
        mergedVoucherCount: data.mergedVoucherCount,
        ...buildTollFields(data.voucherInfo || {}, searchedFor),
        ...(vehicleOptions && vehicleOptions.length > 1 ? { vehicleOptions } : {}),
      }
    });
  } catch (error: any) {
    console.error('Error in toll voucher endpoint:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// Convert number to words (Indian format)
function numberToWords(num: number): string {
  if (num === 0) return 'Zero Rupees Only';
  
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  
  function convertLessThan100(n: number): string {
    if (n < 10) return ones[n];
    if (n >= 10 && n < 20) return teens[n - 10];
    return tens[Math.floor(n / 10)] + (n % 10 !== 0 ? ' ' + ones[n % 10] : '');
  }
  
  function convertLessThan1000(n: number): string {
    if (n === 0) return '';
    if (n < 100) return convertLessThan100(n);
    return ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 !== 0 ? ' ' + convertLessThan100(n % 100) : '');
  }
  
  let result = '';
  
  // Crores
  if (num >= 10000000) {
    result += convertLessThan1000(Math.floor(num / 10000000)) + ' Crore ';
    num %= 10000000;
  }
  
  // Lakhs
  if (num >= 100000) {
    result += convertLessThan100(Math.floor(num / 100000)) + ' Lakh ';
    num %= 100000;
  }
  
  // Thousands
  if (num >= 1000) {
    result += convertLessThan100(Math.floor(num / 1000)) + ' Thousand ';
    num %= 1000;
  }
  
  // Hundreds
  if (num > 0) {
    result += convertLessThan1000(num);
  }
  
  return result.trim() + ' Rupees Only';
}

export default router;
