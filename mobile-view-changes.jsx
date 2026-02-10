{/* Mobile view - Loaded status section with conditional rendering */}
{/* Replace the existing loaded section with this code */}

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
        checked={item.loaded ?? false}
        onCheckedChange={(checked) => {
          // Code from original file for the checkbox event handler
          const isChecked = checked === true;
          
          // Update UI element background
          const card = document.querySelector(`[data-item-id="${item.id}"]`);
          if (card) {
            card.classList.toggle('bg-green-50', isChecked);
          }
          
          // ... rest of your existing code
        }}
        className="h-5 w-5 data-[state=checked]:bg-green-600 data-[state=checked]:text-white border-2" 
      />
      <Label htmlFor={`confirm-loaded-mobile-${item.id}`} className="text-sm font-medium">Load Item</Label>
    </div>
  )}
</div>