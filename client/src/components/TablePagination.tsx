import React from "react";
import { Button } from "@/components/ui/button";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

interface TablePaginationProps {
  currentPage: number;
  onPageChange: (page: number) => void;
  hasMore: boolean;
  showCondition?: boolean | undefined;
}

const TablePagination: React.FC<TablePaginationProps> = ({ 
  currentPage, 
  onPageChange, 
  hasMore,
  showCondition = true 
}) => {
  if (!showCondition) return null;
  
  return (
    <div className="flex justify-end space-x-2 mt-4">
      <Button
        variant="outline"
        size="sm"
        onClick={() => onPageChange(Math.max(1, currentPage - 1))}
        disabled={currentPage === 1}
      >
        <ChevronLeftIcon className="h-4 w-4" />
      </Button>
      <Button variant="outline" size="sm">
        Page {currentPage}
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => onPageChange(currentPage + 1)}
        disabled={!hasMore}
      >
        <ChevronRightIcon className="h-4 w-4" />
      </Button>
    </div>
  );
};

export default TablePagination;