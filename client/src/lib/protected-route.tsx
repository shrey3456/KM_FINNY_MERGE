import { useAuth } from "@/hooks/use-auth";
import { Loader2 } from "lucide-react";
import { Redirect, Route } from "wouter";
import { getCurrentUserPermissions } from "./permissions";
import NotFound from "@/pages/not-found";

interface ProtectedRouteProps {
  path: string;
  component: () => React.JSX.Element;
  requireInventoryAccess?: boolean;
  requireAdmin?: boolean;
}

export function ProtectedRoute({
  path,
  component: Component,
  requireInventoryAccess = false,
  requireAdmin = false,
}: ProtectedRouteProps) {
  const { user, isLoading } = useAuth();

  return (
    <Route path={path}>
      {() => {
        if (isLoading) {
          return (
            <div className="flex items-center justify-center min-h-screen">
              <Loader2 className="h-8 w-8 animate-spin text-border" />
            </div>
          );
        }

        if (!user) {
          return <Redirect to="/auth" />;
        }
        
        // Check permissions based on requirements
        const userPermissions = getCurrentUserPermissions();
        
        if (requireAdmin && !userPermissions.canManageUsers) {
          return <NotFound />;
        }
        
        if (requireInventoryAccess && !userPermissions.canAccessInventory) {
          return <NotFound />;
        }

        return <Component />;
      }}
    </Route>
  );
}