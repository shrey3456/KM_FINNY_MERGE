import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Send, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface MessageComposerProps {
  message: string;
  setMessage: (message: string) => void;
  onSendMessage: () => void;
  onFileUpload?: (event: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  showFileUpload?: boolean;
}

export function MessageComposer({
  message,
  setMessage,
  onSendMessage,
  onFileUpload,
  placeholder = "iMessage",
  disabled = false,
  className = "",
  showFileUpload = true
}: MessageComposerProps) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSendMessage();
    }
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (onFileUpload) {
      onFileUpload(event);
    } else {
      // Default file upload handler if none provided
      const file = event.target.files?.[0];
      if (file) {
        toast({
          title: "File Upload",
          description: "File upload functionality will be implemented soon",
        });
      }
    }
  };

  return (
    <div className={`bg-transparent p-3 ${className}`}>
      <div className="flex items-end space-x-2 max-w-full">
        {showFileUpload && (
          <Button 
            variant="ghost"
            size="icon"
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex-shrink-0 text-gray-500 hover:text-gray-700 hover:bg-gray-100 mb-1"
            disabled={disabled}
          >
            <Plus className="h-5 w-5" />
          </Button>
        )}
        <input
          type="file"
          ref={fileInputRef}
          className="hidden"
          onChange={handleFileUpload}
        />
        <div className="flex-1 relative">
          <div className="flex items-end bg-transparent rounded-2xl border border-gray-200 px-4 py-2">
            <Input
              placeholder={placeholder}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={disabled}
              className="border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 p-0 text-sm resize-none min-h-[20px] placeholder:text-gray-500"
              data-testid="input-message"
            />
            {message.trim() && (
              <Button 
                type="button" 
                onClick={onSendMessage}
                disabled={!message.trim() || disabled}
                size="icon"
                className="ml-2 h-8 w-8 rounded-full bg-[#001d6e] hover:bg-[#001a5e] text-white flex-shrink-0"
                data-testid="button-send"
              >
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default MessageComposer;