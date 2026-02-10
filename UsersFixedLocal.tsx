import { useQuery, useMutation } from '@tanstack/react-query';
import { apiRequest, queryClient } from '@/lib/queryClient';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Plus, Search, Edit, Trash, Loader2, Users as UsersIcon, Check, X } from 'lucide-react';
import { useState } from 'react';
import { User, InsertUser } from '@shared/schema';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogClose
} from "@/components/ui/dialog";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useToast } from "@/hooks/use-toast";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";


// Form schema for user creation/editing
const userFormSchema = z.object({
  username: z.string().min(3, "Username must be at least 3 characters")
    .transform(val => val.includes('@km-tribe') ? val : `${val}@km-tribe`),
  pin: z.string().length(4, "PIN must be exactly 4 digits").regex(/^\d{4}$/, "PIN must contain only numbers"),
  name: z.string().optional(),
  role: z.enum(["admin", "super-admin", "read/write", "read"]).default("read"),
  department: z.string().optional(),
  designation: z.string().optional(),
});

type UserFormValues = z.infer<typeof userFormSchema>;

const Users = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<Partial<User> | null>(null);
  const { toast } = useToast();

  // Fetch users
  const { data: users = [], isLoading } = useQuery({
    queryKey: ['/api/users']
  });

  // Create user mutation
  const createUserMutation = useMutation({
    mutationFn: (data: UserFormValues) =>
      apiRequest('POST', '/api/users', data),
    onSuccess: () => {
      toast({
        title: "Success",
        description: "User created successfully",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/users'] });
      
      // Reset form values
      addUserForm.reset({
        username: "",
        pin: "",
        name: "",
        role: "read",
        department: "",
        designation: ""
      });
      
      setIsAddDialogOpen(false);
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: `Failed to create user: ${error.message}`,
        variant: "destructive",
      });
    }
  });

  // Update user mutation
  const updateUserMutation = useMutation({
    mutationFn: ({ id, data }: { id: number, data: Partial<UserFormValues> }) =>
      apiRequest('PUT', `/api/users/${id}`, data),
    onSuccess: () => {
      toast({
        title: "Success",
        description: "User updated successfully",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/users'] });
      setIsEditDialogOpen(false);
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: `Failed to update user: ${error.message}`,
        variant: "destructive",
      });
    }
  });

  // Delete user mutation
  const deleteUserMutation = useMutation({
    mutationFn: (id: number) =>
      apiRequest('DELETE', `/api/users/${id}`),
    onSuccess: () => {
      toast({
        title: "Success",
        description: "User deleted successfully",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/users'] });
      setIsDeleteDialogOpen(false);
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: `Failed to delete user: ${error.message}`,
        variant: "destructive",
      });
    }
  });

  // Filter users based on search term
  const filteredUsers = searchTerm && Array.isArray(users)
    ? users.filter((user: User) =>
        user.username.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (user.name && user.name.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (user.role && user.role.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (user.designation && user.designation.toLowerCase().includes(searchTerm.toLowerCase()))
      )
    : Array.isArray(users) ? users : [];

  // User role check
  const isAdmin = true; // In a real app, this would be derived from the current user's role

  // Form for adding a new user
  const addUserForm = useForm<UserFormValues>({
    resolver: zodResolver(userFormSchema),
    defaultValues: {
      username: "",
      pin: "",
      name: "",
      role: "read",
      department: "",
      designation: ""
    }
  });

  // Form for editing an existing user
  const editUserForm = useForm<Partial<UserFormValues>>({
    resolver: zodResolver(userFormSchema.partial()),
    defaultValues: {
      username: "",
      name: "",
      role: "read",
      department: "",
      designation: ""
    }
  });

  // Handle adding a new user
  const handleAddUser = (data: UserFormValues) => {
    createUserMutation.mutate(data);
  };
  
  // Handle dialog close for add user dialog
  const handleAddDialogClose = (open: boolean) => {
    if (!open) {
      // Clear form when dialog is closed
      addUserForm.reset({
        username: "",
        pin: "",
        name: "",
        role: "read",
        department: "",
        designation: ""
      });
    }
    setIsAddDialogOpen(open);
  };

  // Handle editing an existing user
  const handleEditUser = (data: Partial<UserFormValues>) => {
    if (currentUser && currentUser.id) {
      // Don't send empty PIN
      if (data.pin === "") {
        delete data.pin;
      }
      updateUserMutation.mutate({ id: currentUser.id, data });
    }
  };

  // Handle deleting a user
  const handleDeleteUser = () => {
    if (currentUser && currentUser.id) {
      deleteUserMutation.mutate(currentUser.id);
    }
  };

  // Open edit dialog and set current user
  const openEditDialog = (user: User) => {
    setCurrentUser(user);
    editUserForm.reset({
      username: user.username,
      name: user.name || "",
      role: (user.role as any) || "read",
      department: user.department || "",
      designation: user.designation || ""
    });
    setIsEditDialogOpen(true);
  };

  // Open delete dialog and set current user
  const openDeleteDialog = (user: User) => {
    setCurrentUser(user);
    setIsDeleteDialogOpen(true);
  };

  // States for departments
  const [departments, setDepartments] = useState<string[]>([
    "MANAGEMENT", "IT", "BILLING", "SALES", "DISPATCH {VALSAD}", "DISPATCH {INDORE}", "DISPATCH {LUCKNOW}", "ACCOUNTS", "STEER", "M&S"
  ]);
  const [customDepartment, setCustomDepartment] = useState("");
  const [isAddingDepartment, setIsAddingDepartment] = useState(false);

  // States for designations
  const [designations, setDesignations] = useState<string[]>([
    "DIRECTOR", "MANAGER", "ASST. MANAGER", "HEAD", "ASSISTANT", "STAFF", 
    "HELPER", "SUPERVISOR", "STOREKEEPER", "LOADER", "DRIVER"
  ]);
  const [customDesignation, setCustomDesignation] = useState("");
  const [isAddingDesignation, setIsAddingDesignation] = useState(false);

  // Add a new department
  const addNewDepartment = () => {
    if (customDepartment.trim() !== "" && !departments.includes(customDepartment.trim())) {
      setDepartments([...departments, customDepartment.trim()]);
      setCustomDepartment("");
      setIsAddingDepartment(false);
    }
  };
  
  // Add a new designation
  const addNewDesignation = () => {
    if (customDesignation.trim() !== "" && !designations.includes(customDesignation.trim())) {
      setDesignations([...designations, customDesignation.trim()]);
      setCustomDesignation("");
      setIsAddingDesignation(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 lg:p-6">
      <div className="max-w-6xl mx-auto">
        <div className="mb-6">
          <h2 className="text-2xl font-bold">Users</h2>
          <p className="text-gray-600">Manage user accounts and permissions</p>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
              <CardTitle>User Management</CardTitle>
              <div className="flex gap-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-500" />
                  <Input
                    type="search"
                    placeholder="Search users..."
                    className="pl-8 w-full sm:w-[250px]"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                </div>
                <Button
                  className="flex items-center gap-1"
                  onClick={() => setIsAddDialogOpen(true)}
                  disabled={!isAdmin}
                >
                  <Plus className="h-4 w-4" />
                  <span>Add User</span>
                </Button>
              </div>
            </div>
          </CardHeader>

          <CardContent>
            <div className="overflow-x-auto mt-4">
              {isLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-8 w-8 animate-spin text-primary" />
                </div>
              ) : filteredUsers.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  {searchTerm ? "No users found matching your search." : "No users have been added yet."}
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[100px]">User</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Username</TableHead>
                      <TableHead>Designation</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredUsers.map((user: User) => (
                      <TableRow key={user.id}>
                        <TableCell>
                          <Avatar>
                            <AvatarFallback className="bg-primary/10 text-primary">
                              {(user.name || user.username).substring(0, 2).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                        </TableCell>
                        <TableCell className="font-medium">{user.name || "-"}</TableCell>
                        <TableCell>{user.username}</TableCell>
                        <TableCell>{user.designation || "-"}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={
                            user.role === "admin"
                              ? "bg-blue-50 text-blue-700 border-blue-200"
                              : "bg-green-50 text-green-700 border-green-200"
                          }>
                            {user.role || "User"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => openEditDialog(user)}
                            >
                              <Edit className="h-4 w-4" />
                              <span className="sr-only">Edit</span>
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => openDeleteDialog(user)}
                            >
                              <Trash className="h-4 w-4" />
                              <span className="sr-only">Delete</span>
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Add User Dialog */}
        <Dialog open={isAddDialogOpen} onOpenChange={handleAddDialogClose}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Add New User</DialogTitle>
              <DialogDescription>
                Create a new user account with appropriate permissions.
              </DialogDescription>
            </DialogHeader>
            <Form {...addUserForm}>
              <form onSubmit={addUserForm.handleSubmit(handleAddUser)} className="space-y-4 py-2">
                <FormField
                  control={addUserForm.control}
                  name="username"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Username</FormLabel>
                      <FormControl>
                        <Input placeholder="johndoe" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={addUserForm.control}
                  name="pin"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>PIN (4 digits)</FormLabel>
                      <FormControl>
                        <Input type="text" placeholder="1234" maxLength={4} inputMode="numeric" {...field} />
                      </FormControl>
                      <FormDescription>
                        4-digit PIN code for authentication
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={addUserForm.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Display Name</FormLabel>
                      <FormControl>
                        <Input placeholder="John Doe" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={addUserForm.control}
                    name="role"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Role</FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          defaultValue={field.value}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select role" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="admin">Admin</SelectItem>
                            <SelectItem value="super-admin">Super Admin</SelectItem>
                            <SelectItem value="read/write">Read/Write</SelectItem>
                            <SelectItem value="read">Read Only</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={addUserForm.control}
                    name="department"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Department</FormLabel>
                        {isAddingDepartment ? (
                          <div className="flex gap-2">
                            <FormControl>
                              <Input 
                                placeholder="New department name" 
                                value={customDepartment}
                                onChange={(e) => setCustomDepartment(e.target.value)}
                                className="flex-1"
                              />
                            </FormControl>
                            <Button 
                              type="button" 
                              size="icon" 
                              onClick={addNewDepartment}
                              disabled={!customDepartment.trim()}
                            >
                              <Check className="h-4 w-4" />
                            </Button>
                            <Button 
                              type="button" 
                              size="icon" 
                              variant="ghost" 
                              onClick={() => {
                                setIsAddingDepartment(false);
                                setCustomDepartment("");
                              }}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        ) : (
                          <div className="flex gap-2">
                            <Select
                              onValueChange={field.onChange}
                              value={field.value || undefined}
                            >
                              <FormControl>
                                <SelectTrigger className="flex-1">
                                  <SelectValue placeholder="Select department" />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {departments.map((dept) => (
                                  <SelectItem key={dept} value={dept}>
                                    {dept}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Button 
                              type="button" 
                              size="icon" 
                              variant="outline" 
                              onClick={() => setIsAddingDepartment(true)}
                            >
                              <Plus className="h-4 w-4" />
                            </Button>
                          </div>
                        )}
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                
                {/* Designation field */}
                <FormField
                  control={addUserForm.control}
                  name="designation"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Designation</FormLabel>
                      {isAddingDesignation ? (
                        <div className="flex gap-2">
                          <FormControl>
                            <Input 
                              placeholder="New designation" 
                              value={customDesignation}
                              onChange={(e) => setCustomDesignation(e.target.value)}
                              className="flex-1"
                            />
                          </FormControl>
                          <Button 
                            type="button" 
                            size="icon" 
                            onClick={addNewDesignation}
                            disabled={!customDesignation.trim()}
                          >
                            <Check className="h-4 w-4" />
                          </Button>
                          <Button 
                            type="button" 
                            size="icon" 
                            variant="ghost" 
                            onClick={() => {
                              setIsAddingDesignation(false);
                              setCustomDesignation("");
                            }}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <Select
                            onValueChange={field.onChange}
                            value={field.value || undefined}
                          >
                            <FormControl>
                              <SelectTrigger className="flex-1">
                                <SelectValue placeholder="Select designation" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {designations.map((designation) => (
                                <SelectItem key={designation} value={designation}>
                                  {designation}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Button 
                            type="button" 
                            size="icon" 
                            variant="outline" 
                            onClick={() => setIsAddingDesignation(true)}
                          >
                            <Plus className="h-4 w-4" />
                          </Button>
                        </div>
                      )}
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <DialogFooter>
                  <DialogClose asChild>
                    <Button type="button" variant="outline">
                      Cancel
                    </Button>
                  </DialogClose>
                  <Button 
                    type="submit" 
                    disabled={createUserMutation.isPending}
                  >
                    {createUserMutation.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Creating...
                      </>
                    ) : (
                      'Create User'
                    )}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>

        {/* Edit User Dialog */}
        <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Edit User</DialogTitle>
              <DialogDescription>
                Update user information and permissions.
              </DialogDescription>
            </DialogHeader>
            <Form {...editUserForm}>
              <form onSubmit={editUserForm.handleSubmit(handleEditUser)} className="space-y-4 py-2">
                <FormField
                  control={editUserForm.control}
                  name="username"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Username</FormLabel>
                      <FormControl>
                        <Input placeholder="johndoe" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editUserForm.control}
                  name="pin"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>PIN (4 digits)</FormLabel>
                      <FormControl>
                        <Input
                          type="text"
                          placeholder="Leave blank to keep current PIN"
                          maxLength={4}
                          inputMode="numeric"
                          {...field}
                          value={field.value || ''}
                        />
                      </FormControl>
                      <FormDescription>
                        Leave blank to keep the current PIN. Must be exactly 4 digits.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editUserForm.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Display Name</FormLabel>
                      <FormControl>
                        <Input placeholder="John Doe" {...field} value={field.value || ''} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={editUserForm.control}
                    name="role"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Role</FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          value={field.value || undefined}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select role" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="admin">Admin</SelectItem>
                            <SelectItem value="super-admin">Super Admin</SelectItem>
                            <SelectItem value="read/write">Read/Write</SelectItem>
                            <SelectItem value="read">Read Only</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={editUserForm.control}
                    name="department"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Department</FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          value={field.value || undefined}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select department" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {departments.map((dept) => (
                              <SelectItem key={dept} value={dept}>
                                {dept}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                
                <FormField
                  control={editUserForm.control}
                  name="designation"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Designation</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value || undefined}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select designation" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {designations.map((designation) => (
                            <SelectItem key={designation} value={designation}>
                              {designation}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <DialogFooter>
                  <DialogClose asChild>
                    <Button type="button" variant="outline">
                      Cancel
                    </Button>
                  </DialogClose>
                  <Button 
                    type="submit"
                    disabled={updateUserMutation.isPending}
                  >
                    {updateUserMutation.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Updating...
                      </>
                    ) : (
                      'Update User'
                    )}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>

        {/* Delete User Dialog */}
        <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete User</DialogTitle>
              <DialogDescription>
                Are you sure you want to delete this user? This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            {currentUser && (
              <div className="py-4">
                <div className="flex items-center gap-3 p-3 bg-gray-50 rounded">
                  <Avatar>
                    <AvatarFallback>
                      {(currentUser.name || currentUser.username || '').substring(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-medium">{currentUser.name || currentUser.username}</p>
                    <p className="text-sm text-gray-600">{currentUser.username}</p>
                  </div>
                </div>
              </div>
            )}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button 
                variant="destructive" 
                onClick={handleDeleteUser}
                disabled={deleteUserMutation.isPending}
              >
                {deleteUserMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Deleting...
                  </>
                ) : (
                  'Delete User'
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
};

export default Users;