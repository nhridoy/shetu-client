import { Button } from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import { useCertTrustStore } from "@/lib/storage/certTrust";

/** "AB:CD:…" groups, easier to compare by eye than one long hex string. */
const pretty = (hex: string) => hex.match(/.{1,2}/g)?.join(":") ?? hex;

/** The only place certificate questions are shown; whoever asked waits for the answer. */
export default function CertTrustDialog() {
  const head = useCertTrustStore((s) => s.queue[0]);
  const answer = useCertTrustStore((s) => s.answer);
  if (!head) return null;
  const { prompt } = head;
  const changed = prompt.kind === "changed";
  return (
    <Modal
      open
      onClose={() => answer(false)}
      title={
        changed
          ? "The server's certificate changed"
          : "Trust this server's certificate?"
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-dark-300">
          {changed
            ? `${prompt.host} now presents a different certificate than the one you trusted. If you didn't replace it, someone may be intercepting the connection.`
            : `${prompt.host} uses a certificate your system doesn't trust (often a self-signed certificate on a NAS). Trust it only if the fingerprint matches the one your server shows.`}
        </p>
        {changed && prompt.previous && (
          <div>
            <div className="text-xs text-dark-400">
              Trusted before (SHA-256)
            </div>
            <code className="block break-all text-xs text-dark-300">
              {pretty(prompt.previous)}
            </code>
          </div>
        )}
        <div>
          <div className="text-xs text-dark-400">
            {changed ? "Now (SHA-256)" : "Fingerprint (SHA-256)"}
          </div>
          <code className="block break-all text-xs text-white">
            {prompt.sha256}
          </code>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={() => answer(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={changed ? "destructive" : "default"}
            onClick={() => answer(true)}
          >
            Trust
          </Button>
        </div>
      </div>
    </Modal>
  );
}
