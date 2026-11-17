import { ShieldCheckIcon, WarningIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  type SecurityEvent,
  securityEventsApi,
} from "@/lib/api/securityEvents";
import { formatRelativeTime } from "@/lib/format/relativeTime";
import { PLATFORMS } from "./DevicesSettings";

const FAILED = new Set(["sign_in_failed", "two_factor_failed"]);
const PROVIDERS: Record<string, string> = {
  google: "Google",
  github: "GitHub",
};

const TITLES: Record<string, string> = {
  sign_in_new_device: "New device signed in",
  sign_in_failed: "Failed sign-ins",
  two_factor_failed: "Wrong two-factor code",
  password_changed: "Password changed",
  recovery_used: "Password reset with recovery code",
  two_factor_enabled: "Two-factor turned on",
  two_factor_disabled: "Two-factor turned off",
  backup_code_used: "Backup code used",
  deletion_scheduled: "Account deletion scheduled",
  deletion_cancelled: "Account deletion cancelled",
};

/** Plain-language title for an event; unknown kinds (a newer server) still show. */
export function eventTitle(e: SecurityEvent): string {
  switch (e.kind) {
    case "sign_in":
      return PROVIDERS[e.detail]
        ? `Signed in · ${PROVIDERS[e.detail]}`
        : "Signed in";
    case "device_revoked":
      return `Device signed out: ${e.detail}`;
    case "devices_revoked_others":
      return `Signed out ${e.detail} other devices`;
    default:
      return TITLES[e.kind] ?? "Account activity";
  }
}

function eventDetail(e: SecurityEvent): string {
  const parts: string[] = [];
  if (e.device_name) parts.push(e.device_name);
  if (e.platform) parts.push(PLATFORMS[e.platform] ?? e.platform);
  let ip = e.ip;
  if (e.count > 1)
    ip +=
      e.ip_count > 1
        ? ` (${e.count}× from ${e.ip_count} addresses)`
        : ` (${e.count}×)`;
  if (ip) parts.push(ip);
  // The list runs by when each entry started; a grouped row also says when it last happened.
  if (e.count > 1) parts.push(`latest ${formatRelativeTime(e.last_at)}`);
  return parts.join(" · ");
}

/** Settings → Security → Recent activity: the account's security history, newest first. */
export default function RecentActivity() {
  const [events, setEvents] = useState<SecurityEvent[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (before?: number) => {
    setBusy(true);
    setError(false);
    try {
      const page = await securityEventsApi.list(before);
      setEvents((prev) =>
        before === undefined ? page.events : [...(prev ?? []), ...page.events],
      );
      setNext(page.next);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !events) {
    return (
      <div className="flex items-center gap-3 text-sm text-dark-400">
        Couldn't load recent activity.
        <Button size="sm" variant="ghost" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }
  if (!events) return <p className="text-sm text-dark-400">Loading…</p>;

  return (
    <div className="space-y-3">
      <p className="text-xs text-dark-400">
        Something you don't recognise? Sign out that device in Devices and
        change your password.
      </p>
      {events.length === 0 ? (
        <p className="text-sm text-dark-400">No activity yet</p>
      ) : (
        <ul className="divide-y divide-dark-800 rounded-lg border border-dark-700">
          {events.map((e) => {
            const failed = FAILED.has(e.kind);
            const Icon = failed ? WarningIcon : ShieldCheckIcon;
            return (
              <li key={e.id} className="flex items-start gap-3 px-3 py-2">
                <Icon
                  className={`mt-0.5 h-4 w-4 shrink-0 ${failed ? "text-amber-400" : "text-dark-400"}`}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm text-white">
                    {eventTitle(e)}
                    {e.current_device && <Badge>This device</Badge>}
                  </div>
                  <div className="break-words text-xs text-dark-400">
                    {eventDetail(e)}
                  </div>
                </div>
                <span className="shrink-0 text-xs text-dark-500">
                  {formatRelativeTime(e.created_at)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p className="text-xs text-red-400">Couldn't load recent activity.</p>
      )}
      {next !== null && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void load(next)}
        >
          Show more
        </Button>
      )}
    </div>
  );
}
