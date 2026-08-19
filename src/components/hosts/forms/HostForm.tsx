import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useTransition } from "react";
import { Controller, useForm } from "react-hook-form";
import ModalForm from "@/components/common/ModalForm";
import { Button } from "@/components/ui/Button";
import { FormInput } from "@/components/ui/forms/FormInput";
import { FormSelect } from "@/components/ui/forms/FormSelect";
import {
  type HostFormValues,
  hostFormDefaultValues,
  hostFormSchema,
} from "@/lib/schema/hosts/hostFormSchema";
import { parseTags } from "@/lib/snippets/parseTags";
import { useHostStore } from "@/stores/hosts/hostStore";
import { useKeyStore } from "@/stores/keys/keyStore";
import { useVaultStore } from "@/stores/vault/vaultStore";

export interface HostData {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  authType: "password" | "key" | "both" | "none";
  keyId?: string;
  color?: string;
  groupId?: string;
  tags?: string[];
}

interface HostFormProps {
  host?: HostData;
  defaultGroupId?: string;
  onClose: () => void;
}

export default function HostForm({
  host,
  defaultGroupId,
  onClose,
}: HostFormProps) {
  const { createHost, updateHost, groups } = useHostStore();
  const { currentVaultId } = useVaultStore();
  const keys = useKeyStore((s) => s.keys);
  const fetchKeys = useKeyStore((s) => s.fetchKeys);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    fetchKeys(currentVaultId ?? undefined);
  }, [fetchKeys, currentVaultId]);

  const { control, handleSubmit, watch, reset } = useForm<HostFormValues>({
    resolver: zodResolver(hostFormSchema),
    defaultValues: {
      name: host?.name || hostFormDefaultValues.name,
      address: host?.address || hostFormDefaultValues.address,
      port: host?.port || hostFormDefaultValues.port,
      username: host?.username || hostFormDefaultValues.username,
      authType: host?.authType || hostFormDefaultValues.authType,
      password: hostFormDefaultValues.password,
      keyId: host?.keyId || hostFormDefaultValues.keyId,
      color: host?.color || hostFormDefaultValues.color,
      groupId: host?.groupId || defaultGroupId || hostFormDefaultValues.groupId,
      tags: host?.tags ? parseTags(host.tags) : hostFormDefaultValues.tags,
    },
  });

  const authType = watch("authType");

  const colors = [
    "#64748b",
    "#ef4444",
    "#f59e0b",
    "#22c55e",
    "#3b82f6",
    "#8b5cf6",
    "#ec4899",
    "#06b6d4",
  ];

  const getButtonText = () => {
    if (isPending) return "Saving...";
    return host ? "Save Changes" : "Add Host";
  };

  const handleHostSubmit = async (data: HostFormValues) => {
    const hostData = {
      name: data.name,
      address: data.address,
      port: Number(data.port),
      username: data.username,
      authType: data.authType,
      keyId:
        data.authType === "key" || data.authType === "both"
          ? data.keyId
          : undefined,
      password:
        data.authType === "password" || data.authType === "both"
          ? data.password
          : undefined,
      color: data.color,
      groupId: data.groupId || undefined,
      vaultId: currentVaultId || undefined,
      tags: data.tags
        ? data.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
    };

    if (host) {
      await updateHost(host.id, hostData);
    } else {
      await createHost(hostData);
    }
    reset();
    onClose();
  };

  const onSubmit = async (data: HostFormValues) => {
    startTransition(async () => {
      await handleHostSubmit(data);
    });
  };

  return (
    <ModalForm
      onClose={onClose}
      title={host ? "Edit Host" : "Add Host"}
      isPending={isPending}
      onSubmit={handleSubmit(onSubmit)}
      submitButtonText={getButtonText()}
    >
      <FormInput
        name="name"
        label="Name"
        control={control}
        placeholder="My Server"
        required
      />

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <FormInput
            name="address"
            label="Address"
            control={control}
            placeholder="192.168.1.100 or hostname"
            required
          />
        </div>
        <div>
          <FormInput
            name="port"
            label="Port"
            control={control}
            type="number"
            required
          />
        </div>
      </div>

      <FormInput
        name="username"
        label="Username"
        control={control}
        placeholder="root"
        required
      />

      <fieldset>
        <legend className="block text-dark-300 text-sm mb-2">
          Authentication <span className="text-red-400 ml-0.5">*</span>
        </legend>
        <Controller
          name="authType"
          control={control}
          render={({ field }) => (
            <div className="grid grid-cols-4 gap-2">
              {(["password", "key", "both", "none"] as const).map((type) => (
                <Button
                  key={type}
                  type="button"
                  onClick={() => field.onChange(type)}
                  variant={field.value === type ? "default" : "secondary"}
                  className="flex-1"
                >
                  {type === "password"
                    ? "Password"
                    : type === "key"
                      ? "SSH Key"
                      : type === "both"
                        ? "Both"
                        : "None"}
                </Button>
              ))}
            </div>
          )}
        />
      </fieldset>

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

      <fieldset>
        <legend className="block text-dark-300 text-sm mb-2">Color</legend>
        <Controller
          name="color"
          control={control}
          render={({ field }) => (
            <div className="flex gap-2">
              {colors.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => field.onChange(c)}
                  className={`cursor-pointer w-8 h-8 rounded-full ${
                    field.value === c
                      ? "ring-2 ring-white ring-offset-2 ring-offset-dark-900"
                      : ""
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          )}
        />
      </fieldset>

      <FormInput
        name="tags"
        label="Tags"
        control={control}
        placeholder="production, web (comma-separated)"
      />

      {!defaultGroupId && (
        <FormSelect
          name="groupId"
          label="Group"
          control={control}
          options={[
            { value: "", label: "No Group" },
            ...groups.map((g) => ({ value: g.id, label: g.name })),
          ]}
        />
      )}
    </ModalForm>
  );
}
