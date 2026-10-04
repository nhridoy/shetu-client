import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Navigate, useNavigate } from "react-router";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { FormInput } from "@/components/ui/forms/FormInput";
import {
  type SetupFormSchema,
  setupFormDefaultValues,
  setupFormSchema,
} from "@/lib/schema/auth/setupFormSchema";
import { useAuthStore } from "@/stores/auth/authStore";

export default function SetupPage() {
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const pendingOAuth = useAuthStore((s) => s.pendingOAuth);
  const oauthSetup = useAuthStore((s) => s.oauthSetup);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const { control, handleSubmit } = useForm<SetupFormSchema>({
    defaultValues: setupFormDefaultValues,
    resolver: zodResolver(setupFormSchema),
  });

  if (isAuthenticated) {
    return <Navigate to="/hosts" replace />;
  }

  if (!pendingOAuth) {
    return <Navigate to="/login" replace />;
  }

  const onSubmit = async (data: SetupFormSchema) => {
    setError("");
    setIsLoading(true);

    try {
      await oauthSetup(data.password);
      navigate("/hosts");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Setup failed";
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-[calc(100vh-2.25rem)] bg-dark-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-primary-600 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <span className="text-white font-bold text-2xl">TV</span>
          </div>
          <h1 className="text-3xl font-bold text-white">TermVault</h1>
          <p className="text-dark-400 mt-2">Self-hosted SSH client</p>
        </div>

        <div className="bg-dark-900 rounded-xl p-6 shadow-xl">
          <h2 className="text-xl font-semibold text-white mb-2">
            Set Your Password
          </h2>
          <p className="text-dark-400 text-sm mb-6">
            This password signs you in and encrypts your SSH keys and secrets.
            It never leaves your device.
          </p>

          {error && (
            <div className="mb-4">
              <Alert variant="error">{error}</Alert>
            </div>
          )}

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <FormInput
              control={control}
              name="password"
              label="Password"
              type="password"
              placeholder="••••••••"
              required
            />

            <FormInput
              control={control}
              name="confirmPassword"
              label="Confirm Password"
              type="password"
              placeholder="••••••••"
              required
            />

            <Button
              type="submit"
              disabled={isLoading}
              variant="default"
              size="sm"
              className="w-full"
            >
              {isLoading ? "Setting up..." : "Complete Setup"}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
