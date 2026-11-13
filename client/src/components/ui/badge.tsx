import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent glass-tint bg-primary/85 text-primary-foreground hover:bg-primary/95",
        secondary:
          "glass text-secondary-foreground",
        destructive:
          "border-transparent glass-tint bg-destructive/85 text-destructive-foreground hover:bg-destructive/95",
        outline: "glass text-foreground",
        success: 
          "border-transparent glass-tint bg-green-500/85 text-white hover:bg-green-600",
        warning:
          "border-transparent glass-tint bg-amber-500/85 text-white hover:bg-amber-600",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
