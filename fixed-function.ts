// Fixed version of handleOrderLookupForOperation function
const handleOrderLookupForOperation = async (orderNumber: string) => {
  try {
    setIsOrderSearchLoading(true);
    if (!orderNumber.trim()) {
      toast({
        title: "Error",
        description: "Please enter an order number",
        variant: "destructive",
      });
      setIsOrderSearchLoading(false);
      return;
    }
    
    // Use batch API for better performance
    const response = await fetch('/api/proforma-slips/batch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ orderNumbers: [orderNumber.trim()] }),
    });
    
    const batchResults = await response.json();
    const data = batchResults[orderNumber.trim()];
    
    if (!data) {
      throw new Error(`No data found for order number ${orderNumber.trim()}`);
    }
    
    // Check if operation already exists
    const opResponse = await apiRequest(
      'GET',
      `/api/loading-operations/reference/${orderNumber.trim()}`
    );
    
    const opData = await opResponse.json();
    
    // Preload missing product data if needed
    await preloadProductData(data.items);
    
    // Process the items to ensure they have names and SKUs
    const processedData = {
      slip: data.slip,
      items: data.items.map((item: any, idx: number) => {
        // Make sure all item properties are populated
        return {
          ...item,
          srNo: item.srNo || item.sr_no || idx + 1,
          srNoDisplay: item.srNoDisplay || item.sr_no_display || (item.srNo || item.sr_no || idx + 1).toString(),
          itemName: item.itemName || item.item_name || "Unknown Item",
          sku: item.sku || item.barcode || ""
        };
      }),
      operation: opData.exists ? opData.operation : undefined
    };
    
    setProformaSlipDetails(processedData);
    
    toast({
      title: "Success",
      description: `Found proforma slip #${data.slip.orderNumber}`,
    });
  } catch (error) {
    toast({
      title: "Error",
      description: "Proforma slip not found with that order number",
      variant: "destructive",
    });
  } finally {
    setIsOrderSearchLoading(false);
  }
};