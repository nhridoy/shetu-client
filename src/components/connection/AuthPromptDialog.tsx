import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import {
  isSavedHostSession,
  rememberCredentials,
} from "@/lib/terminal/pendingCredentials";

interface AuthPrompt {
  id: string;
  host: string;
  port: number;
  username: string;
  name: string;
  instructions: string;
  prompts: { text: string; echo: boolean }[];
  kind?: "password" | "keyboard-interactive";
  sessionId?: string;
  hop?: "target" | "bastion";
}

/** The only listener for server login prompts; Rust waits until this answers. */
export default function AuthPromptDialog() {
  const [queue, setQueue] = useState<AuthPrompt[]>([]);

  useEffect(() => {
    const off = listen<AuthPrompt>("ssh-auth-prompt", (event) => {
      const { kind, hop, sessionId } = event.payload;
      // Any other target prompt means the password asked earlier was rejected: never save it.
      if (sessionId && hop === "target" && kind !== "password")
        rememberCredentials(sessionId, { password: undefined });
      setQueue((q) => [...q, event.payload]);
    });
    const closed = listen<{ id: string }>("ssh-auth-prompt-closed", (event) => {
      setQueue((q) => q.filter((p) => p.id !== event.payload.id));
    });
    return () => {
      void off.then((unlisten) => unlisten());
      void closed.then((unlisten) => unlisten());
    };
  }, []);

  const prompt = queue[0];
  if (!prompt) return null;

  const answer = (responses: string[] | null) => {
    setQueue((q) => q.slice(1));
    void invoke("answer_auth_prompt", { id: prompt.id, responses }).catch(
      () => {},
    );
  };

  return (
    <Modal
      key={prompt.id}
      onClose={() => answer(null)}
      title={`Login required — ${prompt.username}@${prompt.host}:${prompt.port}`}
      zClass="z-[60]"
    >
      {/* Keyed so typed answers never render into the next prompt. */}
      <PromptForm key={prompt.id} prompt={prompt} onAnswer={answer} />
    </Modal>
  );
}

function PromptForm({
  prompt,
  onAnswer,
}: {
  prompt: AuthPrompt;
  onAnswer: (responses: string[] | null) => void;
}) {
  const [values, setValues] = useState<string[]>([]);
  const [save, setSave] = useState(false);
  // Only the target's own password belongs on the saved host this terminal opened.
  const sessionId =
    prompt.kind === "password" &&
    prompt.hop === "target" &&
    prompt.sessionId &&
    isSavedHostSession(prompt.sessionId)
      ? prompt.sessionId
      : null;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const responses = prompt.prompts.map((_, i) => values[i] ?? "");
        // An unchecked retry also replaces a password an earlier attempt marked to save.
        if (sessionId)
          rememberCredentials(sessionId, {
            password: save ? responses[0] : undefined,
          });
        onAnswer(responses);
      }}
    >
      {prompt.name && (
        <p className="text-sm font-medium text-white">{prompt.name}</p>
      )}
      {prompt.instructions && (
        <p className="mt-1 whitespace-pre-wrap text-sm text-dark-200">
          {prompt.instructions}
        </p>
      )}
      <div className="mt-4 space-y-3">
        {prompt.prompts.map((p, i) => (
          <label key={p.text + String(i)} className="block">
            <span className="text-xs text-dark-400">{p.text}</span>
            <input
              // biome-ignore lint/a11y/noAutofocus: the dialog exists to be typed into
              autoFocus={i === 0}
              type={p.echo ? "text" : "password"}
              autoComplete="off"
              value={values[i] ?? ""}
              onChange={(e) =>
                setValues((v) => {
                  const next = [...v];
                  next[i] = e.target.value;
                  return next;
                })
              }
              className="mt-1 w-full rounded-lg bg-dark-800 px-3 py-2 text-sm text-white outline-none"
            />
          </label>
        ))}
        {sessionId && (
          <label className="flex items-center gap-2 text-sm text-white">
            <input
              type="checkbox"
              checked={save}
              onChange={(e) => setSave(e.target.checked)}
              className="accent-primary-500"
            />
            <span>Save to this host</span>
          </label>
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => onAnswer(null)}>
          Cancel
        </Button>
        <Button type="submit">Continue</Button>
      </div>
    </form>
  );
}
