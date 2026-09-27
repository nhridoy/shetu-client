import { type FormEvent, useState } from "react";
import ModalForm from "@/components/common/ModalForm";
import Input from "@/components/ui/Input";
import Select from "@/components/ui/Select";
import {
  type PortForwardFormSchema,
  portForwardFormSchema,
} from "@/lib/schema/portforwarding/portForwardFormSchema";
import type {
  ForwardMode,
  PortForward,
} from "@/stores/portforwarding/portForwardingStore";

interface PortForwardFormProps {
  initial?: PortForward;
  onClose: () => void;
  onSubmit: (data: PortForwardFormSchema) => Promise<void>;
}

type FieldName =
  | "name"
  | "localPort"
  | "remoteBindAddress"
  | "remotePort"
  | "destinationHost"
  | "destinationPort";
type Draft = Record<FieldName, string> & { mode: ForwardMode };

function draftFromForward(forward?: PortForward): Draft {
  return {
    mode: forward?.mode ?? "local",
    name: forward?.name ?? "",
    localPort: String(forward?.localPort ?? 8080),
    remoteBindAddress: forward?.remoteBindAddress ?? "127.0.0.1",
    remotePort: String(forward?.remotePort ?? 8080),
    destinationHost: forward?.destinationHost ?? "localhost",
    destinationPort: String(forward?.destinationPort ?? 80),
  };
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export default function PortForwardForm({
  initial,
  onClose,
  onSubmit,
}: PortForwardFormProps) {
  const [draft, setDraft] = useState<Draft>(() => draftFromForward(initial));
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<FieldName, string>>
  >({});
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const setField = (field: FieldName, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
  };

  const field = (
    name: FieldName,
    label: string,
    options?: { type?: "number"; placeholder?: string },
  ) => (
    <label
      className="block space-y-1 text-xs text-dark-300"
      htmlFor={name}
      key={name}
    >
      <span>{label}</span>
      <Input
        id={name}
        type={options?.type ?? "text"}
        min={options?.type === "number" ? 1 : undefined}
        max={options?.type === "number" ? 65535 : undefined}
        value={draft[name]}
        placeholder={options?.placeholder}
        onChange={(event) => setField(name, event.target.value)}
        aria-invalid={Boolean(fieldErrors[name])}
      />
      {fieldErrors[name] && (
        <span className="text-danger-400">{fieldErrors[name]}</span>
      )}
    </label>
  );

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data =
      draft.mode === "local"
        ? {
            mode: "local" as const,
            name: draft.name,
            localPort: Number(draft.localPort),
            destinationHost: draft.destinationHost,
            destinationPort: Number(draft.destinationPort),
          }
        : draft.mode === "remote"
          ? {
              mode: "remote" as const,
              name: draft.name,
              remoteBindAddress: draft.remoteBindAddress,
              remotePort: Number(draft.remotePort),
              destinationHost: draft.destinationHost,
              destinationPort: Number(draft.destinationPort),
            }
          : {
              mode: "dynamic" as const,
              name: draft.name,
              localPort: Number(draft.localPort),
            };
    const parsed = portForwardFormSchema.safeParse(data);
    if (!parsed.success) {
      const errors: Partial<Record<FieldName, string>> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as FieldName;
        if (!errors[key]) errors[key] = issue.message;
      }
      setFieldErrors(errors);
      return;
    }
    setIsPending(true);
    setSubmissionError(null);
    try {
      await onSubmit(parsed.data);
      onClose();
    } catch (error) {
      setSubmissionError(errorText(error));
    } finally {
      setIsPending(false);
    }
  };

  return (
    <ModalForm
      onClose={onClose}
      title={initial ? "Edit Port Forward" : "Add Port Forward"}
      isPending={isPending}
      onSubmit={submit}
      submitButtonText={initial ? "Save Changes" : "Save Forward"}
    >
      <label
        className="block space-y-1 text-xs text-dark-300"
        htmlFor="forward-mode"
      >
        <span>Mode</span>
        <Select
          id="forward-mode"
          value={draft.mode}
          onValueChange={(value) => {
            setDraft((current) => ({ ...current, mode: value as ForwardMode }));
            setFieldErrors({});
          }}
          options={[
            { value: "local", label: "Local TCP" },
            { value: "remote", label: "Remote TCP" },
            { value: "dynamic", label: "Dynamic SOCKS5" },
          ]}
        />
      </label>
      {field("name", "Name", { placeholder: "My forward" })}
      {draft.mode !== "remote" &&
        field("localPort", "Local port", { type: "number" })}
      {draft.mode === "remote" && (
        <>
          <label
            className="block space-y-1 text-xs text-dark-300"
            htmlFor="remote-bind-address"
          >
            <span>Remote bind address</span>
            <Select
              id="remote-bind-address"
              value={draft.remoteBindAddress}
              onValueChange={(value) => setField("remoteBindAddress", value)}
              options={[
                { value: "127.0.0.1", label: "127.0.0.1 (remote loopback)" },
                { value: "0.0.0.0", label: "0.0.0.0 (all remote interfaces)" },
              ]}
            />
            {fieldErrors.remoteBindAddress && (
              <span className="text-danger-400">
                {fieldErrors.remoteBindAddress}
              </span>
            )}
          </label>
          {field("remotePort", "Remote port", { type: "number" })}
        </>
      )}
      {draft.mode !== "dynamic" && (
        <>
          {field(
            "destinationHost",
            draft.mode === "local"
              ? "Destination from SSH server"
              : "Destination from this device",
            { placeholder: "localhost" },
          )}
          {field("destinationPort", "Destination port", { type: "number" })}
        </>
      )}
      <p className="rounded-lg bg-dark-800 p-3 text-xs text-dark-400">
        Saved forwards stay stopped until you press Start. They never reconnect
        automatically.
      </p>
      {submissionError && (
        <p role="alert" className="text-sm text-danger-400">
          {submissionError}
        </p>
      )}
    </ModalForm>
  );
}
