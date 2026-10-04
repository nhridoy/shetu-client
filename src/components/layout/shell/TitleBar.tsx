import {
  ArrowsInSimpleIcon,
  ArrowsOutSimpleIcon,
  MinusIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { isTauriAvailable } from "@/lib/common/utils";
import { windowControls } from "@/lib/window/windowControls";

const isMac =
  typeof navigator !== "undefined" &&
  /Macintosh|Mac OS X/.test(navigator.userAgent);

export default function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!isTauriAvailable()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void windowControls
      .watchMaximized((value) => {
        if (!disposed) setMaximized(value);
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const run = (action: () => Promise<void>) => {
    void action().catch(() => toast.error("Window action failed. Try again."));
  };

  const controls = (
    <fieldset
      className="m-0 flex h-full min-w-0 shrink-0 items-stretch border-0 p-0"
      aria-label="Window controls"
    >
      <button
        type="button"
        aria-label="Minimize window"
        title="Minimize"
        onClick={() => run(windowControls.minimize)}
        className="flex w-11 items-center justify-center text-dark-400 hover:bg-dark-800 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-primary-400"
      >
        <MinusIcon size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label={maximized ? "Restore window" : "Maximize window"}
        title={maximized ? "Restore" : "Maximize"}
        onClick={() => run(windowControls.toggleMaximize)}
        className="flex w-11 items-center justify-center text-dark-400 hover:bg-dark-800 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-primary-400"
      >
        {maximized ? (
          <ArrowsInSimpleIcon size={14} aria-hidden="true" />
        ) : (
          <ArrowsOutSimpleIcon size={14} aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        aria-label="Close window"
        title="Close"
        onClick={() => run(windowControls.close)}
        className="flex w-11 items-center justify-center text-dark-400 hover:bg-danger-600 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-primary-400"
      >
        <XIcon size={15} aria-hidden="true" />
      </button>
    </fieldset>
  );

  return (
    <div className="fixed inset-x-0 top-0 z-[60] flex h-9 select-none items-center border-b border-dark-800 bg-dark-900 text-xs text-dark-300">
      {isMac && controls}
      <button
        type="button"
        aria-label="Drag window; press Enter to maximize or restore"
        data-titlebar-drag-area
        className="flex h-full min-w-0 flex-1 cursor-default items-center gap-2 px-3 focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-primary-400"
        onMouseDown={(event) => {
          if (event.button === 0)
            dragStart.current = { x: event.clientX, y: event.clientY };
        }}
        onMouseMove={(event) => {
          const start = dragStart.current;
          if (!start || event.buttons !== 1) return;
          if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4)
            return;
          dragStart.current = null;
          run(windowControls.startDragging);
        }}
        onMouseUp={() => {
          dragStart.current = null;
        }}
        onMouseLeave={() => {
          dragStart.current = null;
        }}
        onDoubleClick={() => run(windowControls.toggleMaximize)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            run(windowControls.toggleMaximize);
          }
        }}
      >
        <span
          className="h-2 w-2 rounded-[2px] bg-primary-500"
          aria-hidden="true"
        />
        <span className="font-semibold tracking-wide text-dark-200">
          TermVault
        </span>
      </button>
      {!isMac && controls}
    </div>
  );
}
