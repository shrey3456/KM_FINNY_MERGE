import React, { useState, useEffect, useRef } from "react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage
} from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useUser } from "@/hooks/use-user";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";
import { Info, Bell, BellOff, MessageCircle, Plus } from "lucide-react";
import { useLocation } from "wouter";
import MessageComposer from "@/components/MessageComposer";

export function MessagesPage() {
  const { user } = useUser();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [location, navigate] = useLocation();
  const [message, setMessage] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [previousMessageCount, setPreviousMessageCount] = useState(0);
  const [lastMessageId, setLastMessageId] = useState<number | null>(null);

  // Fetch users for displaying user info
  const { data: users = [] } = useQuery({
    queryKey: ['/api/users'],
    queryFn: async () => {
      const response = await fetch('/api/users');
      if (!response.ok) {
        throw new Error('Failed to fetch users');
      }
      return response.json();
    },
    enabled: !!user,
  });

  // Fetch all group messages
  const { data: groupMessages = [], isLoading: messagesLoading } = useQuery({
    queryKey: ['/api/messages/conversation'],
    queryFn: async () => {
      const response = await fetch('/api/messages/conversation');
      if (!response.ok) {
        throw new Error('Failed to fetch group messages');
      }
      return response.json();
    },
    enabled: !!user?.id,
    refetchInterval: 5000, // Refetch every 5 seconds
  });

  // Send message mutation
  const sendMessageMutation = useMutation({
    mutationFn: async (messageData: any) => {
      const response = await fetch('/api/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(messageData),
      });
      
      if (!response.ok) {
        throw new Error('Failed to send message');
      }
      
      return response.json();
    },
    onSuccess: () => {
      // Clear the message input and refetch conversation
      setMessage("");
      queryClient.invalidateQueries({ queryKey: ['/api/messages/conversation'] });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: `Failed to send message: ${error}`,
        variant: "destructive",
      });
    },
  });

  // Request notification permission
  const requestNotificationPermission = async () => {
    if (!("Notification" in window)) {
      toast({
        title: "Notifications Not Supported",
        description: "This browser does not support desktop notifications",
        variant: "destructive",
      });
      return;
    }
    
    try {
      const permission = await Notification.requestPermission();
      setNotificationsEnabled(permission === "granted");
      
      if (permission === "granted") {
        toast({
          title: "Notifications Enabled",
          description: "You will now receive notifications for new messages",
        });
      } else {
        toast({
          title: "Notifications Disabled",
          description: "You will not receive notifications for new messages",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("Error requesting notification permission:", error);
    }
  };

  // Check notification permission on component mount
  useEffect(() => {
    if (!("Notification" in window)) return;
    
    // Check if permission is already granted
    if (Notification.permission === "granted") {
      setNotificationsEnabled(true);
    }
  }, []);

  // Check and trigger notifications for new messages
  useEffect(() => {
    if (!groupMessages || !notificationsEnabled || !user) return;
    
    // Only notify if we have messages and the count has increased
    if (groupMessages.length > 0 && 
        groupMessages.length > previousMessageCount && 
        previousMessageCount > 0) {
      
      // Get the latest message
      const latestMessage = groupMessages[groupMessages.length - 1];
      
      // Only notify if it's not from the current user and it's a new message
      if (latestMessage.senderCode !== user.userCode && 
          (!lastMessageId || latestMessage.id !== lastMessageId)) {
        
        const sender = findUserByCode(latestMessage.senderCode);
        const senderName = sender?.name || sender?.username || "Unknown User";
        
        // Create and show notification
        try {
          const notification = new Notification("Team Chat", {
            body: `${senderName}: ${latestMessage.content.substring(0, 60)}${latestMessage.content.length > 60 ? '...' : ''}`,
            icon: "/favicon.ico",
          });
          
          // Close notification after 5 seconds
          setTimeout(() => notification.close(), 5000);
          
          // Store the last notified message ID
          setLastMessageId(latestMessage.id);
        } catch (error) {
          console.error("Error showing notification:", error);
        }
      }
    }
    
    // Update previous count
    setPreviousMessageCount(groupMessages.length);
  }, [groupMessages, notificationsEnabled, user, previousMessageCount, lastMessageId]);

  // Auto-scroll to bottom of messages
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [groupMessages]);

  // Find user by userCode or username helper function
  const findUserByCode = (userCode: string) => {
    return users.find((u: any) => u.userCode === userCode || u.username === userCode) || null;
  };

  // Handle send message
  const handleSendMessage = () => {
    // Use userCode if available, otherwise fall back to username
    const senderCode = user?.userCode || user?.username;
    
    if (!message.trim() || !senderCode) {
      return;
    }
    
    const messageContent = message.trim();
    
    // Clear message immediately for better UX
    setMessage('');
    
    // Creating a message to all users (group message)
    sendMessageMutation.mutate({
      senderCode: senderCode,
      recipientCode: null, // null indicates group message
      content: messageContent,
      isRead: false,
      broadcastToAll: true
    }, {
      onError: (error) => {
        console.error('Send message error:', error);
        // Restore message on error
        setMessage(messageContent);
      }
    });
  };

  // Handle file upload
  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    
    // Implementation will be added later for file uploads
    toast({
      title: "File Upload",
      description: "File upload functionality will be implemented soon",
    });
  };


  // Handle notifications toggle
  const handleNotificationsToggle = () => {
    if (notificationsEnabled) {
      toast({
        title: "Notifications",
        description: "Notifications are currently enabled. To disable, please go to your browser settings.",
      });
    } else {
      requestNotificationPermission();
    }
  };

  return (
    <div className="h-dvh flex flex-col bg-white relative">
      {/* iMessage-style Header */}
      <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-3">
            <div>
              <h1 className="text-lg font-semibold text-gray-900">Team Chat</h1>
              <p className="text-xs text-gray-500">{users.length} members</p>
            </div>
            <div className="flex -space-x-2">
              {users.slice(0, 3).map((user: any, index: number) => (
                <Avatar key={user.id} className="h-8 w-8 border-2 border-white">
                  <AvatarFallback className="bg-gray-300 text-gray-700 text-xs">
                    {user.name?.charAt(0) || user.username?.charAt(0) || 'U'}
                  </AvatarFallback>
                </Avatar>
              ))}
              {users.length > 3 && (
                <div className="h-8 w-8 bg-gray-200 border-2 border-white rounded-full flex items-center justify-center">
                  <span className="text-xs text-gray-600">+{users.length - 3}</span>
                </div>
              )}
            </div>
          </div>
        </div>
        <Button 
          variant="ghost" 
          className="p-2 shrink-0 text-[#001d6e] hover:bg-transparent hover:text-[#001d6e] active:bg-transparent"
          onClick={handleNotificationsToggle}
          data-testid="button-notifications"
          title={notificationsEnabled ? "Notifications enabled" : "Enable notifications"}
        >
          {notificationsEnabled ? (
            <Bell style={{ width: '22px', height: '22px' }} className="fill-[#001d6e]" />
          ) : (
            <BellOff style={{ width: '22px', height: '22px' }} />
          )}
        </Button>
      </div>
        
      {/* Messages area - iMessage style */}
      <div className="flex-1 overflow-y-auto px-4 py-2 pb-[176px] bg-white">
        {messagesLoading ? (
          <div className="flex justify-center py-8">
            <div className="flex space-x-1">
              <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
              <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
              <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
            </div>
          </div>
        ) : groupMessages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-20">
            <h3 className="text-lg font-medium text-gray-900 mb-2">No messages yet</h3>
            <p className="text-gray-500 text-sm">Send a message to start the conversation</p>
          </div>
        ) : (
          <div className="space-y-1">
            {groupMessages.map((msg: any, index: number) => {
              const isSender = msg.senderCode === user?.userCode;
              const sender = findUserByCode(msg.senderCode);
              const isLastFromSender = index === groupMessages.length - 1 || 
                groupMessages[index + 1]?.senderCode !== msg.senderCode;
              const isFirstFromSender = index === 0 || 
                groupMessages[index - 1]?.senderCode !== msg.senderCode;
              
              return (
                <div 
                  key={msg.id} 
                  className={`flex ${isSender ? 'justify-end' : 'justify-start'} px-2 mb-1`}
                >
                  <div className={`flex items-end max-w-[75%] ${isSender ? 'flex-row-reverse' : 'flex-row'}`}>
                    {!isSender && isLastFromSender && (
                      <Avatar className="h-6 w-6 mr-2 mb-1 flex-shrink-0">
                        <AvatarFallback className="bg-gray-300 text-gray-700 text-xs">
                          {sender?.name?.charAt(0) || sender?.username?.charAt(0) || 'U'}
                        </AvatarFallback>
                      </Avatar>
                    )}
                    
                    <div className={`flex flex-col ${isSender ? 'items-end' : 'items-start'}`}>
                      {isFirstFromSender && !isSender && (
                        <span className="text-xs text-gray-500 mb-1 px-3">
                          {sender?.name || sender?.username || 'Unknown User'}
                        </span>
                      )}
                      
                      <div 
                        className={`px-4 py-2 max-w-xs lg:max-w-md ${
                          isSender 
                            ? `bg-[#001d6e] text-white ${
                                isLastFromSender ? 'rounded-2xl rounded-br-lg' : 'rounded-2xl'
                              }`
                            : `bg-[#bfdbfe] text-black ${
                                isLastFromSender ? 'rounded-2xl rounded-bl-lg' : 'rounded-2xl'
                              }`
                        }`}
                      >
                        <p className="text-sm leading-relaxed break-words">{msg.content}</p>
                      </div>
                      
                      {isLastFromSender && (
                        <div className={`text-xs text-gray-500 mt-1 px-1 ${isSender ? 'text-right' : 'text-left'}`}>
                          {msg.createdAt 
                            ? format(parseISO(msg.createdAt), 'h:mm a')
                            : 'now'
                          }
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
        
      {/* Message Composer at bottom - within page, above footer */}
      <div 
        className="absolute bottom-0 left-0 right-0 z-20 border border-[#001d6e] bg-white shadow-lg rounded-3xl mx-2" 
        style={{ 
          marginBottom: "96px", // Space for footer navigation + extra margin
          paddingBottom: "max(env(safe-area-inset-bottom), 0px)",
          minHeight: "auto"
        }}
      >
        <MessageComposer
          message={message}
          setMessage={setMessage}
          onSendMessage={handleSendMessage}
          onFileUpload={handleFileUpload}
          placeholder="Type a message..."
          disabled={sendMessageMutation.isPending}
          className="border-0"
        />
      </div>
    </div>
  );
}

export default MessagesPage;