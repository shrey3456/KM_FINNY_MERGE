import { useQuery, useMutation } from '@tanstack/react-query';
import { apiRequest, queryClient } from '@/lib/queryClient';
import {
  Card,
  CardContent,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DataTable,
  DataTableColumnToggle,
  DataTablePaginationNav,
  type DataTableColumn,
} from '@/components/ui/data-table';
import {
  Plus, Search, Edit, Trash, Loader2, Users as UsersIcon, Check, X, ChevronsUpDown,
  ChevronLeft, ChevronRight,
  UserPlus, UserCog, AlertTriangle, KeyRound, IdCard, ShieldCheck,
} from 'lucide-react';
import { useEffect, useState } from 'react';
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
import { PlantBadge } from "@/components/PlantBadge";
import { CONTROLLABLE_PAGES } from "@shared/pageKeys";
import { hasPageViewAccess, hasPageWriteAccess } from "@/lib/permissions";

// Solid navy fill, matching the Product Master action buttons.
const FILTER_BTN_CLASS = "h-8 border-0 bg-[#001d6e] text-white hover:bg-[#001552] hover:text-white text-xs";
const PRIMARY_BTN_CLASS = "bg-[#001d6e] text-white hover:bg-[#001552]";

// Full-bleed navy banner + scrollable body + pinned footer. The [&>button] rules recolor
// Dialog's built-in close X, which would otherwise be dark-on-navy.
const DIALOG_SHELL_CLASS =
  "sm:max-w-[620px] max-h-[90vh] flex flex-col gap-0 overflow-hidden p-0 [&>button]:text-white [&>button]:opacity-80 [&>button:hover]:opacity-100";

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
const USERS_PAGE_SIZE = 15;

function parseJsonArray(val: string | null | undefined): string[] {
  try { return JSON.parse(val || "[]"); } catch { return []; }
}

// Navy banner used at the top of every user dialog, so all three read as one themed family.
function DialogBanner({
  icon: Icon,
  title,
  description,
  tone = "navy",
}: {
  icon: typeof UserPlus;
  title: string;
  description: string;
  tone?: "navy" | "danger";
}) {
  const bg = tone === "danger" ? "bg-red-600" : "bg-[#001d6e]";
  return (
    <DialogHeader className={`${bg} space-y-0 px-5 py-4 text-left`}>
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15">
          <Icon className="h-5 w-5 text-white" />
        </div>
        <div className="min-w-0">
          <DialogTitle className="text-base font-bold tracking-tight text-white sm:text-lg">
            {title}
          </DialogTitle>
          <DialogDescription className="mt-0.5 text-xs text-white/70">
            {description}
          </DialogDescription>
        </div>
      </div>
    </DialogHeader>
  );
}

