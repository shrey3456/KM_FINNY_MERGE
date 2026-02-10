/**
 * Mobile-specific dialog fixes to prevent forms from closing
 * This module directly patches the DOM/React to keep dialogs open
 */

// Store a mapping of operation IDs to their open dialog status
const openDialogStatus: Record<number, boolean> = {};

/**
 * Initialize mobile fixes to prevent dialogs from closing
 * This patches the DOM to intercept closing events
 */
export function initializeMobileDialogFix() {
  console.log("[MobileDialogFix] Initializing mobile dialog fix");
  
  // Create a MutationObserver to detect dialog changes
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes' && 
          mutation.attributeName === 'data-state' && 
          mutation.target instanceof HTMLElement) {
        
        const dialog = mutation.target;
        const operationId = extractOperationId(dialog);
        
        if (operationId) {
          const isOpen = dialog.getAttribute('data-state') === 'open';
          
          if (isOpen) {
            // Mark this dialog as open
            openDialogStatus[operationId] = true;
            console.log(`[MobileDialogFix] Dialog for operation ${operationId} opened`);
          } else {
            // Only allow closing if not in our forced-open list
            if (openDialogStatus[operationId] === true && 
                shouldKeepDialogOpen(operationId)) {
              
              console.log(`[MobileDialogFix] Preventing dialog close for operation ${operationId}`);
              
              // Keep dialog open by forcing data-state back to open
              setTimeout(() => {
                if (dialog && dialog.parentNode) {
                  dialog.setAttribute('data-state', 'open');
                  
                  // Also fix any backdrop or overlay elements
                  const backdrop = document.querySelector('[data-state="closed"].dialog-backdrop');
                  if (backdrop && backdrop instanceof HTMLElement) {
                    backdrop.setAttribute('data-state', 'open');
                  }
                  
                  console.log(`[MobileDialogFix] Forced dialog for operation ${operationId} to stay open`);
                }
              }, 0);
              
              return;
            } else {
              // Allow normal closing
              openDialogStatus[operationId] = false;
              console.log(`[MobileDialogFix] Dialog for operation ${operationId} closed normally`);
            }
          }
        }
      }
    }
  });
  
  // Start observing the entire document
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ['data-state'],
    subtree: true
  });
  
  // Also patch any click events that might close the dialog
  document.addEventListener('click', (event) => {
    // Find if we're clicking on a dialog close button
    let target = event.target as HTMLElement;
    
    while (target && target !== document.body) {
      // Check if this is a close button inside a dialog we want to keep open
      if ((target.getAttribute('data-dialog-close') === 'true' || 
           target.hasAttribute('data-dialog-close')) &&
          target.closest('[role="dialog"]')) {
        
        const dialog = target.closest('[role="dialog"]');
        const operationId = extractOperationId(dialog as HTMLElement);
        
        if (operationId && shouldKeepDialogOpen(operationId)) {
          console.log(`[MobileDialogFix] Preventing close button click for operation ${operationId}`);
          event.preventDefault();
          event.stopPropagation();
          return false;
        }
      }
      
      target = target.parentElement as HTMLElement;
    }
  }, true);  // Use capture phase
  
  console.log("[MobileDialogFix] Mobile dialog fix initialized");
}

/**
 * Mark a dialog as needing to stay open
 * Call this before performing operations that might cause dialogs to close
 * 
 * @param operationId The operation ID
 */
export function keepDialogOpen(operationId: number) {
  if (!operationId) return;
  
  console.log(`[MobileDialogFix] Marking dialog for operation ${operationId} to stay open`);
  openDialogStatus[operationId] = true;
  
  // Find the dialog and make sure it's open
  const dialog = findDialogForOperation(operationId);
  if (dialog) {
    dialog.setAttribute('data-state', 'open');
  }
  
  // Set a timeout to stop forcing open after a few seconds
  // This prevents permanently stuck dialogs
  setTimeout(() => {
    releaseDialog(operationId);
  }, 5000);
}

/**
 * Release a dialog from forced open state
 * 
 * @param operationId The operation ID
 */
export function releaseDialog(operationId: number) {
  if (!operationId) return;
  
  console.log(`[MobileDialogFix] Releasing dialog for operation ${operationId}`);
  openDialogStatus[operationId] = false;
}

/**
 * Find a dialog element for an operation
 * 
 * @param operationId The operation ID
 * @returns The dialog element or null
 */
function findDialogForOperation(operationId: number): HTMLElement | null {
  // Try by ID first
  let dialog = document.getElementById(`view-dialog-${operationId}`);
  
  // If not found, look for any open dialog
  if (!dialog) {
    dialog = document.querySelector('[data-state="open"][role="dialog"]');
  }
  
  return dialog;
}

/**
 * Extract operation ID from a dialog element
 * 
 * @param dialog The dialog element
 * @returns The operation ID or 0
 */
function extractOperationId(dialog: HTMLElement): number {
  if (!dialog) return 0;
  
  // Try to get from ID
  const idMatch = dialog.id.match(/view-dialog-(\d+)/);
  if (idMatch && idMatch[1]) {
    return parseInt(idMatch[1], 10);
  }
  
  // Try to extract from content
  const titleElement = dialog.querySelector('.dialog-title, [class*="DialogTitle"], h2');
  if (titleElement && titleElement.textContent) {
    const textMatch = titleElement.textContent.match(/(\d{5})/);
    if (textMatch && textMatch[1]) {
      return parseInt(textMatch[1], 10);
    }
  }
  
  return 0;
}

/**
 * Determine if a dialog should be kept open
 * 
 * @param operationId The operation ID
 * @returns True if the dialog should be kept open
 */
function shouldKeepDialogOpen(operationId: number): boolean {
  // In a real implementation, we might check if an operation is in progress
  return openDialogStatus[operationId] === true;
}