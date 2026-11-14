import { Button } from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import { SectionHeader } from "@/components/ui/SectionHeader";
import type { SshTabProps } from "@/types/settings/types";

export default function SshTab({
  knownHosts,
  knownHostsLoading,
  onLoadKnownHosts,
  onRemoveKnownHost,
  onClearAllKnownHosts,
  trustNewHosts,
  setTrustNewHosts,
}: SshTabProps) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium text-white mb-3">
          SSH Configuration
        </h3>
        <div className="bg-dark-800 rounded-lg p-4 space-y-3">
          <p className="text-sm text-dark-300">
            SSH client options are configured per-host in the host settings.
          </p>
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
