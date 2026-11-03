import { CaretDownIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/common/utils";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps {
  id?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export default function Select({
  id,
  value,
  onValueChange,
  options,
  placeholder = "Select...",
  disabled = false,
  className,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const selected = options.find((o) => o.value === value);

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
    triggerRef.current?.focus();
  }, []);

  const selectOption = useCallback(
    (option: SelectOption) => {
      if (option.disabled) return;
      onValueChange?.(option.value);
      close();
    },
    [onValueChange, close],
  );

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node) &&
        listRef.current &&
        !listRef.current.contains(e.target as Node)
      ) {
        close();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, close]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, close]);

  // Scroll active item into view
  useEffect(() => {
    if (activeIndex < 0) return;
    const opt = enabledOptions()[activeIndex];
    if (opt)
      itemRefs.current.get(opt.value)?.scrollIntoView({ block: "nearest" });
  });

  const enabledOptions = () => options.filter((o) => !o.disabled);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const opts = enabledOptions();
    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        if (!open) {
          setOpen(true);
          const idx = value ? opts.findIndex((o) => o.value === value) : -1;
          setActiveIndex(idx + 1 < opts.length ? idx + 1 : 0);
        } else {
          setActiveIndex((i) => (i + 1 < opts.length ? i + 1 : 0));
        }
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        if (!open) {
          setOpen(true);
          const idx = value ? opts.findIndex((o) => o.value === value) : -1;
          setActiveIndex(idx > 0 ? idx - 1 : opts.length - 1);
        } else {
          setActiveIndex((i) => (i > 0 ? i - 1 : opts.length - 1));
        }
        break;
      }
      case "Enter":
      case " ": {
        e.preventDefault();
        if (!open) {
          setOpen(true);
          const idx = value ? opts.findIndex((o) => o.value === value) : -1;
          setActiveIndex(idx >= 0 ? idx : 0);
        } else if (activeIndex >= 0 && opts[activeIndex]) {
          selectOption(opts[activeIndex]);
        }
        break;
      }
      case "Home": {
        if (open) {
          e.preventDefault();
          setActiveIndex(0);
        }
        break;
      }
      case "End": {
        if (open) {
          e.preventDefault();
          setActiveIndex(opts.length - 1);
        }
        break;
      }
    }
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={handleKeyDown}
        className={cn(
          "w-full h-7 bg-dark-900 text-white px-2 text-sm rounded-md border border-dark-700 cursor-default",
          "flex items-center justify-between gap-2",
          "focus:outline-none focus:ring-[3px] focus:ring-primary-500/50 focus:border-primary-500",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          "text-left truncate",
          !selected && "text-dark-500",
          className,
        )}
      >
        <span className="truncate">{selected?.label ?? placeholder}</span>
        <CaretDownIcon
          className={cn(
            "w-3.5 h-3.5 text-dark-400 shrink-0 transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          className={cn(
            "absolute z-50 mt-1 w-full",
            "bg-dark-900 border border-dark-700/60 rounded-md shadow-xl",
            "max-h-60 overflow-y-auto p-[5px]",
          )}
        >
          {options.map((option, index) => {
            const isActive =
              option.value ===
              (activeIndex >= 0
                ? enabledOptions()[activeIndex]?.value
                : undefined);
            const isSelected = option.value === value;

            return (
              <div
                key={option.value}
                ref={(el) => {
                  if (el) itemRefs.current.set(option.value, el);
                }}
                role="option"
                tabIndex={-1}
                aria-selected={isSelected}
                aria-disabled={option.disabled}
                onMouseEnter={() => {
                  if (!option.disabled) setActiveIndex(index);
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectOption(option);
                }}
                className={cn(
                  "h-[22px] px-2 rounded-[4px] cursor-default flex items-center justify-between",
                  "text-sm transition-colors",
                  option.disabled
                    ? "text-dark-600 cursor-not-allowed"
                    : isActive
                      ? "bg-primary-600 text-white"
                      : "text-dark-300",
                )}
              >
                <span className="truncate">{option.label}</span>
                {isSelected && (
                  <div className="w-1.5 h-1.5 rounded-full bg-primary-500 shrink-0 ml-2" />
                )}
              </div>
            );
          })}
          {options.length === 0 && (
            <div className="h-[22px] px-2 text-sm text-dark-500">
              No options
            </div>
          )}
        </div>
      )}
    </div>
  );
}
