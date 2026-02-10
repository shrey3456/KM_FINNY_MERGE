import React from 'react';
import { cn } from "@/lib/utils";

interface PlantBadgeProps {
  plant: string | null | undefined;
  className?: string;
  onClick?: React.MouseEventHandler<HTMLSpanElement>;
}

export function PlantBadge({ plant, className, onClick }: PlantBadgeProps) {
  if (!plant) return <span className="text-muted">N/A</span>;

  // Define colors for each plant
  const getPlantColors = (plantName: string) => {
    const upperPlant = plantName.toUpperCase();
    
    switch (upperPlant) {
      case 'VALSAD':
        return 'bg-green-100 text-green-800 border-green-500';
      case 'INDORE':
        return 'bg-amber-100 text-amber-800 border-amber-500';
      case 'RAJKOT':
        return 'bg-blue-100 text-blue-800 border-blue-500';
      case 'BARODA':
        return 'bg-blue-100 text-blue-800 border-blue-500';
      case 'LUCKNOW':
        return 'bg-orange-100 text-orange-800 border-orange-500';
      default:
        return 'bg-gray-100 text-gray-800 border-gray-500';
    }
  };

  return (
    <span
      className={cn(
        "inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-xs font-medium border",
        getPlantColors(plant),
        className
      )}
      onClick={onClick}
    >
      {plant.toUpperCase()}
    </span>
  );
}