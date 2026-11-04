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

export const isMac =
  typeof navigator !== "undefined" &&
  /Macintosh|Mac OS X/.test(navigator.userAgent);

const runWindowAction = (action: () => Promise<void>) => {
  void action().catch(() => toast.error("Window action failed. Try again."));
};

/** Subscribes to a boolean window state (maximized, fullscreen, focus). */
function useWindowState(
  watch: (onChange: (value: boolean) => void) => Promise<() => void>,
  initial: boolean,
) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (!isTauriAvailable()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void watch((next) => {
      if (!disposed) setValue(next);
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
  }, [watch]);
  return value;
}

const glyphClass =
  "h-2 w-2 opacity-0 group-hover/tl:opacity-100 group-focus-within/tl:opacity-100";

// Fixed macOS colors (not themed). Unfocused windows show gray until hovered.
const TRAFFIC_LIGHTS = [
  {
    key: "close",
    focused: "bg-[#FF5F57] shadow-[inset_0_0_0_0.5px_#E0443E]",
    blurred:
      "bg-dark-600 group-hover/tl:bg-[#FF5F57] group-hover/tl:shadow-[inset_0_0_0_0.5px_#E0443E]",
    glyph: (
      <svg viewBox="0 0 8 8" className={glyphClass} aria-hidden="true">
        <path
          d="M2 2l4 4M6 2L2 6"
          stroke="rgba(0,0,0,0.55)"
          strokeWidth="1.1"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    key: "minimize",
    focused: "bg-[#FEBC2E] shadow-[inset_0_0_0_0.5px_#DEA123]",
    blurred:
      "bg-dark-600 group-hover/tl:bg-[#FEBC2E] group-hover/tl:shadow-[inset_0_0_0_0.5px_#DEA123]",
    glyph: (
      <svg viewBox="0 0 8 8" className={glyphClass} aria-hidden="true">
        <path
          d="M1.5 4h5"
          stroke="rgba(0,0,0,0.55)"
          strokeWidth="1.1"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    key: "zoom",
    focused: "bg-[#28C840] shadow-[inset_0_0_0_0.5px_#1AAB29]",
    blurred:
      "bg-dark-600 group-hover/tl:bg-[#28C840] group-hover/tl:shadow-[inset_0_0_0_0.5px_#1AAB29]",
    glyph: (
      <svg viewBox="0 0 8 8" className={glyphClass} aria-hidden="true">
        <path d="M2.5 1.5h4v4zM1.5 2.5v4h4z" fill="rgba(0,0,0,0.55)" />
      </svg>
    ),
  },
] as const;

function TrafficLights() {
  const focused = useWindowState(windowControls.watchFocus, true);
  const fullscreen = useWindowState(windowControls.watchFullscreen, false);
  const actions = {
    close: { label: "Close window", run: windowControls.close },
    minimize: { label: "Minimize window", run: windowControls.minimize },
    zoom: {
      label: fullscreen ? "Exit full screen" : "Enter full screen",
      run: windowControls.toggleFullscreen,
    },
  };

  return (
    <fieldset
      data-traffic-lights
      className="group/tl m-0 flex h-full shrink-0 items-center border-0 py-0 pl-2 pr-1"
      aria-label="Window controls"
    >
      {TRAFFIC_LIGHTS.map((light) => {
        const action = actions[light.key];
        return (
          <button
            key={light.key}
            type="button"
            aria-label={action.label}
            title={action.label}
            onClick={() => runWindowAction(action.run)}
            className="grid h-5 w-5 cursor-default place-items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          >
            <span
              className={`grid h-3 w-3 place-items-center rounded-full ${focused ? light.focused : light.blurred}`}
            >
              {light.glyph}
            </span>
          </button>
        );
      })}
    </fieldset>
  );
}

/** macOS: drawn traffic lights. Windows/Linux: minimize, maximize, close on the right. */
export function WindowControls({ mac = isMac }: { mac?: boolean }) {
  return mac ? <TrafficLights /> : <StandardWindowControls />;
}

function StandardWindowControls() {
  const maximized = useWindowState(windowControls.watchMaximized, false);
  const run = runWindowAction;

  return (
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
}

export function WindowDragArea({
  showBrand = false,
  className = "",
}: {
  showBrand?: boolean;
  className?: string;
}) {
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const run = runWindowAction;

  return (
    <button
      type="button"
      aria-label="Drag window; press Enter to maximize or restore"
      data-titlebar-drag-area
      className={`flex h-full min-w-0 cursor-default items-center gap-2 px-3 focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-primary-400 ${className}`}
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
      {showBrand && (
        <>
          <span
            className="h-2 w-2 rounded-[2px] bg-primary-500"
            aria-hidden="true"
          />
          <span className="font-semibold tracking-wide text-dark-200">
            Terra
          </span>
        </>
      )}
    </button>
  );
}

export default function TitleBar() {
  return (
    <div className="chrome fixed inset-x-0 top-0 z-[60] flex h-[var(--toolbar-height)] items-center border-b border-dark-800 bg-dark-900 text-sm text-dark-300">
      {isMac && <WindowControls />}
      <WindowDragArea showBrand className="flex-1" />
      {!isMac && <WindowControls />}
    </div>
  );
}
