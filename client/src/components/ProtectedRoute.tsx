import React from 'react';
import { Route } from 'wouter';
import { getCurrentUserPermissions } from '../lib/permissions';
import { useAuth } from '../hooks/use-auth';
import NotFound from '@/pages/not-found';

interface ProtectedRouteProps {
  path: string;
  component: React.ComponentType<any>;
  requireInventoryAccess?: boolean;
  requireAdmin?: boolean;
  requireOrderManagement?: boolean;
  requiredPage?: string;
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  path,
  component: Component,
  requireInventoryAccess = false,
  requireAdmin = false,
  requireOrderManagement = false,
  requiredPage,
}) => {
  const userPermissions = getCurrentUserPermissions();
  const { user, isLoading } = useAuth();

  return (
    <Route path={path}>
      {(params) => {
        // While session user is loading, don't block access yet
        if (isLoading) return null;

        if (requireAdmin && !userPermissions.canManageUsers) {
          return <NotFound />;
        }

        if (requireInventoryAccess && !userPermissions.canAccessInventory) {
          return <NotFound />;
        }

        if (requireOrderManagement && !userPermissions.canAccessOrderManagement) {
          return <NotFound />;
        }

        // Page-based access control for non-admin users
        if (requiredPage) {
          const role = (user as any)?.role ?? '';
          const isAdmin = role === 'admin' || role === 'super-admin';
          if (!isAdmin) {
            let allowedPages: string[] = [];
            try {
              allowedPages = JSON.parse((user as any)?.allowedPages || '[]');
            } catch {
              allowedPages = [];
            }
            if (!allowedPages.includes(requiredPage)) {
              return <NotFound />;
            }
          }
        }

        return <Component {...params} />;
      }}
    </Route>
  );
};

export default ProtectedRoute;