// Groups related fields under a small navy rule, matching the table header treatment.
function FormSection({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof UserPlus;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-[#001d6e]" />
        <h4 className="text-sm font-bold uppercase tracking-wide text-[#001d6e]">{title}</h4>
        <div className="h-px flex-1 bg-gray-200" />
      </div>
      {children}
    </div>
  );
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
  options: readonly { readonly key: string; readonly label: string }[];
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
  const [pageIndex, setPageIndex] = useState(0);
  // Searching re-cuts the list, so start it from the top rather than leaving you on a page number
  // that means something different (or nothing at all) against the new set.
  useEffect(() => { setPageIndex(0); }, [searchTerm]);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<Partial<User> | null>(null);
  const [visibleColumnIds, setVisibleColumnIds] = useState<Set<string>>(
    () => new Set(['avatar', 'name', 'username', 'designation', 'role', 'plants', 'actions']),
  );

  // Column order, remembered per page. Kept in the same session-scoped storage the filters use —
  // a rearranged table is working context for this sitting, not a permanent preference. An empty
  // array means "declared order", which is also what Reset order restores.
  const [columnOrder, setColumnOrder] = useState<string[]>(() => {
    try {
      const raw = sessionStorage.getItem("users:columnOrder");
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try { sessionStorage.setItem("users:columnOrder", JSON.stringify(columnOrder)); } catch { /* storage unavailable */ }
  }, [columnOrder]);

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
    "HELPER", "SUPERVISOR", "STOREKEEPER", "LOADER", "DRIVER", "SCANNER"
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

    // You can only grant access you have yourself: the Allowed Pages / Write Access dropdowns list
    // only pages the CURRENT admin can read or write (admins/super-admins pass everything, so they
    // still see the full list). Keeps a limited manager from handing out pages they can't access.
    const grantablePages = CONTROLLABLE_PAGES.filter(
      (p) => hasPageViewAccess(p.key) || hasPageWriteAccess(p.key),
    );

    return (
      <div className="space-y-6">
        <FormSection icon={IdCard} title="Account">
          <div className="grid gap-4 sm:grid-cols-2">
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
          </div>

          <FormField control={form.control} name="pin" render={({ field }) => (
            <FormItem>
              <FormLabel className="flex items-center gap-1.5">
                <KeyRound className="h-3.5 w-3.5 text-gray-400" />
                PIN (4 digits)
              </FormLabel>
              <FormControl>
                <Input
                  type="text"
                  placeholder={isEdit ? "Leave blank to keep current PIN" : "1234"}
                  maxLength={4}
                  pattern="[0-9]{4}"
                  inputMode="numeric"
                  className={`font-mono tracking-[0.4em] placeholder:tracking-normal placeholder:font-sans ${isEdit ? "w-64" : "w-32"}`}
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
        </FormSection>

        <FormSection icon={UserCog} title="Profile">
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
        </FormSection>

        <FormSection icon={ShieldCheck} title="Access">
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
                options={grantablePages}
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
          const writableOptions = grantablePages.filter((p) => allowed.includes(p.key));
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
        </FormSection>
      </div>
    );
  };

  const userColumns: DataTableColumn<User>[] = [
    {
      id: 'avatar',
      header: 'User',
      width: 70,
      align: 'center',
      render: (user) => (
        <div className="flex justify-center">
          <Avatar className="h-8 w-8">
            <AvatarFallback className="bg-primary/10 text-primary text-[10px]">
              {(user.name || user.username).substring(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
        </div>
      ),
    },
    {
      id: 'name',
      header: 'Name',
      width: 160,
      sortable: true,
      accessor: (user) => user.name,
      cellClassName: 'font-medium text-gray-900',
      render: (user) => user.name || '-',
    },
    {
      id: 'username',
      header: 'Username',
      width: 160,
      sortable: true,
      accessor: (user) => user.username,
      render: (user) => user.username,
    },
    {
      id: 'designation',
      header: 'Designation',
      width: 140,
      sortable: true,
      accessor: (user) => user.designation,
      render: (user) => user.designation || '-',
    },
    {
      id: 'role',
      header: 'Role',
      width: 110,
      sortable: true,
      accessor: (user) => user.role,
      render: (user) => (
        <Badge
          variant="outline"
          className={
            user.role === 'admin' || user.role === 'super-admin'
              ? 'bg-blue-50 text-blue-700 border-blue-200'
              : 'bg-green-50 text-green-700 border-green-200'
          }
        >
          {user.role || 'User'}
        </Badge>
      ),
    },
    {
      id: 'plants',
      header: 'Plants',
      width: 160,
      render: (user) => {
        const userPlants = parseJsonArray((user as any).plants);
        return (
          <div className="flex flex-wrap gap-1">
            {userPlants.length === 0 ? (
              <span className="text-gray-400">-</span>
            ) : (
              userPlants.map((p: string) => (
                <PlantBadge key={p} plant={p} className="text-[10px]" />
              ))
            )}
          </div>
        );
      },
    },
    {
      id: 'actions',
      header: 'Actions',
      width: 90,
      align: 'left',
      hideable: false,  
      preventRowClick: true,
      render: (user) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEditDialog(user)}>
            <Edit className="h-3.5 w-3.5" />
            <span className="sr-only">Edit</span>
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openDeleteDialog(user)}>
            <Trash className="h-3.5 w-3.5" />
            <span className="sr-only">Delete</span>
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 lg:p-6">
      <div className="mx-auto w-full max-w-[1800px]">
        <div className="mb-6">
          <h2 className="text-2xl font-bold">Users</h2>
          <p className="text-gray-600">Manage user accounts and permissions</p>
        </div>

        <Card className="overflow-hidden">
          {/* Header bar — title + search, filters directly beneath */}
          <div className="bg-white border-b border-gray-200 px-3 sm:px-5 py-3 sm:py-3.5">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-full bg-[#001d6e] text-white">
                  <UsersIcon className="h-4 w-4 sm:h-5 sm:w-5" />
                </div>
                <div>
                  <div className="text-lg sm:text-xl font-bold tracking-tight text-gray-900">User Management</div>
                  <div className="text-xs text-gray-400 leading-none mt-0.5">
                    {searchTerm
                      ? `${filteredUsers.length} of ${Array.isArray(users) ? users.length : 0} users`
                      : `${Array.isArray(users) ? users.length : 0} users`}
                  </div>
                </div>
              </div>
              <div className="relative w-full sm:w-auto sm:shrink-0">
                <Search className="absolute left-2.5 top-1.5 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
                <input
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search users…"
                  className="h-7 w-full sm:w-64 rounded-md border border-gray-200 bg-gray-50 pl-7 pr-6 text-xs text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-[#001d6e]/30 focus:bg-white"
                />
                {searchTerm && (
                  <button onClick={() => setSearchTerm('')} className="absolute right-2 top-1.5 text-gray-400 hover:text-gray-600">
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Filters */}
            <div className="flex flex-col md:flex-row md:items-center gap-2 mt-3">
              <DataTableColumnToggle
              columnOrder={columnOrder}
              onColumnOrderChange={setColumnOrder}
                columns={userColumns}
                visibleColumnIds={visibleColumnIds}
                onToggleColumn={(id) =>
                  setVisibleColumnIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
                onSetAll={(visible) =>
                  setVisibleColumnIds(visible ? new Set(userColumns.map((c) => c.id)) : new Set())
                }
                buttonClassName={FILTER_BTN_CLASS}
              />
              <Button
                className={`${FILTER_BTN_CLASS} flex items-center gap-1 md:ml-auto`}
                onClick={() => setIsAddDialogOpen(true)}
                disabled={!isAdmin}
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Add User</span>
              </Button>
            </div>
          </div>

          <CardContent className="p-0">
            {/* Seven columns total ~890px — a phone can only reach them by swiping sideways, so
                below 480px (and in portrait) each user becomes a stacked card instead. */}
            <div className="min-[480px]:hidden landscape:hidden">
              {isLoading ? (
                <div className="flex justify-center py-10">
                  <Loader2 className="h-5 w-5 animate-spin text-[#001d6e]" />
                </div>
              ) : filteredUsers.length === 0 ? (
                <p className="py-10 text-center text-sm text-gray-400">
                  {searchTerm ? "No users found matching your search." : "No users have been added yet."}
                </p>
              ) : (
                <>
                  {filteredUsers
                    .slice(pageIndex * USERS_PAGE_SIZE, (pageIndex + 1) * USERS_PAGE_SIZE)
                    .map((user) => {
                      const userPlants = parseJsonArray((user as any).plants);
                      const isAdminRole = user.role === "admin" || user.role === "super-admin";
                      return (
                        <div key={user.userCode} className="flex items-start gap-3 border-b border-gray-100 px-4 py-3 last:border-b-0">
                          <Avatar className="mt-0.5 h-9 w-9 shrink-0">
                            <AvatarFallback className="bg-primary/10 text-[11px] text-primary">
                              {(user.name || user.username).substring(0, 2).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[15px] font-semibold leading-snug text-gray-900">
                              {user.name || "-"}
                            </p>
                            <p className="mt-0.5 truncate text-xs text-gray-400">{user.username}</p>
                            <div className="mt-1.5 flex flex-wrap items-center gap-1">
                              <Badge
                                variant="outline"
                                className={isAdminRole
                                  ? "border-blue-200 bg-blue-50 text-blue-700"
                                  : "border-green-200 bg-green-50 text-green-700"}
                              >
                                {user.role || "User"}
                              </Badge>
                              {user.designation && (
                                <span className="text-xs text-gray-500">{user.designation}</span>
                              )}
                            </div>
                            {userPlants.length > 0 && (
                              <div className="mt-1.5 flex flex-wrap gap-1">
                                {userPlants.map((pl: string) => (
                                  <PlantBadge key={pl} plant={pl} className="text-[10px]" />
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="flex shrink-0 gap-1">
                            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEditDialog(user)}>
                              <Edit className="h-4 w-4" />
                              <span className="sr-only">Edit</span>
                            </Button>
                            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openDeleteDialog(user)}>
                              <Trash className="h-4 w-4" />
                              <span className="sr-only">Delete</span>
                            </Button>
                          </div>
                        </div>
                      );
                    })}

                  {/* The table's pager lives inside the table, which is hidden here — so the card
                      list needs its own or mobile can only ever see page 1. */}
                  {filteredUsers.length > USERS_PAGE_SIZE && (() => {
                    const pageCount = Math.ceil(filteredUsers.length / USERS_PAGE_SIZE);
                    return (
                      <div className="flex flex-col gap-2 border-t border-gray-200 px-4 py-3">
                        <span className="text-xs text-gray-500">
                          Showing {(pageIndex * USERS_PAGE_SIZE + 1).toLocaleString()}–
                          {Math.min((pageIndex + 1) * USERS_PAGE_SIZE, filteredUsers.length).toLocaleString()} of{" "}
                          {filteredUsers.length.toLocaleString()}
                        </span>
                        <DataTablePaginationNav
                          pageIndex={pageIndex}
                          pageCount={pageCount}
                          onPageIndexChange={setPageIndex}
                        />
                      </div>
                    );
                  })()}
                </>
              )}
            </div>

            <DataTable<User>
              className="hidden space-y-0 min-[480px]:block landscape:block"
              containerClassName="rounded-none border-0"
              columns={userColumns}
              data={filteredUsers}
              getRowId={(user) => user.userCode}
              isLoading={isLoading}
              loadingLabel="Loading users…"
              emptyState="No users have been added yet."
              noResultsState="No users found matching your search."
              hasActiveFilters={!!searchTerm}
              sortMode="client"
              // Paginated, with no isStickyHeader/maxHeight, so the table has no inner scroll box
              // of its own — matching develop.
              paginationMode="client"
              pageIndex={pageIndex}
              onPageIndexChange={setPageIndex}
              defaultPageSize={15}
              pageSizeOptions={[15, 25, 50, 100]}
              enableColumnResizing
              enableColumnVisibility
              columnVisibility={visibleColumnIds}
            columnOrder={columnOrder}
            onColumnOrderChange={setColumnOrder}
              onColumnVisibilityChange={setVisibleColumnIds}
              enableZebraStripes
              showMobileSwipeHint
              headerClassName="bg-[#001d6e] text-white hover:bg-[#0a2b7e] hover:text-white border-[#1a3a9c]"
            />
          </CardContent>
        </Card>
      </div>

      {/* Add User Dialog */}
      <Dialog open={isAddDialogOpen} onOpenChange={handleAddDialogClose}>
        <DialogContent className={DIALOG_SHELL_CLASS}>
          <DialogBanner
            icon={UserPlus}
            title="Add New User"
            description="Create a new user account with appropriate permissions."
          />
          <Form {...addUserForm}>
            <form onSubmit={addUserForm.handleSubmit(handleAddUser)} className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
                {renderFormBody(addUserForm, false)}
              </div>
              <DialogFooter className="shrink-0 gap-2 border-t bg-gray-50 px-5 py-3">
                <Button type="button" variant="outline" onClick={() => handleAddDialogClose(false)}>
                  Cancel
                </Button>
                <Button type="submit" className={PRIMARY_BTN_CLASS} disabled={createUserMutation.isPending}>
                  {createUserMutation.isPending
                    ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    : <UserPlus className="mr-2 h-4 w-4" />}
                  Create User
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Edit User Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className={DIALOG_SHELL_CLASS}>
          <DialogBanner
            icon={UserCog}
            title="Edit User"
            description="Update user information and permissions."
          />
          <Form {...editUserForm}>
            <form onSubmit={editUserForm.handleSubmit(handleEditUser)} className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
                {renderFormBody(editUserForm, true)}
              </div>
              <DialogFooter className="shrink-0 gap-2 border-t bg-gray-50 px-5 py-3">
                <Button type="button" variant="outline" onClick={() => setIsEditDialogOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" className={PRIMARY_BTN_CLASS} disabled={updateUserMutation.isPending}>
                  {updateUserMutation.isPending
                    ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    : <Check className="mr-2 h-4 w-4" />}
                  Save Changes
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Delete User Confirmation Dialog */}
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent className="sm:max-w-[440px] gap-0 overflow-hidden p-0 [&>button]:text-white [&>button]:opacity-80 [&>button:hover]:opacity-100">
          <DialogBanner
            icon={AlertTriangle}
            tone="danger"
            title="Delete User"
            description="This action cannot be undone."
          />
          <div className="px-5 py-5">
            {currentUser && (
              <div className="flex items-center gap-3 rounded-xl border border-red-100 bg-red-50/60 p-3">
                <Avatar>
                  <AvatarFallback className="bg-red-100 text-red-700">
                    {(currentUser.name || currentUser.username || "").substring(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="truncate font-medium text-gray-900">{currentUser.name}</p>
                  <p className="truncate text-sm text-gray-500">{currentUser.username}</p>
                </div>
              </div>
            )}
            <p className="mt-3 text-sm text-gray-500">
              Are you sure you want to permanently delete this user?
            </p>
          </div>
          <DialogFooter className="gap-2 border-t bg-gray-50 px-5 py-3">
            <Button type="button" variant="outline" onClick={() => setIsDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={handleDeleteUser} disabled={deleteUserMutation.isPending}>
              {deleteUserMutation.isPending
                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                : <Trash className="mr-2 h-4 w-4" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Users;
