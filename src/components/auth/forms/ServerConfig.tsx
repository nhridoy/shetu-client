import { zodResolver } from "@hookform/resolvers/zod";
import { HardDrivesIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { FormInput } from "@/components/ui/forms/FormInput";
import {
  authApi,
  clearApiUrlOverride,
  getDefaultApiUrl,
  setApiUrl,
} from "@/lib/api/auth";
import { setBaseUrl } from "@/lib/crypto/crypto";
import {
  type ServerUrlSchema,
  serverUrlDefaultValues,
  serverUrlSchema,
} from "@/lib/schema/auth/serverUrlSchema";

export default function ServerConfig() {
  const [isOpen, setIsOpen] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const {
    control,
    handleSubmit,
    formState: { isValid },
  } = useForm<ServerUrlSchema>({
    defaultValues: serverUrlDefaultValues,
    resolver: zodResolver(serverUrlSchema),
  });

  return (
    <>
      <div className="mt-6 pt-4 border-t border-dark-900 flex justify-center">
        <Button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          variant="ghost"
          className="text-dark-500 hover:text-dark-300 font-mono text-xs"
        >
          <HardDrivesIcon className="w-3.5 h-3.5" />
          {isOpen ? "Hide server settings" : "Connect to custom server"}
        </Button>
      </div>

      {isOpen && (
        <div className="mt-3">
          <form
            onSubmit={handleSubmit(async (data) => {
              const serverUrl = data.serverUrl?.trim();
              setIsChecking(true);
              try {
                if (serverUrl) {
                  await setApiUrl(serverUrl);
                } else {
                  await clearApiUrlOverride();
                }
                await setBaseUrl(serverUrl || getDefaultApiUrl());
                const label = serverUrl
                  ? new URL(serverUrl).host
                  : "the default server";
                if (await authApi.isShetuServer()) {
                  toast.success(`Connected to ${label}`);
                  setIsOpen(false);
                } else {
                  toast.warning(
                    `Saved, but no Shetu server answered at ${label}`,
                  );
                }
              } catch {
                toast.error("Couldn't save the server URL. Try again.");
              } finally {
                setIsChecking(false);
              }
            })}
          >
            {/* Locked while checking so an edit can't be lost when the panel closes. */}
            <fieldset disabled={isChecking} className="space-y-3">
              <FormInput
                control={control}
                name="serverUrl"
                label="Sync server URL"
                placeholder="https://sync.example.com"
              />
              <div className="flex items-center justify-between gap-3">
                <p className="text-dark-500 text-xs">
                  Leave empty to use the default server.
                </p>
                <Button
                  type="submit"
                  disabled={!isValid || isChecking}
                  variant="default"
                >
                  {isChecking ? "Checking..." : "Save"}
                </Button>
              </div>
            </fieldset>
          </form>
        </div>
      )}
    </>
  );
}
