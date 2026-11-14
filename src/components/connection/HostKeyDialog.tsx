import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";

interface HostKeyPrompt {
  kind: "new" | "changed";
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  oldFingerprint?: string | null;
}

/** The only listener for host-key prompts; Rust waits until this answers. */
export default function HostKeyDialog() {
  const [queue, setQueue] = useState<HostKeyPrompt[]>([]);

  useEffect(() => {
    const off = listen<HostKeyPrompt>("ssh-host-key-prompt", (event) =>
      setQueue((q) => [...q, event.payload]),
    );
    return () => {
      void off.then((unlisten) => unlisten());
    };
  }, []);

  const prompt = queue[0];
  if (!prompt) return null;

  const answer = (accepted: boolean) => {
    setQueue((q) => q.slice(1));
    void invoke("accept_host_key", {
      host: prompt.host,
      port: prompt.port,
      accepted,
    }).catch(() => {});
  };
  const changed = prompt.kind === "changed";
  const fingerprintRow = (label: string, value: string) => (
    <div>
      <p className="text-xs text-dark-400">{label}</p>
      <p className="font-mono text-xs text-white break-all">{value}</p>
    </div>
  );

  return (
    <Modal
      key={`${prompt.host}:${prompt.port}:${prompt.fingerprint}`}
      onClose={() => answer(false)}
      title={changed ? "Host key changed" : "Verify host key"}
      hideClose
      zClass="z-[60]"
    >
      {changed ? (
        <p className="text-sm text-red-400">
          This could mean someone is intercepting the connection.
        </p>
      ) : (
        <p className="text-sm text-dark-200">
          First connection to {prompt.host}:{prompt.port}. Check that this
          fingerprint matches the server before trusting it.
        </p>
      )}
      <div className="mt-4 space-y-2 rounded-lg bg-dark-800 p-3">
        {changed && fingerprintRow("Host", `${prompt.host}:${prompt.port}`)}
        {fingerprintRow("Key type", prompt.keyType)}
        {changed &&
          fingerprintRow("Old fingerprint", prompt.oldFingerprint ?? "")}
        {fingerprintRow(
          changed ? "New fingerprint" : "Fingerprint",
          prompt.fingerprint,
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => answer(false)}>
          Cancel
        </Button>
        <Button
          type="button"
          variant={changed ? "destructive" : "default"}
          onClick={() => answer(true)}
        >
          {changed ? "Trust new key" : "Trust and connect"}
        </Button>
      </div>
    </Modal>
  );
}
