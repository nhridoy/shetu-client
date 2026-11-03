import { CheckIcon } from "@phosphor-icons/react";
import { useId } from "react";
import { cn } from "@/lib/common/utils";

interface CheckboxProps {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  name?: string;
  "aria-label"?: string;
}

export default function Checkbox({
  checked = false,
  onCheckedChange,
  disabled = false,
  id: providedId,
  className,
  name,
  "aria-label": ariaLabel,
}: CheckboxProps) {
  const generatedId = useId();
  const id = providedId || generatedId;

  return (
    // biome-ignore lint/a11y/useSemanticElements: custom styled checkbox
    <button
      id={id}
      name={name}
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        "peer shrink-0 w-3.5 h-3.5 rounded-[4px] border transition-colors cursor-default",
        "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary-500/50",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked
          ? "bg-primary-600 border-primary-600 text-white"
          : "bg-dark-900 border-dark-600",
        className,
      )}
    >
      {checked && <CheckIcon className="w-2.5 h-2.5" weight="bold" />}
    </button>
  );
}
