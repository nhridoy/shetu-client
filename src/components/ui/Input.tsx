import { forwardRef } from "react";
import { cn } from "@/lib/common/utils";

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={cn(
          "w-full h-7 bg-dark-900 text-white px-2 text-sm rounded-md border border-dark-700",
          "focus:outline-none focus:ring-[3px] focus:ring-primary-500/50 focus:border-primary-500",
          "placeholder:text-dark-500",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          className,
        )}
        {...props}
      />
    );
  },
);

Input.displayName = "Input";

export default Input;
