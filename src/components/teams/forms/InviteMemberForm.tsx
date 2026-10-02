import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import ModalForm from "@/components/common/ModalForm";
import { FormInput } from "@/components/ui/forms/FormInput";
import { FormSelect } from "@/components/ui/forms/FormSelect";
import { teamsApi } from "@/lib/api/teams";
import {
  type InviteMemberFormSchema,
  inviteMemberFormDefaultValues,
  inviteMemberFormSchema,
} from "@/lib/schema/teams/inviteMemberFormSchema";

interface InviteMemberFormProps {
  teamId: string;
  onClose: () => void;
  onSubmit: (
    data: InviteMemberFormSchema,
    confirmedFingerprint: string,
  ) => Promise<void>;
}

export default function InviteMemberForm({
  teamId,
  onClose,
  onSubmit,
}: InviteMemberFormProps) {
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lookup, setLookup] = useState<{
    email: string;
    fingerprint: string;
  } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const { control, handleSubmit, watch } = useForm<InviteMemberFormSchema>({
    resolver: zodResolver(inviteMemberFormSchema),
    defaultValues: inviteMemberFormDefaultValues,
  });
  const email = watch("email").trim().toLowerCase();
  const activeLookup = lookup?.email === email ? lookup : null;

  const submit = handleSubmit(async (data) => {
    setPending(true);
    setError(null);
    try {
      const normalizedEmail = data.email.trim().toLowerCase();
      if (!activeLookup) {
        const recipient = await teamsApi.recipientKey(teamId, normalizedEmail);
        setLookup({
          email: normalizedEmail,
          fingerprint: recipient.fingerprint,
        });
        setConfirmed(false);
        return;
      }
      if (!confirmed)
        throw new Error(
          "Compare this fingerprint with the recipient and confirm it before inviting.",
        );
      await onSubmit(data, activeLookup.fingerprint);
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not send the invitation. Try again.",
      );
    } finally {
      setPending(false);
    }
  });

  return (
    <ModalForm
      onClose={onClose}
      title="Invite Member"
      isPending={isPending}
      onSubmit={submit}
      submitButtonText={
        isPending
          ? "Working..."
          : activeLookup
            ? "Send invitation"
            : "Check recipient key"
      }
    >
      <FormInput
        name="email"
        label="Existing account email"
        control={control}
        type="email"
        placeholder="user@example.com"
        required
      />
      <FormSelect
        name="role"
        label="Role"
        control={control}
        options={[
          { value: "member", label: "Member" },
          { value: "admin", label: "Admin" },
        ]}
      />
      {activeLookup && (
        <div className="space-y-3 rounded-lg bg-dark-800 p-3">
          <p className="text-sm text-white">
            Verify the recipient’s identity key
          </p>
          <p className="text-sm text-dark-300">
            Ask the account owner to compare this fingerprint with the one shown
            in their app. A mismatch can expose the shared vault key.
          </p>
          <code className="block break-all rounded bg-dark-900 p-2 text-xs text-white select-all">
            {activeLookup.fingerprint}
          </code>
          <label className="flex items-start gap-2 text-sm text-white">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              className="mt-1 accent-primary-500"
            />
            <span>I compared this fingerprint with the recipient.</span>
          </label>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger-400">
          {error}
        </p>
      )}
    </ModalForm>
  );
}
