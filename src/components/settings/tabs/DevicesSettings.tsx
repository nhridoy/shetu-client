import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import { type DeviceView, devicesApi } from "@/lib/api/devices";
import { formatRelativeTime } from "@/lib/format/relativeTime";

const PLATFORMS: Record<string, string> = {
  linux: "Linux",
  macos: "macOS",
  windows: "Windows",
};

const label = (d: DeviceView) => d.name || "Unnamed device";

/** Settings → Security: devices signed in to this account; rename or sign out the others. */
export default function DevicesSettings() {
  const [devices, setDevices] = useState<DeviceView[] | null>(null);
  const [error, setError] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [confirm, setConfirm] = useState<DeviceView | "others" | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      setDevices(await devicesApi.list());
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await run();
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveName = (id: string, name: string) => {
    setRenaming(null);
    const trimmed = name.trim();
    if (trimmed) void act(() => devicesApi.rename(id, trimmed));
  };

  if (error)
    return (
      <div className="flex items-center gap-3 text-sm text-dark-400">
        Couldn't load devices.
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => void load()}
        >
          Retry
        </Button>
      </div>
    );
  if (!devices)
    return <p className="text-sm text-dark-400">Loading devices…</p>;

  const others = devices.filter((d) => !d.current);
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-dark-800 rounded-lg border border-dark-700">
        {devices.map((d) => (
          <li key={d.device_id} className="flex items-center gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              {renaming?.id === d.device_id ? (
                <input
                  aria-label="Device name"
                  // biome-ignore lint/a11y/noAutofocus: the user just asked to rename this row
                  autoFocus
                  value={renaming.name}
                  maxLength={100}
                  onChange={(e) =>
                    setRenaming({ id: d.device_id, name: e.target.value })
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveName(d.device_id, renaming.name);
                    if (e.key === "Escape") setRenaming(null);
                  }}
                  className="w-full rounded bg-dark-800 border border-dark-700 px-2 py-1 text-sm text-white focus:outline-none focus:border-primary-500"
                />
              ) : (
                <div className="flex items-center gap-2 text-sm text-white">
                  <span className="truncate">{label(d)}</span>
                  {d.current && <Badge>This device</Badge>}
                </div>
              )}
              <div className="text-xs text-dark-400">
                {[
                  PLATFORMS[d.platform] ?? d.platform,
                  d.app_version && `Shetu ${d.app_version}`,
                  `Signed in ${new Date(d.created_at).toLocaleDateString()}`,
                  `Active ${formatRelativeTime(d.last_seen_at)}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>
            {!d.current && renaming?.id !== d.device_id && (
              <div className="flex shrink-0 gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Rename ${label(d)}`}
                  disabled={busy}
                  onClick={() => setRenaming({ id: d.device_id, name: d.name })}
                >
                  Rename
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Sign out ${label(d)}`}
                  disabled={busy}
                  onClick={() => setConfirm(d)}
                >
                  Sign out
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {others.length > 0 && (
        <Button
          type="button"
          size="sm"
          variant="soft-destructive"
          disabled={busy}
          onClick={() => setConfirm("others")}
        >
          Sign out all other devices
        </Button>
      )}
      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm === "others"
            ? "Sign out all other devices?"
            : "Sign out device?"
        }
        message={
          confirm === "others"
            ? "Every other device loses access now and erases its Shetu data the next time it's online. If one was lost or stolen, also change your password."
            : confirm
              ? `Sign out ${label(confirm)}? It loses access now and erases its Shetu data the next time it's online. If it was lost or stolen, also change your password.`
              : ""
        }
        confirmLabel={confirm === "others" ? "Sign out all" : "Sign out device"}
        destructive
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const target = confirm;
          setConfirm(null);
          if (target === "others")
            void act(async () => {
              const { revoked } = await devicesApi.revokeOthers();
              toast.success(
                `Signed out ${revoked} device${revoked === 1 ? "" : "s"}`,
              );
            });
          else if (target) void act(() => devicesApi.revoke(target.device_id));
        }}
      />
    </div>
  );
}
