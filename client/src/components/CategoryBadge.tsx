import React from 'react';
import { cn } from "@/lib/utils";

interface CategoryBadgeProps {
  category: string | null | undefined;
  className?: string;
}

export function CategoryBadge({ category, className }: CategoryBadgeProps) {
  if (!category) return <span className="text-muted">N/A</span>;

  // Convert category to a consistent hash for color assignment
  const getColorHash = (str: string) => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return hash;
  };

  // Generate a consistent pastel color based on category name
  const getCategoryColor = (category: string) => {
    const hash = getColorHash(category.toLowerCase());
    
    // Generate consistent color combinations for the same category
    const hue = hash % 360;
    
    // Select appropriate color based on hue ranges
    if (hue >= 0 && hue < 60) {
      return 'bg-blue-100 text-blue-800 border-blue-500'; // blue
    } else if (hue >= 60 && hue < 120) {
      return 'bg-amber-100 text-amber-800 border-amber-500'; // amber
    } else if (hue >= 120 && hue < 180) {
      return 'bg-green-100 text-green-800 border-green-500'; // green
    } else if (hue >= 180 && hue < 240) {
      return 'bg-cyan-100 text-cyan-800 border-cyan-500'; // cyan
    } else if (hue >= 240 && hue < 300) {
      return 'bg-blue-100 text-blue-800 border-blue-500'; // blue
    } else {
      return 'bg-purple-100 text-purple-800 border-purple-500'; // purple
    }
  };

  return (
    <span
      className={cn(
        "inline-flex items-center justify-center px-2.5 py-0.5 rounded-md text-xs font-medium border",
        getCategoryColor(category),
        className
      )}
    >
      {category}
    </span>
  );
}