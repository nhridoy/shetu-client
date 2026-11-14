import { useState } from "react";
import { Button } from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import {
  answerUsername,
  useUsernameAsks,
} from "@/lib/terminal/pendingCredentials";

/** Asks for the login name when neither the host nor its groups set one. */
export default function UsernamePromptDialog() {
  const ask = useUsernameAsks((s) => s.queue[0]);
  if (!ask) return null;
  return (
    <Modal
      onClose={() => answerUsername(null)}
      title={`Username for ${ask.host}`}
      zClass="z-[60]"
    >
      {/* Keyed so a typed name never carries into the next question. */}
      <UsernameForm key={ask.id} />
    </Modal>
  );
}

function UsernameForm() {
  const [username, setUsername] = useState("");
  const [save, setSave] = useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (username.trim())
          answerUsername({ username: username.trim(), save });
      }}
    >
      <label className="block">
        <span className="text-xs text-dark-400">Username</span>
        <input
          // biome-ignore lint/a11y/noAutofocus: the dialog exists to be typed into
          autoFocus
          type="text"
          autoComplete="off"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="mt-1 w-full rounded-lg bg-dark-800 px-3 py-2 text-sm text-white outline-none"
        />
      </label>
      <label className="mt-3 flex items-center gap-2 text-sm text-white">
        <input
          type="checkbox"
          checked={save}
          onChange={(e) => setSave(e.target.checked)}
          className="accent-primary-500"
        />
        <span>Save to this host</span>
      </label>
      <div className="mt-5 flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() => answerUsername(null)}
        >
          Cancel
        </Button>
        <Button type="submit">Continue</Button>
      </div>
    </form>
  );
}
