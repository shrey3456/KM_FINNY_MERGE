import { useQuery } from "@tanstack/react-query";
import { useState, useEffect, useRef } from "react";
import { apiRequest } from "@/lib/queryClient";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Calendar, Activity, Filter, RefreshCcw, Search, User, CheckCircle2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";

type ActivityData = {
  id: number;
  pageName: string;
  action: string;
  entityType: string;
  entityId: string | null;
  details: string | null;
  userId: number | null;
  userName: string | null;
  createdAt: string;
};

export default function Activities() {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [actionFilter, setActionFilter] = useState("all-actions");
  const [pageFilter, setPageFilter] = useState("all-pages");
  const [liveUpdate, setLiveUpdate] = useState(true);
  const [activityCount, setActivityCount] = useState(0);
  const [newActivities, setNewActivities] = useState(0);
  const intervalRef = useRef<NodeJS.Timeout>();

  // Fetch activities data
  const { 
    data, 
    isLoading, 
    refetch, 
    isRefetching, 
    dataUpdatedAt
  } = useQuery({
    queryKey: ["activities"],
    queryFn: async () => {
      try {
        const res = await apiRequest("GET", `/api/activities`);
        if (!res.ok) {
          throw new Error(`Failed to fetch activities: ${res.status}`);
        }
        const activities = await res.json();
        
        // Debug logging to check if load operations activities exist in the response
        console.log("Activities from server:", activities.slice(0, 5));
        console.log("Page names in activities:", [...new Set(activities.map((a: any) => a.pageName))]);
        console.log("Entity types in activities:", [...new Set(activities.map((a: any) => a.entityType))]);
        
        // Update activity count - exclude test entries
        if (activities && Array.isArray(activities)) {
          // Filter out test activities
          const validActivities = activities.filter(
            (activity) => 
              activity.pageName?.toLowerCase() !== 'test' && 
              activity.action?.toLowerCase() !== 'test'
          );
          
          const previousCount = activityCount;
          setActivityCount(validActivities.length);
          
          // Calculate new activities
          if (previousCount > 0 && validActivities.length > previousCount) {
            const diff = validActivities.length - previousCount;
            setNewActivities((prev) => prev + diff);
            if (diff > 0) {
              toast({
                title: `${diff} New ${diff === 1 ? "Activity" : "Activities"}`,
                description: "New activities have been logged",
                variant: "default",
              });
            }
          }
        }
        
        return activities;
      } catch (error) {
        console.error("Error fetching activities:", error);
        return [];
      }
    },
    refetchInterval: liveUpdate ? 5000 : false, // Poll every 5 seconds if live update is enabled
  });

  // Show a notification when there are new activities
  useEffect(() => {
    if (newActivities > 0 && !isRefetching) {
      // Reset new activities counter when user manually refreshes
      setNewActivities(0);
    }
  }, [isRefetching, newActivities]);

  // Clean up interval on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  // Filter data based on search query and filters, excluding test entries
  // Log the entire dataset for reference
  console.log("Filter debug - Total activities:", data?.length);
  console.log("Filter debug - Action types:", [...new Set(data?.map(a => a.action))]);
  
  const filteredData = data
    ? data.filter((activity: ActivityData) => {
        // Exclude test entries completely
        if (activity.pageName?.toLowerCase() === 'test' || 
            activity.action?.toLowerCase() === 'test') {
          return false;
        }
        
        // Parse details to get reference number for search
        let referenceNumber = "";
        if (activity.details) {
          try {
            const details = JSON.parse(activity.details);
            referenceNumber = details.referenceNumber || "";
          } catch (e) {
            // Ignore parsing errors
          }
        }
        
        const matchesSearch =
          searchQuery === "" ||
          activity.pageName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
          activity.action?.toLowerCase().includes(searchQuery.toLowerCase()) ||
          activity.entityType?.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (activity.userName &&
            activity.userName.toLowerCase().includes(searchQuery.toLowerCase())) ||
          (activity.details &&
            activity.details.toLowerCase().includes(searchQuery.toLowerCase())) ||
          (referenceNumber && 
            referenceNumber.toLowerCase().includes(searchQuery.toLowerCase()));

        // Check if action matches the filter (with special handling for 'generated', 'deleted', and 'updated')
        let matchesAction = false;
        
        // Add debug logging for the actionFilter value
        console.log("ActionFilter:", actionFilter, "Activity:", activity.id, "Action:", activity.action, "EntityType:", activity.entityType);
        
        if (actionFilter.toLowerCase() === "all-actions") {
          // All actions should match regardless of type
          matchesAction = true;
          console.log("All actions filter - should match everything");
        } else if (actionFilter.toLowerCase() === "generated") {
          // Match "generated" filter with sales create activities or load operations create activities
          matchesAction = (activity.entityType?.toLowerCase() === "sale" && activity.action?.toLowerCase() === "create") ||
                          (activity.action?.toLowerCase() === "create" && (
                            activity.entityType?.toLowerCase() === "loadoperation" || 
                            activity.entityType?.toLowerCase() === "loadingoperation"
                          ));
        } else if (actionFilter.toLowerCase() === "deleted") {
          // Match "deleted" filter with "delete" action
          matchesAction = activity.action?.toLowerCase() === "delete";
        } else if (actionFilter.toLowerCase() === "updated") {
          // Match "updated" filter with "update" action
          matchesAction = activity.action?.toLowerCase() === "update";
        } else if (actionFilter.toLowerCase() === "update") {
          // Direct match for update action
          matchesAction = activity.action?.toLowerCase() === "update";
        } else if (actionFilter.toLowerCase() === "create") {
          // Direct match for create action 
          matchesAction = activity.action?.toLowerCase() === "create";
        } else if (actionFilter.toLowerCase() === "delete") {
          // Direct match for delete action
          matchesAction = activity.action?.toLowerCase() === "delete";
        } else {
          // Direct match for other action types
          matchesAction = activity.action?.toLowerCase() === actionFilter.toLowerCase();
        }
        
        // Debug log for action matching
        console.log("Action match result:", matchesAction);

        // Special handling for different page filters
        let matchesPage = false;
        
        // If "All Pages" is selected, show everything
        if (pageFilter.toLowerCase() === "all-pages") {
          matchesPage = true;
        }
        // For LoadOperations, include both LoadOperations and GJOperations and relevant entity types
        else if (pageFilter.toLowerCase() === "loadoperations") {
          matchesPage = activity.pageName?.toLowerCase() === "loadoperations" || 
                        activity.pageName?.toLowerCase() === "gjoperations" ||
                        activity.entityType?.toLowerCase() === "loadoperation" ||
                        activity.entityType?.toLowerCase() === "loadingoperation" ||
                        activity.entityType?.toLowerCase() === "loadoperations";
        } 
        // For Sales, include both Sales page and sale entity types
        else if (pageFilter.toLowerCase() === "sales") {
          matchesPage = activity.pageName?.toLowerCase() === "sales" || 
                        activity.entityType?.toLowerCase() === "sale";
        }
        // Default case: direct page name match
        else {
          matchesPage = activity.pageName?.toLowerCase() === pageFilter.toLowerCase();
        }

        return matchesSearch && matchesAction && matchesPage;
      })
    : [];

  // Sort activities by newest first (createdAt desc)
  const sortedData = filteredData.sort((a, b) => {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  // Extract unique action types and page names for filters, excluding test entries
  const actionTypes = data 
    ? Array.from(new Set(data.map((activity: ActivityData) => {
        // Normalize action names for consistency
        if (activity.entityType?.toLowerCase() === "sale" && activity.action?.toLowerCase() === "create") {
          return "generated";
        } else if (activity.action?.toLowerCase() === "create" && 
                  (activity.entityType?.toLowerCase() === "loadoperation" || 
                   activity.entityType?.toLowerCase() === "loadingoperation")) {
          return "generated";
        } else if (activity.action?.toLowerCase() === "delete") {
          return "deleted";
        } else if (activity.action?.toLowerCase() === "update") {
          return "updated";
        } else {
          return activity.action;
        }
      })))
        .filter(Boolean)
        .filter((action) => action?.toLowerCase() !== 'test')
        .sort()
    : [];
    
  // Get unique page names with special handling for LoadOperations and GJOperations
  const pageNames = data
    ? Array.from(new Set(data.map((activity: ActivityData) => {
        // Normalize page names for consistency
        if (activity.pageName?.toLowerCase() === "loadoperations" || 
            activity.pageName?.toLowerCase() === "gjoperations" ||
            activity.entityType?.toLowerCase() === "loadoperation" || 
            activity.entityType?.toLowerCase() === "loadoperations" ||
            activity.entityType?.toLowerCase() === "loadingoperation") {
          return "LoadOperations";
        } else if (activity.pageName?.toLowerCase() === "sales" || 
                   activity.entityType?.toLowerCase() === "sale") {
          return "Sales";
        } else if (activity.pageName?.toLowerCase() === "proformaslips") {
          return "ProformaSlips";
        } else {
          return activity.pageName;
        }
      })))
        .filter(Boolean)
        .filter((page) => page?.toLowerCase() !== 'test')
        .sort()
    : [];

  // Format date for display
  const formatDate = (dateString: string) => {
    try {
      const date = new Date(dateString);
      return format(date, "dd-MM-yyyy");
    } catch (error) {
      return dateString;
    }
  };

  // Format time for display in 24-hour format
  const formatTime = (dateString: string) => {
    try {
      const date = new Date(dateString);
      return format(date, "HH:mm:ss");
    } catch (error) {
      return "";
    }
  };

  // Format JSON details for display
  const formatDetails = (details: string | null, activityType: string, entityType: string) => {
    if (!details) return "—";
    
    // Special handling for encoded JSON strings that might appear as plain text
    if (details.includes("{") && details.includes("}") && 
        (details.includes("changedFields") || details.includes("operationId") || 
        details.includes("referenceNumber") || details.includes("oldStatus"))) {
      try {
        // This handles the case where the details string is a raw JSON string
        // that wasn't properly stored as JSON in the database
        const detailsObj = JSON.parse(details.replace(/\\/g, ""));
        const referenceNumber = detailsObj.referenceNumber || "";
        
        if (referenceNumber) {
          return (
            <div className="flex flex-col gap-1">
              <div>
                <span className="text-[#001d6e] font-medium">Order #{referenceNumber}</span>
              </div>
              {(detailsObj.oldStatus && detailsObj.newStatus) && 
                <div>
                  <span className="font-medium">
                    Status changed from {detailsObj.oldStatus} to {detailsObj.newStatus}
                  </span>
                </div>
              }
            </div>
          );
        }
      } catch (e) {
        // If parsing fails, continue with normal processing
      }
    }
    
    try {
      const parsed = JSON.parse(details);
      
      // For sales activities, show order number, dealer name, amount, and date in a structured format
      if (entityType === "sale") {
        const orderDate = parsed.orderDate ? format(new Date(parsed.orderDate), "dd/MM/yyyy") : "";
        const orderNumber = parsed.orderNumber || "";
        const dealer = parsed.dealer || "Unknown";
        const amount = parsed.amount || "0";
        
        return (
          <div className="flex flex-col gap-1">
            <div>
              <span className="text-[#001d6e] font-medium">Order #{orderNumber}</span>
              <span>, {dealer}</span>
            </div>
            <div>
              <span className="font-medium">₹{amount}</span>
              {orderDate && <span>, Date: {orderDate}</span>}
            </div>
          </div>
        );
      }
      
      // For Load Operations activities, highlight the order/reference number and key details
      if (entityType?.toLowerCase() === "loadoperation" || 
          entityType?.toLowerCase() === "loadoperations" ||
          entityType?.toLowerCase() === "loadingoperation" || 
          activity.pageName?.toLowerCase() === "loadoperations" || 
          activity.pageName?.toLowerCase() === "gjoperations") {
        
        // Extract essential information for load operations
        const referenceNumber = parsed.referenceNumber || "";
        const plant = parsed.plant || parsed.plantName || "";
        const vehicleNumber = parsed.vehicleNumber || "";
        const status = parsed.status || "";
        
        if (referenceNumber) {
          let statusInfo = "";
          // For status changes, highlight the status change
          if (parsed.oldStatus && parsed.newStatus) {
            statusInfo = (
              <span className="font-medium">
                Status changed from {parsed.oldStatus} to {parsed.newStatus}
              </span>
            );
          } else if (status) {
            statusInfo = (
              <span>
                Status: <span className="font-medium">{status}</span>
              </span>
            );
          }
          
          return (
            <div className="flex flex-col gap-1">
              <div>
                <span className="text-[#001d6e] font-medium">Order #{referenceNumber}</span>
                {plant && <span>, {plant}</span>}
                {vehicleNumber && <span>, Vehicle: {vehicleNumber}</span>}
              </div>
              {statusInfo && <div>{statusInfo}</div>}
            </div>
          );
        }
      }
      
      // For status changes, highlight the status change specifically
      if (parsed.oldStatus && parsed.newStatus) {
        return (
          <div className="flex flex-col gap-1">
            <div>
              {parsed.referenceNumber && (
                <span className="text-[#001d6e] font-medium">Order #{parsed.referenceNumber}</span>
              )}
              {parsed.plant && <span>, {parsed.plant}</span>}
              {parsed.vehicleNumber && <span>, Vehicle: {parsed.vehicleNumber}</span>}
            </div>
            <div>
              <span className="font-medium">
                Status changed from {parsed.oldStatus} to {parsed.newStatus}
              </span>
            </div>
          </div>
        );
      }
      
      // For other changes, show more readable format
      return Object.entries(parsed)
        .filter(([key, _]) => !['operationId', 'entityId', 'referenceNumber', 'status'].includes(key)) // Remove redundant fields and referenceNumber (shown in badge)
        .map(([key, value]) => {
          // Format key names to be more readable
          const formattedKey = key
            .replace(/([A-Z])/g, ' $1') // Add space before capital letters
            .replace(/^./, str => str.toUpperCase()); // Capitalize first letter
          
          return `${formattedKey}: ${value}`;
        })
        .join(", ");
    } catch (error) {
      // For plain strings with load operation details that fail JSON parsing
      if (typeof details === 'string' && 
         (details.includes('referenceNumber') || details.includes('operationId'))) {
        
        // Try to extract reference number using regex
        const refMatch = details.match(/"referenceNumber":"(\d+)"/);
        const refNumber = refMatch ? refMatch[1] : null;
        
        // Try to extract plant using regex
        const plantMatch = details.match(/"plant":"([^"]+)"/);
        const plant = plantMatch ? plantMatch[1] : null;
        
        // Try to extract vehicle number using regex
        const vehicleMatch = details.match(/"vehicleNumber":"([^"]+)"/);
        const vehicleNumber = vehicleMatch ? vehicleMatch[1] : null;
        
        // Try to extract status changes
        const oldStatusMatch = details.match(/"oldStatus":"([^"]+)"/);
        const newStatusMatch = details.match(/"newStatus":"([^"]+)"/);
        const oldStatus = oldStatusMatch ? oldStatusMatch[1] : null;
        const newStatus = newStatusMatch ? newStatusMatch[1] : null;
        
        if (refNumber) {
          return (
            <div className="flex flex-col gap-1">
              <div>
                <span className="text-[#001d6e] font-medium">Order #{refNumber}</span>
                {plant && <span>, {plant}</span>}
                {vehicleNumber && <span>, Vehicle: {vehicleNumber}</span>}
              </div>
              {(oldStatus && newStatus) && 
                <div>
                  <span className="font-medium">
                    Status changed from {oldStatus} to {newStatus}
                  </span>
                </div>
              }
            </div>
          );
        }
      }
      
      return details;
    }
  };

  // Get badge color based on action type
  const getActionBadgeColor = (action: string) => {
    switch (action.toLowerCase()) {
      case "create":
        return "bg-green-100 text-green-800 hover:bg-green-100";
      case "update":
        return "bg-blue-100 text-blue-800 hover:bg-blue-100";
      case "delete":
        return "bg-blue-100 text-blue-800 hover:bg-blue-100";
      case "import":
        return "bg-purple-100 text-purple-800 hover:bg-purple-100";
      case "export":
        return "bg-yellow-100 text-yellow-800 hover:bg-yellow-100";
      case "test":
        return "bg-teal-100 text-teal-800 hover:bg-teal-100";
      default:
        return "bg-gray-100 text-gray-800 hover:bg-gray-100";
    }
  };

  // No pagination — every row renders at once.
  const paginated = sortedData;

  return (
    <div className="container-fluid px-4 md:px-6 py-6 space-y-6 max-w-full">
      <div className="flex flex-col space-y-4">
        <div className="flex flex-col md:flex-row md:justify-between md:items-center gap-4">
          <h2 className="text-2xl font-bold tracking-tight flex items-center">
            <Activity className="h-6 w-6 mr-2 text-[#001d6e]" />
            <span className="text-[#001d6e]">Activities</span>
            <Badge variant="outline" className="ml-2">
              {activityCount} Total
            </Badge>
          </h2>
          
          <div className="flex gap-2">
            <Button
              variant={liveUpdate ? "default" : "outline"}
              size="sm"
              onClick={() => setLiveUpdate(!liveUpdate)}
              className="w-full md:w-auto"
            >
              {liveUpdate ? (
                <>
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  Live Updates On
                </>
              ) : (
                <>
                  <RefreshCcw className="h-4 w-4 mr-2" />
                  Live Updates Off
                </>
              )}
            </Button>
            
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              className="w-full md:w-auto"
              disabled={isRefetching}
            >
              <RefreshCcw className={`h-4 w-4 mr-2 ${isRefetching ? "animate-spin" : ""}`} />
              Refresh {newActivities > 0 && `(${newActivities} new)`}
            </Button>
          </div>
        </div>

        {/* Last updated timestamp */}
        <div className="text-sm text-muted-foreground">
          Last updated: {dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : "Never"}
          {liveUpdate && " • Live updates enabled"}
        </div>

        {/* Filters */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search activities..."
              className="pl-8"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div className="flex items-center space-x-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <Select
              value={actionFilter}
              onValueChange={setActionFilter}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Filter by action" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all-actions">All Actions</SelectItem>
                <SelectItem value="generated">Generated</SelectItem>
                <SelectItem value="update">Updated</SelectItem>
                <SelectItem value="delete">Deleted</SelectItem>
                {/* Debug for action types */}
                {console.log("Action types from data:", actionTypes)}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center space-x-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <Select 
              value={pageFilter} 
              onValueChange={setPageFilter}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Filter by page" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all-pages">All Pages</SelectItem>
                {pageNames.map((page) => {
                  const pageValue = page as string;
                  if (!pageValue) return null;
                  
                  // Convert to user-friendly name
                  let displayName = pageValue;
                  if (pageValue === "LoadOperations") {
                    displayName = "Load Operations";
                  }
                  
                  return (
                    <SelectItem key={pageValue} value={pageValue.toLowerCase()}>
                      {displayName}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Activity Log</CardTitle>
          <CardDescription>
            Track all user activities across the application in real-time
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {Array.from({ length: 5 }).map((_, index) => (
                <div key={index} className="flex flex-col gap-2">
                  <Skeleton className="h-5 w-full" />
                  <Skeleton className="h-5 w-3/4" />
                </div>
              ))}
            </div>
          ) : paginated.length === 0 ? (
            <div className="text-center py-10">
              <p className="text-muted-foreground">
                {data?.length === 0 
                  ? "No activities recorded yet" 
                  : "No activities match the current filters"}
              </p>
            </div>
          ) : (
            <>
              {/* Desktop view with table */}
              <div className="hidden md:block overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="whitespace-nowrap">Time</TableHead>
                      <TableHead className="whitespace-nowrap">User</TableHead>
                      <TableHead className="whitespace-nowrap">Page</TableHead>
                      <TableHead className="whitespace-nowrap">Action</TableHead>
                      <TableHead className="whitespace-nowrap">Details</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginated.map((activity: ActivityData) => (
                      <TableRow key={activity.id}>
                        <TableCell className="whitespace-nowrap">
                          <div className="flex flex-col">
                            <div className="flex items-center">
                              <Calendar className="h-4 w-4 mr-1 text-muted-foreground" />
                              <span>{formatDate(activity.createdAt)}</span>
                            </div>
                            <div className="text-xs text-muted-foreground ml-5">
                              {formatTime(activity.createdAt)}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <User className="h-4 w-4 text-muted-foreground" />
                            <span>{(activity.entityType === "sale" && activity.action === "create") ? "System" : activity.userName || "System"}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {activity.pageName === "LoadOperations" || activity.pageName === "GJOperations"
                              ? "Load Operations" 
                              : activity.pageName === "ProformaSlips"
                              ? "Proforma Slips"
                              : activity.pageName === "Sales"
                              ? "Sales"
                              : activity.pageName}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge className={getActionBadgeColor(activity.action || '')}>
                            {activity.entityType === "sale" && activity.action === "create" 
                              ? "generated" 
                              : activity.action === "delete"
                                ? "deleted"
                                : activity.action === "update"
                                  ? "updated"
                                  : activity.action === "create" && (activity.entityType === "loadOperation" || activity.entityType === "loadingOperation")
                                    ? "created"
                                    : activity.action}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-xs">
                          <div className="flex flex-col gap-1">
                            <div className="break-words text-sm">{formatDetails(activity.details, activity.action, activity.entityType)}</div>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              
              {/* Mobile view with cards */}
              <div className="md:hidden space-y-4">
                {paginated.map((activity: ActivityData) => {
                  // Get formatted action text
                  const actionText = activity.entityType === "sale" && activity.action === "create" 
                    ? "generated" 
                    : activity.action === "delete"
                      ? "deleted"
                      : activity.action === "update"
                        ? "updated"
                        : activity.action === "create" && (activity.entityType === "loadOperation" || activity.entityType === "loadingOperation")
                          ? "created"
                          : activity.action;
                          
                  // Get formatted page name        
                  const pageName = activity.pageName === "LoadOperations" || activity.pageName === "GJOperations"
                    ? "Load Operations" 
                    : activity.pageName === "ProformaSlips"
                    ? "Proforma Slips"
                    : activity.pageName === "Sales"
                    ? "Sales"
                    : activity.pageName;
                  
                  return (
                    <Card key={activity.id} className="overflow-hidden">
                      <CardHeader className="pb-2 pt-3">
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline">
                              {pageName}
                            </Badge>
                            <Badge className={getActionBadgeColor(activity.action || '')}>
                              {actionText}
                            </Badge>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {formatDate(activity.createdAt)}, {formatTime(activity.createdAt)}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 text-sm text-muted-foreground mb-1">
                          <User className="h-3 w-3" />
                          <span>{(activity.entityType === "sale" && activity.action === "create") ? "System" : activity.userName || "System"}</span>
                        </div>
                      </CardHeader>
                      <CardContent className="pt-0 pb-3">
                        <div className="text-sm">
                          {formatDetails(activity.details, activity.action, activity.entityType)}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>

            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}