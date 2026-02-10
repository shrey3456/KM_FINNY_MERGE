/**
 * Form state preservation utilities
 * Used to keep forms open during operations and prevent them from closing
 */
import { createElement, ComponentType } from 'react';

// Store a mapping of operation IDs to their open state
const openOperationForms: Record<number, boolean> = {};

/**
 * Ensure a dialog stays open during operations
 * Call this before performing operations that might cause dialogs to close
 * 
 * @param operationId The operation ID
 */
export function ensureDialogOpen(operationId: number) {
  if (!operationId) return;
  
  console.log(`[FormStatePreservation] Ensuring dialog stays open for operation ${operationId}`);
  openOperationForms[operationId] = true;
}

/**
 * Release the form lock for an operation
 * Call this after operations are complete
 * 
 * @param operationId The operation ID
 */
export function releaseDialogLock(operationId: number) {
  if (!operationId) return;
  
  console.log(`[FormStatePreservation] Releasing dialog lock for operation ${operationId}`);
  openOperationForms[operationId] = false;
}

/**
 * Check if a dialog should stay open
 * 
 * @param operationId The operation ID
 * @returns True if the dialog should stay open
 */
export function shouldKeepDialogOpen(operationId: number): boolean {
  return openOperationForms[operationId] === true;
}

/**
 * Apply dialog preservation to a form component
 * 
 * @param Component The form component to wrap
 * @param operationId The operation ID
 * @returns The wrapped component
 */
export function withDialogPreservation(Component: ComponentType<any>, operationId: number) {
  return function WrappedComponent(props: any) {
    // Mark this dialog as needing to stay open
    ensureDialogOpen(operationId);
    
    // Pass the flag to the component if it uses it
    const enhancedProps = {
      ...props,
      keepOpen: true,
      preventAutoClose: true,
    };
    
    return createElement(Component, enhancedProps);
  };
}