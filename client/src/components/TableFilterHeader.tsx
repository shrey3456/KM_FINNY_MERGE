import React from "react";
import { Input } from "@/components/ui/input";
import { SearchIcon } from "lucide-react";
import { DateRangeFilter } from "@/components/DateRangeFilter";
import { DateRange } from "react-day-picker";

// Original interface with date range
interface TableFilterHeaderPropsWithDate {
  title: string;
  searchPlaceholder: string;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onDateRangeChange: (range: DateRange | undefined) => void;
}

// New interface for simplified header with just children
interface SimpleTableFilterHeaderProps {
  children: React.ReactNode;
}

// Union type to support both interfaces
type TableFilterHeaderProps = TableFilterHeaderPropsWithDate | SimpleTableFilterHeaderProps;

const TableFilterHeader: React.FC<TableFilterHeaderProps> = (props) => {
  // Check if this is the simple version with just children
  if ('children' in props) {
    return (
      <div className="flex flex-col md:flex-row justify-between items-center gap-4 p-4 bg-muted/30 rounded-lg">
        {props.children}
      </div>
    );
  }
  
  // Otherwise, render the original version with date filter
  const { title, searchPlaceholder, searchQuery, onSearchChange, onDateRangeChange } = props;
  
  return (
    <div className="flex justify-between items-center">
      <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
      <div className="flex gap-2">
        <DateRangeFilter onDateRangeChange={onDateRangeChange} />
        <div className="relative">
          <SearchIcon className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={searchPlaceholder}
            className="pl-8 w-[250px]"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
      </div>
    </div>
  );
};

export default TableFilterHeader;