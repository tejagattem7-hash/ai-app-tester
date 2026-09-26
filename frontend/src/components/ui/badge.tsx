import type { HTMLAttributes } from "react"
import { cn } from "@/lib/utils"

type BadgeVariant = "neutral" | "success" | "danger" | "warning" | "info"

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant
}

export function Badge({ className, variant = "neutral", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold capitalize",
        variant === "neutral" && "bg-slate-100 text-slate-700",
        variant === "success" && "bg-emerald-50 text-emerald-700",
        variant === "danger" && "bg-rose-50 text-rose-700",
        variant === "warning" && "bg-amber-50 text-amber-700",
        variant === "info" && "bg-indigo-50 text-indigo-700",
        className,
      )}
      {...props}
    />
  )
}
