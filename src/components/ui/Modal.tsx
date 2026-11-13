import { XIcon } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/Button";

interface ModalProps {
  open?: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  maxWidth?: string;
  closeOnBackdrop?: boolean;
  hideClose?: boolean;
  zClass?: string;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])';

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  );
}

// Open dialogs, topmost last; only the top one handles keys.
const openModals: HTMLElement[] = [];

function getPrimaryButton(container: HTMLElement): HTMLElement | null {
  const all = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  for (const el of all) {
    if (
      el.getAttribute("type") === "submit" &&
      !el.className.includes("ghost") &&
      !el.className.includes("secondary")
    ) {
      return el;
    }
  }
  const nonGhost = Array.from(all).filter(
    (el) =>
      !el.className.includes("ghost") && !el.className.includes("secondary"),
  );
  if (nonGhost.length > 0) return nonGhost[nonGhost.length - 1];
  return all.length > 0 ? all[all.length - 1] : null;
}

export default function Modal({
  open = true,
  onClose,
  title,
  children,
  maxWidth = "max-w-lg",
  closeOnBackdrop = false,
  hideClose = false,
  zClass = "z-50",
}: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const hideCloseRef = useRef(hideClose);
  hideCloseRef.current = hideClose;

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const self = overlayRef.current as HTMLElement;
    // Child effects run first, so a parent goes below any dialog nested inside it.
    const nested = openModals.findIndex((m) => self.contains(m));
    openModals.splice(nested === -1 ? openModals.length : nested, 0, self);

    const bodyEls = bodyRef.current && getFocusableElements(bodyRef.current);
    if (bodyEls && bodyEls.length > 0) {
      bodyEls[0].focus();
    } else if (panelRef.current) {
      const focusable = getFocusableElements(panelRef.current);
      if (focusable.length > 0) {
        focusable[0].focus();
      } else {
        panelRef.current.focus();
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (openModals[openModals.length - 1] !== self) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        if (!hideCloseRef.current) onCloseRef.current();
        return;
      }
      if (e.key === "Enter") {
        if (panelRef.current && !panelRef.current.contains(e.target as Node))
          return;
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "BUTTON" || tag === "TEXTAREA") return;
        e.preventDefault();
        const primary = panelRef.current && getPrimaryButton(panelRef.current);
        primary?.click();
        return;
      }
      if (e.key === "Tab" && panelRef.current) {
        const focusable = getFocusableElements(panelRef.current);
        if (focusable.length < 2) {
          e.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      openModals.splice(openModals.indexOf(self), 1);
      prev?.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      className={`fixed inset-0 bg-black/30 flex items-center justify-center ${zClass} p-4`}
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === overlayRef.current)
          onCloseRef.current();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`bg-dark-900 rounded-[10px] border border-dark-700/60 shadow-2xl shadow-black/40 w-full ${maxWidth} max-h-[90vh] flex flex-col outline-none`}
      >
        {title && (
          <div className="flex items-center justify-between h-11 px-4 border-b border-dark-700 shrink-0">
            <h2 className="text-sm font-semibold text-white">{title}</h2>
            {!hideClose && (
              <Button
                type="button"
                onClick={() => onCloseRef.current()}
                variant="ghost"
                size="icon-xs"
                aria-label="Close"
              >
                <XIcon size={12} weight="bold" aria-hidden="true" />
              </Button>
            )}
          </div>
        )}
        <div ref={bodyRef} className="overflow-y-auto p-5">
          {children}
        </div>
      </div>
    </div>
  );
}
