import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { error, info, warn } from "@tauri-apps/plugin-log";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

const ISSUES_URL = "https://github.com/nhridoy/terra-client/issues/new";

export function formatLogArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error)
        return arg.stack ?? `${arg.name}: ${arg.message}`;
      if (arg === null || typeof arg !== "object") return String(arg);
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

// Never use console here: a failing log call would loop through the wrapper.
const send = (write: (message: string) => Promise<void>, args: unknown[]) =>
  void write(formatLogArgs(args)).catch(() => {});

/** Mirrors console errors/warnings and uncaught errors into the log file. */
export function installLogForwarding() {
  for (const [method, write] of [
    ["error", error],
    ["warn", warn],
  ] as const) {
    const original = console[method];
    console[method] = (...args: unknown[]) => {
      original(...args);
      send(write, args);
    };
  }
  window.addEventListener("error", (event) =>
    send(error, ["Uncaught:", event.error ?? event.message]),
  );
  window.addEventListener("unhandledrejection", (event) =>
    send(error, ["Unhandled rejection:", event.reason]),
  );
  send(info, ["Frontend started"]);
}

/** Asks where to save, then writes all log files into one text file. */
export async function exportLogs(): Promise<boolean> {
  const date = new Date().toISOString().slice(0, 10);
  const destination = await save({
    title: "Export Terra logs",
    defaultPath: `terra-logs-${date}.txt`,
    filters: [{ name: "Text", extensions: ["txt"] }],
  });
  if (!destination) return false;
  await invoke("export_logs", { destination });
  return true;
}

export async function reportProblem() {
  const version = await getVersion().catch(() => "");
  const params = new URLSearchParams({ template: "bug_report.yml", version });
  await openUrl(`${ISSUES_URL}?${params}`);
}

export async function notifyIfPreviousCrash() {
  const crashed = await invoke<boolean>("take_crash_marker").catch(() => false);
  if (!crashed) return;
  toast.error("Terra closed unexpectedly last time", {
    description: "Export the logs and attach them to a bug report.",
    id: "previous-crash",
    duration: Number.POSITIVE_INFINITY,
    action: {
      label: "Export logs",
      onClick: () =>
        void exportLogs().then((saved) => {
          if (saved) void reportProblem();
        }),
    },
    cancel: { label: "Dismiss", onClick: () => {} },
  });
}
