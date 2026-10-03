import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import ModalForm from "@/components/common/ModalForm";
import { FormInput } from "@/components/ui/forms/FormInput";
import {
  type WorkspaceFormSchema,
  workspaceFormDefaultValues,
  workspaceFormSchema,
} from "@/lib/schema/workspaces/workspaceFormSchema";

interface WorkspaceFormProps {
  title: string;
  initialName?: string;
  submitLabel?: string;
  onSubmit: (name: string) => void | Promise<void>;
  onClose: () => void;
}

export default function WorkspaceForm({
  title,
  initialName = "",
  submitLabel = "Save",
  onSubmit,
  onClose,
}: WorkspaceFormProps) {
  const [isPending, startTransition] = useTransition();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { control, handleSubmit, reset } = useForm<WorkspaceFormSchema>({
    resolver: zodResolver(workspaceFormSchema),
    defaultValues: workspaceFormDefaultValues,
  });

  useEffect(() => {
    reset(initialName ? { name: initialName } : workspaceFormDefaultValues);
  }, [initialName, reset]);

  const getButtonText = () => {
    if (isPending) return "Saving...";
    return submitLabel;
  };

  const onValid = (data: WorkspaceFormSchema) => {
    startTransition(async () => {
      setSubmitError(null);
      try {
        await onSubmit(data.name);
        reset();
        onClose();
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : String(error));
      }
    });
  };

  return (
    <ModalForm
      onClose={onClose}
      title={title}
      isPending={isPending}
      onSubmit={handleSubmit(onValid)}
      submitButtonText={getButtonText()}
    >
      {submitError && (
        <p role="alert" className="text-sm text-red-400">
          {submitError}
        </p>
      )}
      <FormInput
        name="name"
        label="Workspace name"
        control={control}
        placeholder="e.g. Production Cluster"
        required
      />
    </ModalForm>
  );
}
