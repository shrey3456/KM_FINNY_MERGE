import { useState } from 'react';
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

interface LoginProps {
  onLogin: () => void;
}

const Login = ({ onLogin }: LoginProps) => {
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  // Available users from your database with their actual PINs
  const users = [
    { 
      id: 1, 
      name: "Vraj", 
      username: "vraj@km-tribe", 
      role: "admin", 
      department: "MANAGEMENT",
      pin: "9999",
      description: "Full admin access to all modules"
    },
    { 
      id: 9, 
      name: "Yash Patel", 
      username: "yash@km-tribe", 
      role: "super-admin", 
      department: "IT",
      pin: "0000",
      description: "Super admin with complete system access"
    },
    { 
      id: 22, 
      name: "Test User", 
      username: "test@km-tribe", 
      role: "read", 
      department: "Testing",
      pin: "1234",
      description: "Read-only access for testing"
    },
    { 
      id: 3, 
      name: "Dharmesh", 
      username: "dharmesh@km-tribe", 
      role: "read/write", 
      department: "MANAGEMENT",
      pin: "5678",
      description: "Read/write access to operations"
    },
    { 
      id: 4, 
      name: "Yagnik Patel", 
      username: "yagnik@km-tribe", 
      role: "read/write", 
      department: "BILLING",
      pin: "2468",
      description: "Billing department access"
    }
  ];

  const handleUserLogin = async (user: any) => {
    setIsLoading(true);
    
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          username: "pin-login",
          password: user.pin
        })
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.message || 'Login failed');
      }
      
      toast({
        title: "Login successful",
        description: `Welcome back, ${user.name}`,
      });
      
      localStorage.setItem('currentUser', JSON.stringify({
        id: data.id,
        username: data.username,
        name: data.name,
        role: data.role,
        department: data.department
      }));
      
      localStorage.setItem('userId', data.id.toString());
      
      onLogin();
      
    } catch (error) {
      console.error('Login error:', error);
      toast({
        title: "Login failed",
        description: error instanceof Error ? error.message : "Authentication failed",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const getRoleColor = (role: string) => {
    switch (role) {
      case 'super-admin': return 'bg-red-50 text-red-700 border-red-200';
      case 'admin': return 'bg-blue-50 text-blue-700 border-blue-200';
      case 'read/write': return 'bg-green-50 text-green-700 border-green-200';
      case 'read': return 'bg-gray-50 text-gray-700 border-gray-200';
      default: return 'bg-gray-50 text-gray-700 border-gray-200';
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <div className="w-full max-w-lg py-8 flex flex-col items-center">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">KM Tribe</h1>
          <p className="text-gray-600">Manufacturing Operations System</p>
          <div className="w-16 h-1 bg-primary mx-auto mt-4 rounded"></div>
        </div>
        
        {/* User Selection */}
        <div className="w-full space-y-3">
          <h2 className="text-lg font-semibold text-center mb-4 text-gray-800">
            Select User Account
          </h2>
          
          {users.map((user) => (
            <Button
              key={user.id}
              onClick={() => handleUserLogin(user)}
              disabled={isLoading}
              variant="outline"
              className="w-full p-4 h-auto text-left hover:bg-white hover:shadow-md transition-all duration-200 bg-white/70 backdrop-blur-sm"
            >
              <div className="flex flex-col w-full">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-gray-900">{user.name}</span>
                  <span className={`px-2 py-1 rounded-full text-xs font-medium border ${getRoleColor(user.role)}`}>
                    {user.role.toUpperCase()}
                  </span>
                </div>
                <div className="text-sm text-gray-600 mb-1">
                  {user.department} • PIN: {user.pin}
                </div>
                <div className="text-xs text-gray-500">
                  {user.description}
                </div>
              </div>
            </Button>
          ))}
        </div>

        {/* Loading State */}
        {isLoading && (
          <div className="text-center mt-6">
            <div className="inline-flex items-center gap-2">
              <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
              <p className="text-sm text-gray-600">Authenticating...</p>
            </div>
          </div>
        )}

        {/* Quick Access Info */}
        <div className="mt-8 p-4 bg-white/50 backdrop-blur-sm rounded-lg border border-white/20">
          <h3 className="text-sm font-medium text-gray-800 mb-2">Quick Access Guide:</h3>
          <div className="text-xs text-gray-600 space-y-1">
            <div>• <strong>Admin/Super-Admin:</strong> Full system access</div>
            <div>• <strong>Read/Write:</strong> Create and edit operations</div>
            <div>• <strong>Read:</strong> View-only access</div>
          </div>
        </div>
        
        {/* Footer */}
        <div className="mt-6 text-center">
          <p className="text-xs text-gray-500">
            Manufacturing Operations Management System
          </p>
          <p className="text-xs text-gray-400 mt-1">
            व्रज पटेल द्वारा निर्मित
          </p>
        </div>
      </div>
    </div>
  );
};

export default Login;