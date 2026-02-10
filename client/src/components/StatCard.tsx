import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LucideIcon } from "lucide-react";

interface StatCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  iconColor?: string;
  size?: "sm" | "md" | "lg";
}

const StatCard: React.FC<StatCardProps> = ({
  title,
  value,
  icon: Icon,
  iconColor = "text-primary",
  size = "sm"
}) => {
  // Size styles
  const iconSizeClass = size === "sm" ? "w-6 h-6" : size === "md" ? "w-8 h-8" : "w-10 h-10";
  const valueTextClass = size === "sm" ? "text-lg" : size === "md" ? "text-2xl" : "text-3xl";
  const titleTextClass = size === "sm" ? "text-xs" : size === "md" ? "text-sm" : "text-base";
  const paddingClass = size === "sm" ? "pb-1" : "pb-2";

  return (
    <Card className="shadow-sm">
      <CardHeader className={paddingClass}>
        <CardTitle className={`${titleTextClass} font-medium`}>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center space-x-2">
          <Icon className={`${iconSizeClass} ${iconColor}`} />
          <div className={`${valueTextClass} font-bold`}>{value}</div>
        </div>
      </CardContent>
    </Card>
  );
};

export default StatCard;