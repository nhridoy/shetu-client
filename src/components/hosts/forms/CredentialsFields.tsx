import {
  ArrowCounterClockwiseIcon,
  EyeIcon,
  EyeSlashIcon,
  IdentificationCardIcon,
  KeyIcon,
  PlusIcon,
  XIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  type Control,
  type FieldValues,
  type UseFormResetField,
  useController,
  useWatch,
} from "react-hook-form";
import IdentityModal from "@/components/identities/IdentityModal";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { FormBase } from "@/components/ui/forms/FormBase";
import Input from "@/components/ui/Input";
import { getRow } from "@/lib/db/db";
import { ownCredentials } from "@/lib/hosts/credentials";
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

/** A filled-in credential: icon, text, and an optional remove button. */
function Chip({
  icon,
  children,
  muted,
  onRemove,
  removeLabel,
}: {
  icon: ReactNode;
  children: ReactNode;
  muted?: boolean;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  return (
    <div
      className={`flex h-7 min-w-0 items-center gap-1.5 rounded-md border px-2 text-sm ${
        muted
          ? "border-dashed border-dark-700 text-dark-400"
          : "border-primary-500/30 bg-primary-600/10 text-white"
      }`}
    >
      <span className="shrink-0 [&>svg]:size-3.5">{icon}</span>
      <span className="truncate">{children}</span>
      {onRemove && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={removeLabel}
          className="ml-auto"
          onClick={onRemove}
        >
          <XIcon />
        </Button>
      )}
    </div>
  );
}

/** Options shown under a field; mousedown keeps focus in the field while picking. */
function Suggestions({
  items,
}: {
  items: { key: string; label: ReactNode; onPick: () => void }[];
}) {
  return (
    <div
      role="listbox"
      className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-dark-700 bg-dark-800 py-1 shadow-lg"
    >
      {items.map((item) => (
        <div
          key={item.key}
          role="option"
          aria-selected={false}
          tabIndex={-1}
          className="cursor-pointer px-2 py-1 text-sm text-dark-200 hover:bg-dark-700 hover:text-white"
          onMouseDown={(e) => {
            e.preventDefault();
            item.onPick();
          }}
        >
          {item.label}
        </div>
      ))}
    </div>
  );
}

/**
 * Username (with identity suggestions), password and key, as plain fields like Termius.
 * The login method is worked out from what is filled when the form saves.
 */
