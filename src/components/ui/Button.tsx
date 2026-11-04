import { cva, type VariantProps } from "class-variance-authority";
import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/common/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap text-sm font-medium transition-colors rounded-md cursor-default select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-primary-600 text-primary-text shadow-sm shadow-black/20 hover:bg-primary-700",
        destructive: "bg-danger-600 text-danger-text hover:bg-danger-700",
        secondary: "bg-dark-700 text-white hover:bg-dark-600",
        ghost: "text-dark-400 hover:text-white hover:bg-dark-800",
        outline:
          "border border-dark-700 bg-transparent text-white hover:bg-dark-800",
        link: "text-primary-500 underline-offset-4 hover:underline hover:text-primary-600",
        "soft-destructive":
          "bg-danger-600/20 text-danger-400 hover:bg-danger-600/30 hover:text-danger-300",
        success: "bg-green-600 text-white hover:bg-green-700",
      },
      size: {
        default: "h-7 px-3",
        sm: "h-6 px-2.5 text-xs",
        lg: "h-8 px-4",
        icon: "h-7 w-7",
        "icon-sm": "h-6 w-6",
        "icon-xs": "h-5 w-5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
