import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Trash2, Edit, Plus, Factory, Printer, Lock, Unlock, FileText, ScrollText, ChevronDown, ChevronRight, Tag } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Link } from "wouter";

// Schema matching shared/schema.ts
const plantFormSchema = z.object({
  name: z.string().min(1, "Plant name is required"),
  bgColor: z.string().min(1, "Background color is required"),
  textColor: z.string().min(1, "Text color is required"),
  borderColor: z.string().min(1, "Border color is required"),
  isLockingEnabled: z.boolean().default(true),
  isSplitPagesEnabled: z.boolean().default(false),
});

type PlantFormValues = z.infer<typeof plantFormSchema>;

type PlantRecord = PlantFormValues & {
  id: number;
  createdAt?: string | Date | null;
};

const PLANTS_QUERY_KEY = ["/api/plants"] as const;

const normalizePlantResponse = (
  response: PlantRecord | { plant?: PlantRecord } | null | undefined,
): PlantRecord | null => {
  if (!response) return null;
  if ("plant" in response) return response.plant ?? null;
  return response;
};

const updatePlantsCache = (
  queryClient: QueryClient,
  updater: (plants: PlantRecord[]) => PlantRecord[],
) => {
  queryClient.setQueriesData({ queryKey: PLANTS_QUERY_KEY }, (oldData: unknown) => {
    if (!Array.isArray(oldData)) return oldData;
    return updater(oldData as PlantRecord[]);
  });
};

const getStvsQueryKey = (plantId: number) => ["/api/plants", plantId, "stvs"] as const;

