import { useState } from "react";
import { Button } from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import Input from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/SectionHeader";
import Select from "@/components/ui/Select";
import type { SshTerminalType } from "@/stores/settings/settingsStore";
import type { SshTabProps } from "@/types/settings/types";

const TERM_OPTIONS = ["xterm-256color", "xterm", "vt100"].map((v) => ({
  value: v,
  label: v,
}));

function SecondsField({
  id,
  label,
  help,
  error,
  value,
  valid,
  onCommit,
}: {
  id: string;
  label: string;
  help?: string;
  error: string;
  value: number;
  valid: (n: number) => boolean;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const n = Number(draft);
  const invalid = draft.trim() === "" || !Number.isInteger(n) || !valid(n);
  return (
    <div>
      <label htmlFor={id} className="block text-sm text-white mb-1">
        {label}
      </label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        value={draft}
        aria-invalid={invalid}
        className="w-28"
        onChange={(e) => {
          setDraft(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isInteger(v) && valid(v))
            onCommit(v);
        }}
      />
      {invalid ? (
        <span className="block text-xs text-red-400 mt-1">{error}</span>
      ) : (
        help && <span className="block text-xs text-dark-400 mt-1">{help}</span>
      )}
    </div>
  );
}

export default function SshTab({
  knownHosts,
  knownHostsLoading,
  onLoadKnownHosts,
  onRemoveKnownHost,
  onClearAllKnownHosts,
  trustNewHosts,
  setTrustNewHosts,
  sshKeepaliveSecs,
  sshConnectTimeoutSecs,
  sshTerminalType,
  onSshSettingChange,
}: SshTabProps) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium text-white mb-3">
          SSH Configuration
        </h3>
        <div className="bg-dark-800 rounded-lg p-4 space-y-3">
          <p className="text-sm text-dark-300">
            Applies to every SSH connection on this device. Hosts can override
            keepalive in their Advanced settings.
          </p>
          <SecondsField
            id="ssh-keepalive"
            label="Keepalive interval (seconds)"
            help="0 turns keepalive off."
            error="Use 0 (off) or 5–600 seconds"
            value={sshKeepaliveSecs}
            valid={(n) => n === 0 || (n >= 5 && n <= 600)}
            onCommit={(n) => onSshSettingChange("sshKeepaliveSecs", n)}
          />
          <SecondsField
            id="ssh-connect-timeout"
            label="Connect timeout (seconds)"
            error="Use 5–60 seconds"
            value={sshConnectTimeoutSecs}
            valid={(n) => n >= 5 && n <= 60}
            onCommit={(n) => onSshSettingChange("sshConnectTimeoutSecs", n)}
          />
          <div>
            <label htmlFor="ssh-term" className="block text-sm text-white mb-1">
              Terminal type
            </label>
            <Select
              id="ssh-term"
              value={sshTerminalType}
              options={TERM_OPTIONS}
              onValueChange={(v) =>
                onSshSettingChange("sshTerminalType", v as SshTerminalType)
              }
            />
          </div>
          <label
            htmlFor="trust-new-hosts"
            className="flex items-start gap-2 cursor-pointer"
          >
            <Checkbox
              id="trust-new-hosts"
              checked={trustNewHosts}
              onCheckedChange={setTrustNewHosts}
              className="mt-0.5"
            />
            <span>
              <span className="block text-sm text-white">
                Trust new hosts automatically
              </span>
              <span className="block text-xs text-dark-400">
                Skip the fingerprint check the first time you connect to a
                server. Changed keys still ask.
              </span>
            </span>
          </label>
        </div>
      </div>

      <div className="border-t border-dark-700 pt-6">
        <SectionHeader title="Known Hosts" level="h4" className="mb-3">
          <div className="flex gap-2">
            <Button
              type="button"
              onClick={onLoadKnownHosts}
              disabled={knownHostsLoading}
              variant="ghost"
              size="sm"
            >
              {knownHostsLoading ? "Loading..." : "Refresh"}
            </Button>
            {knownHosts.length > 0 && (
              <Button
                type="button"
                onClick={onClearAllKnownHosts}
                variant="ghost"
                size="sm"
                className="text-red-400 hover:text-red-300"
              >
                Clear All
              </Button>
            )}
          </div>
        </SectionHeader>

        {knownHosts.length === 0 ? (
          <div className="bg-dark-800 rounded-lg p-4 text-sm text-dark-400">
            {knownHostsLoading
              ? "Loading known hosts..."
              : "No known hosts. They are saved automatically when you verify a host on first connection."}
          </div>
        ) : (
          <div className="bg-dark-800 rounded-lg divide-y divide-dark-700">
            {knownHosts.map((kh) => (
              <div
                key={`${kh.host}:${kh.port}`}
                className="flex items-center justify-between p-3"
              >
                <div className="min-w-0">
                  <p className="text-white text-sm font-mono truncate">
                    {kh.host}:{kh.port}
                  </p>
                  <p className="text-dark-500 text-xs font-mono truncate mt-0.5">
                    {kh.fingerprint}
                  </p>
                </div>
                <Button
                  type="button"
                  onClick={() => onRemoveKnownHost(kh.host, kh.port)}
                  variant="ghost"
                  size="sm"
                  className="hover:text-red-400 ml-3 shrink-0"
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
