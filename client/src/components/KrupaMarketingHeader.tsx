import React from 'react';
import { cn } from "@/lib/utils";

interface KrupaMarketingHeaderProps {
  plant: string | null | undefined;
  className?: string;
}

export function KrupaMarketingHeader({ plant, className }: KrupaMarketingHeaderProps) {
  // Define colors for each plant, same as PlantBadge
  const getPlantColors = (plantName: string) => {
    const upperPlant = plantName?.toUpperCase() || '';
    
    switch (upperPlant) {
      case 'VALSAD':
        return 'bg-green-200 text-green-900';
      case 'INDORE':
        return 'bg-[#f5f0e6] text-[#8b5a2b]';
      case 'RAJKOT':
        return 'bg-blue-200 text-blue-900';
      case 'BARODA':
        return 'bg-blue-200 text-blue-900';
      case 'LUCKNOW':
        return 'bg-orange-200 text-orange-900';
      default:
        return 'bg-gray-200 text-gray-900';
    }
  };

  return (
    <div
      className={cn(
        "w-full p-2 text-center font-semibold mb-2 rounded-sm",
        getPlantColors(plant || ''),
        className
      )}
    >
      KRUPA MARKETING {plant ? <span className="font-bold">{`{${plant.toUpperCase()}}`}</span> : <span className="font-bold">{'{N/A}'}</span>}
    </div>
  );
}