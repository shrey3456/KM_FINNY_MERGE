/**
 * Safe Toast Utility
 * 
 * This utility creates a toast function that preserves dialog state and form state
 * during toast notifications, preventing UI disruption.
 */

import { useToast } from "@/hooks/use-toast";
import { useCallback } from "react";
import { useDialogPreservation } from './dialogPreservation';
import { ensureDialogOpen } from './formStatePreservation';
import { keepDialogOpen } from './mobileDialogFix';

interface ToastProps {
  title: string;
  description?: string;
  variant?: "default" | "destructive";
}

/**
 * Use this hook to create a toast function that preserves dialog state
 * @param operationId Optional ID of the current operation to preserve dialogs for
 * @param preservationTime How long to keep dialogs open after toast in milliseconds
 */
export function useSafeToast(operationId?: number | null) {
  const { toast: originalToast } = useToast();
  const { preserveDialog } = useDialogPreservation();
  
  // Create a safe toast function that preserves dialog state
  const safeToast = useCallback((props: ToastProps) => {
    // If we have a selected operation, ensure the dialog stays open
    if (operationId) {
      preserveDialog(operationId, 3000);
      
      // Legacy dialog preservation (for backward compatibility)
      ensureDialogOpen(operationId);
      keepDialogOpen(operationId);
    }
    
    // Show the toast notification with correct type
    originalToast({
      title: props.title,
      description: props.description,
      variant: props.variant || "default",
    });
  }, [originalToast, operationId, preserveDialog]);
  
  return { toast: safeToast, safeToast };
}