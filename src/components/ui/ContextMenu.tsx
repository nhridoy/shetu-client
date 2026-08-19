import { useEffect, useRef, useState } from "react";

export type ContextMenuItem =
  | {
      label: string;
      icon?: React.ReactNode;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      onClick: () => void;
    }
  | { type: "separator" };

interface ContextMenuProps {
  items: ContextMenuItem[];
  x: number;
  y: number;
  onClose: () => void;
}

export default function ContextMenu({
  items,
  x,
  y,
  onClose,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setSelectedIndex(0);
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [onClose]);

  // Clamp position to viewport
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const padding = 8;
    if (rect.right > window.innerWidth - padding) {
      menuRef.current.style.left = `${window.innerWidth - rect.width - padding}px`;
    }
    if (rect.bottom > window.innerHeight - padding) {
      menuRef.current.style.top = `${window.innerHeight - rect.height - padding}px`;
    }
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => {
        let next = prev + 1;
        while (next < items.length && "type" in items[next]) next++;
        return next < items.length ? next : prev;
      });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => {
        let next = prev - 1;
        while (next >= 0 && "type" in items[next]) next--;
        return next >= 0 ? next : prev;
      });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[selectedIndex];
      if (item && !("type" in item) && !item.disabled) {
        item.onClick();
        onClose();
      }
    }
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-[100] min-w-[180px] py-1 bg-dark-800 border border-dark-600 rounded-lg shadow-xl"
      style={{ left: x, top: y }}
      onKeyDown={handleKeyDown}
      onMouseDown={(e) => e.stopPropagation()}
      tabIndex={-1}
    >
      {items.map((item, index) => {
        if ("type" in item) {
          const next = items[index + 1];
          const sepKey = next && "label" in next ? next.label : "end";
          return (
            <div
              key={`sep-${sepKey}`}
              className="my-1 border-t border-dark-600"
            />
          );
        }
        return (
          <button
            key={item.label}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (!item.disabled) {
                item.onClick();
                onClose();
              }
            }}
            onMouseEnter={() => !item.disabled && setSelectedIndex(index)}
            className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left ${
              item.disabled
                ? "text-dark-500 cursor-not-allowed"
                : item.danger
                  ? "text-red-400 hover:bg-red-500/10"
                  : index === selectedIndex
                    ? "text-white bg-dark-700"
                    : "text-dark-300 hover:bg-dark-700"
            }`}
          >
            {item.icon && <span className="w-4 h-4 shrink-0">{item.icon}</span>}
            <span className="flex-1">{item.label}</span>
            {item.shortcut && (
              <span className="text-xs text-dark-500 ml-4">
                {item.shortcut}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
