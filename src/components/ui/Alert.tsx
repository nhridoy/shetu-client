import type { ReactNode } from "react";
import { cn } from "@/lib/common/utils";

type AlertVariant = "error" | "success";

interface AlertProps {
  variant: AlertVariant;
  children: ReactNode;
  className?: string;
}

const VARIANT_CLASSES: Record<AlertVariant, string> = {
  error:
    "bg-red-500/20 border border-red-500/50 text-red-400 rounded-md p-3 text-sm",
  success:
    "bg-green-500/20 border border-green-500/50 text-green-400 rounded-md p-3 text-sm",
};

export function Alert({ variant, children, className }: AlertProps) {
  return (
    <div className={cn(VARIANT_CLASSES[variant], className)}>{children}</div>
  );
}
