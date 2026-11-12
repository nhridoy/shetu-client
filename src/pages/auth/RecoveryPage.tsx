import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useNavigate } from "react-router";
import AuthLayout from "@/components/auth/AuthLayout";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { FormInput } from "@/components/ui/forms/FormInput";
import {
  type RecoveryFormSchema,
  recoveryFormDefaultValues,
  recoveryFormSchema,
} from "@/lib/schema/auth/recoveryFormSchema";
import { useAuthStore } from "@/stores/auth/authStore";

export default function RecoveryPage() {
  const navigate = useNavigate();
  const { recovery, isLoading, error, clearError } = useAuthStore();
  const [success, setSuccess] = useState(false);

  const { control, handleSubmit } = useForm<RecoveryFormSchema>({
    defaultValues: recoveryFormDefaultValues,
    resolver: zodResolver(recoveryFormSchema),
  });

  const onSubmit = async (data: RecoveryFormSchema) => {
    setSuccess(false);
    clearError();

    try {
      await recovery(data.recoveryCode, data.newPassword);
      setSuccess(true);
    } catch {
      // error is shown via the store's error field
    }
  };

  if (success) {
    return (
      <AuthLayout
        command="recover"
        title="Account recovered"
        subtitle="Your password has been reset. You can now sign in with your new password."
      >
        <Button
          type="button"
          onClick={() => navigate("/login")}
          variant="default"
          className="w-full"
        >
          Sign in
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      command="recover"
      title="Recover your account"
      subtitle="Enter your recovery code and set a new password."
    >
      {error && (
        <div className="mb-4">
          <Alert variant="error">{error}</Alert>
        </div>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <FormInput
          name="recoveryCode"
          label="Recovery Code"
          control={control}
          placeholder="Enter your recovery code"
          required
        />

        <FormInput
          name="newPassword"
          label="New Password"
          control={control}
          type="password"
          placeholder="••••••••"
          required
        />

        <FormInput
          name="confirmPassword"
          label="Confirm Password"
          control={control}
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
          {isLoading ? "Recovering..." : "Recover account"}
        </Button>
      </form>

      <Link
        to="/login"
        className="mt-6 flex items-center justify-center gap-1.5 text-dark-400 hover:text-white text-sm transition-colors"
      >
        <ArrowLeftIcon className="w-4 h-4" />
        Back to sign in
      </Link>
    </AuthLayout>
  );
}
