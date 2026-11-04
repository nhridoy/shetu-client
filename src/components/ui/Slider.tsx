import { useId } from "react";
import { cn } from "@/lib/common/utils";

interface SliderProps {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  id?: string;
  className?: string;
}

export default function Slider({
  value,
  onValueChange,
  min = 0,
  max = 100,
  step = 1,
  disabled = false,
  id: providedId,
  className,
}: SliderProps) {
  const generatedId = useId();
  const id = providedId || generatedId;

  const percentage = ((value - min) / (max - min)) * 100;

  return (
    <div className={cn("relative flex items-center w-full", className)}>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onValueChange(Number(e.target.value))}
        className={cn(
          "w-full h-1 rounded-full appearance-none cursor-default",
          "bg-dark-700",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "[&::-webkit-slider-thumb]:appearance-none",
          "[&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4",
          "[&::-webkit-slider-thumb]:rounded-full",
          "[&::-webkit-slider-thumb]:bg-white",
          "[&::-webkit-slider-thumb]:shadow-md",
          "[&::-webkit-slider-thumb]:transition-transform",
          "[&::-webkit-slider-thumb]:duration-150",
          "[&::-webkit-slider-thumb]:focus-visible:outline-none",
          "[&::-webkit-slider-thumb]:focus-visible:ring-2",
          "[&::-webkit-slider-thumb]:focus-visible:ring-primary-500",
          "[&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4",
          "[&::-moz-range-thumb]:rounded-full",
          "[&::-moz-range-thumb]:bg-white",
          "[&::-moz-range-thumb]:border-0",
          "[&::-moz-range-thumb]:shadow-md",
        )}
        style={{
          background: `linear-gradient(to right, var(--color-primary-500) 0%, var(--color-primary-500) ${percentage}%, var(--color-dark-700) ${percentage}%, var(--color-dark-700) 100%)`,
        }}
      />
    </div>
  );
}
