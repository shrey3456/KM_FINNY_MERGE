import { createContext, ReactNode, useContext, useEffect } from "react";
import {
  useQuery,
  useMutation,
  UseMutationResult,
} from "@tanstack/react-query";
import { User as SelectUser } from "@shared/schema";
import { getQueryFn, apiRequest, queryClient } from "../lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";

// Mirrors the fields the rest of the app reads out of localStorage('currentUser')
// (permissions.ts, Sidebar.tsx) so page-access/write-access checks never run
// against a stale snapshot from whenever the user last typed their password.
function syncCurrentUserToLocalStorage(user: SelectUser) {
  localStorage.setItem('currentUser', JSON.stringify({
    userCode: user.userCode,
    username: user.username,
    name: user.name,
    role: user.role,
    department: user.department,
    designation: (user as any).designation ?? null,
    plants: (user as any).plants ?? '[]',
    allowedPages: (user as any).allowedPages ?? '[]',
    pageWriteAccess: (user as any).pageWriteAccess ?? '[]',
  }));
  localStorage.setItem('userCode', user.userCode || '');
}

type AuthContextType = {
  user: SelectUser | null;
  isLoading: boolean;
  error: Error | null;
  loginMutation: UseMutationResult<SelectUser, Error, LoginData>;
  logoutMutation: UseMutationResult<void, Error, void>;
};

type LoginData = {
  username: string;
  password: string;
};

export const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  
  const {
    data: user,
    error,
    isLoading,
  } = useQuery<SelectUser | null, Error>({
    queryKey: ["/api/user"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  // Keep localStorage('currentUser') in step with whatever /api/user last returned —
  // otherwise a write-access grant made while the user's tab is already open never
  // takes effect until they log out and back in (see hasPageWriteAccess in permissions.ts).
  useEffect(() => {
    if (user) syncCurrentUserToLocalStorage(user);
  }, [user]);

  const loginMutation = useMutation({
    mutationFn: async (credentials: LoginData) => {
      const res = await apiRequest("POST", "/api/login", credentials);
      return await res.json();
    },
    onSuccess: (user: SelectUser) => {
      queryClient.setQueryData(["/api/user"], user);
      syncCurrentUserToLocalStorage(user);

      toast({
        title: "Login successful",
        description: `Welcome back to KM Finny, ${user.name || user.username}`,
        variant: "success",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Login failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/logout");
    },
    onSuccess: () => {
      queryClient.setQueryData(["/api/user"], null);
      localStorage.removeItem('currentUser');
      localStorage.removeItem('km-user');
      localStorage.removeItem('userCode');
      localStorage.removeItem('userId');
      navigate('/');
      
      toast({
        title: "Logged out successfully",
        description: "You have been logged out of KM Finny",
        variant: "success",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Logout failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  return (
    <AuthContext.Provider
      value={{
        user: user ?? null,
        isLoading,
        error,
        loginMutation,
        logoutMutation,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}