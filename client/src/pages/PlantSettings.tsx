import React, { useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
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
import type { LucideIcon } from "lucide-react";
import { Trash2, Edit, Plus, Factory, Printer, Lock, Unlock, FileText, ScrollText, ChevronDown, ChevronRight, Tag, CheckCircle2, Hand, Zap } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Link } from "wouter";
import { hasPageWriteAccess } from "@/lib/permissions";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { TableCard } from "@/components/ui/table-card";

// Schema matching shared/schema.ts
const plantFormSchema = z.object({
  name: z.string().min(1, "Plant name is required"),
  bgColor: z.string().min(1, "Background color is required"),
  textColor: z.string().min(1, "Text color is required"),
  borderColor: z.string().min(1, "Border color is required"),
  // Short code for the Indian state this plant is in (e.g. "GJ", "MP") — drives which
  // per-state pallet-size column on a product (gjPlt/mpPlt) a scan against this plant reads.
  // Optional so existing plants don't fail validation until an admin fills it in.
  state: z.string().optional(),
  isLockingEnabled: z.boolean().default(true),
  isSplitPagesEnabled: z.boolean().default(false),
  isAutoCompleteEnabled: z.boolean().default(false),
  isAutoScanEnabled: z.boolean().default(false),
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

// ─── Dialog form building blocks ──────────────────────────────────────────────

/** Small navy section heading with a hairline rule, matching the Users form layout. */
function FormSection({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0 text-[#001d6e]" />
        <h4 className="text-[11px] font-bold uppercase tracking-wide text-[#001d6e]">{title}</h4>
        <div className="h-px flex-1 bg-gray-200" />
      </div>
      {children}
    </div>
  );
}

/** One labelled on/off row. The description swaps with the switch so the effect is always stated. */
function SettingToggle({
  icon: Icon, title, checked, onChange, onText, offText, tone,
}: {
  icon: LucideIcon; title: string; checked: boolean; onChange: (v: boolean) => void;
  onText: string; offText: string; tone: string;
}) {
  return (
    <FormItem className="flex flex-row items-start justify-between gap-3 rounded-xl border bg-gray-50/60 p-3">
      <div className="min-w-0 space-y-0.5">
        <FormLabel className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
          <Icon className={`h-3.5 w-3.5 shrink-0 ${checked ? tone : "text-gray-400"}`} />
          {title}
        </FormLabel>
        <div className="text-xs leading-snug text-muted-foreground">{checked ? onText : offText}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5 shrink-0" />
    </FormItem>
  );
}

export default function PlantSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingPlant, setEditingPlant] = useState<any>(null);
  const [expandedPlantId, setExpandedPlantId] = useState<number | null>(null);
  const [plantSearch, setPlantSearch] = useState("");
  const [newStv, setNewStv] = useState("");
  const [editingStvId, setEditingStvId] = useState<number | null>(null);
  const [editingStvValue, setEditingStvValue] = useState("");
  const canWrite = hasPageWriteAccess("plant-management");

  const form = useForm<PlantFormValues>({
    resolver: zodResolver(plantFormSchema),
    defaultValues: {
      name: "",
      bgColor: "#ffffff",
      textColor: "#000000",
      borderColor: "#cccccc",
      state: "",
      isLockingEnabled: true,
      isSplitPagesEnabled: false,
      isAutoCompleteEnabled: false,
      isAutoScanEnabled: false,
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
      toast({ title: "Success", description: "Dispatch Directory added" });
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
      toast({ title: "Success", description: "Dispatch Directory updated" });
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
      toast({ title: "Deleted", description: "Dispatch Directory removed" });
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
      state: plant.state ?? "",
      isLockingEnabled: plant.isLockingEnabled !== undefined && plant.isLockingEnabled !== null ? plant.isLockingEnabled : true,
      isSplitPagesEnabled: plant.isSplitPagesEnabled !== undefined && plant.isSplitPagesEnabled !== null ? plant.isSplitPagesEnabled : false,
      isAutoCompleteEnabled: plant.isAutoCompleteEnabled !== undefined && plant.isAutoCompleteEnabled !== null ? plant.isAutoCompleteEnabled : false,
      isAutoScanEnabled: plant.isAutoScanEnabled !== undefined && plant.isAutoScanEnabled !== null ? plant.isAutoScanEnabled : false,
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
        state: "",
        isLockingEnabled: true,
        isSplitPagesEnabled: false,
        isAutoCompleteEnabled: false,
        isAutoScanEnabled: false,
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
        state: "",
        isLockingEnabled: true,
        isSplitPagesEnabled: false,
        isAutoCompleteEnabled: false,
        isAutoScanEnabled: false,
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

  // ── Plants table ───────────────────────────────────────────────────────────
  const filteredPlants = (plants ?? []).filter((p: any) =>
    !plantSearch.trim() ||
    [p.name, p.bgColor, p.textColor, p.borderColor].some((v) =>
      String(v ?? "").toLowerCase().includes(plantSearch.toLowerCase()),
    ),
  );

  // A colour swatch + its hex, used by the three colour columns.
  const colorCell = (hex: string) => (
    <div className="flex items-center gap-2">
      <div className="h-4 w-4 shrink-0 rounded border" style={{ backgroundColor: hex }} />
      <span className="font-mono text-xs text-gray-600">{hex}</span>
    </div>
  );

  // A coloured icon + label, used by the four on/off status columns.
  const statusCell = (on: boolean, onIcon: ReactNode, onLabel: string, offIcon: ReactNode, offLabel: string, onClass: string) => (
    <span className={`flex items-center gap-1 text-xs font-medium ${on ? onClass : "text-gray-500"}`}>
      {on ? onIcon : offIcon} <span>{on ? onLabel : offLabel}</span>
    </span>
  );

  const plantColumns: DataTableColumn<any>[] = [
    {
      id: "name",
      header: "Name",
      width: 110,
      hideable: false,
      sortable: true,
      accessor: (p) => p.name,
      cellClassName: "font-medium text-gray-900",
      render: (p) => p.name,
    },
    {
      id: "state",
      header: "State",
      width: 80,
      sortable: true,
      accessor: (p) => p.state ?? "",
      render: (p) => p.state ? (
        <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-700">
          {p.state}
        </span>
      ) : (
        <span className="text-xs text-gray-400">—</span>
      ),
    },
    {
      id: "locking",
      header: "Print Locking",
      width: 100,
      sortable: true,
      accessor: (p) => (p.isLockingEnabled ? 1 : 0),
      render: (p) => statusCell(
        !!p.isLockingEnabled,
        <Lock className="h-3.5 w-3.5" />, "Locked",
        <Unlock className="h-3.5 w-3.5" />, "Unlocked",
        "text-red-600",
      ),
    },
    {
      id: "splitPages",
      header: "Split Pages",
      width: 105,
      sortable: true,
      accessor: (p) => (p.isSplitPagesEnabled ? 1 : 0),
      render: (p) => statusCell(
        !!p.isSplitPagesEnabled,
        <FileText className="h-3.5 w-3.5" />, "Splited",
        <ScrollText className="h-3.5 w-3.5" />, "Continuous",
        "text-blue-600",
      ),
    },
    {
      id: "autoComplete",
      header: "Auto Complete",
      width: 105,
      sortable: true,
      accessor: (p) => (p.isAutoCompleteEnabled ? 1 : 0),
      render: (p) => statusCell(
        !!p.isAutoCompleteEnabled,
        <CheckCircle2 className="h-3.5 w-3.5" />, "Auto",
        <Hand className="h-3.5 w-3.5" />, "Manual",
        "text-emerald-600",
      ),
    },
    {
      id: "autoScan",
      header: "Auto Scan",
      width: 95,
      sortable: true,
      accessor: (p) => (p.isAutoScanEnabled ? 1 : 0),
      render: (p) => statusCell(
        !!p.isAutoScanEnabled,
        <Zap className="h-3.5 w-3.5" />, "Auto",
        <FileText className="h-3.5 w-3.5" />, "Confirm",
        "text-amber-600",
      ),
    },
    {
      id: "stvs",
      header: "Dispatch Directories",
      width: 105,
      render: (p) => (
        <Button
          type="button"
          variant="ghost"
          className="h-auto px-2 py-1 text-xs text-muted-foreground"
          onClick={(event) => { event.stopPropagation(); handleToggleStvPanel(p); }}
        >
          <div className="flex items-center gap-1.5">
            {expandedPlantId === p.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <span>View Dispatch Directories</span>
          </div>
        </Button>
      ),
    },
    { id: "bgColor", header: "Background", width: 100, render: (p) => colorCell(p.bgColor) },
    { id: "textColor", header: "Text", width: 100, render: (p) => colorCell(p.textColor) },
    { id: "borderColor", header: "Border", width: 100, render: (p) => colorCell(p.borderColor) },
    {
      id: "preview",
      header: "Preview",
      width: 105,
      render: (p) => (
        <div
          className="w-24 rounded border px-2 py-1 text-center text-xs font-bold"
          style={{ backgroundColor: p.bgColor, color: p.textColor, borderColor: p.borderColor, borderWidth: "1px" }}
        >
          {p.name}
        </div>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      width: 88,
      align: "right",
      hideable: false,
      render: (p) => (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="icon"
            disabled={!canWrite}
            title={!canWrite ? "You have read-only access to Plant Management" : undefined}
            onClick={(event) => { event.stopPropagation(); handleEdit(p); }}
          >
            <Edit className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="text-destructive"
            disabled={!canWrite}
            title={!canWrite ? "You have read-only access to Plant Management" : undefined}
            onClick={(event) => { event.stopPropagation(); deleteMutation.mutate(p.id); }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ),
    },
  ];

  // STV directory panel for one plant — shared by the desktop table's expanded row and the
  // mobile card list below, so the two don't drift apart.
  const renderStvPanel = (plant: any) => (
    <div className="rounded-xl border bg-white p-0 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/40 px-5 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white shadow-sm">
            <Tag className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="space-y-0.5">
            <div className="text-sm font-semibold">Dispatch Directory</div>
            <div className="text-xs text-muted-foreground">{plant.name}</div>
          </div>
        </div>
        <div className="rounded-full border bg-white px-3 py-1 text-xs font-medium text-muted-foreground">
          {stvs?.length ?? 0} Dispatch Directories
        </div>
      </div>

      <div className="px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex w-full max-w-md gap-2">
            <Input
              placeholder="Add Dispatch Directory"
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
              disabled={createStvMutation.isPending || !newStv.trim() || !canWrite}
              title={!canWrite ? "You have read-only access to Plant Management" : undefined}
            >
              Add
            </Button>
          </div>
        </div>

        {isStvsLoading ? (
          <div className="mt-4 text-sm text-muted-foreground">Loading Dispatch Directories...</div>
        ) : stvs && stvs.length > 0 ? (
          <div className="mt-4 space-y-2">
            {stvs.map((stv: any, index: number) => (
              <div key={stv.id} className="flex items-center gap-3 rounded-xl border bg-muted/30 px-3 py-2">
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
                      disabled={updateStvMutation.isPending || !editingStvValue.trim() || !canWrite}
                      title={!canWrite ? "You have read-only access to Plant Management" : undefined}
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
                      disabled={!canWrite}
                      title={!canWrite ? "You have read-only access to Plant Management" : undefined}
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
                      disabled={deleteStvMutation.isPending || !canWrite}
                      title={!canWrite ? "You have read-only access to Plant Management" : undefined}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-4 text-sm text-muted-foreground">No Dispatch Directories added yet.</div>
        )}
      </div>
    </div>
  );

  return (
    <div className="w-full px-4 py-6 sm:py-8 sm:px-6">
      <div className="flex flex-col gap-3 mb-6 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl sm:text-2xl font-bold flex items-center gap-2">
            <Factory className="h-6 w-6 shrink-0 text-[#001d6e]" style={{ fill: "#4d7eff" }} />
            Plant Master
        </h1>
        <div className="flex gap-2">
          <Link href="/print-operations" className="flex-1 sm:flex-initial">
            <Button variant="outline" className="w-full sm:w-auto">
              <Printer className="mr-2 h-4 w-4 shrink-0" />
              <span className="sm:hidden">Print Ops</span>
              <span className="hidden sm:inline">Print Operations</span>
            </Button>
          </Link>
          <Dialog open={isDialogOpen} onOpenChange={handleDialogChange}>
            <DialogTrigger asChild>
              <Button onClick={handleAddNew} disabled={!canWrite} title={!canWrite ? "You have read-only access to Plant Management" : undefined} className="flex-1 sm:flex-initial">
                <Plus className="mr-2 h-4 w-4 shrink-0" /> <span className="sm:hidden">Add Plant</span><span className="hidden sm:inline">Add New Plant</span>
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] gap-0 overflow-hidden p-0 sm:max-w-2xl">
              {/* Navy header band, matching the page headers elsewhere in the app. */}
              <DialogHeader className="space-y-0 bg-gradient-to-r from-[#001d6e] to-[#0a2b7e] px-5 py-3.5 text-left">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15 ring-1 ring-inset ring-white/20">
                    <Factory className="h-4.5 w-4.5 text-white" />
                  </div>
                  <div>
                    <DialogTitle className="text-base font-bold text-white">
                      {editingPlant ? "Edit Plant" : "Add New Plant"}
                    </DialogTitle>
                    <p className="text-xs text-white/60">
                      {editingPlant ? `Updating ${editingPlant.name}` : "Configure a plant's print behaviour and slip colours"}
                    </p>
                  </div>
                </div>
              </DialogHeader>

              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="flex max-h-[calc(90vh-8rem)] flex-col">
                  <div className="space-y-5 overflow-y-auto px-5 py-4">
                    <FormSection icon={Factory} title="Details">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <FormField
                          control={form.control}
                          name="name"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs font-medium text-gray-700">Plant Name (ID)</FormLabel>
                              <FormControl>
                                <Input placeholder="e.g. VALSAD" className="h-9" {...field} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="state"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs font-medium text-gray-700">State Code</FormLabel>
                              <FormControl>
                                <Input placeholder="e.g. GJ" className="h-9 uppercase" {...field} />
                              </FormControl>
                              {/* Drives which per-state pallet-size column (gjPlt/mpPlt) products
                                  resolve for scans against this plant — see products.mpPlt/gjPlt. */}
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                    </FormSection>

                    <FormSection icon={Printer} title="Print Behaviour">
                      <div className="grid gap-2 sm:grid-cols-2">
                        <FormField
                          control={form.control}
                          name="isLockingEnabled"
                          render={({ field }) => (
                            <SettingToggle
                              icon={Lock}
                              title="Print Locking"
                              tone="text-red-600"
                              checked={field.value}
                              onChange={field.onChange}
                              onText="Slips can only be printed once (locked after first print)"
                              offText="Unlimited prints allowed (no locking)"
                            />
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="isSplitPagesEnabled"
                          render={({ field }) => (
                            <SettingToggle
                              icon={FileText}
                              title="Split Pages"
                              tone="text-blue-600"
                              checked={field.value}
                              onChange={field.onChange}
                              onText="Print will be split across multiple pages"
                              offText="Print will be continuous (single long page)"
                            />
                          )}
                        />
                      </div>
                    </FormSection>

                    <FormSection icon={Zap} title="Order Scan Behaviour">
                      <div className="grid gap-2 sm:grid-cols-2">
                        <FormField
                          control={form.control}
                          name="isAutoCompleteEnabled"
                          render={({ field }) => (
                            <SettingToggle
                              icon={CheckCircle2}
                              title="Auto Complete"
                              tone="text-emerald-600"
                              checked={field.value}
                              onChange={field.onChange}
                              onText="A part completes itself the instant every item is fully scanned — except the last part of a group, which always waits for the manual Complete button"
                              offText="Parts only complete when an admin clicks Complete (default)"
                            />
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="isAutoScanEnabled"
                          render={({ field }) => (
                            <SettingToggle
                              icon={Zap}
                              title="Auto Scan"
                              tone="text-amber-600"
                              checked={field.value}
                              onChange={field.onChange}
                              onText="A full pallet (or more) remaining scans automatically with a 5s image popup — only a leftover loose amount opens the confirm dialog"
                              offText="Every scan opens the confirm dialog (default)"
                            />
                          )}
                        />
                      </div>
                    </FormSection>

                    <FormSection icon={Tag} title="Slip Colours">
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        {([
                          { name: "bgColor", label: "Background", placeholder: "#ffffff" },
                          { name: "textColor", label: "Text", placeholder: "#000000" },
                          { name: "borderColor", label: "Border", placeholder: "#cccccc" },
                        ] as const).map((c) => (
                          <FormField
                            key={c.name}
                            control={form.control}
                            name={c.name}
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel className="text-xs font-medium text-gray-700">{c.label}</FormLabel>
                                <div className="flex gap-2">
                                  <FormControl>
                                    <Input type="color" className="h-9 w-11 shrink-0 cursor-pointer p-1" {...field} />
                                  </FormControl>
                                  <Input {...field} placeholder={c.placeholder} className="h-9 font-mono text-xs" />
                                </div>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        ))}
                      </div>

                      {/* Live preview of the printed slip header. */}
                      <div className="rounded-xl border bg-gray-50/60 p-3">
                        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Preview</p>
                        <div
                          className="rounded border p-4 text-center font-bold"
                          style={{
                            backgroundColor: form.watch("bgColor"),
                            color: form.watch("textColor"),
                            borderColor: form.watch("borderColor"),
                            borderWidth: "2px",
                          }}
                        >
                          KRUPA MARKETING - {form.watch("name")?.toUpperCase() || "PLANT NAME"}
                          <div className="mt-2 space-y-0.5 text-xs font-medium opacity-75">
                            <div>{form.watch("isLockingEnabled") ? "Print once only" : "Unlimited prints"}</div>
                            <div>{form.watch("isSplitPagesEnabled") ? "Multi-page mode" : "Continuous mode"}</div>
                            <div>{form.watch("isAutoCompleteEnabled") ? "Auto Complete on" : "Manual Complete only"}</div>
                            <div>{form.watch("isAutoScanEnabled") ? "Auto Scan on" : "Confirm every scan"}</div>
                          </div>
                        </div>
                      </div>
                    </FormSection>
                  </div>

                  {/* Sticky footer so the action stays reachable on a long form. */}
                  <div className="flex shrink-0 justify-end gap-2 border-t bg-gray-50/80 px-5 py-3">
                    <Button type="button" variant="outline" className="h-9" onClick={() => handleDialogChange(false)}>
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      className="h-9 bg-[#001d6e] text-white hover:bg-[#00154b]"
                      disabled={createMutation.isPending || updateMutation.isPending || !canWrite}
                    >
                      {editingPlant ? "Update Plant" : "Create Plant"}
                    </Button>
                  </div>
                </form>
              </Form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <TableCard
        icon={Factory}
        title="Configured Plants"
        subtitle="Manage plant colors and print locking behavior"
        searchValue={plantSearch}
        onSearchChange={setPlantSearch}
        searchPlaceholder="Search plants…"
      >
        {/* Desktop/tablet: full table with every column. */}
        <div className="hidden sm:block">
          <DataTable<any>
            className="space-y-0"
            containerClassName="rounded-none border-0"
            columns={plantColumns}
            data={filteredPlants}
            getRowId={(plant) => String(plant.id)}
            isLoading={isLoading}
            loadingLabel="Loading plants…"
            emptyState="No plants configured yet."
            noResultsState="No plants match your search."
            hasActiveFilters={!!plantSearch}
            sortMode="client"
            // Paginated, with no isStickyHeader/maxHeight, so the table has no inner scroll box of
            // its own — matching develop.
            paginationMode="client"
            defaultPageSize={10}
            pageSizeOptions={[10, 25, 50, 100]}
            enableColumnResizing
            enableZebraStripes
            showMobileSwipeHint
            headerClassName="bg-[#001d6e] text-white border-[#1a3a9c] hover:bg-[#0a2b7e] hover:text-white"
            expandedRowId={expandedPlantId ? String(expandedPlantId) : null}
            renderExpandedRow={renderStvPanel}
          />
        </div>

        {/* Mobile: one card per plant instead of a sideways-scrolling table — the color
            columns collapse into a single name badge styled with the plant's actual print
            colors, since the exact hex values aren't actionable from a phone anyway (Edit
            still shows them). */}
        <div className="sm:hidden divide-y divide-gray-100">
          {isLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">Loading plants…</div>
          ) : filteredPlants.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              {plantSearch ? "No plants match your search." : "No plants configured yet."}
            </div>
          ) : (
            filteredPlants.map((plant: any) => (
              <div key={plant.id} className="p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <div
                      className="rounded border px-2.5 py-1 text-sm font-bold truncate"
                      style={{ backgroundColor: plant.bgColor, color: plant.textColor, borderColor: plant.borderColor, borderWidth: "1px" }}
                    >
                      {plant.name}
                    </div>
                    {plant.state && (
                      <span className="inline-flex shrink-0 items-center rounded-full bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-700">
                        {plant.state}
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={!canWrite}
                      title={!canWrite ? "You have read-only access to Plant Management" : undefined}
                      onClick={() => handleEdit(plant)}
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive"
                      disabled={!canWrite}
                      title={!canWrite ? "You have read-only access to Plant Management" : undefined}
                      onClick={() => deleteMutation.mutate(plant.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {statusCell(!!plant.isLockingEnabled, <Lock className="h-3.5 w-3.5" />, "Locked", <Unlock className="h-3.5 w-3.5" />, "Unlocked", "text-red-600")}
                  {statusCell(!!plant.isSplitPagesEnabled, <FileText className="h-3.5 w-3.5" />, "Split Pages", <ScrollText className="h-3.5 w-3.5" />, "Continuous", "text-blue-600")}
                  {statusCell(!!plant.isAutoCompleteEnabled, <CheckCircle2 className="h-3.5 w-3.5" />, "Auto Complete", <Hand className="h-3.5 w-3.5" />, "Manual Complete", "text-emerald-600")}
                  {statusCell(!!plant.isAutoScanEnabled, <Zap className="h-3.5 w-3.5" />, "Auto Scan", <FileText className="h-3.5 w-3.5" />, "Confirm Scan", "text-amber-600")}
                </div>

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full justify-center"
                  onClick={() => handleToggleStvPanel(plant)}
                >
                  {expandedPlantId === plant.id ? <ChevronDown className="h-4 w-4 mr-1.5" /> : <ChevronRight className="h-4 w-4 mr-1.5" />}
                  View Dispatch Directories
                </Button>

                {expandedPlantId === plant.id && (
                  <div className="pt-1">{renderStvPanel(plant)}</div>
                )}
              </div>
            ))
          )}
        </div>
      </TableCard>
    </div>
  );
}


