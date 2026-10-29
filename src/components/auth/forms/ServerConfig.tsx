import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/Button";
import { FormInput } from "@/components/ui/forms/FormInput";
import {
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
      <div className="mt-4 text-center">
        <Button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          variant="ghost"
          className="text-dark-500 hover:text-dark-300 text-xs"
        >
          {isOpen ? "Hide server settings" : "Connect to custom server"}
        </Button>
      </div>

      {isOpen && (
        <div className="mt-4 p-3 bg-dark-800 rounded-lg">
          <form
            onSubmit={handleSubmit(async (data) => {
              const serverUrl = data.serverUrl?.trim();
              if (serverUrl) {
                await setApiUrl(serverUrl);
              } else {
                await clearApiUrlOverride();
              }
              await setBaseUrl(serverUrl || getDefaultApiUrl());
            })}
            className="space-y-2"
          >
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <FormInput
                  control={control}
                  name="serverUrl"
                  label="Server URL"
                  placeholder="Value from client/.env (VITE_API_URL)"
                />
              </div>
              <Button
                type="submit"
                disabled={!isValid}
                variant="default"
                size="sm"
                className="h-12"
              >
                Save
              </Button>
            </div>
            <p className="text-dark-500 text-xs">
              Leave empty to use VITE_API_URL from client/.env. Changes take effect immediately.
            </p>
          </form>
        </div>
      )}
    </>
  );
}
