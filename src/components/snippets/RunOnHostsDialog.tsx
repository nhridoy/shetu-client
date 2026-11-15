import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import { runOnHosts } from "@/lib/snippets/runOnHosts";
import { useHostStore } from "@/stores/hosts/hostStore";
import { useSnippetStore } from "@/stores/snippets/snippetStore";
import { useUnsavedChanges } from "@/stores/ui/unsavedChangesStore";

/** Termius-style "Run on hosts": pick hosts (saved per snippet), one tab each. */
export default function RunOnHostsDialog({
  snippet,
  onClose,
}: {
  snippet: { id: string; name: string };
  onClose: () => void;
}) {
  const hosts = useHostStore((s) => s.hosts);
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  // Picking waits for the saved targets, so they can't overwrite a choice already made.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void useSnippetStore
      .getState()
      .getDecryptedSnippet(snippet.id)
      // Saved ids of hosts deleted since don't count as picked.
      .then((s) =>
        setSelected(
          (s?.targets ?? []).filter((id) =>
            useHostStore.getState().hosts.some((h) => h.id === id),
          ),
        ),
      )
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [snippet.id]);

  const q = query.trim().toLowerCase();
  const shown = hosts.filter((h) => !q || h.name.toLowerCase().includes(q));
  const toggle = (id: string) =>
    setSelected((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
    );

  const saveTargets = async () => {
    await useSnippetStore.getState().updateSnippet(snippet.id, {
      targets: selected,
    });
    if (useSnippetStore.getState().error) toast.error("Couldn't save targets");
    else toast.success("Targets saved");
  };

  const run = async () => {
    if (selected.length === 0) {
      toast.error("Pick at least one host");
      return;
    }
    // Opened from the palette on any page: leaving must not drop unsaved edits there.
    if (!(await useUnsavedChanges.getState().confirmLeave())) return;
    setBusy(true);
    const result = await runOnHosts(snippet.id, selected);
    setBusy(false);
    if (result === "ok") {
      onClose();
      navigate("/terminal");
    } else if (result === "decrypt-failed")
      toast.error("Couldn't load this snippet");
    else if (result === "no-hosts") toast.error("Pick at least one host");
  };

  return (
    <Modal onClose={onClose} title="Run on hosts" maxWidth="max-w-md">
      {/* Modal turns Enter into its last button (Run); here Enter must never run. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: only swallows Enter from the fields inside */}
      <div
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        <p className="mb-3 text-sm text-dark-400">
          Opens a tab for each host and runs{" "}
          <span className="text-white">{snippet.name}</span> once it connects.
        </p>
        <input
          type="search"
          aria-label="Search hosts"
          placeholder="Search hosts"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="mb-2 h-8 w-full rounded-md border border-dark-700 bg-dark-900 px-2 text-sm text-white outline-none"
        />
        <div className="max-h-64 space-y-0.5 overflow-y-auto">
          {shown.length === 0 && (
            <p className="py-4 text-center text-sm text-dark-500">No hosts</p>
          )}
          {shown.map((h) => (
            <label
              key={h.id}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-dark-200 hover:bg-dark-800"
            >
              <input
                type="checkbox"
                checked={selected.includes(h.id)}
                disabled={!loaded}
                onChange={() => toggle(h.id)}
                className="accent-primary-500"
              />
              {h.name}
            </label>
          ))}
        </div>
        <div className="mt-4 flex items-center justify-between gap-2">
          <span aria-live="polite" className="text-xs text-dark-400">
            {selected.length} selected
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!loaded}
              onClick={saveTargets}
            >
              Save targets
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={busy || !loaded}
              onClick={run}
            >
              Run
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
