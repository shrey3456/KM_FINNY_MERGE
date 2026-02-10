import { useState, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

interface DebugLoginProps {
  onLogin: () => void;
}

const DebugLogin = ({ onLogin }: DebugLoginProps) => {
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  // Add global error listener to catch the pattern validation error
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      console.log('Global error caught:', event.error, event.message, event.filename, event.lineno);
    };

    const handleInvalid = (event: Event) => {
      console.log('Invalid event caught:', event.target, event);
      event.preventDefault();
    };

    const handleSubmit = (event: Event) => {
      console.log('Form submit caught:', event.target, event);
    };

    // Listen for all possible validation errors
    window.addEventListener('error', handleError);
    document.addEventListener('invalid', handleInvalid, true);
    document.addEventListener('submit', handleSubmit, true);

    return () => {
      window.removeEventListener('error', handleError);
      document.removeEventListener('invalid', handleInvalid, true);
      document.removeEventListener('submit', handleSubmit, true);
    };
  }, []);

  const handleDirectLogin = async () => {
    console.log('Direct login clicked');
    setIsLoading(true);
    
    try {
      // Bypass authentication completely for debugging
      toast({
        title: "Debug Login",
        description: "Logging in as Test User",
      });
      
      localStorage.setItem('currentUser', JSON.stringify({
        id: 1,
        username: "debug@km-tribe",
        name: "Debug User",
        role: "admin",
        department: "TESTING"
      }));
      
      localStorage.setItem('userId', "1");
      
      console.log('About to call onLogin()');
      onLogin();
      console.log('onLogin() called successfully');
      
    } catch (error) {
      console.error('Debug login error:', error);
      toast({
        title: "Debug Error",
        description: String(error),
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-white p-4">
      <div className="w-full max-w-md py-8 flex flex-col items-center">
        <h1 className="text-2xl font-bold text-center mb-3">Debug Login</h1>
        <p className="text-center text-muted-foreground mb-6">
          Testing pattern validation error
        </p>
        
        <div className="w-full space-y-4">
          <Button
            onClick={handleDirectLogin}
            disabled={isLoading}
            className="w-full"
          >
            {isLoading ? 'Logging in...' : 'Direct Login (No Server Call)'}
          </Button>
          
          <div className="text-xs text-gray-500 space-y-1">
            <p>Check browser console for error details</p>
            <p>This bypasses all server authentication</p>
            <p>If error still occurs, it's from another component</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DebugLogin;