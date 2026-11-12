import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Navigate, useNavigate } from "react-router";
import AuthLayout from "@/components/auth/AuthLayout";
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
    <AuthLayout
      title="Set your password"
      subtitle="This password signs you in and encrypts your SSH keys and secrets. It never leaves your device."
    >
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
          className="w-full"
        >
          {isLoading ? "Setting up..." : "Complete setup"}
        </Button>
      </form>
    </AuthLayout>
  );
}
