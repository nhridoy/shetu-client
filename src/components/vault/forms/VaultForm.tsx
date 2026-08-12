import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useTransition } from "react";
import { useForm } from "react-hook-form";
import ModalForm from "@/components/common/ModalForm";
import { FormInput } from "@/components/ui/forms/FormInput";
import { FormSelect } from "@/components/ui/forms/FormSelect";
import {
  type VaultFormSchema,
  vaultFormDefaultValues,
  vaultFormSchema,
} from "@/lib/schema/vault/vaultFormSchema";
import { useVaultStore } from "@/stores/vault/vaultStore";

interface VaultFormProps {
  vault?: { id: string; name: string; description?: string; kind?: string };
  onClose: () => void;
}

const VAULT_KIND_OPTIONS = [
  { value: "personal", label: "Personal" },
  { value: "team", label: "Team" },
];

export default function VaultForm({ vault, onClose }: VaultFormProps) {
  const { createVault, updateVault } = useVaultStore();
  const [isPending, startTransition] = useTransition();

  const { control, handleSubmit, reset } = useForm<VaultFormSchema>({
    resolver: zodResolver(vaultFormSchema),
    defaultValues: vaultFormDefaultValues,
  });

  useEffect(() => {
    reset(
      vault
        ? {
            name: vault.name,
            kind:
              (vault.kind as VaultFormSchema["kind"]) ||
              vaultFormDefaultValues.kind,
            description: vault.description || "",
          }
        : vaultFormDefaultValues,
    );
  }, [vault, reset]);

  const getButtonText = () => {
    if (isPending) return "Saving...";
    return vault ? "Save" : "Create";
  };

  const handleVaultSubmit = async (data: VaultFormSchema) => {
    if (!data.name.trim()) return;

    if (vault) {
      await updateVault(vault.id, {
        name: data.name.trim(),
        kind: data.kind,
        description: (data.description || "").trim(),
      });
    } else {
      await createVault(
        data.name.trim(),
        data.kind,
        (data.description || "").trim(),
      );
    }
    reset();
    onClose();
  };

  const onSubmit = async (data: VaultFormSchema) => {
    startTransition(async () => {
      await handleVaultSubmit(data);
    });
  };

  return (
    <ModalForm
      onClose={onClose}
      title={vault ? "Edit Vault" : "Create Vault"}
      isPending={isPending}
      onSubmit={handleSubmit(onSubmit)}
      submitButtonText={getButtonText()}
    >
      <FormInput
        name="name"
        label="Name"
        control={control}
        placeholder="e.g. Personal, Production, Staging"
        required
      />
      <FormSelect
        name="kind"
        label="Type"
        control={control}
        options={VAULT_KIND_OPTIONS}
        placeholder="Select vault type"
      />
      <FormInput
        name="description"
        label="Description"
        control={control}
        placeholder="Optional description"
      />
    </ModalForm>
  );
}
