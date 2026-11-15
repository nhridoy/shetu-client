import { useEffect, useState } from "react";
import {
  type Control,
  type FieldValues,
  type UseFormResetField,
  useController,
  useWatch,
} from "react-hook-form";
import IdentityModal from "@/components/identities/IdentityModal";
import { FormBase } from "@/components/ui/forms/FormBase";
import { FormInput } from "@/components/ui/forms/FormInput";
import { FormSelect } from "@/components/ui/forms/FormSelect";
import Select from "@/components/ui/Select";
import { getRow } from "@/lib/db/db";
import type { InheritedDefaults } from "@/lib/hosts/inherited";
import { loginLine } from "@/lib/hosts/inheritedLabels";
import { useIdentityStore } from "@/stores/identities/identityStore";
import { useKeyStore } from "@/stores/keys/keyStore";
import { useVaultStore } from "@/stores/vault/vaultStore";

interface Props<T extends FieldValues> {
  control: Control<T>;
  mode: "host" | "group";
  inherited?: InheritedDefaults;
  /** Drops a stored identity that no longer exists, without marking the form dirty. */
  resetField?: UseFormResetField<T>;
}

const LABELS = {
  inherit: "From group",
  password: "Password",
  key: "SSH key",
  both: "Password + key",
  identity: "Identity",
  none: "None",
} as const;

const NEW_IDENTITY = "__new__";

const HOST_NONE = "Ask when connecting";

/**
 * Auth method, password and key picker. Group mode adds "Not set" (empty value);
 * host mode adds "From group" when the host has a group.
 */
export default function CredentialsFields<T extends FieldValues>({
  control: typedControl,
  mode,
  inherited,
  resetField: typedResetField,
}: Props<T>) {
  // Shared by the host and group forms, whose value types differ.
  const control = typedControl as unknown as Control<FieldValues>;
  const keys = useKeyStore((s) => s.keys);
  const authType = useWatch({ control, name: "authType" });
  const groupId = useWatch({ control, name: "groupId" });
  const resetField = typedResetField as unknown as
    | UseFormResetField<FieldValues>
    | undefined;
  const currentVaultId = useVaultStore((s) => s.currentVaultId);
  const identities = useIdentityStore((s) => s.identities);
  const identityField = useController({ control, name: "identityId" }).field;
  const [identitiesLoaded, setIdentitiesLoaded] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    setIdentitiesLoaded(false);
    void useIdentityStore
      .getState()
      .fetchIdentities(currentVaultId ?? undefined)
      .then(() => setIdentitiesLoaded(!useIdentityStore.getState().error));
  }, [currentVaultId]);

  // A deleted identity resolves as unset when connecting; show that instead of a dead pick.
  useEffect(() => {
    if (!identitiesLoaded || authType !== "identity" || !identityField.value)
      return;
    const id = identityField.value as string;
    if (identities.some((i) => i.id === id)) return;
    // The list can be stale (vault switch, sync refresh); only the row itself says it's gone.
    let live = true;
    void getRow("identities", id)
      .catch(() => null)
      .then((row) => {
        if (
          !live ||
          (row && !row.deleted_at && row.vault_id === currentVaultId)
        )
          return;
        resetField?.("authType", {
          defaultValue: mode === "host" ? "none" : "",
        });
        resetField?.("identityId", { defaultValue: "" });
      });
    return () => {
      live = false;
    };
  }, [
    currentVaultId,
    identitiesLoaded,
    identities,
    authType,
    identityField.value,
    resetField,
    mode,
  ]);
  // A stored "inherit" stays visible without a group so the validation error can explain it.
  const offerInherit = mode === "host" && (!!groupId || authType === "inherit");
  const choices = [
    ...(mode === "group" ? [["", "Not set"] as const] : []),
    ...(offerInherit ? [["inherit", LABELS.inherit] as const] : []),
    ...(["password", "key", "both", "identity", "none"] as const).map(
      (t) =>
        [t, t === "none" && mode === "host" ? HOST_NONE : LABELS[t]] as const,
    ),
  ];

  const options = choices.map(([value, label]) => ({ value, label }));

  return (
    <>
      <div>
        {mode === "group" ? (
          <FormBase
            name="authType"
            label="Authentication"
            control={control}
            horizontal
          >
            {({ onChange, value, placeholder: _p, ...field }) => (
              <div className="ml-auto w-40 shrink-0">
                <Select
                  {...field}
                  value={value}
                  onValueChange={onChange}
                  options={options}
                />
              </div>
            )}
          </FormBase>
        ) : (
          <FormSelect
            name="authType"
            label="Authentication"
            control={control}
            options={options}
          />
        )}
        {authType === "inherit" && (
          <p className="mt-1 text-xs text-dark-300">{loginLine(inherited)}</p>
        )}
      </div>

      {authType === "identity" && (
        <FormBase name="identityId" label="Identity" control={control} required>
          {({ onChange, value, placeholder: _p, ...field }) => (
            <Select
              {...field}
              value={value}
              onValueChange={(v) =>
                v === NEW_IDENTITY ? setCreating(true) : onChange(v)
              }
              options={[
                { value: "", label: "Select an identity" },
                ...identities.map((i) => ({ value: i.id, label: i.name })),
                { value: NEW_IDENTITY, label: "+ New identity" },
              ]}
            />
          )}
        </FormBase>
      )}

      {creating && (
        <IdentityModal
          onClose={() => setCreating(false)}
          onSaved={(id) => identityField.onChange(id)}
        />
      )}

      {(authType === "password" || authType === "both") && (
        <FormInput
          name="password"
          label="Password"
          control={control}
          type="password"
          placeholder="Enter password"
          required
        />
      )}

      {(authType === "key" || authType === "both") && (
        <FormSelect
          name="keyId"
          label="SSH Key"
          control={control}
          options={[
            { value: "", label: "Select a key" },
            ...keys.map((key) => ({ value: key.id, label: key.name })),
          ]}
          required
        />
      )}
    </>
  );
}
