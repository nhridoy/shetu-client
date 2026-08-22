export type ConnectionStatus =
  | "connected"
  | "connecting"
  | "error"
  | "disconnected"
  | "idle"
  | "reconnecting"
  | "failed";

const STATUS_COLOR: Record<ConnectionStatus, string> = {
  connected: "bg-green-500",
  connecting: "bg-yellow-500 animate-pulse",
  error: "bg-red-500",
  disconnected: "bg-dark-500",
  idle: "bg-dark-500",
  reconnecting: "bg-yellow-500 animate-pulse",
  failed: "bg-red-500",
};

export function getStatusColor(status: string): string {
  if (status in STATUS_COLOR) return STATUS_COLOR[status as ConnectionStatus];
  return STATUS_COLOR.idle;
}

export function getWorstStatus(statuses: string[]): string {
  if (statuses.includes("connected")) return "connected";
  if (statuses.includes("connecting")) return "connecting";
  if (statuses.includes("error")) return "error";
  return "idle";
}
