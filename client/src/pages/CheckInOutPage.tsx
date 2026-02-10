import React, { useState } from "react";
import { 
  Card, 
  CardContent, 
  CardHeader, 
  CardTitle, 
  CardDescription 
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useUser } from "@/hooks/use-user";
import { useQuery } from "@tanstack/react-query";
import { format, parseISO, startOfMonth, endOfMonth, eachDayOfInterval, isSameMonth, isSameDay, addMonths, subMonths } from "date-fns";
import { CheckCircle, XCircle, CalendarClock, ChevronLeft, ChevronRight } from "lucide-react";

export function CheckInOutPage() {
  const { user } = useUser();
  const { toast } = useToast();
  const [currentDate, setCurrentDate] = useState(new Date());

  // Get current user's name for filtering - use the actual name that matches Notion "Staff Name :" field
  const currentUserStr = localStorage.getItem('currentUser');
  const currentUser = currentUserStr ? JSON.parse(currentUserStr) : null;
  const userName = currentUser?.firstName || currentUser?.name || currentUser?.username?.replace('@km-finny', '') || '';

  // Fetch check-in/out records filtered by current user
  const { data: checkInOuts = [], isLoading } = useQuery({
    queryKey: ['/api/checkinouts', userName],
    queryFn: async () => {
      const url = userName ? `/api/checkinouts?userName=${encodeURIComponent(userName)}` : '/api/checkinouts';
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error('Failed to fetch check-in/out records');
      }
      return response.json();
    },
    enabled: !!user,
  });

  // Calendar navigation functions
  const goToPreviousMonth = () => {
    setCurrentDate(subMonths(currentDate, 1));
  };

  const goToNextMonth = () => {
    setCurrentDate(addMonths(currentDate, 1));
  };

  // Get calendar days for current month
  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(currentDate);
  const calendarDays = eachDayOfInterval({ start: monthStart, end: monthEnd });

  // Group check-in/out records by date and filter for current month only
  const recordsByDate = checkInOuts.reduce((acc: any, record: any) => {
    if (record.timestamp) {
      try {
        const recordDate = parseISO(record.timestamp);
        const date = format(recordDate, 'yyyy-MM-dd');
        
        // Only include records from the current month being viewed
        if (isSameMonth(recordDate, currentDate)) {
          if (!acc[date]) acc[date] = [];
          acc[date].push(record);
        }
      } catch (error) {
        console.error('Error parsing timestamp:', record.timestamp, error);
      }
    }
    return acc;
  }, {});

  // Debug: Log today's date and available record dates
  const today = format(new Date(), 'yyyy-MM-dd');
  const availableDates = Object.keys(recordsByDate);
  console.log('Today:', today, 'Available dates:', availableDates);
  console.log('Total records received:', checkInOuts.length);
  console.log('Records for current month:', Object.values(recordsByDate).flat().length);

  // Calendar view with check-in/out records
  return (
    <div className="container py-4 max-w-7xl mx-auto">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarClock className="h-5 w-5" />
            My Check In & Out Records
          </CardTitle>
          <CardDescription>
            View your latest check-in/out records
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center my-8">
              <div className="loading-dots">
                <div className="loading-dots--dot"></div>
                <div className="loading-dots--dot"></div>
                <div className="loading-dots--dot"></div>
              </div>
            </div>
          ) : checkInOuts.length === 0 ? (
            <div className="text-center py-8">
              <CalendarClock className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">No Recent Records</h3>
              <p className="text-gray-500">
                No recent check-in/out records found for {userName || 'your account'}.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Calendar Header */}
              <div className="flex items-center justify-between">
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={goToPreviousMonth}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <h2 className="text-xl font-semibold">
                  {format(currentDate, 'MMMM yyyy')}
                </h2>
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={goToNextMonth}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>

              {/* Calendar Grid */}
              <div className="grid grid-cols-7 gap-2">
                {/* Day headers */}
                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
                  <div key={day} className="p-2 text-center font-medium text-gray-500 text-sm">
                    {day}
                  </div>
                ))}

                {/* Calendar days */}
                {calendarDays.map(day => {
                  const dateKey = format(day, 'yyyy-MM-dd');
                  const dayRecords = recordsByDate[dateKey] || [];
                  const isToday = isSameDay(day, new Date());
                  
                  return (
                    <div
                      key={dateKey}
                      className={`min-h-24 p-2 border rounded-lg ${
                        isToday ? 'bg-blue-50 border-blue-200' : 'bg-white border-gray-200'
                      } ${!isSameMonth(day, currentDate) ? 'opacity-30' : ''}`}
                    >
                      <div className="text-sm font-medium text-gray-700 mb-1">
                        {format(day, 'd')}
                      </div>
                      
                      {/* Records for this day */}
                      <div className="space-y-1">
                        {dayRecords.map((record: any, index: number) => (
                          <div
                            key={`${record.id}-${index}`}
                            className={`text-xs p-1 rounded text-white ${
                              record.type === 'in' 
                                ? 'bg-green-500' 
                                : record.type === 'out' 
                                ? 'bg-blue-500' 
                                : 'bg-gray-500'
                            }`}
                            title={`${record.type?.toUpperCase()} - ${record.responseDetails} - ${format(parseISO(record.timestamp), 'HH:mm')}`}
                          >
                            <div className="flex items-center gap-1">
                              {record.type === 'in' ? (
                                <CheckCircle className="h-3 w-3" />
                              ) : (
                                <XCircle className="h-3 w-3" />
                              )}
                              <span>{record.type?.toUpperCase()}</span>
                              <span className="ml-auto">
                                {format(parseISO(record.timestamp), 'HH:mm')}
                              </span>
                            </div>
                            <div className="text-xs opacity-90 truncate">
                              {record.shift}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Legend */}
              <div className="flex items-center gap-4 pt-4 border-t">
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 bg-green-500 rounded"></div>
                  <span className="text-sm text-gray-600">Check In</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 bg-blue-500 rounded"></div>
                  <span className="text-sm text-gray-600">Check Out</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 bg-blue-100 border-2 border-blue-200 rounded"></div>
                  <span className="text-sm text-gray-600">Today</span>
                </div>
              </div>

              {checkInOuts.length === 0 && (
                <div className="text-center py-8 text-gray-500">
                  No check-in/out records found for your account
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default CheckInOutPage;