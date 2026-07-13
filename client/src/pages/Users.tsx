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
import { Plus, Search, Edit, Trash, Loader2, Users as UsersIcon, Check, X, ChevronsUpDown } from 'lucide-react';
import { useState } from 'react';
import { User } from '@shared/schema';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { CONTROLLABLE_PAGES } from "@shared/pageKeys";

// Form schema
const userFormSchema = z.object({
  userCode: z.string().optional(),
  username: z.string().min(3, "Username must be at least 3 characters")
    .transform(val => val.includes('@km-finny') ? val : `${val}@km-finny`),
  pin: z.string().length(4, "PIN must be exactly 4 digits").regex(/^\d{4}$/, "PIN must contain only numbers"),
  name: z.string().optional(),
  role: z.enum(["admin", "super-admin", "read/write", "read"]).default("read"),
  department: z.string().optional(),
  designation: z.string().optional(),
  plants: z.array(z.string()).default([]),
  allowedPages: z.array(z.string()).default([]),
  pageWriteAccess: z.array(z.string()).default([]),
});

type UserFormValues = z.infer<typeof userFormSchema>;

// Helper: parse JSON array field from user object
function parseJsonArray(val: string | null | undefined): string[] {
  try { return JSON.parse(val || "[]"); } catch { return []; }
}

