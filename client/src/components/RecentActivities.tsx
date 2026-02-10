import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useQuery } from "@tanstack/react-query";
import { Loader2, FileText, Package, TruckIcon } from "lucide-react";
import { format, parseISO } from "date-fns";
import { useUser } from "@/hooks/use-user";

// Function to determine the icon based on the activity type
const getActivityIcon = (type: string) => {
  switch (type.toLowerCase()) {
    case 'scan':
      return <Package className="h-5 w-5 text-blue-500" />;
    case 'load':
      return <TruckIcon className="h-5 w-5 text-green-500" />;
    case 'proforma':
      return <FileText className="h-5 w-5 text-purple-500" />;
    default:
      return <FileText className="h-5 w-5 text-gray-500" />;
  }
};

export function RecentActivities() {
  const { user } = useUser();
  
  // Fetch recent activities (last 3)
  const { data: activities = [], isLoading } = useQuery({
    queryKey: ['/api/activities/recent'],
    queryFn: async () => {
      const response = await fetch('/api/activities/recent?limit=3');
      if (!response.ok) {
        throw new Error('Failed to fetch recent activities');
      }
      return response.json();
    },
    enabled: !!user,
    // Keep the data fresh but don't refetch too often
    refetchInterval: 60000, // 1 minute
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Recent Activities</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
          </div>
        </CardContent>
      </Card>
    );
  }

  // If no activities, show a message
  if (activities.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Recent Activities</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-center text-sm text-gray-500 py-4">
            No recent activities found
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg text-[#001d6e]">Recent Activities</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {activities.map((activity: any) => (
          <div key={activity.id} className="flex items-start space-x-3 py-2 border-b last:border-0">
            <div className="flex-shrink-0 mt-1">
              {getActivityIcon(activity.type)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium line-clamp-1">
                {activity.description}
              </p>
              <div className="flex items-center text-xs text-gray-500 mt-1 space-x-2">
                <span>{activity.userName || 'System'}</span>
                <span>•</span>
                <span>
                  {activity.timestamp
                    ? format(parseISO(activity.timestamp), 'MM/dd/yyyy hh:mm a')
                    : 'Unknown time'}
                </span>
              </div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export default RecentActivities;