export default function PlantSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingPlant, setEditingPlant] = useState<any>(null);
  const [expandedPlantId, setExpandedPlantId] = useState<number | null>(null);
  const [newStv, setNewStv] = useState("");
  const [editingStvId, setEditingStvId] = useState<number | null>(null);
  const [editingStvValue, setEditingStvValue] = useState("");

  const form = useForm<PlantFormValues>({
    resolver: zodResolver(plantFormSchema),
    defaultValues: {
      name: "",
      bgColor: "#ffffff",
      textColor: "#000000",
      borderColor: "#cccccc",
      isLockingEnabled: true,
      isSplitPagesEnabled: false,
    },
  });

  // Debug: Watch form values
  const formValues = form.watch();
  console.log('🔍 Current form values:', formValues);

  // Fetch plants
  const { data: plants, isLoading } = useQuery<PlantRecord[]>({
    queryKey: PLANTS_QUERY_KEY,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/plants?_t=${Date.now()}`);
      return res.json();
    },
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  const selectedPlant = plants?.find((plant) => plant.id === expandedPlantId) ?? null;

  const { data: stvs, isLoading: isStvsLoading } = useQuery<any[]>({
    queryKey: ["/api/plants", expandedPlantId, "stvs"],
    queryFn: async () => {
      if (!expandedPlantId) return [];
      const res = await apiRequest("GET", `/api/plants/${expandedPlantId}/stvs?_t=${Date.now()}`);
      return res.json();
    },
    enabled: !!expandedPlantId,
  });

  // Create Mutation
  const createMutation = useMutation({
    mutationFn: async (data: PlantFormValues) => {
      console.log('📤 Creating plant with data:', data); // DEBUG
      const res = await apiRequest("POST", "/api/plants", data);
      const result = await res.json();
      console.log('📥 Create response:', result); // DEBUG
      return result;
    },
    onSuccess: (response, variables) => {
      const createdPlant = normalizePlantResponse(response);
      if (createdPlant) {
        updatePlantsCache(queryClient, (oldPlants) => {
          const existingIndex = oldPlants.findIndex((plant) => plant.id === createdPlant.id);
          if (existingIndex >= 0) {
            return oldPlants.map((plant) => (plant.id === createdPlant.id ? createdPlant : plant));
          }
          return [...oldPlants, createdPlant];
        });
      } else {
        const optimisticPlant: PlantRecord = {
          id: Date.now(),
          ...variables,
          name: variables.name.toUpperCase(),
        };
        updatePlantsCache(queryClient, (oldPlants) => [...oldPlants, optimisticPlant]);
      }
      queryClient.invalidateQueries({ queryKey: PLANTS_QUERY_KEY, refetchType: "inactive" });
      toast({ title: "Success", description: "Plant added successfully" });
      setIsDialogOpen(false);
      setEditingPlant(null);
    },
    onError: (err: any) => {
      console.error('❌ Create error:', err);
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  });

  // Update Mutation
  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: PlantFormValues }) => {
      console.log('📤 Updating plant ID', id, 'with data:', data); // DEBUG
      const res = await apiRequest("PUT", `/api/plants/${id}`, data);
      const result = await res.json();
      console.log('📥 Update response:', result); // DEBUG
      return result;
    },
    onMutate: async ({ id, data }) => {
      await queryClient.cancelQueries({ queryKey: PLANTS_QUERY_KEY });
      const previousPlants = queryClient.getQueryData<PlantRecord[]>(PLANTS_QUERY_KEY);

      updatePlantsCache(queryClient, (oldPlants) =>
        oldPlants.map((plant) => (plant.id === id ? { ...plant, ...data } : plant)),
      );

      return { previousPlants };
    },
    onSuccess: (response, variables) => {
      const updatedPlant = normalizePlantResponse(response) ?? {
        id: variables.id,
        ...variables.data,
      };
      updatePlantsCache(queryClient, (oldPlants) =>
        oldPlants.map((plant) => (plant.id === variables.id ? { ...plant, ...updatedPlant } : plant)),
      );
      queryClient.invalidateQueries({ queryKey: PLANTS_QUERY_KEY, refetchType: "inactive" });
      toast({ title: "Success", description: "Plant updated successfully" });
      setIsDialogOpen(false);
      setEditingPlant(null);
    },
     onError: (err: any, _variables, context) => {
      if (context?.previousPlants) {
        queryClient.setQueryData(PLANTS_QUERY_KEY, context.previousPlants);
      }
      console.error('❌ Update error:', err);
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  });

  // Delete Mutation
  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/plants/${id}`);
    },
    onMutate: async (deletedId) => {
      await queryClient.cancelQueries({ queryKey: PLANTS_QUERY_KEY });
      const previousPlants = queryClient.getQueryData<PlantRecord[]>(PLANTS_QUERY_KEY);

      updatePlantsCache(queryClient, (oldPlants) =>
        oldPlants.filter((plant) => plant.id !== deletedId),
      );

      if (expandedPlantId === deletedId) {
        setExpandedPlantId(null);
      }

      return { previousPlants };
    },
    onSuccess: (_response, deletedId) => {
      updatePlantsCache(queryClient, (oldPlants) =>
        oldPlants.filter((plant) => plant.id !== deletedId),
      );
      toast({ title: "Deleted", description: "Plant removed successfully" });
    },
    onError: (err: any, _variables, context) => {
      if (context?.previousPlants) {
        queryClient.setQueryData(PLANTS_QUERY_KEY, context.previousPlants);
      }
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: PLANTS_QUERY_KEY, refetchType: "inactive" });
    },
  });

  const createStvMutation = useMutation({
    mutationFn: async (data: { plantId: number; stv: string }) => {
      const res = await apiRequest("POST", `/api/plants/${data.plantId}/stvs`, {
        stv: data.stv,
      });
      return res.json();
    },
    onSuccess: (createdStv, variables) => {
      if (expandedPlantId) {
        queryClient.setQueryData(
          getStvsQueryKey(expandedPlantId),
          (oldStvs: any[] | undefined) => {
            if (!oldStvs) return createdStv ? [createdStv] : [];
            if (!createdStv) return oldStvs;
            const exists = oldStvs.some((stv) => stv.id === createdStv.id);
            return exists ? oldStvs : [...oldStvs, createdStv];
          },
        );

        queryClient.invalidateQueries({
          queryKey: getStvsQueryKey(expandedPlantId),
          refetchType: "inactive",
        });
      } else {
        queryClient.invalidateQueries({
          queryKey: getStvsQueryKey(variables.plantId),
          refetchType: "inactive",
        });
      }
      setNewStv("");
      toast({ title: "Success", description: "STV added" });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  });

  const updateStvMutation = useMutation({
    mutationFn: async (data: { id: number; stv: string }) => {
      const res = await apiRequest("PUT", `/api/plant-stvs/${data.id}`, {
        stv: data.stv,
      });
      return res.json();
    },
    onMutate: async (variables) => {
      if (!expandedPlantId) return {};
      const stvsQueryKey = getStvsQueryKey(expandedPlantId);
      await queryClient.cancelQueries({ queryKey: stvsQueryKey });
      const previousStvs = queryClient.getQueryData<any[]>(stvsQueryKey);

      queryClient.setQueryData(
        stvsQueryKey,
        (oldStvs: any[] | undefined) => {
          if (!oldStvs) return oldStvs;
          return oldStvs.map((stv) =>
            stv.id === variables.id ? { ...stv, stv: variables.stv } : stv,
          );
        },
      );

      return { previousStvs };
    },
    onSuccess: (updatedStv) => {
      if (expandedPlantId) {
        queryClient.setQueryData(
          getStvsQueryKey(expandedPlantId),
          (oldStvs: any[] | undefined) => {
            if (!oldStvs || !updatedStv) return oldStvs ?? [];
            return oldStvs.map((stv) => (stv.id === updatedStv.id ? updatedStv : stv));
          },
        );
      }
      setEditingStvId(null);
      setEditingStvValue("");
      toast({ title: "Success", description: "STV updated" });
    },
    onError: (err: any, _variables, context) => {
      if (context?.previousStvs && expandedPlantId) {
        queryClient.setQueryData(
          getStvsQueryKey(expandedPlantId),
          context.previousStvs,
        );
      }
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
    onSettled: () => {
      if (expandedPlantId) {
        queryClient.invalidateQueries({
          queryKey: getStvsQueryKey(expandedPlantId),
          refetchType: "inactive",
        });
      }
    },
  });

  const deleteStvMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/plant-stvs/${id}`);
    },
    onMutate: async (deletedId) => {
      if (!expandedPlantId) return {};
      const stvsQueryKey = getStvsQueryKey(expandedPlantId);
      await queryClient.cancelQueries({ queryKey: stvsQueryKey });
      const previousStvs = queryClient.getQueryData<any[]>(stvsQueryKey);

      queryClient.setQueryData(
        stvsQueryKey,
        (oldStvs: any[] | undefined) => {
          if (!oldStvs) return [];
          return oldStvs.filter((stv) => stv.id !== deletedId);
        },
      );

      return { previousStvs };
    },
    onSuccess: () => {
      if (expandedPlantId) {
        queryClient.invalidateQueries({
          queryKey: getStvsQueryKey(expandedPlantId),
          refetchType: "inactive",
        });
      }
      toast({ title: "Deleted", description: "STV removed" });
    },
    onError: (err: any, _variables, context) => {
      if (context?.previousStvs && expandedPlantId) {
        queryClient.setQueryData(
          getStvsQueryKey(expandedPlantId),
          context.previousStvs,
        );
      }
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
    onSettled: () => {
      if (expandedPlantId) {
        queryClient.invalidateQueries({
          queryKey: getStvsQueryKey(expandedPlantId),
          refetchType: "inactive",
        });
      }
    },
  });

  const onSubmit = (data: PlantFormValues) => {
    console.log('📤 Submitting plant form with data:', data); // DEBUG
    if (editingPlant) {
      updateMutation.mutate({ id: editingPlant.id, data });
    } else {
      createMutation.mutate(data);
    }
  };

  const handleEdit = (plant: any) => {
    setEditingPlant(plant);
    console.log('✏️ Editing plant:', plant); // DEBUG
    console.log('  - isLockingEnabled:', plant.isLockingEnabled, typeof plant.isLockingEnabled);
    console.log('  - isSplitPagesEnabled:', plant.isSplitPagesEnabled, typeof plant.isSplitPagesEnabled);
    form.reset({
      name: plant.name,
      bgColor: plant.bgColor,
      textColor: plant.textColor,
      borderColor: plant.borderColor,
      isLockingEnabled: plant.isLockingEnabled !== undefined && plant.isLockingEnabled !== null ? plant.isLockingEnabled : true,
      isSplitPagesEnabled: plant.isSplitPagesEnabled !== undefined && plant.isSplitPagesEnabled !== null ? plant.isSplitPagesEnabled : false,
    });
    setIsDialogOpen(true);
  };

  const handleAddNew = () => {
    setEditingPlant(null);
    form.reset({
        name: "",
        bgColor: "#ffffff",
        textColor: "#000000",
        borderColor: "#cccccc",
        isLockingEnabled: true,
        isSplitPagesEnabled: false,
    });
    setIsDialogOpen(true);
  }

  const handleDialogChange = (open: boolean) => {
    setIsDialogOpen(open);
    if (!open) {
      // Reset form and editing state when dialog closes
      setEditingPlant(null);
      form.reset({
        name: "",
        bgColor: "#ffffff",
        textColor: "#000000",
        borderColor: "#cccccc",
        isLockingEnabled: true,
        isSplitPagesEnabled: false,
      });
    }
  }

  const handleToggleStvPanel = (plant: any) => {
    if (expandedPlantId === plant.id) {
      setExpandedPlantId(null);
    } else {
      setExpandedPlantId(plant.id);
    }
    setEditingStvId(null);
    setEditingStvValue("");
    setNewStv("");
  };

  const handleAddStv = () => {
    if (!expandedPlantId || !newStv.trim()) return;
    createStvMutation.mutate({
      plantId: expandedPlantId,
      stv: newStv.trim(),
    });
  };

  return (
    <div className="container mx-auto py-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2">
            <Factory className="h-6 w-6" />
            Plant Management
        </h1>
        <div className="flex gap-2">
          <Link href="/print-operations">
            <Button variant="outline">
              <Printer className="mr-2 h-4 w-4" />
              Print Operations
            </Button>
          </Link>
          <Dialog open={isDialogOpen} onOpenChange={handleDialogChange}>
            <DialogTrigger asChild>
              <Button onClick={handleAddNew}>
                <Plus className="mr-2 h-4 w-4" /> Add New Plant
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{editingPlant ? "Edit Plant" : "Add New Plant"}</DialogTitle>
              </DialogHeader>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Plant Name (ID)</FormLabel>
                        <FormControl>
                          <Input placeholder="e.g. VALSAD" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* ADD THIS: Print Locking Toggle */}
                  <FormField
                    control={form.control}
                    name="isLockingEnabled"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 bg-muted/50">
                        <div className="space-y-0.5">
                          <FormLabel className="text-base">🔒 Print Locking</FormLabel>
                          <div className="text-sm text-muted-foreground">
                            {field.value 
                              ? "Slips can only be printed once (locked after first print)" 
                              : "⚠️ Unlimited prints allowed (no locking)"}
                          </div>
                        </div>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="isSplitPagesEnabled"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3 shadow-sm">
                        <div className="space-y-0.5">
                          <FormLabel>📄 Split Pages</FormLabel>
                          <div className="text-xs text-muted-foreground">
                            {field.value 
                              ? "Print will be split across multiple pages" 
                              : "Print will be continuous (single long page)"}
                          </div>
                        </div>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormItem>
                    )}
                  />

                  <div className="grid grid-cols-3 gap-4">
                      <FormField
                      control={form.control}
                      name="bgColor"
                      render={({ field }) => (
                          <FormItem>
                          <FormLabel>Background</FormLabel>
                          <div className="flex gap-2">
                              <FormControl>
                              <Input type="color" className="w-12 p-1 h-9" {...field} />
                              </FormControl>
                              <Input {...field} placeholder="#ffffff" />
                          </div>
                          <FormMessage />
                          </FormItem>
                      )}
                      />
                      
                      <FormField
                      control={form.control}
                      name="textColor"
                      render={({ field }) => (
                          <FormItem>
                          <FormLabel>Text Color</FormLabel>
                          <div className="flex gap-2">
                              <FormControl>
                              <Input type="color" className="w-12 p-1 h-9" {...field} />
                              </FormControl>
                               <Input {...field} placeholder="#000000" />
                          </div>
                          <FormMessage />
                          </FormItem>
                      )}
                      />

                      <FormField
                      control={form.control}
                      name="borderColor"
                      render={({ field }) => (
                          <FormItem>
                          <FormLabel>Border Color</FormLabel>
                          <div className="flex gap-2">
                              <FormControl>
                              <Input type="color" className="w-12 p-1 h-9" {...field} />
                              </FormControl>
                               <Input {...field} placeholder="#cccccc" />
                          </div>
                          <FormMessage />
                          </FormItem>
                      )}
                      />
                  </div>

                  <div className="bg-muted p-4 rounded-md mt-4">
                      <p className="text-sm font-medium mb-2">Preview:</p>
                      <div 
                          className="p-4 border text-center font-bold rounded"
                          style={{
                              backgroundColor: form.watch("bgColor"),
                              color: form.watch("textColor"),
                              borderColor: form.watch("borderColor"),
                              borderWidth: "2px"
                          }}
                      >
                          KRUPA MARKETING - {form.watch("name")?.toUpperCase() || "PLANT NAME"}
                          <div className="text-xs mt-2 opacity-75 space-y-1">
                              <div>
                                {form.watch("isLockingEnabled") 
                                  ? '🔒 Print once only' 
                                  : '⚠️ Unlimited prints'}
                              </div>
                              <div>
                                {form.watch("isSplitPagesEnabled") 
                                  ? '📄 Multi-page mode' 
                                  : '📜 Continuous mode'}
                              </div>
                          </div>
                      </div>
                  </div>

                  <Button type="submit" className="w-full" disabled={createMutation.isPending || updateMutation.isPending}>
                    {editingPlant ? "Update Plant" : "Create Plant"}
                  </Button>
                </form>
              </Form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Configured Plants</CardTitle>
          <CardDescription>Manage plant colors and print locking behavior</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Print Locking</TableHead>
                <TableHead>Split Pages</TableHead>
                <TableHead>STVs</TableHead>
                <TableHead>Background</TableHead>
                <TableHead>Text</TableHead>
                <TableHead>Border</TableHead>
                <TableHead>Preview</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={9} className="text-center">Loading...</TableCell></TableRow>
              ) : plants?.map((plant: any) => (
                <React.Fragment key={plant.id}>
                <TableRow className="cursor-pointer" onClick={() => handleToggleStvPanel(plant)}>
                  <TableCell className="font-medium">{plant.name}</TableCell>
                  {/* ADD THIS: Locking Status Column */}
                  <TableCell>
                    {plant.isLockingEnabled ? (
                      <span className="text-red-600 font-medium text-xs flex items-center gap-1">
                        <Lock className="h-3.5 w-3.5" /> <span>Locked</span>
                      </span>
                    ) : (
                      <span className="text-green-600 font-medium text-xs flex items-center gap-1">
                        <Unlock className="h-3.5 w-3.5" /> <span>Unlocked</span>
                      </span>
                    )}
                  </TableCell>
                  {/* ADD THIS: Split Pages Status Column */}
                  <TableCell>
                    {plant.isSplitPagesEnabled ? (
                      <span className="text-blue-600 font-medium text-xs flex items-center gap-1">
                        <FileText className="h-3.5 w-3.5" /> <span>Splited</span>
                      </span>
                    ) : (
                      <span className="text-gray-600 font-medium text-xs flex items-center gap-1">
                        <ScrollText className="h-3.5 w-3.5" /> <span>Continuous</span>
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      {expandedPlantId === plant.id ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                      <span>View STVs</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                        <div className="w-4 h-4 rounded border" style={{ backgroundColor: plant.bgColor }}></div>
                        {plant.bgColor}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                        <div className="w-4 h-4 rounded border" style={{ backgroundColor: plant.textColor }}></div>
                        {plant.textColor}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                        <div className="w-4 h-4 rounded border" style={{ backgroundColor: plant.borderColor }}></div>
                        {plant.borderColor}
                    </div>
                  </TableCell>
                  <TableCell>
                     <div 
                        className="px-2 py-1 text-xs border text-center font-bold rounded w-24"
                        style={{
                            backgroundColor: plant.bgColor,
                            color: plant.textColor,
                            borderColor: plant.borderColor,
                            borderWidth: "1px"
                        }}
                    >
                        {plant.name}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleEdit(plant);
                      }}
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive"
                      onClick={(event) => {
                        event.stopPropagation();
                        deleteMutation.mutate(plant.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
                {expandedPlantId === plant.id ? (
                  <TableRow>
                    <TableCell colSpan={9}>
                      <div className="rounded-xl border bg-white p-0 shadow-sm">
                        <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/40 px-5 py-3">
                          <div className="flex items-center gap-3">
                            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-white shadow-sm">
                              <Tag className="h-4 w-4 text-muted-foreground" />
                            </div>
                            <div className="space-y-0.5">
                              <div className="text-sm font-semibold">STV Directory</div>
                              <div className="text-xs text-muted-foreground">{plant.name}</div>
                            </div>
                          </div>
                          <div className="rounded-full border bg-white px-3 py-1 text-xs font-medium text-muted-foreground">
                            {stvs?.length ?? 0} STVs
                          </div>
                        </div>

                        <div className="px-5 py-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="flex w-full max-w-md gap-2">
                              <Input
                                placeholder="Add STV"
                                value={newStv}
                                onChange={(event) => setNewStv(event.target.value)}
                                onClick={(event) => event.stopPropagation()}
                              />
                              <Button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleAddStv();
                                }}
                                disabled={createStvMutation.isPending || !newStv.trim()}
                              >
                                Add
                              </Button>
                            </div>
                          </div>

                          {isStvsLoading ? (
                            <div className="mt-4 text-sm text-muted-foreground">Loading STVs...</div>
                          ) : stvs && stvs.length > 0 ? (
                            <div className="mt-4 space-y-2">
                              {stvs.map((stv: any, index: number) => (
                                <div key={stv.id} className="flex items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2">
                                  <div className="flex h-7 w-7 items-center justify-center rounded-full border bg-white text-xs font-semibold text-muted-foreground">
                                    {String(index + 1).padStart(2, "0")}
                                  </div>
                                  {editingStvId === stv.id ? (
                                    <div className="flex flex-1 flex-wrap items-center gap-2">
                                      <Input
                                        value={editingStvValue}
                                        onChange={(event) => setEditingStvValue(event.target.value)}
                                        onClick={(event) => event.stopPropagation()}
                                      />
                                      <Button
                                        type="button"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          updateStvMutation.mutate({
                                            id: stv.id,
                                            stv: editingStvValue.trim(),
                                          });
                                        }}
                                        disabled={updateStvMutation.isPending || !editingStvValue.trim()}
                                      >
                                        Save
                                      </Button>
                                      <Button
                                        type="button"
                                        variant="outline"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          setEditingStvId(null);
                                          setEditingStvValue("");
                                        }}
                                      >
                                        Cancel
                                      </Button>
                                    </div>
                                  ) : (
                                    <>
                                      <div className="flex-1 text-sm font-semibold text-gray-900">
                                        {stv.stv}
                                      </div>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          setEditingStvId(stv.id);
                                          setEditingStvValue(stv.stv || "");
                                        }}
                                      >
                                        <Edit className="h-4 w-4" />
                                      </Button>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="text-destructive"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          deleteStvMutation.mutate(stv.id);
                                        }}
                                        disabled={deleteStvMutation.isPending}
                                      >
                                        <Trash2 className="h-4 w-4" />
                                      </Button>
                                    </>
                                  )}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="mt-4 text-sm text-muted-foreground">No STVs added yet.</div>
                          )}
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : null}
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
