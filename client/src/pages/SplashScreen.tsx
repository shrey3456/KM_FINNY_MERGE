import { useEffect, useState } from 'react';
import finnyLogo from "@assets/finny-logo.png";

const SplashScreen = () => {
  const [fadeOut, setFadeOut] = useState(false);

  useEffect(() => {
    // Start fade out animation after 2 seconds
    const timer = setTimeout(() => {
      setFadeOut(true);
    }, 2000);

    return () => {
      clearTimeout(timer);
    };
  }, []);

  return (
    <div 
      className={`flex flex-col items-center justify-center min-h-screen bg-white transition-opacity duration-500 ${
        fadeOut ? 'opacity-0' : 'opacity-100'
      }`}
    >
      <div className="w-40 h-40 mb-8">
        <img 
          src={finnyLogo} 
          alt="KM Finny Logo" 
          className="w-full h-full object-contain transition-opacity duration-1000" 
        />
      </div>
      <div className="absolute bottom-6 text-gray-500 text-sm">
        © {new Date().getFullYear()} KM Finny
      </div>
    </div>
  );
};

export default SplashScreen;