export default function CredentialsFields<T extends FieldValues>({
  control: typedControl,
  mode,
  inherited,
  resetField: typedResetField,
}: Props<T>) {
  // Shared by the host and group forms, whose value types differ.
  const control = typedControl as unknown as Control<FieldValues>;
  const resetField = typedResetField as unknown as
    | UseFormResetField<FieldValues>
    | undefined;
  const keys = useKeyStore((s) => s.keys);
  const currentVaultId = useVaultStore((s) => s.currentVaultId);
  const identities = useIdentityStore((s) => s.identities);
  const identityField = useController({ control, name: "identityId" }).field;
  const keyField = useController({ control, name: "keyId" }).field;
  const usernameField = useController({ control, name: "username" }).field;
  const [password, groupId] = useWatch({
    control,
    name: ["password", "groupId"],
  });
  const identityId = (identityField.value as string) || "";
  const keyId = (keyField.value as string) || "";
  const [identitiesLoaded, setIdentitiesLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  // Typing narrows the identity list; focusing shows all of them.
  const [query, setQuery] = useState("");
  const [pickingKey, setPickingKey] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [identityUser, setIdentityUser] = useState("");
  const usernameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setIdentitiesLoaded(false);
    void useIdentityStore
      .getState()
      .fetchIdentities(currentVaultId ?? undefined)
      .then(() => setIdentitiesLoaded(!useIdentityStore.getState().error));
  }, [currentVaultId]);

  useEffect(() => {
    setIdentityUser("");
    if (!identityId) return;
    let live = true;
    void useIdentityStore
      .getState()
      .getDecryptedIdentity(identityId)
      .then((v) => live && setIdentityUser(v?.username ?? ""))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [identityId]);

  // A deleted identity resolves as unset when connecting; drop the dead pick.
  useEffect(() => {
    if (!identitiesLoaded || !identityId) return;
    if (identities.some((i) => i.id === identityId)) return;
    // The list can be stale (vault switch, sync refresh); only the row itself says it's gone.
    let live = true;
    void getRow("identities", identityId)
      .catch(() => null)
      .then((row) => {
        if (
          !live ||
          (row && !row.deleted_at && row.vault_id === currentVaultId)
        )
          return;
        resetField?.("identityId", { defaultValue: "" });
      });
    return () => {
      live = false;
    };
  }, [currentVaultId, identitiesLoaded, identities, identityId, resetField]);

  // Empty host fields fall back to the group's login.
  const from = inherited?.authFrom;
  const inheriting =
    mode === "host" &&
    !!groupId &&
    !ownCredentials({ password, keyId, identityId });
  const inheritedAuth = inheriting && from ? inherited?.authType : undefined;
  const typed = query.toLowerCase();
  const identityName = identities.find((i) => i.id === identityId)?.name;

  const usernameRow = identityId ? (
    <div>
      <p className="mb-1 text-sm font-medium text-dark-200">Identity</p>
      <Chip
        icon={<IdentificationCardIcon />}
        removeLabel="Remove identity"
        onRemove={() => identityField.onChange("")}
      >
        {identityName ?? "Identity"}
        {identityUser && ` (${identityUser})`}
      </Chip>
    </div>
  ) : inheritedAuth === "identity" ? (
    <div>
      <p className="mb-1 text-sm font-medium text-dark-200">Identity</p>
      <Chip icon={<IdentificationCardIcon />} muted>
        Identity '{inherited?.identityName}' · {from}
      </Chip>
    </div>
  ) : (
    <div>
      <FormBase name="username" label="Username" control={control}>
        {({ ref, onBlur, placeholder: _p, ...field }) => (
          <div className="relative">
            <Input
              {...field}
              ref={(el) => {
                ref(el);
                usernameRef.current = el;
              }}
              autoComplete="off"
              placeholder={
                mode === "group"
                  ? "Not set"
                  : (inherited?.username ?? "Ask when connecting")
              }
              onChange={(e) => {
                field.onChange(e);
                setQuery(e.target.value);
              }}
              onFocus={() => {
                setQuery("");
                setSuggesting(true);
              }}
              onBlur={() => {
                setSuggesting(false);
                onBlur();
              }}
            />
            {suggesting && (
              <Suggestions
                items={[
                  ...identities
                    .filter(
                      (i) => !typed || i.name.toLowerCase().includes(typed),
                    )
                    .map((i) => ({
                      key: i.id,
                      label: (
                        <span className="flex items-center gap-1.5">
                          <IdentificationCardIcon className="size-3.5" />
                          {i.name}
                        </span>
                      ),
                      onPick: () => {
                        identityField.onChange(i.id);
                        setSuggesting(false);
                      },
                    })),
                  {
                    key: "new",
                    label: "+ New identity",
                    onPick: () => {
                      setSuggesting(false);
                      setCreating(true);
                    },
                  },
                ]}
              />
            )}
          </div>
        )}
      </FormBase>
      {mode === "host" && inherited?.username && (
        <div className="mt-1 flex items-center gap-1 text-xs text-dark-400">
          <span>{usernameField.value ? "Overrides" : "From group"}</span>
          <Badge className="max-w-32">
            <span className="truncate">{inherited.usernameFrom}</span>
          </Badge>
          {usernameField.value && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Use group value"
              onClick={() => {
                usernameField.onChange("");
                // The button hides once the field is empty; keep focus in the panel.
                usernameRef.current?.focus();
              }}
            >
              <ArrowCounterClockwiseIcon />
            </Button>
          )}
        </div>
      )}
    </div>
  );

  const groupPassword =
    (inheritedAuth === "password" || inheritedAuth === "both") &&
    inherited?.hasPassword;
  const groupKey =
    (inheritedAuth === "key" || inheritedAuth === "both") && inherited?.keyName;
  const keyName = keys.find((k) => k.id === keyId)?.name;

  return (
    <>
      {usernameRow}

      {!identityId && (
        <FormBase name="password" label="Password" control={control}>
          {({ placeholder: _p, ...field }) => (
            <div className="relative">
              <Input
                {...field}
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                placeholder={groupPassword ? `•••••• · ${from}` : "Password"}
                className="pr-8"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="absolute top-0.5 right-0.5"
                onClick={() => setShowPassword((s) => !s)}
              >
                {showPassword ? <EyeSlashIcon /> : <EyeIcon />}
              </Button>
            </div>
          )}
        </FormBase>
      )}

      {!identityId && (
        <div>
          <p className="mb-1 text-sm font-medium text-dark-200">SSH key</p>
          {keyId ? (
            <Chip
              icon={<KeyIcon />}
              removeLabel="Remove key"
              onRemove={() => keyField.onChange("")}
            >
              {keyName ?? "Key"}
            </Chip>
          ) : (
            <div className="relative flex items-center gap-2">
              {groupKey && (
                <Chip icon={<KeyIcon />} muted>
                  {inherited?.keyName} · {from}
                </Chip>
              )}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setPickingKey((p) => !p)}
                onBlur={() => setPickingKey(false)}
              >
                <PlusIcon className="size-3" weight="bold" />
                Key
              </Button>
              {pickingKey && (
                <div className="absolute top-7 left-0 w-full">
                  <Suggestions
                    items={
                      keys.length
                        ? keys.map((k) => ({
                            key: k.id,
                            label: k.name,
                            onPick: () => {
                              keyField.onChange(k.id);
                              setPickingKey(false);
                            },
                          }))
                        : [
                            {
                              key: "none",
                              label: "No keys in this vault",
                              onPick: () => setPickingKey(false),
                            },
                          ]
                    }
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {inheriting && !inheritedAuth && (
        <p className="text-xs text-dark-400">{loginLine(inherited)}</p>
      )}

      {creating && (
        <IdentityModal
          onClose={() => setCreating(false)}
          onSaved={(id) => identityField.onChange(id)}
        />
      )}
    </>
  );
}
