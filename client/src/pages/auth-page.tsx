import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import finnyLogo from "@assets/finny-logo.png";
import ganpatiImage from "@assets/ganpati.png";
import { Loader2 } from "lucide-react";

const loginSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "PIN is required")
});

const registerSchema = z.object({
  username: z.string().min(3, "Username must be at least 3 characters"),
  password: z.string().min(4, "PIN must be at least 4 characters"),
  name: z.string().min(1, "Name is required"),
  department: z.string().optional(),
  role: z.string().optional()
});

type LoginFormValues = z.infer<typeof loginSchema>;
type RegisterFormValues = z.infer<typeof registerSchema>;

export default function AuthPage() {
  const [activeTab, setActiveTab] = useState<string>("login");
  const { user, loginMutation, isLoading } = useAuth();
  const [, navigate] = useLocation();
  
  const loginForm = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      username: "",
      password: ""
    }
  });
  
  const registerForm = useForm<RegisterFormValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      username: "",
      password: "",
      name: "",
      department: "",
      role: "read"
    }
  });
  
  // Redirect to dashboard if already logged in
  useEffect(() => {
    if (user) {
      navigate("/");
    }
  }, [user, navigate]);
  
  // Handle login form submission
  function onLoginSubmit(data: LoginFormValues) {
    loginMutation.mutate(data);
  }
  
  // Handle register form submission
  function onRegisterSubmit(data: RegisterFormValues) {
    // Currently using loginMutation since we don't have separate registration
    // When implementing full registration, use registerMutation from useAuth
    loginMutation.mutate({
      username: data.username,
      password: data.password
    });
  }
  
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }
  
  return (
    <div className="min-h-screen flex flex-col md:flex-row">
      {/* Login Form Column */}
      <div className="flex-1 p-6 md:p-10 flex flex-col justify-center">
        <div className="mx-auto max-w-md space-y-6 w-full">
          <div className="flex flex-col items-center space-y-2 mb-6">
            <img 
              src={finnyLogo} 
              alt="KM Finny Logo" 
              className="h-20 w-20 object-contain"
            />
            <h1 className="text-3xl font-bold">Welcome to KM Finny</h1>
            <p className="text-gray-500">
              Log in to access the operations management system
            </p>
          </div>
          
          <Tabs defaultValue="login" value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="grid w-full grid-cols-2 mb-6">
              <TabsTrigger value="login">Login</TabsTrigger>
              <TabsTrigger value="register">Register</TabsTrigger>
            </TabsList>
            
            <TabsContent value="login">
              <Form {...loginForm}>
                <form onSubmit={loginForm.handleSubmit(onLoginSubmit)} className="space-y-4">
                  <FormField
                    control={loginForm.control}
                    name="username"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Username</FormLabel>
                        <FormControl>
                          <Input placeholder="Enter your username" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <FormField
                    control={loginForm.control}
                    name="password"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>PIN</FormLabel>
                        <FormControl>
                          <Input 
                            type="password" 
                            placeholder="Enter your PIN" 
                            {...field} 
                            maxLength={4}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <Button 
                    type="submit" 
                    className="w-full" 
                    disabled={loginMutation.isPending}
                  >
                    {loginMutation.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Logging in...
                      </>
                    ) : 
                      "Log in"
                    }
                  </Button>
                </form>
              </Form>
            </TabsContent>
            
            <TabsContent value="register">
              <Form {...registerForm}>
                <form onSubmit={registerForm.handleSubmit(onRegisterSubmit)} className="space-y-4">
                  <FormField
                    control={registerForm.control}
                    name="username"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Username</FormLabel>
                        <FormControl>
                          <Input placeholder="Create a username" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <FormField
                    control={registerForm.control}
                    name="password"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>PIN</FormLabel>
                        <FormControl>
                          <Input 
                            type="password" 
                            placeholder="Create a 4-digit PIN" 
                            {...field} 
                            maxLength={4}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <FormField
                    control={registerForm.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Full Name</FormLabel>
                        <FormControl>
                          <Input placeholder="Enter your full name" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <FormField
                    control={registerForm.control}
                    name="department"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Department</FormLabel>
                        <FormControl>
                          <Input placeholder="Your department (optional)" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <Button 
                    type="submit" 
                    className="w-full" 
                    disabled={loginMutation.isPending}
                  >
                    {loginMutation.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Creating account...
                      </>
                    ) : 
                      "Create Account"
                    }
                  </Button>
                </form>
              </Form>
            </TabsContent>
          </Tabs>
        </div>
      </div>
      
      {/* Hero Column - Hidden on mobile, shown on md and above */}
      <div className="hidden md:flex flex-1 bg-gradient-to-r from-primary-700 to-primary-900 flex-col justify-center items-center p-10 text-white">
        <div className="max-w-md">
          <img 
            src={ganpatiImage}
            alt="Ganpati Illustration" 
            className="w-full max-w-[300px] mb-8"
          />
          
          <h2 className="text-4xl font-bold mb-4">
            Operations Management System
          </h2>
          
          <p className="text-lg mb-6">
            Manage your entire manufacturing process with our comprehensive system. Control loading operations, product inventory, and proforma slips all in one place.
          </p>
          
          <div className="space-y-4">
            <div className="flex items-start">
              <div className="w-8 h-8 rounded-full bg-white text-primary flex items-center justify-center mr-4 font-bold">1</div>
              <p>Track loading operations in real-time with status updates</p>
            </div>
            <div className="flex items-start">
              <div className="w-8 h-8 rounded-full bg-white text-primary flex items-center justify-center mr-4 font-bold">2</div>
              <p>Manage product inventory with barcode scanning</p>
            </div>
            <div className="flex items-start">
              <div className="w-8 h-8 rounded-full bg-white text-primary flex items-center justify-center mr-4 font-bold">3</div>
              <p>Generate and track proforma slips for accurate documentation</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}