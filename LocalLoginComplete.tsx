import { useState, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

interface LoginProps {
  onLogin: () => void;
}

const Login = ({ onLogin }: LoginProps) => {
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  // Clear any existing authentication on component mount
  useEffect(() => {
    // Force clear localStorage to ensure clean state
    localStorage.removeItem('currentUser');
    localStorage.removeItem('userId');
  }, []);

  // Real users from your database
  const users = [
    { 
      id: 1, 
      name: "Vraj", 
      username: "vraj@km-tribe", 
      role: "admin", 
      department: "MANAGEMENT",
      pin: "9999",
      description: "Complete admin access"
    },
    { 
      id: 9, 
      name: "Yash Patel", 
      username: "yash@km-tribe", 
      role: "super-admin", 
      department: "IT",
      pin: "0000",
      description: "Super admin privileges"
    },
    { 
      id: 22, 
      name: "Test User", 
      username: "test@km-tribe", 
      role: "read", 
      department: "Testing",
      pin: "1234",
      description: "Read-only access"
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
        description: `Welcome ${user.name}`,
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

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-white p-4">
      <div className="w-full max-w-md py-8 flex flex-col items-center">
        <h1 className="text-2xl font-bold text-center mb-3">KM Tribe Login</h1>
        <p className="text-center text-muted-foreground mb-6">
          Select user account
        </p>
        
        <div className="w-full space-y-3">
          {users.map((user) => (
            <Button
              key={user.id}
              onClick={() => handleUserLogin(user)}
              disabled={isLoading}
              variant="outline"
              className="w-full p-4 h-auto text-left"
            >
              <div className="flex flex-col w-full">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-medium">{user.name}</span>
                  <span className="text-xs bg-gray-100 px-2 py-1 rounded">
                    {user.role}
                  </span>
                </div>
                <div className="text-sm text-gray-600">
                  PIN: {user.pin} • {user.description}
                </div>
              </div>
            </Button>
          ))}
        </div>

        {isLoading && (
          <div className="text-center mt-4">
            <p className="text-sm text-muted-foreground">Authenticating...</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default Login;