import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { QrCode, X, User as UserIcon, Mail, Phone, Home as HomeIcon, Edit, Hash, Upload } from 'lucide-react';
import { User } from '@shared/schema';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';
import { useRef } from 'react';
import QRCode from 'qrcode';
import finnyLogo from '@assets/finny-logo.png';
import { PageSkeleton } from "@/components/ui/loading-skeletons";

const Profile = () => {
  // Get the current user code from local storage (if available)
  const userCode = localStorage.getItem('userCode');
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Profile image upload mutation
  const uploadImageMutation = useMutation({
    mutationFn: async (imageBase64: string) => {
      if (!userCode) throw new Error('No user code');
      const response = await apiRequest('PATCH', `/api/users/${userCode}/profile-image`, { imageBase64 }, false, true);
      return response;
    },
    onSuccess: (updatedUser) => {
      queryClient.invalidateQueries({ queryKey: ['/api/users', userCode] });
      // Also update the cache directly to show immediate results
      queryClient.setQueryData(['/api/users', userCode], updatedUser);
      toast({ title: 'Profile image updated successfully', duration: 3000 });
      setImagePreview(null);
      setIsUploading(false);
    },
    onError: (error: any) => {
      console.error('Upload error:', error);
      toast({ 
        title: 'Upload failed', 
        description: error.message || 'Failed to upload image',
        variant: 'destructive',
        duration: 5000 
      });
      setIsUploading(false);
    },
  });

  // Handle file selection
  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      toast({ 
        title: 'Invalid file type', 
        description: 'Please select an image file',
        variant: 'destructive' 
      });
      return;
    }

    // Validate file size (1MB limit for better compression)
    if (file.size > 1 * 1024 * 1024) {
      toast({ 
        title: 'File too large', 
        description: 'Please select an image smaller than 1MB',
        variant: 'destructive' 
      });
      return;
    }

    // Create preview
    const previewUrl = URL.createObjectURL(file);
    setImagePreview(previewUrl);

    // Compress and convert to base64
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();
    
    img.onload = () => {
      // Set max dimensions while maintaining aspect ratio
      const maxSize = 400;
      let { width, height } = img;
      
      if (width > height) {
        if (width > maxSize) {
          height *= maxSize / width;
          width = maxSize;
        }
      } else {
        if (height > maxSize) {
          width *= maxSize / height;
          height = maxSize;
        }
      }
      
      canvas.width = width;
      canvas.height = height;
      
      // Draw and compress image
      ctx?.drawImage(img, 0, 0, width, height);
      
      // Convert to base64 with compression (0.8 quality)
      const compressedBase64 = canvas.toDataURL('image/jpeg', 0.8);
      
      setIsUploading(true);
      uploadImageMutation.mutate(compressedBase64);
    };
    
    img.src = previewUrl;
  };

  // Handle upload button click
  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  // Fetch user details
  const { data: user, isLoading, error } = useQuery({
    queryKey: ['/api/users', userCode],
    queryFn: () => fetch(`/api/users/${userCode}`).then(res => res.json()),
    enabled: !!userCode, // Only run the query if we have a userCode
  });

  // Generate QR code with circular dots when user data is available
  useEffect(() => {
    if (user && (user as any).userCode) {
      // Create canvas for custom QR code with circles
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      
      if (!ctx) {
        console.error('Failed to get canvas context');
        return;
      }

      try {
        // Create QR code with proper module structure
        const qr = QRCode.create((user as any).userCode, { errorCorrectionLevel: 'Q' });
        const moduleCount = qr.modules.size;
        const quietZone = 2;
        const moduleSize = Math.max(35, Math.floor(800 / (moduleCount + quietZone * 2)));
        const canvasSize = (moduleCount + quietZone * 2) * moduleSize;
        
        // Create canvas for styled QR code
        const styledCanvas = document.createElement('canvas');
        const styledCtx = styledCanvas.getContext('2d');
        
        if (!styledCtx) {
          throw new Error('Could not get canvas context');
        }
        
        styledCanvas.width = canvasSize;
        styledCanvas.height = canvasSize;
        
        // Disable image smoothing for crisp edges
        styledCtx.imageSmoothingEnabled = false;
        
        // Fill background with white
        styledCtx.fillStyle = '#FFFFFF';
        styledCtx.fillRect(0, 0, canvasSize, canvasSize);
        styledCtx.fillStyle = '#000000'; // Black color
        
        // Function to check if module is in finder pattern or timing pattern
        const isFinderOrTiming = (row: number, col: number) => {
          // Finder patterns: top-left, top-right, bottom-left (7x7 each)
          if ((row < 7 && col < 7) || // top-left
              (row < 7 && col >= moduleCount - 7) || // top-right
              (row >= moduleCount - 7 && col < 7)) { // bottom-left
            return true;
          }
          // Timing patterns: row 6 and column 6 (excluding finder areas)
          if ((row === 6 && (col < 7 || col >= moduleCount - 7)) ||
              (col === 6 && (row < 7 || row >= moduleCount - 7))) {
            return true;
          }
          return false;
        };
        
        // Draw each module
        for (let row = 0; row < moduleCount; row++) {
          for (let col = 0; col < moduleCount; col++) {
            if (qr.modules.get(row, col)) {
              const x = (col + quietZone) * moduleSize;
              const y = (row + quietZone) * moduleSize;
              
              if (isFinderOrTiming(row, col)) {
                // Keep finder and timing patterns as solid squares for detection
                styledCtx.fillRect(x, y, moduleSize, moduleSize);
              } else {
                // Style data modules with capsule shapes
                const capsuleWidth = moduleSize * 0.85;
                const capsuleHeight = moduleSize * 0.85;
                const borderRadius = moduleSize * 0.3;
                
                const centerX = x + moduleSize / 2;
                const centerY = y + moduleSize / 2;
                const rectX = centerX - capsuleWidth / 2;
                const rectY = centerY - capsuleHeight / 2;
                
                styledCtx.beginPath();
                styledCtx.roundRect(rectX, rectY, capsuleWidth, capsuleHeight, borderRadius);
                styledCtx.fill();
              }
            }
          }
        }
        
        // Add logo overlay in the center
        const logoImg = new Image();
        logoImg.onload = () => {
          const logoSize = canvasSize * 0.20; // Logo is 20% of QR code size
          const logoX = (canvasSize - logoSize) / 2;
          const logoY = (canvasSize - logoSize) / 2;
          
          // Create a white background circle for the logo
          styledCtx.fillStyle = '#FFFFFF';
          styledCtx.beginPath();
          styledCtx.arc(canvasSize / 2, canvasSize / 2, logoSize / 2 + 8, 0, 2 * Math.PI);
          styledCtx.fill();
          
          // Draw the logo
          styledCtx.drawImage(logoImg, logoX, logoY, logoSize, logoSize);
          
          setQrCodeUrl(styledCanvas.toDataURL());
        };
        logoImg.onerror = () => {
          // If logo fails to load, just set QR without logo
          setQrCodeUrl(styledCanvas.toDataURL());
        };
        logoImg.src = finnyLogo;
      } catch (err) {
        console.error('Error generating QR code:', err);
        // Fallback to regular QR code
        QRCode.toDataURL((user as any).userCode, {
          width: 800,
          margin: 0,
          color: {
            dark: '#000000',
            light: '#FFFFFF'
          }
        })
        .then(url => {
          setQrCodeUrl(url);
        })
        .catch(fallbackErr => {
          console.error('Fallback QR code generation failed:', fallbackErr);
        });
      }
    }
  }, [user]);

  if (isLoading) {
    return (
      <div className="p-6 flex justify-center items-center min-h-[50vh]">
        <PageSkeleton />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="pt-6">
            <div className="text-red-500">Error loading profile information</div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="pt-6">
            <div className="text-muted-foreground">No profile information available</div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="lg:p-6 p-0 space-y-4 lg:space-y-6 pb-20 lg:pb-6 bg-gray-50 lg:bg-white min-h-screen lg:min-h-0 -mx-4 sm:-mx-6 px-0">
      
      {/* Desktop Header */}
      <h1 className="text-2xl font-bold hidden lg:block">User Profile</h1>
      
      {/* Profile Avatar Section */}
      <div className="lg:hidden bg-gray-50 px-4 py-8 text-center">
        <div className="relative inline-block">
          <Avatar className="h-24 w-24 mx-auto border-4 border-white shadow-lg">
            {(user as any).profileImage && (
              <AvatarImage 
                src={(user as any).profileImage} 
                alt="Profile" 
                className="object-cover"
              />
            )}
            <AvatarFallback className="text-2xl font-medium bg-gray-100 text-gray-700">
              {user?.name ? user.name.substring(0, 2).toUpperCase() : (user?.username ? user.username.substring(0, 2).toUpperCase() : 'U')}
            </AvatarFallback>
          </Avatar>
          <button 
            onClick={handleUploadClick}
            disabled={isUploading}
            className="absolute -bottom-1 -right-1 w-8 h-8 bg-white rounded-full shadow-md border border-gray-200 flex items-center justify-center hover:bg-gray-50 disabled:opacity-50"
            data-testid="button-upload-profile-image"
          >
            {isUploading ? (
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary" />
            ) : (
              <Upload size={16} className="text-gray-600" />
            )}
          </button>
        </div>
        <p className="text-sm text-gray-600 mt-3 font-medium">{user.name || user.username}</p>
        {(user as any).designation && (
          <div className="mt-2">
            <span className="inline-block px-3 py-1 bg-blue-50 text-primary border border-primary/30 rounded-full text-xs font-medium">
              {(user as any).designation}
            </span>
          </div>
        )}
      </div>
      
      {/* Desktop Layout */}
      <Card className="hidden lg:block">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-4">
            <Avatar className="h-16 w-16 border border-muted">
              {(user as any).profileImage && (
                <AvatarImage 
                  src={(user as any).profileImage} 
                  alt="Profile" 
                  className="object-cover"
                />
              )}
              <AvatarFallback className="text-lg font-medium">
                {user?.name ? user.name.substring(0, 2).toUpperCase() : (user?.username ? user.username.substring(0, 2).toUpperCase() : 'U')}
              </AvatarFallback>
            </Avatar>
            <div>
              <h2 className="text-xl">{user.name || 'User'}</h2>
              {(user as any).designation && (
                <div className="mt-2">
                  <span className="inline-block px-3 py-1 bg-blue-50 text-primary border border-primary/30 rounded-full text-xs font-medium">
                    {(user as any).designation}
                  </span>
                </div>
              )}
            </div>
          </CardTitle>
        </CardHeader>
      </Card>
      
      {/* Desktop Personal Info Section */}
      <div className="hidden lg:block bg-white rounded-2xl shadow-sm">
        <div className="p-4">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-gray-900">Personall info</h2>
          </div>
          
          <div className="space-y-4">
            <div className="flex items-center space-x-3">
              <div className="w-5 h-5 text-gray-400">
                <Hash size={20} />
              </div>
              <div>
                <p className="text-sm text-gray-500">User code</p>
                <p className="text-base text-gray-900 font-medium">{(user as any).userCode || 'Not specified'}</p>
              </div>
            </div>
            
            <div className="flex items-center space-x-3">
              <div className="w-5 h-5 text-gray-400">
                <HomeIcon size={20} />
              </div>
              <div>
                <p className="text-sm text-gray-500">Department</p>
                <p className="text-base text-gray-900 font-medium">{user.department || 'Not specified'}</p>
              </div>
            </div>
            
            <div className="flex items-center space-x-3">
              <div className="w-5 h-5 text-gray-400">
                <Mail size={20} />
              </div>
              <div>
                <p className="text-sm text-gray-500">E-mail</p>
                <p className="text-base text-gray-900 font-medium">{user.username}</p>
              </div>
            </div>
            
            <div className="flex items-center space-x-3">
              <div className="w-5 h-5 text-gray-400">
                <Phone size={20} />
              </div>
              <div>
                <p className="text-sm text-gray-500">Phone number</p>
                <p className="text-base text-gray-900 font-medium">{(user as any).phone || 'Not specified'}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
      
      {/* Desktop Digital ID Section */}
      <div className="hidden lg:block">
        <div className="flex justify-center">
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button 
                className="flex items-center gap-2 bg-primary text-white hover:bg-primary/90 px-8 py-3 rounded-2xl" 
                data-testid="button-show-digital-id"
                disabled={!(user as any).userCode}
              >
                <QrCode size={16} />
                Digital ID
              </Button>
            </DialogTrigger>
            <DialogContent className="lg:sm:max-w-sm lg:w-full lg:max-w-[320px] w-full h-full lg:h-auto p-0 bg-gradient-to-b from-gray-800 via-gray-900 to-black border-0 overflow-hidden" hideCloseButton={true}>
              <div className="relative min-h-[650px] lg:min-h-[650px] h-full lg:h-auto flex flex-col items-center justify-center">
                {/* ID Card */}
                <div className="relative bg-white rounded-t-2xl p-10 mx-6 shadow-2xl" style={{
                  borderBottomLeftRadius: '1rem',
                  borderBottomRightRadius: '1rem',
                  clipPath: 'polygon(0% 0%, 100% 0%, 100% 100%, 72% 100%, 68% 95%, 32% 95%, 28% 100%, 0% 100%)'
                }}>
                  <div className="text-center mb-3">
                    <div className="w-24 h-3 bg-black rounded-full mx-auto"></div>
                  </div>
                  
                  {qrCodeUrl ? (
                    <div className="relative bg-white rounded-lg mb-4">
                      <img 
                        src={qrCodeUrl} 
                        alt="Digital ID QR Code" 
                        className="w-72 h-72 mx-auto aspect-square object-contain rounded-2xl"
                        data-testid="qr-code-image"
                      />
                      
                      {/* User info below QR code */}
                      <div className="text-center mt-1 space-y-1">
                        <div className="text-lg font-semibold text-gray-800" data-testid="qr-username">
                          {user.name || user.username}
                        </div>
                        {user.department && (
                          <div className="text-sm text-gray-600" data-testid="qr-department">
                            ({user.department})
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="w-72 h-72 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                      <div className="text-gray-500">Loading QR Code...</div>
                    </div>
                  )}
                  
                  {/* Decorative dots */}
                  <div className="flex justify-center space-x-2">
                    <div className="w-2 h-2 rounded-full" style={{backgroundColor: '#001d6e'}}></div>
                    <div className="w-2 h-2 rounded-full" style={{backgroundColor: '#4d7eff'}}></div>
                    <div className="w-2 h-2 rounded-full" style={{backgroundColor: '#8766e3'}}></div>
                    <div className="w-2 h-2 rounded-full" style={{backgroundColor: '#eab308'}}></div>
                    <div className="w-2 h-2 rounded-full" style={{backgroundColor: '#ea580c'}}></div>
                    <div className="w-2 h-2 rounded-full" style={{backgroundColor: '#4d7eff'}}></div>
                    <div className="w-2 h-2 rounded-full" style={{backgroundColor: '#001d6e'}}></div>
                  </div>
                </div>

                {/* Close button */}
                <button
                  onClick={() => setIsDialogOpen(false)}
                  className="mt-8 w-12 h-12 bg-white rounded-full flex items-center justify-center shadow-lg hover:bg-gray-50 transition-colors"
                  data-testid="button-close-digital-id"
                >
                  <X size={20} className="text-gray-600" />
                </button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>
      
      {/* Mobile Personal Info Section */}
      <div className="lg:hidden bg-white mx-4 rounded-2xl shadow-sm">
        <div className="p-4">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-gray-900">Personal info</h2>
          </div>
          
          <div className="space-y-4">
            <div className="flex items-center space-x-3">
              <div className="w-5 h-5 text-gray-400">
                <Hash size={20} />
              </div>
              <div>
                <p className="text-sm text-gray-500">User code</p>
                <p className="text-base text-gray-900 font-medium">{(user as any).userCode || 'Not specified'}</p>
              </div>
            </div>
            
            <div className="flex items-center space-x-3">
              <div className="w-5 h-5 text-gray-400">
                <HomeIcon size={20} />
              </div>
              <div>
                <p className="text-sm text-gray-500">Department</p>
                <p className="text-base text-gray-900 font-medium">{user.department || 'Not specified'}</p>
              </div>
            </div>
            
            <div className="flex items-center space-x-3">
              <div className="w-5 h-5 text-gray-400">
                <Mail size={20} />
              </div>
              <div>
                <p className="text-sm text-gray-500">E-mail</p>
                <p className="text-base text-gray-900 font-medium">{user.username}</p>
              </div>
            </div>
            
            <div className="flex items-center space-x-3">
              <div className="w-5 h-5 text-gray-400">
                <Phone size={20} />
              </div>
              <div>
                <p className="text-sm text-gray-500">Phone number</p>
                <p className="text-base text-gray-900 font-medium">{(user as any).phone || 'Not specified'}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
      
      {/* Mobile Digital ID Button - Separate from card */}
      <div className="lg:hidden px-4 mt-8 flex justify-center">
        <Button 
          className="flex items-center gap-2 bg-primary text-white hover:bg-primary/90 px-12 py-2.5 rounded-full" 
          data-testid="button-show-digital-id-mobile"
          disabled={!(user as any).userCode}
          onClick={() => setIsDialogOpen(true)}
        >
          <QrCode size={16} />
          Digital ID
        </Button>
      </div>
      
      {/* Hidden file input for profile image upload */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileSelect}
        className="hidden"
        data-testid="input-profile-image"
      />
    </div>
  );
};

export default Profile;