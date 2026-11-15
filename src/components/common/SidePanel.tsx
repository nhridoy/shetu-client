import { XIcon } from "@phosphor-icons/react";
import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/common/utils";
import { useUnsavedChanges } from "@/stores/ui/unsavedChangesStore";

interface SidePanelProps {
  title: string;
  open: boolean;
  dirty: boolean;
  onClose: () => void;
  footer: ReactNode;
  children: ReactNode;
  intro?: string;
}

/** Below this container width the panel overlays instead of pushing. */
const OVERLAY_BELOW = 900;
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])';

function SidePanel({
  title,
  open,
  dirty,
  onClose,
  footer,
  children,
  intro,
}: SidePanelProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overlay, setOverlay] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const requestClose = () => {
    useUnsavedChanges
      .getState()
      .confirmLeave()
      .then((ok) => {
        if (ok) onCloseRef.current();
      });
  };
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  // Dirty flag for the sidebar guard; cleared on close/unmount.
  useEffect(() => {
    useUnsavedChanges.getState().setDirty(open && dirty);
    return () => useUnsavedChanges.getState().setDirty(false);
  }, [open, dirty]);

  useEffect(() => {
    if (!open || !dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [open, dirty]);

  // Pick push or overlay from the hosts page container width, measured before first paint.
  useLayoutEffect(() => {
    const parent = panelRef.current?.parentElement;
    if (!open || !parent) return;
    setOverlay(parent.clientWidth < OVERLAY_BELOW);
    const ro = new ResizeObserver(([entry]) =>
      setOverlay(entry.contentRect.width < OVERLAY_BELOW),
    );
    ro.observe(parent);
    return () => ro.disconnect();
  }, [open]);

  // Focus the first field on open; give focus back to the opener on close.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    bodyRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => opener?.focus();
  }, [open]);

  // The overlay is modal: narrowing into it pulls focus in from outside,
  // unless another dialog (e.g. "Discard changes?") holds it.
  useEffect(() => {
    const active = document.activeElement;
    if (
      overlay &&
      !panelRef.current?.contains(active) &&
      !active?.closest('[role="dialog"]')
    )
      bodyRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [overlay]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const panel = panelRef.current;
      if (!panel?.contains(document.activeElement)) return;
      // An open select or dialog consumes this Escape.
      if (
        panel.querySelector('[aria-expanded="true"]') ||
        Array.from(document.querySelectorAll('[role="dialog"]')).some(
          (d) => d !== panel,
        )
      )
        return;
      requestCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  const trapTab = (e: React.KeyboardEvent) => {
    if (!overlay || e.key !== "Tab" || !panelRef.current) return;
    const els = Array.from(
      panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
    );
    const first = els[0];
    const last = els[els.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  };

  return (
    <>
      {overlay && (
        // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: Esc already closes; the backdrop is a pointer-only affordance
        <div
          data-testid="side-panel-backdrop"
          className="absolute inset-0 z-20 bg-black/40"
          onClick={requestClose}
        />
      )}
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-modal is set only together with role=dialog */}
      <aside
        ref={panelRef}
        role={overlay ? "dialog" : undefined}
        aria-modal={overlay ? true : undefined}
        aria-labelledby={titleId}
        onKeyDown={trapTab}
        className={cn(
          "flex h-full w-[420px] max-w-full shrink-0 flex-col border-l border-dark-800 bg-dark-900",
          "motion-safe:animate-side-panel-in",
          overlay && "absolute inset-y-0 right-0 z-30 shadow-xl",
        )}
      >
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-dark-800 px-4">
          <h2
            id={titleId}
            className="truncate text-sm font-semibold text-white"
          >
            {title}
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Close panel"
            onClick={requestClose}
          >
            <XIcon className="h-3.5 w-3.5" />
          </Button>
        </header>
        <div ref={bodyRef} className="flex-1 overflow-y-auto">
          {intro && <p className="px-4 pt-3 text-sm text-dark-400">{intro}</p>}
          {children}
        </div>
        <footer className="flex shrink-0 justify-end gap-2 border-t border-dark-800 px-4 py-3">
          {footer}
        </footer>
      </aside>
    </>
  );
}

function Card({
  icon,
  title,
  summary,
  action,
  children,
}: {
  icon: ReactNode;
  title: string;
  summary?: string;
  /** Rendered at the right of the header row. */
  action?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="rounded-lg border border-dark-700/60 bg-dark-800 p-3"
    >
      <header className="mb-3 flex items-center justify-between gap-2">
        <div className="flex shrink-0 items-center gap-2 text-sm font-medium text-white">
          <span
            aria-hidden
            className="shrink-0 text-primary-400 [&>svg]:h-4 [&>svg]:w-4"
          >
            {icon}
          </span>
          <h3 id={id}>{title}</h3>
        </div>
        {summary && (
          <span
            data-card-summary
            title={summary}
            className="ml-auto min-w-0 truncate text-xs text-dark-400"
          >
            {summary}
          </span>
        )}
        {action && <div className="shrink-0">{action}</div>}
      </header>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

SidePanel.Card = Card;
export default SidePanel;