// Multi-select popover for plants and pages
function MultiSelectField({
  label,
  options,
  selected,
  onChange,
  disabled,
  disabledNote,
}: {
  label: string;
  options: { key: string; label: string }[];
  selected: string[];
  onChange: (val: string[]) => void;
  disabled?: boolean;
  disabledNote?: string;
}) {
  const toggle = (key: string) => {
    if (selected.includes(key)) {
      onChange(selected.filter(k => k !== key));
    } else {
      onChange([...selected, key]);
    }
  };

  if (disabled) {
    return (
      <p className="text-sm text-muted-foreground italic">{disabledNote}</p>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="w-full justify-between font-normal h-auto min-h-9 py-1.5">
          <span className="text-left flex-1 flex flex-wrap gap-1">
            {selected.length === 0 ? (
              <span className="text-muted-foreground">Select {label}...</span>
            ) : (
              selected.map(k => {
                const opt = options.find(o => o.key === k);
                return (
                  <Badge key={k} variant="secondary" className="text-xs font-normal">
                    {opt?.label ?? k}
                  </Badge>
                );
              })
            )}
          </span>
          <ChevronsUpDown className="h-4 w-4 ml-2 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" style={{ maxHeight: "none" }}>
        <div
          className="overflow-y-auto overscroll-contain"
          style={{ maxHeight: "260px" }}
          onWheel={(e) => e.stopPropagation()}
          onTouchMove={(e) => e.stopPropagation()}
        >
          <div className="p-2">
            {options.map(opt => (
              <div
                key={opt.key}
                className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted cursor-pointer"
                onClick={() => toggle(opt.key)}
              >
                <Checkbox
                  checked={selected.includes(opt.key)}
                  onCheckedChange={() => toggle(opt.key)}
                />
                <span className="text-sm">{opt.label}</span>
              </div>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

const Users = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<Partial<User> | null>(null);
  const { toast } = useToast();

  // Fetch users
  const { data: users = [], isLoading } = useQuery({
    queryKey: ['/api/users'],
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/users?_t=${Date.now()}`);
      return res.json();
    }
  });

  // Fetch plants for multi-select
  const { data: plantsList = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ['/api/plants'],
    queryFn: async () => {
      const res = await apiRequest('GET', '/api/plants');
      return res.json();
    }
  });
  const plantOptions = plantsList.map((p: { id: number; name: string }) => ({ key: p.name, label: p.name }));

  // Create user mutation
  const createUserMutation = useMutation({
    mutationFn: (data: UserFormValues) => {
      const payload = {
        ...data,
        plants: JSON.stringify(data.plants),
        allowedPages: JSON.stringify(data.allowedPages),
        pageWriteAccess: JSON.stringify(data.pageWriteAccess),
      };
      return apiRequest('POST', '/api/users', payload);
    },
    onSuccess: () => {
      toast({ title: "Success", description: "User created successfully" });
      queryClient.invalidateQueries({ queryKey: ['/api/users'] });
      addUserForm.reset({
        userCode: "", username: "", pin: "", name: "",
        role: "read", department: "", designation: "",
        plants: [], allowedPages: [], pageWriteAccess: [],
      });
      setIsAddDialogOpen(false);
    },
    onError: (error) => {
      toast({ title: "Error", description: `Failed to create user: ${error.message}`, variant: "destructive" });
    }
  });

  // Update user mutation
  const updateUserMutation = useMutation({
    mutationFn: ({ userCode, data }: { userCode: string; data: Partial<UserFormValues> }) => {
      const payload = {
        ...data,
        plants: JSON.stringify(data.plants ?? []),
        allowedPages: JSON.stringify(data.allowedPages ?? []),
        pageWriteAccess: JSON.stringify(data.pageWriteAccess ?? []),
      };
      return apiRequest('PUT', `/api/users/${userCode}`, payload);
    },
    onSuccess: () => {
      toast({ title: "Success", description: "User updated successfully" });
      queryClient.invalidateQueries({ queryKey: ['/api/users'] });
      setIsEditDialogOpen(false);
    },
    onError: (error) => {
      toast({ title: "Error", description: `Failed to update user: ${error.message}`, variant: "destructive" });
    }
  });

  // Delete user mutation
  const deleteUserMutation = useMutation({
    mutationFn: (userCode: string) => apiRequest('DELETE', `/api/users/${userCode}`),
    onSuccess: (_, userCode) => {
      queryClient.setQueriesData({ queryKey: ['/api/users'] }, (oldData: any) => {
        if (!Array.isArray(oldData)) return oldData;
        return oldData.filter((user: User) => user.userCode !== userCode);
      });
      toast({ title: "Success", description: "User deleted successfully" });
      setIsDeleteDialogOpen(false);
    },
    onError: (error) => {
      toast({ title: "Error", description: `Failed to delete user: ${error.message}`, variant: "destructive" });
    }
  });

  const filteredUsers = searchTerm && Array.isArray(users)
    ? users.filter((user: User) =>
        user.username.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (user.name && user.name.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (user.role && user.role.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (user.designation && user.designation.toLowerCase().includes(searchTerm.toLowerCase()))
      )
    : Array.isArray(users) ? users : [];

  const isAdmin = true;

  // Form for adding a new user
  const addUserForm = useForm<UserFormValues>({
    resolver: zodResolver(userFormSchema),
    defaultValues: {
      userCode: "", username: "", pin: "", name: "",
      role: "read", department: "", designation: "",
      plants: [], allowedPages: [], pageWriteAccess: [],
    }
  });

  // Form for editing an existing user
  const editUserForm = useForm<Partial<UserFormValues>>({
    resolver: zodResolver(userFormSchema.partial()),
    defaultValues: {
      userCode: "", username: "", name: "",
      role: "read", department: "", designation: "",
      plants: [], allowedPages: [], pageWriteAccess: [],
    }
  });

  const handleAddUser = (data: UserFormValues) => {
    createUserMutation.mutate(data);
  };

  const handleAddDialogClose = (open: boolean) => {
    if (!open) {
      addUserForm.reset({
        userCode: "", username: "", pin: "", name: "",
        role: "read", department: "", designation: "",
        plants: [], allowedPages: [], pageWriteAccess: [],
      });
    }
    setIsAddDialogOpen(open);
  };

  const handleEditUser = (data: Partial<UserFormValues>) => {
    if (currentUser && currentUser.userCode) {
      if (data.pin === "") delete data.pin;
      updateUserMutation.mutate({ userCode: currentUser.userCode, data });
    }
  };

  const handleDeleteUser = () => {
    if (currentUser && currentUser.userCode) {
      deleteUserMutation.mutate(currentUser.userCode);
    }
  };

  const openEditDialog = (user: User) => {
    setCurrentUser(user);
    editUserForm.reset({
      userCode: user.userCode || "",
      username: user.username,
      name: user.name || "",
      role: (user.role as any) || "read",
      department: user.department || "",
      designation: user.designation || "",
      plants: parseJsonArray((user as any).plants),
      allowedPages: parseJsonArray((user as any).allowedPages),
      pageWriteAccess: parseJsonArray((user as any).pageWriteAccess),
    });
    setIsEditDialogOpen(true);
  };

  const openDeleteDialog = (user: User) => {
    setCurrentUser(user);
    setIsDeleteDialogOpen(true);
  };

  const [departments, setDepartments] = useState<string[]>([
    "MANAGEMENT", "IT", "BILLING", "SALES", "DISPATCH {VALSAD}", "DISPATCH {INDORE}", "DISPATCH {LUCKNOW}", "ACCOUNTS", "STEER", "M&S"
  ]);
  const [customDepartment, setCustomDepartment] = useState("");
  const [isAddingDepartment, setIsAddingDepartment] = useState(false);

  const [designations, setDesignations] = useState<string[]>([
    "DIRECTOR", "MANAGER", "ASST. MANAGER", "HEAD", "ASSISTANT", "STAFF",
    "HELPER", "SUPERVISOR", "STOREKEEPER", "LOADER", "DRIVER"
  ]);
  const [customDesignation, setCustomDesignation] = useState("");
  const [isAddingDesignation, setIsAddingDesignation] = useState(false);

  const addNewDepartment = () => {
    if (customDepartment.trim() !== "" && !departments.includes(customDepartment.trim())) {
      setDepartments([...departments, customDepartment.trim()]);
      setCustomDepartment("");
      setIsAddingDepartment(false);
    }
  };

  const addNewDesignation = () => {
    if (customDesignation.trim() !== "" && !designations.includes(customDesignation.trim())) {
      setDesignations([...designations, customDesignation.trim()]);
      setCustomDesignation("");
      setIsAddingDesignation(false);
    }
  };

  // Shared form body (used for both add + edit forms)
  const renderFormBody = (form: any, isEdit = false) => {
    const watchedRole = form.watch("role");
    const isAdminRole = watchedRole === "admin" || watchedRole === "super-admin";

    return (
      <div className="space-y-4 py-2">
        <FormField control={form.control} name="userCode" render={({ field }) => (
          <FormItem>
            <FormLabel>User Code</FormLabel>
            <FormControl>
              <Input placeholder="Enter user code" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )} />

        <FormField control={form.control} name="username" render={({ field }) => (
          <FormItem>
            <FormLabel>Username</FormLabel>
            <FormControl>
              <Input placeholder="johndoe" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )} />

        <FormField control={form.control} name="pin" render={({ field }) => (
          <FormItem>
            <FormLabel>PIN (4 digits)</FormLabel>
            <FormControl>
              <Input
                type="text"
                placeholder={isEdit ? "Leave blank to keep current PIN" : "1234"}
                maxLength={4}
                pattern="[0-9]{4}"
                inputMode="numeric"
                {...field}
                value={field.value || ''}
              />
            </FormControl>
            {isEdit && (
              <FormDescription>Leave blank to keep the current PIN. Must be exactly 4 digits.</FormDescription>
            )}
            {!isEdit && (
              <FormDescription>4-digit PIN code for authentication</FormDescription>
            )}
            <FormMessage />
          </FormItem>
        )} />

        <FormField control={form.control} name="name" render={({ field }) => (
          <FormItem>
            <FormLabel>Display Name</FormLabel>
            <FormControl>
              <Input placeholder="John Doe" {...field} value={field.value || ''} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )} />

        <div className="grid grid-cols-2 gap-4">
          <FormField control={form.control} name="role" render={({ field }) => (
            <FormItem>
              <FormLabel>Role</FormLabel>
              <Select onValueChange={field.onChange} value={field.value || undefined}>
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
          )} />

          <FormField control={form.control} name="department" render={({ field }) => (
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
                  <Button type="button" size="icon" onClick={addNewDepartment} disabled={!customDepartment.trim()}>
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button type="button" size="icon" variant="ghost" onClick={() => { setIsAddingDepartment(false); setCustomDepartment(""); }}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Select onValueChange={field.onChange} value={field.value || undefined}>
                    <FormControl>
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="Select department" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {departments.map((dept) => (
                        <SelectItem key={dept} value={dept}>{dept}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button type="button" size="icon" variant="outline" onClick={() => setIsAddingDepartment(true)}>
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              )}
              <FormMessage />
            </FormItem>
          )} />
        </div>

        <FormField control={form.control} name="designation" render={({ field }) => (
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
                <Button type="button" size="icon" onClick={addNewDesignation} disabled={!customDesignation.trim()}>
                  <Check className="h-4 w-4" />
                </Button>
                <Button type="button" size="icon" variant="ghost" onClick={() => { setIsAddingDesignation(false); setCustomDesignation(""); }}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <div className="flex gap-2">
                <Select onValueChange={field.onChange} value={field.value || undefined}>
                  <FormControl>
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder="Select designation" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {designations.map((d) => (
                      <SelectItem key={d} value={d}>{d}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button type="button" size="icon" variant="outline" onClick={() => setIsAddingDesignation(true)}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            )}
            <FormMessage />
          </FormItem>
        )} />

        {/* Plants multi-select */}
        <FormField control={form.control} name="plants" render={({ field }) => (
          <FormItem>
            <FormLabel>Plants</FormLabel>
            <FormControl>
              <MultiSelectField
                label="plants"
                options={plantOptions}
                selected={field.value ?? []}
                onChange={field.onChange}
              />
            </FormControl>
            <FormDescription>Select one or more plants this user belongs to.</FormDescription>
            <FormMessage />
          </FormItem>
        )} />

        {/* Allowed Pages multi-select */}
        <FormField control={form.control} name="allowedPages" render={({ field }) => (
          <FormItem>
            <FormLabel>Allowed Pages</FormLabel>
            <FormControl>
              <MultiSelectField
                label="pages"
                options={CONTROLLABLE_PAGES}
                selected={field.value ?? []}
                onChange={(val) => {
                  field.onChange(val);
                  // A page can't have write access without also having read access —
                  // drop it from Write Access the moment it's unchecked here.
                  const currentWrite: string[] = form.getValues("pageWriteAccess") ?? [];
                  const pruned = currentWrite.filter((k) => val.includes(k));
                  if (pruned.length !== currentWrite.length) form.setValue("pageWriteAccess", pruned);
                }}
                disabled={isAdminRole}
                disabledNote="Admin / Super-Admin have access to all pages automatically."
              />
            </FormControl>
            {!isAdminRole && (
              <FormDescription>Select which pages this user can access. Home, Messages, Check In/Out and Profile are always accessible.</FormDescription>
            )}
            <FormMessage />
          </FormItem>
        )} />

        {/* Write Access multi-select — subset of Allowed Pages; the rest are read-only for this user */}
        <FormField control={form.control} name="pageWriteAccess" render={({ field }) => {
          const allowed: string[] = form.watch("allowedPages") ?? [];
          const writableOptions = CONTROLLABLE_PAGES.filter((p) => allowed.includes(p.key));
          return (
            <FormItem>
              <FormLabel>Write Access</FormLabel>
              <FormControl>
                <MultiSelectField
                  label="pages with write access"
                  options={writableOptions}
                  selected={field.value ?? []}
                  onChange={field.onChange}
                  disabled={isAdminRole || allowed.length === 0}
                  disabledNote={isAdminRole
                    ? "Admin / Super-Admin have full write access to all pages automatically."
                    : "Select Allowed Pages first — write access can only be granted on pages this user can already view."}
                />
              </FormControl>
              {!isAdminRole && allowed.length > 0 && (
                <FormDescription>Pages checked here are read/write for this user; any other allowed page is view-only.</FormDescription>
              )}
              <FormMessage />
            </FormItem>
          );
        }} />
      </div>
    );
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
                      <TableHead className="w-[60px]">User</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Username</TableHead>
                      <TableHead>Designation</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Plants</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredUsers.map((user: User) => {
                      const userPlants = parseJsonArray((user as any).plants);
                      return (
                        <TableRow key={user.userCode}>
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
                              user.role === "admin" || user.role === "super-admin"
                                ? "bg-blue-50 text-blue-700 border-blue-200"
                                : "bg-green-50 text-green-700 border-green-200"
                            }>
                              {user.role || "User"}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              {userPlants.length === 0
                                ? <span className="text-gray-400 text-sm">-</span>
                                : userPlants.map((p: string) => (
                                    <Badge key={p} variant="secondary" className="text-xs">{p}</Badge>
                                  ))
                              }
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-2">
                              <Button variant="ghost" size="icon" onClick={() => openEditDialog(user)}>
                                <Edit className="h-4 w-4" />
                                <span className="sr-only">Edit</span>
                              </Button>
                              <Button variant="ghost" size="icon" onClick={() => openDeleteDialog(user)}>
                                <Trash className="h-4 w-4" />
                                <span className="sr-only">Delete</span>
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Add User Dialog */}
      <Dialog open={isAddDialogOpen} onOpenChange={handleAddDialogClose}>
        <DialogContent className="sm:max-w-[580px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add New User</DialogTitle>
            <DialogDescription>
              Create a new user account with appropriate permissions.
            </DialogDescription>
          </DialogHeader>
          <Form {...addUserForm}>
            <form onSubmit={addUserForm.handleSubmit(handleAddUser)}>
              {renderFormBody(addUserForm, false)}
              <DialogFooter className="pt-4">
                <Button type="button" variant="outline" onClick={() => handleAddDialogClose(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createUserMutation.isPending}>
                  {createUserMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Create User
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Edit User Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="sm:max-w-[580px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
            <DialogDescription>
              Update user information and permissions.
            </DialogDescription>
          </DialogHeader>
          <Form {...editUserForm}>
            <form onSubmit={editUserForm.handleSubmit(handleEditUser)}>
              {renderFormBody(editUserForm, true)}
              <DialogFooter className="pt-4">
                <Button type="button" variant="outline" onClick={() => setIsEditDialogOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={updateUserMutation.isPending}>
                  {updateUserMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save Changes
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Delete User Confirmation Dialog */}
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Delete User</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this user? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            {currentUser && (
              <div className="flex items-center space-x-4">
                <Avatar>
                  <AvatarFallback className="bg-primary/10 text-primary">
                    {(currentUser.name || currentUser.username || "").substring(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <p className="font-medium">{currentUser.name}</p>
                  <p className="text-sm text-gray-500">{currentUser.username}</p>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setIsDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={handleDeleteUser} disabled={deleteUserMutation.isPending}>
              {deleteUserMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Users;
