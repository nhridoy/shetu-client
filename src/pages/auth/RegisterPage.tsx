import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router";
import AuthLayout from "@/components/auth/AuthLayout";
import EmailVerification from "@/components/auth/forms/EmailVerification";
import OAuthLogin from "@/components/auth/forms/OAuthLogin";
import ServerConfig from "@/components/auth/forms/ServerConfig";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { FormInput } from "@/components/ui/forms/FormInput";
import {
  type RegisterFormSchema,
  registerFormDefaultValues,
  registerFormSchema,
  requiredFields,
} from "@/lib/schema/auth/registerFormSchema";
import { useAuthStore } from "@/stores/auth/authStore";

export default function RegisterPage() {
  const { register, isLoading, error, clearError, pendingVerificationEmail } =
    useAuthStore();
  const [password, setPassword] = useState("");
  const { control, handleSubmit } = useForm<RegisterFormSchema>({
    defaultValues: registerFormDefaultValues,
    resolver: zodResolver(registerFormSchema),
  });

  const onSubmit = async (data: RegisterFormSchema) => {
    clearError();
    setPassword(data.password);
    await register(data.email, data.full_name, data.password);
  };

  if (pendingVerificationEmail) {
    return <EmailVerification password={password} />;
  }

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Sync your hosts and keys across every device."
    >
      {error && (
        <div className="mb-4">
          <Alert variant="error">{error}</Alert>
        </div>
      )}

      <OAuthLogin />

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <FormInput
          control={control}
          name="full_name"
          label="Full Name"
          placeholder="John Doe"
          required={requiredFields.includes("full_name")}
        />

        <FormInput
          control={control}
          name="email"
          label="Email"
          placeholder="you@example.com"
          required={requiredFields.includes("email")}
        />

        <FormInput
          control={control}
          name="password"
          label="Password"
          type="password"
          placeholder="••••••••"
          required={requiredFields.includes("password")}
        />

        <FormInput
          control={control}
          name="confirmPassword"
          label="Confirm Password"
          type="password"
          placeholder="••••••••"
          required={requiredFields.includes("confirmPassword")}
        />

        <Button
          type="submit"
          disabled={isLoading}
          variant="default"
          className="w-full"
        >
          {isLoading ? "Creating account..." : "Create account"}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-dark-400">
        Already have an account?{" "}
        <Link
          to="/login"
          onClick={() => clearError()}
          className="text-primary-400 hover:text-primary-300"
        >
          Sign in
        </Link>
      </p>

      <ServerConfig />
    </AuthLayout>
  );
}
