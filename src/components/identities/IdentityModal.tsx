import { zodResolver } from "@hookform/resolvers/zod";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useForm, useWatch } from "react-hook-form";
import { Button } from "@/components/ui/Button";
import { FormInput } from "@/components/ui/forms/FormInput";
import { FormSelect } from "@/components/ui/forms/FormSelect";
import Modal from "@/components/ui/Modal";
import { extractError } from "@/lib/common/extractError";
import {
  type IdentityFormSchema,
  identityFormDefaultValues,
  identityFormSchema,
} from "@/lib/schema/identities/identityFormSchema";
import {
  type Identity,
  useIdentityStore,
} from "@/stores/identities/identityStore";
import { useKeyStore } from "@/stores/keys/keyStore";
import { useVaultStore } from "@/stores/vault/vaultStore";

interface Preview {
  code: string;
  secondsLeft: number;
}

/** Live code for the TOTP being typed, refreshed every second. */
function useTotpPreview(value: string) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPreview(null);
    setError(null);
    if (!value) return;
    let live = true;
    const tick = () =>
      invoke<Preview>("totp_preview", { value }).then(
        (p) => {
          if (!live) return;
          setPreview(p);
          setError(null);
        },
        (e) => {
          if (!live) return;
          setPreview(null);
          setError(String(e));
        },
      );
    void tick();
    const timer = setInterval(tick, 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [value]);
  return { preview, error };
}

export default function IdentityModal({
  identity,
  onClose,
  onSaved,
}: {
  identity?: Identity;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const keys = useKeyStore((s) => s.keys);
  const currentVaultId = useVaultStore((s) => s.currentVaultId);
  const [stored, setStored] = useState({ password: false, totp: false });
  const [remove, setRemove] = useState({ password: false, totp: false });
  const [error, setError] = useState<string | null>(null);
  // Editing waits for the stored values, so a Save can't drop what wasn't loaded yet.
  const [hydrated, setHydrated] = useState(!identity);
  const openedVaultId = useRef(currentVaultId);
  const { control, handleSubmit, reset, formState } =
    useForm<IdentityFormSchema>({
      resolver: zodResolver(identityFormSchema),
      defaultValues: identityFormDefaultValues,
    });
  const totpSecret = useWatch({ control, name: "totpSecret" })?.trim() ?? "";
  const totp = useTotpPreview(totpSecret);

  useEffect(() => {
    void useKeyStore.getState().fetchKeys(currentVaultId ?? undefined);
  }, [currentVaultId]);

  useEffect(() => {
    if (!identity) return;
    void useIdentityStore
      .getState()
      .getDecryptedIdentity(identity.id)
      .then((view) => {
        if (!view) {
          setError("Couldn't load this identity");
          return;
        }
        reset({
          ...identityFormDefaultValues,
          name: identity.name,
          username: view.username,
          keyId: view.keyId ?? "",
        });
        setStored({ password: view.hasPassword, totp: view.hasTotp });
        setHydrated(true);
      })
      .catch(() => setError("Couldn't load this identity"));
  }, [identity, reset]);

  // A draft belongs to the vault it was opened in; a vault switch discards it.
  useEffect(() => {
    if (currentVaultId !== openedVaultId.current) onClose();
  }, [currentVaultId, onClose]);

  const onSubmit = async (data: IdentityFormSchema) => {
    if (!hydrated) return;
    setError(null);
    if (data.totpSecret) {
      try {
        await invoke("totp_preview", { value: data.totpSecret });
      } catch (e) {
        setError(String(e));
        return;
      }
    }
    const store = useIdentityStore.getState();
    try {
      if (identity) {
        const ok = await store.updateIdentity(identity.id, {
          name: data.name,
          username: data.username,
          // A newly typed secret wins over "Remove saved".
          password: data.password || (remove.password ? null : ""),
          keyId: data.keyId || null,
          totpSecret: data.totpSecret || (remove.totp ? null : ""),
        });
        if (!ok) throw new Error(useIdentityStore.getState().error ?? "");
        onSaved(identity.id);
      } else {
        const id = await store.createIdentity({
          name: data.name,
          username: data.username,
          password: data.password || undefined,
          keyId: data.keyId || undefined,
          totpSecret: data.totpSecret || undefined,
          vaultId: currentVaultId ?? undefined,
        });
        if (!id) throw new Error(useIdentityStore.getState().error ?? "");
        onSaved(id);
      }
      onClose();
    } catch (e) {
      setError(extractError(e, "Failed to save identity"));
    }
  };

  const keepHint = (has: boolean) =>
    identity && has ? "Leave empty to keep" : undefined;

  const removeToggle = (field: "password" | "totp", has: boolean) =>
    identity &&
    has && (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setRemove((r) => ({ ...r, [field]: !r[field] }))}
      >
        {remove[field] ? "Keep saved" : "Remove saved"}
      </Button>
    );

  return createPortal(
    <Modal
      onClose={onClose}
      title={identity ? "Edit identity" : "New identity"}
      maxWidth="max-w-md"
      zClass="z-[60]"
    >
      <form
        onSubmit={(e) => {
          // Opened from the host/group form: React submit events bubble through portals.
          e.stopPropagation();
          void handleSubmit(onSubmit)(e);
        }}
        className="space-y-4"
      >
        {/* Typing before the stored values load would be overwritten by them. */}
        <fieldset disabled={!hydrated} className="min-w-0 space-y-4">
          <FormInput
            name="name"
            label="Label"
            placeholder="deploy@prod"
            control={control}
            required
          />
          <FormInput
            name="username"
            label="Username"
            placeholder="deploy"
            control={control}
            required
          />
          <div>
            <FormInput
              name="password"
              label="Password"
              type="password"
              placeholder={
                remove.password
                  ? "Saved password will be removed"
                  : keepHint(stored.password)
              }
              control={control}
            />
            {removeToggle("password", stored.password)}
          </div>
          <FormSelect
            name="keyId"
            label="SSH key"
            control={control}
            options={[
              { value: "", label: "None" },
              ...keys.map((k) => ({ value: k.id, label: k.name })),
            ]}
          />
          <div>
            <FormInput
              name="totpSecret"
              label="TOTP secret"
              description="Base32 secret or otpauth:// URI. Fills 2FA codes when the server asks."
              placeholder={
                remove.totp
                  ? "Saved TOTP will be removed"
                  : (keepHint(stored.totp) ?? "JBSWY3DPEHPK3PXP")
              }
              control={control}
            />
            {removeToggle("totp", stored.totp)}
            {totp.preview && (
              <p className="mt-1 text-sm text-dark-300">
                Current code{" "}
                <span className="font-mono text-white">
                  {totp.preview.code}
                </span>{" "}
                · {totp.preview.secondsLeft}s
              </p>
            )}
            {totp.error && (
              <p className="mt-1 text-sm text-red-500">{totp.error}</p>
            )}
          </div>
        </fieldset>
        {error && <p className="text-sm text-red-500">{error}</p>}
        <div className="flex justify-end gap-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={!hydrated || formState.isSubmitting}
          >
            Save
          </Button>
        </div>
      </form>
    </Modal>,
    document.body,
  );
}
