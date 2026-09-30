import { zodResolver } from "@hookform/resolvers/zod";
import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/Button";
import { FormInput } from "@/components/ui/forms/FormInput";
import { FormSelect } from "@/components/ui/forms/FormSelect";
import Modal from "@/components/ui/Modal";
import { extractError } from "@/lib/common/extractError";
import {
  type GenerateKeyFormSchema,
  generateKeyFormDefaultValues,
  generateKeyFormSchema,
} from "@/lib/schema/keys/generateKeyFormSchema";
import { useKeyStore } from "@/stores/keys/keyStore";
import type { KeyItem } from "@/types/keys/types";

export default function GenerateKeyModal({
  vaultId: _vaultId,
  onClose,
}: {
  vaultId?: string;
  onClose: (savedKey?: KeyItem) => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [generatedPrivKey, setGeneratedPrivKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<KeyItem | null>(null);
  const [copied, setCopied] = useState(false);

  const { control, handleSubmit } = useForm<GenerateKeyFormSchema>({
    resolver: zodResolver(generateKeyFormSchema),
    defaultValues: generateKeyFormDefaultValues,
  });

  const getButtonText = () => {
    if (isPending) return "Generating...";
    return "Generate";
  };

  const handleKeySubmit = async (data: GenerateKeyFormSchema) => {
    setError(null);
    try {
      const key = await useKeyStore
        .getState()
        .generateKey(data.name, data.keyType, data.description);
      setSavedKey(key);
      setGeneratedPrivKey(key.encryptedPrivateKey);
    } catch (err: unknown) {
      setError(extractError(err, "Failed to generate key"));
    }
  };

  const onSubmit = async (data: GenerateKeyFormSchema) => {
    startTransition(async () => {
      await handleKeySubmit(data);
    });
  };

  const handleCopy = async () => {
    if (generatedPrivKey) {
      await navigator.clipboard.writeText(generatedPrivKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (generatedPrivKey) {
    return (
      <Modal
        onClose={() => onClose(savedKey || undefined)}
        title="Key Generated Successfully"
        maxWidth="max-w-lg"
      >
        <p className="mb-4 text-sm text-dark-400">
          Copy the public key to your server's authorized_keys file. Save the
          private key only if you need an external backup; it is stored
          encrypted in this vault.
        </p>
        <p className="mb-2 text-sm text-dark-400">Public key</p>
        <pre className="p-4 mb-4 overflow-y-auto font-mono text-sm break-all whitespace-pre-wrap rounded-lg bg-dark-800 text-dark-300 max-h-24">
          {savedKey?.publicKey}
        </pre>
        <Button
          type="button"
          onClick={() =>
            navigator.clipboard.writeText(savedKey?.publicKey || "")
          }
          variant="ghost"
          size="sm"
        >
          Copy Public Key
        </Button>
        <p className="mt-4 mb-2 text-sm text-dark-400">Private key</p>
        <div className="p-4 mb-4 rounded-lg bg-dark-800">
          <pre className="overflow-y-auto font-mono text-sm break-all whitespace-pre-wrap text-dark-300 max-h-48">
            {generatedPrivKey}
          </pre>
        </div>
        <div className="flex justify-end gap-3">
          <Button
            type="button"
            onClick={() => onClose(savedKey || undefined)}
            variant="ghost"
            size="sm"
          >
            Close
          </Button>
          <Button
            type="button"
            onClick={handleCopy}
            variant={copied ? "success" : "default"}
            size="sm"
          >
            {copied ? "Copied!" : "Copy Private Key"}
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      onClose={() => onClose()}
      title="Generate SSH Key"
      maxWidth="max-w-md"
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <FormInput
          name="name"
          label="Key Name"
          control={control}
          placeholder="My SSH Key"
          required
        />
        <FormInput
          name="description"
          label="Description"
          control={control}
          placeholder="Staging server key"
        />
        <FormSelect
          name="keyType"
          label="Key Type"
          control={control}
          options={[
            { value: "ed25519", label: "Ed25519 (Recommended)" },
            { value: "rsa", label: "RSA (4096-bit)" },
            { value: "ecdsa", label: "ECDSA (P-256)" },
          ]}
        />
        {error && <p className="text-sm text-red-500">{error}</p>}
        <div className="flex justify-end gap-3">
          <Button
            type="button"
            onClick={() => onClose()}
            variant="ghost"
            size="sm"
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={isPending}>
            {getButtonText()}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
