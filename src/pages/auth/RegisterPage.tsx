import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router";
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

        {pendingVerificationEmail ? (
          <EmailVerification password={password} />
        ) : (
          <div className="bg-dark-900 rounded-xl p-6 shadow-xl">
            <h2 className="text-xl font-semibold text-white mb-6">
              Create Account
            </h2>

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
                size="sm"
                className="w-full"
              >
                {isLoading ? "Loading..." : "Create Account"}
              </Button>
            </form>

            <div className="mt-6 text-center">
              <Link
                to="/login"
                onClick={() => clearError()}
                className="text-primary-500 hover:text-primary-400 text-sm"
              >
                Already have an account? Sign in
              </Link>
            </div>

            <ServerConfig />
          </div>
        )}
      </div>
    </div>
  );
}
