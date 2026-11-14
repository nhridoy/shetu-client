import { type Control, type FieldValues, useWatch } from "react-hook-form";
import { FormBase } from "@/components/ui/forms/FormBase";
import { FormInput } from "@/components/ui/forms/FormInput";
import { FormSelect } from "@/components/ui/forms/FormSelect";
import Select from "@/components/ui/Select";
import type { InheritedDefaults } from "@/lib/hosts/inherited";
import { loginLine } from "@/lib/hosts/inheritedLabels";
import { useKeyStore } from "@/stores/keys/keyStore";

interface Props<T extends FieldValues> {
  control: Control<T>;
  mode: "host" | "group";
  inherited?: InheritedDefaults;
}

const LABELS = {
  inherit: "From group",
  password: "Password",
  key: "SSH key",
  both: "Password + key",
  none: "None",
} as const;

const HOST_NONE = "Ask when connecting";

/**
 * Auth method, password and key picker. Group mode adds "Not set" (empty value);
 * host mode adds "From group" when the host has a group.
 */
export default function CredentialsFields<T extends FieldValues>({
  control: typedControl,
  mode,
  inherited,
}: Props<T>) {
  // Shared by the host and group forms, whose value types differ.
  const control = typedControl as unknown as Control<FieldValues>;
  const keys = useKeyStore((s) => s.keys);
  const authType = useWatch({ control, name: "authType" });
  const groupId = useWatch({ control, name: "groupId" });
  // A stored "inherit" stays visible without a group so the validation error can explain it.
  const offerInherit = mode === "host" && (!!groupId || authType === "inherit");
  const choices = [
    ...(mode === "group" ? [["", "Not set"] as const] : []),
    ...(offerInherit ? [["inherit", LABELS.inherit] as const] : []),
    ...(["password", "key", "both", "none"] as const).map(
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
