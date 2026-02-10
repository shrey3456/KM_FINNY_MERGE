{/* Loaded status section - conditional rendering for load button or value capsule */}
<div className="flex items-center mt-2 pt-2 border-t border-muted gap-2">
  <Button 
    size="sm"
    variant="ghost"
    onClick={() => {
      if (operation.referenceNumber) {
        deleteItem(item.id, operation.id, operation.referenceNumber);
      }
    }}
    className="h-9 w-9 p-0"
    title="Remove item"
  >
    <Trash className="h-6 w-6 text-red-500" style={{height: '1.5rem', width: '1.5rem'}} />
  </Button>
  
  {/* Conditional rendering: Either show Load Item button (not loaded) or value capsule (loaded) */}
  {item.loaded ? (
    /* Show value capsule container with tick icon when loaded */
    <div className="flex items-center space-x-2 w-full">
      <div className="flex items-center border rounded-full overflow-hidden border-green-500">
        <Button
          size="icon"
          variant="ghost"
          className="h-9 w-9 rounded-l-full"
          onClick={() => {
            const currentQuantity = item.loadedQuantity ?? item.quantity ?? 1;
            updateItemQuantity(item.id, Math.max(1, currentQuantity - 1), operation.id);
          }}
          disabled={(item.loadedQuantity ?? item.quantity ?? 0) <= 1}
          title="Decrease quantity"
        >
          <MinusCircle className="h-5 w-5" />
        </Button>
        
        <Input
          type="number"
          min="1"
          id={`item-quantity-mobile-${item.id}`}
          className="w-16 h-9 text-center text-base font-medium border-0 focus:ring-0 p-0"
          value={item.loadedQuantity ?? item.quantity ?? 1}
          onChange={(e) => {
            updateItemQuantity(item.id, parseInt(e.target.value) || 1, operation.id);
          }}
        />
        
        <Button
          size="icon"
          variant="ghost"
          className="h-9 w-9"
          onClick={() => {
            const currentQty = item.loadedQuantity ?? item.quantity ?? 1;
            updateItemQuantity(item.id, currentQty + 1, operation.id);
          }}
          title="Increase quantity"
        >
          <PlusCircle className="h-5 w-5" />
        </Button>
        
        <div className="px-2">
          <CheckCircle className="h-5 w-5 text-green-500" />
        </div>
      </div>
    </div>
  ) : (
    /* Show Load Item button if not loaded */
    <div className="flex items-center space-x-2 w-full">
      <Checkbox
        id={`confirm-loaded-mobile-${item.id}`}
        checked={item.loaded}
        onCheckedChange={(isChecked) => {
          // Prepare the new loaded status
          const newLoadedStatus = !!isChecked;
          
          // Get the current quantity before update
          const currentQuantity = item.quantity ?? item.originalQuantity ?? 1;
          
          // Create updated item with new loaded status and current quantity as loaded quantity
          const updatedItem = { 
            ...item, 
            loaded: newLoadedStatus,
            // Set loadedQuantity to current quantity when checked, otherwise null
            loadedQuantity: newLoadedStatus ? currentQuantity : null
          };
          
          // Update UI state instantly for better UX
          if (viewProformaDetails?.items) {
            const updatedItems = viewProformaDetails.items.map(i => 
              i.id === item.id ? updatedItem : i
            );
            
            setViewProformaDetails({
              ...viewProformaDetails,
              items: updatedItems
            });
          }
          
          // Prepare API payload
          const apiData = {
            id: item.id,
            loaded: newLoadedStatus,
            // If checking, send current quantity as loaded quantity
            ...(newLoadedStatus ? { loadedQuantity: currentQuantity } : {})
          };
          
          // Call API to update server state
          apiRequest(`/api/loading-operations/${operation.id}/items/${item.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(apiData)
          })
            .then(response => {
              console.log("Updated item loaded status:", response);
              
              // Invalidate queries to refresh data
              if (selectedOperation?.id) {
                queryClient.invalidateQueries({ 
                  queryKey: [`/api/loading-operations/${selectedOperation.id}/items`] 
                });
              }
              
              // Broadcast update to other devices if channel exists
              if (broadcastChannelRef.current) {
                broadcastChannelRef.current.postMessage({
                  type: 'LOADED_STATUS_UPDATED',
                  operationId: selectedOperation?.id,
                  data: [{ id: item.id, loaded: newLoadedStatus }],
                  timestamp: Date.now(),
                  sender: window.deviceId
                });
              }
            })
            .catch(error => {
              // Check if it's a network error, which could be normal during page reloads or server restart
              const errorMessage = error?.message || '';
              const isNetworkError = 
                errorMessage.includes('NetworkError') || 
                errorMessage.includes('Failed to fetch') ||
                errorMessage.includes('Network request failed');
              
              if (!isNetworkError) {
                console.error("Failed to update loaded status:", error);
                
                // Show error toast only for actual server errors, not for connection issues
                toast({
                  title: "Error",
                  description: "Failed to save loaded status",
                  variant: "destructive"
                });
                
                // Revert the UI state to match server state on error
                if (viewProformaDetails?.items) {
                  const revertedItem = { ...item, loaded: !newLoadedStatus };
                  const revertedItems = viewProformaDetails.items.map(i => 
                    i.id === item.id ? revertedItem : i
                  );
                  
                  setViewProformaDetails({
                    ...viewProformaDetails,
                    items: revertedItems
                  });
                }
              }
            });
        }}
        className="h-5 w-5 data-[state=checked]:bg-green-600 data-[state=checked]:text-white border-2" 
      />
      <Label htmlFor={`confirm-loaded-mobile-${item.id}`} className="text-sm font-medium">Load Item</Label>
    </div>
  )}
</div>