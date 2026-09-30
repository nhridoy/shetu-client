import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/Button";
import FileInput from "@/components/ui/FileInput";
import { FormBase } from "@/components/ui/forms/FormBase";
import { FormInput } from "@/components/ui/forms/FormInput";
import Modal from "@/components/ui/Modal";
import { extractError } from "@/lib/common/extractError";
import { looksLikePrivateKey } from "@/lib/common/validate";
import {
  type ImportKeyFormSchema,
  importKeyFormDefaultValues,
  importKeyFormSchema,
} from "@/lib/schema/keys/importKeyFormSchema";

export default function ImportKeyModal({
  onClose,
  onImport,
}: {
  onClose: () => void;
  onImport: (key: {
    name: string;
    description: string;
    publicKey: string;
    encryptedPrivateKey: string;
    passphrase?: string;
    fingerprint?: string;
  }) => Promise<void>;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"upload" | "paste">("upload");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const { control, handleSubmit, setValue, watch } =
    useForm<ImportKeyFormSchema>({
      resolver: zodResolver(importKeyFormSchema),
      defaultValues: importKeyFormDefaultValues,
    });

  const handleFile = async (file: File) => {
    setError(null);

    const MAX_SIZE = 50 * 1024;
    if (file.size > MAX_SIZE) {
      setError("File too large. SSH key files are typically under 5KB.");
      return;
    }

    try {
      const content = await file.text();
      const lowerName = file.name.toLowerCase();
      const lowerContent = content.trim().toLowerCase();

      if (lowerName.endsWith(".ppk")) {
        setError(
          "PuTTY (.ppk) format is not yet supported. Please convert to OpenSSH format first.",
        );
        return;
      }

      if (
        lowerContent.includes("begin rsa private key") ||
        lowerContent.includes("begin ec private key") ||
        lowerContent.includes("begin ed25519 private key") ||
        lowerContent.includes("begin dsa private key") ||
        lowerContent.includes("begin openssh private key") ||
        lowerContent.includes("begin private key")
      ) {
        setValue("privateKey", content);
        const currentName = watch("name");
        if (!currentName)
          setValue("name", file.name.replace(/\.(pem|key)$/i, ""));
        setMode("paste");
        return;
      }

      if (
        lowerContent.startsWith("ssh-rsa ") ||
        lowerContent.startsWith("ssh-ed25519 ") ||
        lowerContent.startsWith("ecdsa-sha2-nistp256 ") ||
        lowerContent.startsWith("ecdsa-sha2-nistp384 ") ||
        lowerContent.startsWith("ecdsa-sha2-nistp521 ") ||
        lowerContent.startsWith("ssh-dss ")
      ) {
        setValue("publicKey", content.trim());
        const currentName = watch("name");
        if (!currentName) setValue("name", file.name.replace(/\.(pub)$/i, ""));
        setMode("paste");
        return;
      }

      setError(
        "Unrecognized key file. Please use a PEM or OpenSSH private key.",
      );
    } catch (e: unknown) {
      setError(`Failed to read file: ${extractError(e)}`);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: handleFile is stable
  useEffect(() => {
    if (selectedFile) handleFile(selectedFile);
  }, [selectedFile]);

  const getButtonText = () => {
    if (isPending) return "Importing...";
    return "Import";
  };

  const handleKeySubmit = async (data: ImportKeyFormSchema) => {
    setError(null);

    if (
      data.privateKey &&
      !looksLikePrivateKey(data.privateKey) &&
      !data.publicKey
    ) {
      setError(
        "Private key format not recognized. Expected PEM or OpenSSH format.",
      );
      return;
    }

    await onImport({
      name: data.name,
      description: data.description || "",
      publicKey: data.publicKey || "",
      encryptedPrivateKey: data.privateKey,
      passphrase: data.passphrase || undefined,
    });
    onClose();
  };

  const onSubmit = async (data: ImportKeyFormSchema) => {
    startTransition(async () => {
      try {
        await handleKeySubmit(data);
      } catch (e: unknown) {
        setError(extractError(e, "Failed to import key"));
      }
    });
  };

  const switchToUpload = () => {
    setMode("upload");
    setValue("privateKey", "");
    setValue("publicKey", "");
    setError(null);
  };

  return (
    <Modal onClose={onClose} title="Import SSH Key" maxWidth="max-w-md">
      {mode === "upload" ? (
        <FileInput
          value={selectedFile}
          onValueChange={setSelectedFile}
          description="Supports PEM and OpenSSH formats"
        />
      ) : (
        <form
          id="import-key-form"
          onSubmit={handleSubmit(onSubmit)}
          className="space-y-4"
        >
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
            placeholder="Production server key"
          />
          <FormBase
            name="privateKey"
            label="Private Key"
            control={control}
            required
          >
            {(field) => (
              <textarea
                {...field}
                className="w-full px-4 py-3 font-mono text-sm text-white rounded-lg bg-dark-800 focus:outline-none focus:ring-2 focus:ring-primary-500"
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                rows={4}
                maxLength={65536}
              />
            )}
          </FormBase>
          <FormInput
            name="passphrase"
            label="Private Key Passphrase (if encrypted)"
            type="password"
            control={control}
            placeholder="Enter the key passphrase"
          />
          <FormInput
            name="publicKey"
            label="Public Key (optional)"
            control={control}
            placeholder="ssh-ed25519 AAAA..."
          />
        </form>
      )}

      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}

      <div className="mt-4">
        {mode === "upload" ? (
          <Button type="button" onClick={() => setMode("paste")} variant="link">
            or paste key manually
          </Button>
        ) : (
          <Button type="button" onClick={switchToUpload} variant="link">
            or upload file instead
          </Button>
        )}
      </div>

      <div className="flex justify-end gap-3 pt-4 mt-4 border-t border-dark-700">
        <Button
          type="button"
          onClick={onClose}
          variant="ghost"
          size="sm"
          disabled={isPending}
        >
          Cancel
        </Button>
        {mode === "paste" && (
          <Button
            type="submit"
            form="import-key-form"
            size="sm"
            disabled={isPending}
          >
            {getButtonText()}
          </Button>
        )}
      </div>
    </Modal>
  );
}
