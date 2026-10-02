import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import ModalForm from "@/components/common/ModalForm";
import { FormInput } from "@/components/ui/forms/FormInput";
import { FormTextarea } from "@/components/ui/forms/FormTextarea";
import {
  type CreateTeamFormSchema,
  createTeamFormDefaultValues,
  createTeamFormSchema,
} from "@/lib/schema/teams/createTeamFormSchema";

interface TeamFormProps {
  onClose: () => void;
  onSubmit: (data: CreateTeamFormSchema) => Promise<void>;
}

export default function TeamForm({ onClose, onSubmit }: TeamFormProps) {
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { control, handleSubmit } = useForm<CreateTeamFormSchema>({
    resolver: zodResolver(createTeamFormSchema),
    defaultValues: createTeamFormDefaultValues,
  });

  const submit = handleSubmit(async (data) => {
    setPending(true);
    setError(null);
    try {
      await onSubmit(data);
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not create the team. Try again.",
      );
    } finally {
      setPending(false);
    }
  });

  return (
    <ModalForm
      onClose={onClose}
      title="Create Team"
      isPending={isPending}
      onSubmit={submit}
      submitButtonText={isPending ? "Creating..." : "Create team"}
    >
      <FormInput
        name="name"
        label="Team Name"
        control={control}
        placeholder="My Team"
        required
      />
      <FormTextarea
        name="description"
        label="Description"
        control={control}
        placeholder="Optional description"
      />
      {error && (
        <p role="alert" className="text-sm text-danger-400">
          {error}
        </p>
      )}
    </ModalForm>
  );
}
