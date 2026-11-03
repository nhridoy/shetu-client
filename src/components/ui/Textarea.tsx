import { forwardRef } from "react";
import { cn } from "@/lib/common/utils";

interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(
          "w-full bg-dark-900 text-white text-sm px-2 py-1.5 rounded-md border border-dark-700 resize-y",
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

Textarea.displayName = "Textarea";

export default Textarea;
