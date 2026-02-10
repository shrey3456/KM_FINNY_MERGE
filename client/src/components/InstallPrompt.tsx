import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const InstallPrompt = () => {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  
  useEffect(() => {
    // Store the install prompt event
    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
      setShowPrompt(true);
    };

    // Check if the app is already installed
    const isAppInstalled = window.matchMedia('(display-mode: standalone)').matches;
    if (!isAppInstalled) {
      window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    };
  }, []);

  const handleInstallClick = async () => {
    if (!installPrompt) return;
    
    // Show the installation prompt
    await installPrompt.prompt();
    
    // Wait for the user to respond to the prompt
    const choiceResult = await installPrompt.userChoice;
    
    if (choiceResult.outcome === 'accepted') {
      console.log('User accepted the install prompt');
    } else {
      console.log('User dismissed the install prompt');
    }
    
    // Reset the prompt state
    setInstallPrompt(null);
    setShowPrompt(false);
  };

  const dismissPrompt = () => {
    setShowPrompt(false);
  };

  if (!showPrompt) return null;

  return (
    <div className="fixed bottom-4 left-4 right-4 bg-white dark:bg-gray-800 p-4 rounded-lg shadow-lg z-50 border border-gray-200 dark:border-gray-700">
      <div className="flex items-start justify-between">
        <div className="flex items-center">
          <img src="/assets/icon-512-maskable.png" alt="Tribe Logo" className="w-10 h-10 mr-3" />
          <div>
            <p className="font-semibold text-gray-900 dark:text-white">Install Tribe App</p>
            <p className="text-sm text-gray-600 dark:text-gray-300">Add to your home screen for quick access</p>
          </div>
        </div>
        <button onClick={dismissPrompt} className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
          <X size={18} />
        </button>
      </div>
      <div className="mt-3 flex justify-end space-x-2">
        <Button
          onClick={handleInstallClick}
          variant="default"
          className="bg-[#001d6e] hover:bg-blue-800"
        >
          Install
        </Button>
      </div>
    </div>
  );
};

export default InstallPrompt;