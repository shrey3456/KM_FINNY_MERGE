import React from 'react';
import { Route, useLocation } from 'wouter';
import { getCurrentUserPermissions } from '../lib/permissions';
import NotFound from '@/pages/not-found';

interface ProtectedRouteProps {
  path: string;
  component: React.ComponentType<any>;
  requireInventoryAccess?: boolean;
  requireAdmin?: boolean;
}

/**
 * A route wrapper that checks user permissions before rendering the component
 */
const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  path,
  component: Component,
  requireInventoryAccess = false,
  requireAdmin = false,
}) => {
  const [, navigate] = useLocation();
  
  // Get current user permissions
  const userPermissions = getCurrentUserPermissions();
  
  return (
    <Route
      path={path}
      component={(props) => {
        // Check admin access
        if (requireAdmin && !userPermissions.canManageUsers) {
          return <NotFound />;
        }
        
        // Check inventory access
        if (requireInventoryAccess && !userPermissions.canAccessInventory) {
          return <NotFound />;
        }
        
        // All checks passed, render the component
        return <Component {...props} />;
      }}
    />
  );
};

export default ProtectedRoute;