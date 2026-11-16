import Checkbox from "@/components/ui/Checkbox";
import Select from "@/components/ui/Select";
import {
  LOCK_IDLE_MINUTES,
  useSettingsStore,
} from "@/stores/settings/settingsStore";

const IDLE_OPTIONS = LOCK_IDLE_MINUTES.map((m) => ({
  value: String(m),
  label: m === 0 ? "Off" : m === 1 ? "1 minute" : `${m} minutes`,
}));

/** Settings → Security: when Shetu locks itself while running (this device only). */
export default function AppLockSettings() {
  const minutes = useSettingsStore((s) => s.settings.lockAfterIdleMinutes);
  const onSystem = useSettingsStore((s) => s.settings.lockOnSystemLock);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor="lock-idle" className="text-sm text-white">
          Lock after idle
        </label>
        <Select
          id="lock-idle"
          value={String(minutes)}
          options={IDLE_OPTIONS}
          onValueChange={(v) =>
            void updateSetting("lockAfterIdleMinutes", Number(v))
          }
          className="w-40"
        />
      </div>
      <label
        htmlFor="lock-on-system"
        className="flex items-start gap-3 cursor-pointer"
      >
        <Checkbox
          id="lock-on-system"
          checked={onSystem}
          onCheckedChange={(on) => void updateSetting("lockOnSystemLock", on)}
          className="mt-0.5"
        />
        <div>
          <span className="text-sm text-white block">
            Lock on sleep or screen lock
          </span>
          <span className="text-xs text-dark-400 mt-1 block">
            Locks Shetu when this computer sleeps or its screen locks. Open
            connections keep running; unlock with your password.
          </span>
        </div>
      </label>
    </div>
  );
}
