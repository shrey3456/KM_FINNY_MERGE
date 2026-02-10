import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
import { Trash2, Edit, Plus, Factory } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";

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

export default function PlantSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingPlant, setEditingPlant] = useState<any>(null);

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
  const { data: plants, isLoading } = useQuery({
    queryKey: ["/api/plants"],
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plants"] });
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
    onSuccess: async () => {
      // Wait for query to refetch before closing dialog
      await queryClient.invalidateQueries({ queryKey: ["/api/plants"] });
      await queryClient.refetchQueries({ queryKey: ["/api/plants"] });
      toast({ title: "Success", description: "Plant updated successfully" });
      setIsDialogOpen(false);
      setEditingPlant(null);
    },
     onError: (err: any) => {
      console.error('❌ Update error:', err);
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  });

  // Delete Mutation
  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/plants/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plants"] });
      toast({ title: "Deleted", description: "Plant removed successfully" });
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

  return (
    <div className="container mx-auto py-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2">
            <Factory className="h-6 w-6" />
            Plant Management
        </h1>
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
                <TableHead>Background</TableHead>
                <TableHead>Text</TableHead>
                <TableHead>Border</TableHead>
                <TableHead>Preview</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={8} className="text-center">Loading...</TableCell></TableRow>
              ) : plants?.map((plant: any) => (
                <TableRow key={plant.id}>
                  <TableCell className="font-medium">{plant.name}</TableCell>
                  {/* ADD THIS: Locking Status Column */}
                  <TableCell>
                    {plant.isLockingEnabled ? (
                      <span className="text-green-600 text-xs flex items-center gap-1">
                        🔒 <span>Once</span>
                      </span>
                    ) : (
                      <span className="text-orange-600 text-xs flex items-center gap-1">
                        ⚠️ <span>Unlimited</span>
                      </span>
                    )}
                  </TableCell>
                  {/* ADD THIS: Split Pages Status Column */}
                  <TableCell>
                    {plant.isSplitPagesEnabled ? (
                      <span className="text-blue-600 text-xs flex items-center gap-1">
                        📄 <span>Multi</span>
                      </span>
                    ) : (
                      <span className="text-gray-600 text-xs flex items-center gap-1">
                        📜 <span>Continuous</span>
                      </span>
                    )}
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
                    <Button variant="ghost" size="icon" onClick={() => handleEdit(plant)}>
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="text-destructive" onClick={() => deleteMutation.mutate(plant.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}