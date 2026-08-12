import { zodResolver } from "@hookform/resolvers/zod";
import { useTransition } from "react";
import { useForm } from "react-hook-form";
import ModalForm from "@/components/common/ModalForm";
import { FormInput } from "@/components/ui/forms/FormInput";
import { FormTextarea } from "@/components/ui/forms/FormTextarea";
import {
  type SnippetFormSchema,
  snippetFormDefaultValues,
  snippetFormSchema,
} from "@/lib/schema/snippets/snippetFormSchema";
import { parseTags } from "@/lib/snippets/parseTags";
import { useSnippetStore } from "@/stores/snippets/snippetStore";
import { useVaultStore } from "@/stores/vault/vaultStore";

interface SnippetFormProps {
  snippet?: {
    id: string;
    name: string;
    command: string;
    description?: string;
    tags?: string[];
  };
  onClose: () => void;
}

export default function SnippetForm({ snippet, onClose }: SnippetFormProps) {
  const { createSnippet, updateSnippet } = useSnippetStore();
  const { currentVaultId } = useVaultStore();
  const [isPending, startTransition] = useTransition();

  const { control, handleSubmit, reset } = useForm<SnippetFormSchema>({
    resolver: zodResolver(snippetFormSchema),
    defaultValues: {
      name: snippet?.name || snippetFormDefaultValues.name,
      command: snippet?.command || snippetFormDefaultValues.command,
      description: snippet?.description || snippetFormDefaultValues.description,
      tags: snippet?.tags
        ? parseTags(snippet.tags)
        : snippetFormDefaultValues.tags,
    },
  });

  const getButtonText = () => {
    if (isPending) return "Saving...";
    return snippet ? "Save Changes" : "Create Snippet";
  };

  const handleSnippetSubmit = async (data: SnippetFormSchema) => {
    const tagArray = data.tags
      ? data.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : [];

    if (snippet) {
      await updateSnippet(snippet.id, {
        name: data.name,
        command: data.command,
        description: data.description || "",
        tags: tagArray,
      });
    } else {
      await createSnippet({
        name: data.name,
        command: data.command,
        description: data.description || "",
        tags: tagArray,
        vaultId: currentVaultId || undefined,
      });
    }
    reset();
    onClose();
  };

  const onSubmit = async (data: SnippetFormSchema) => {
    startTransition(async () => {
      await handleSnippetSubmit(data);
    });
  };

  return (
    <ModalForm
      onClose={onClose}
      title={snippet ? "Edit Snippet" : "New Snippet"}
      isPending={isPending}
      onSubmit={handleSubmit(onSubmit)}
      submitButtonText={getButtonText()}
    >
      <FormInput
        name="name"
        label="Name"
        control={control}
        placeholder="Snippet name"
        required
      />

      <FormTextarea
        name="command"
        label="Command"
        control={control}
        placeholder="ssh user@host&#10;ls -la"
        required
      />

      <FormInput
        name="description"
        label="Description"
        control={control}
        placeholder="What does this snippet do?"
      />

      <FormInput
        name="tags"
        label="Tags (comma separated)"
        control={control}
        placeholder="production, deploy, ssh"
      />
    </ModalForm>
  );
}
