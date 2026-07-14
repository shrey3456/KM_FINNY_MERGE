import { useState, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import finnyLogo from "@assets/finny-logo.png";
import { Delete } from "lucide-react";

interface LoginProps {
  onLogin: () => void;
}

const Login = ({ onLogin }: LoginProps) => {
  const [pin, setPin] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isIOSPWA, setIsIOSPWA] = useState(false);
  const { toast } = useToast();
  
  // Detect iOS PWA mode on component mount
  useEffect(() => {
    // Check if running as PWA on iOS
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !('MSStream' in window);
    const isInStandaloneMode = window.matchMedia('(display-mode: standalone)').matches || 
                              (window.navigator as any).standalone || 
                              document.referrer.includes('ios-app://');
    
    setIsIOSPWA(isIOS && isInStandaloneMode);
    
    // Add specific viewport meta tags for iOS PWA mode to help with keyboard issues
    if (isIOS && isInStandaloneMode) {
      // Create or update the viewport meta tag for better iOS PWA keyboard support
      let viewportMeta = document.querySelector('meta[name="viewport"]');
      if (!viewportMeta) {
        viewportMeta = document.createElement('meta');
        viewportMeta.setAttribute('name', 'viewport');
        document.head.appendChild(viewportMeta);
      }
      
      // Set specific iOS viewport settings that help with keyboard issues
      viewportMeta.setAttribute('content', 
        'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
    }
  }, []);

  const handleDigitClick = (digit: string) => {
    if (pin.length < 4) {
      setPin(prev => prev + digit);
    }
  };

  const handleBackspace = () => {
    setPin(prev => prev.slice(0, -1));
  };

  const handleLogin = async (e?: React.FormEvent) => {
    if (e) {
      e.preventDefault();
    }
    
    // Make sure PIN is valid
    if (pin.length !== 4) {
      toast({
        title: "Invalid PIN",
        description: "Please enter a 4-digit PIN",
        variant: "destructive",
      });
      return;
    }
    
    setIsLoading(true);
    
    // For iOS PWA mode, ensure any active input is blurred to hide keyboard
    if (isIOSPWA) {
      // Blur active element to hide keyboard if on iOS PWA mode
      const activeElement = document.activeElement as HTMLElement;
      if (activeElement && activeElement.blur) {
        activeElement.blur();
      }
    }

    try {
      // Use the server-side login endpoint with PIN-only authentication
      // We need to provide both username and password for Passport.js
      const requestBody = JSON.stringify({ 
        username: "pin-login", // Dummy username, our auth.ts will prioritize PIN
        password: pin // The pin is used as the password
      });
      
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: requestBody,
        credentials: 'same-origin'
      });
      console.log("Login Response:",response);
      console.log("Response Data",response.json);
      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = 'Login failed';
        try {
          const errorData = JSON.parse(errorText);
          errorMessage = errorData.message || errorMessage;
        } catch {
          errorMessage = errorText || errorMessage;
        }
        throw new Error(errorMessage);
      }
      
      const data = await response.json();
      
      toast({
        title: "Login successful",
        description: `Welcome back, ${data.username}`,
      });
      
      // Store the logged-in user info in localStorage
      localStorage.setItem('currentUser', JSON.stringify({
        id: data.id,
        userCode: data.userCode,
        username: data.username,
        name: data.name,
        role: data.role,
        department: data.department
      }));
      
      localStorage.setItem('userCode', data.userCode || '');
      
      // Add a slight delay before redirecting on iOS PWA for better UX
      if (isIOSPWA) {
        setTimeout(() => {
          onLogin();
        }, 100);
      } else {
        onLogin();
      }
    } catch (error) {
      console.error('Login error:', error);
      toast({
        title: "Login failed",
        description: error instanceof Error ? error.message : "Invalid PIN",
        variant: "destructive",
      });
      // Reset PIN on failure
      setPin("");
    } finally {
      setIsLoading(false);
    }
  };

  // Watch for PIN completion to auto-submit
  useEffect(() => {
    if (pin.length === 4) {
      handleLogin();
    }
  }, [pin]);

  // Physical keyboard support — listens on window instead of relying on a hidden,
  // auto-focused <input>. That hidden input used to sit on top of the PIN screen
  // to catch typing, but on touch devices it could pop the native on-screen
  // keyboard and shift the layout mid-tap, occasionally swallowing taps on the
  // number pad. A window listener gets keyboard support without an input to steal
  // focus or trigger a virtual keyboard.
  useEffect(() => {
    const handleWindowKeyDown = (e: KeyboardEvent) => {
      if (isLoading) return;
      if (e.key >= '0' && e.key <= '9') {
        e.preventDefault();
        handleDigitClick(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        handleBackspace();
      }
    };
    window.addEventListener('keydown', handleWindowKeyDown);
    return () => window.removeEventListener('keydown', handleWindowKeyDown);
  }, [isLoading, pin]);

  return (
    <div className={`min-h-screen flex flex-col items-center justify-center bg-white p-4 ${
      isIOSPWA ? 'ios-pwa-login-container' : ''
    }`}>
      {/* iOS specific styling */}
      {isIOSPWA && (
        <style dangerouslySetInnerHTML={{ 
          __html: [
            '.ios-pwa-login-container {',
            '  position: absolute;',
            '  top: 0;',
            '  left: 0;',
            '  right: 0;',
            '  bottom: 0;',
            '  padding-top: env(safe-area-inset-top);',
            '  padding-bottom: env(safe-area-inset-bottom);',
            '  padding-left: env(safe-area-inset-left);',
            '  padding-right: env(safe-area-inset-right);',
            '  overflow-y: auto;',
            '  transform: translateZ(0);',
            '  -webkit-transform: translateZ(0);',
            '}',
            '@supports (padding-top: env(safe-area-inset-top)) {',
            '  .ios-pwa-login-container {',
            '    padding-top: 20px;',
            '    padding-top: env(safe-area-inset-top);',
            '  }',
            '}'
          ].join('\n')
        }} />
      )}
      
      <div className="w-full max-w-md py-8 flex flex-col items-center">
        {/* Logo */}
        <div className="w-28 h-28 mb-8">
          <img 
            src={finnyLogo} 
            alt="KM Finny Logo" 
            className="w-full h-full object-contain" 
          />
        </div>
        
        {/* Title */}
        <h1 className="text-2xl font-bold text-center mb-3">Welcome</h1>
        <p className="text-center text-muted-foreground mb-6">
          Enter your 4-digit PIN
        </p>
        
        {/* PIN Input Form */}
        <div className="w-full space-y-8">
          {/* PIN Display */}
          <div className="flex justify-center mb-6">
            <div className="flex gap-4">
              {Array.from({ length: 4 }).map((_, index) => (
                <div 
                  key={index} 
                  className={`w-14 h-14 rounded-full flex items-center justify-center border-2 transition-all duration-200 ${
                    index < pin.length 
                      ? 'border-primary bg-primary/10 shadow-inner scale-105' 
                      : 'border-gray-300'
                  }`}
                >
                  {index < pin.length && (
                    <div 
                      className="w-6 h-6 rounded-full bg-primary animate-in fade-in zoom-in duration-200"
                    ></div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Number Pad */}
          <div className="grid grid-cols-3 gap-4 mx-auto w-[240px]">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(num => (
              <Button
                key={num}
                type="button"
                variant="outline"
                className="h-[65px] w-[65px] text-2xl font-medium rounded-full shadow-sm
                border-2 border-primary hover:bg-primary/10 hover:text-primary active:scale-95
                transition-all duration-150 touch-manipulation select-none"
                onClick={() => handleDigitClick(num.toString())}
                disabled={isLoading || pin.length >= 4}
              >
                {num}
              </Button>
            ))}
            <div></div> {/* Empty div for alignment */}
            <Button
              type="button"
              variant="outline"
              className="h-[65px] w-[65px] text-2xl font-medium rounded-full shadow-sm
              border-2 border-primary hover:bg-primary/10 hover:text-primary active:scale-95
              transition-all duration-150 touch-manipulation select-none"
              onClick={() => handleDigitClick("0")}
              disabled={isLoading || pin.length >= 4}
            >
              0
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-[65px] w-[65px] flex items-center justify-center rounded-full
              border-2 border-primary hover:bg-primary/10 hover:text-primary active:scale-95 transition-all duration-150 touch-manipulation select-none"
              onClick={handleBackspace}
              disabled={isLoading || pin.length === 0}
            >
              <Delete className="h-6 w-6" />
            </Button>
          </div>

          {isLoading && (
            <div className="text-center">
              <p className="text-sm text-muted-foreground animate-pulse">Authenticating...</p>
            </div>
          )}
        </div>
        
        {/* Footer */}
        <div className="mt-8 text-center">
          <p className="text-sm text-gray-500 mt-2">
            Created by
          </p>
          <p className="text-sm text-gray-500 font-semibold">
            व्रज पटेल
          </p>
        </div>
      </div>
    </div>
  );
};

export default Login;