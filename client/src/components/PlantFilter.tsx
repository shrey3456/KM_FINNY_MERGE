import React from 'react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SelectLabel,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Check, X, Filter } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

interface PlantOption {
  value: string;
  label: string;
}

// Default plant options (fallback if none provided)
const DEFAULT_PLANT_OPTIONS: PlantOption[] = [
  { value: "PLANT-1", label: "PLANT-1" },
  { value: "PLANT-2", label: "PLANT-2" },
  { value: "PLANT-3", label: "PLANT-3" },
  { value: "PLANT-4", label: "PLANT-4" },
];

interface PlantFilterProps {
  selectedPlants: string[];
  onPlantChange: (plants: string[]) => void;
  plantOptions?: PlantOption[];
  size?: "sm" | "md" | "lg";
  /** Extra classes merged onto the "Plant" trigger button. */
  buttonClassName?: string;
}

export function PlantFilter({
  selectedPlants,
  onPlantChange,
  plantOptions = DEFAULT_PLANT_OPTIONS,
  size = "md",
  buttonClassName,
}: PlantFilterProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size={size === "lg" ? "default" : "sm"}
          className={cn(
            "border-dashed flex items-center gap-1.5",
            size === "sm" ? "h-8" : size === "lg" ? "h-10" : "h-9",
            selectedPlants.length > 0 && "border-primary",
            buttonClassName,
          )}
        >
          <Filter className={size === "sm" ? "h-3 w-3" : size === "lg" ? "h-4 w-4" : "h-3.5 w-3.5"} />
          <span>Plant</span>
          {selectedPlants.length > 0 && (
            <Badge 
              variant="secondary" 
              className="rounded-sm px-1 font-normal"
            >
              {selectedPlants.length}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-0" align="start">
        <div className="p-2 flex flex-col gap-2">
          <div className="font-medium px-2 pt-1 pb-2 border-b text-sm">
            Filter by Plant
          </div>
          <div className="space-y-2">
            {plantOptions.map((option) => (
              <div key={option.value} className="flex items-center space-x-2 px-2 py-1 hover:bg-muted/50 rounded">
                <Checkbox 
                  id={`plant-${option.value}`}
                  checked={selectedPlants.includes(option.value)}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      onPlantChange([...selectedPlants, option.value]);
                    } else {
                      onPlantChange(selectedPlants.filter((p) => p !== option.value));
                    }
                  }}
                />
                <label 
                  htmlFor={`plant-${option.value}`}
                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer flex-1"
                >
                  {option.label}
                </label>
              </div>
            ))}
          </div>
          {selectedPlants.length > 0 && (
            <div className="flex justify-between pt-2 border-t mt-1">
              <Button 
                variant="ghost" 
                size="sm"
                className="h-7 text-xs"
                onClick={() => onPlantChange([])}
              >
                Clear all
              </Button>
              <div className="text-xs text-muted-foreground py-1 pr-1">
                {selectedPlants.length} selected
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}