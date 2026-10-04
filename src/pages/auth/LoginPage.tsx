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
  type LoginFormSchema,
  loginFormDefaultValues,
  loginFormSchema,
  requiredFields,
} from "@/lib/schema/auth/loginFormSchema";
import { useAuthStore } from "@/stores/auth/authStore";

export default function LoginPage() {
  const { login, isLoading, error, clearError, pendingVerificationEmail } =
    useAuthStore();
  const [password, setPassword] = useState("");
  const {
    control,
    handleSubmit,
    formState: { isValid },
  } = useForm<LoginFormSchema>({
    defaultValues: loginFormDefaultValues,
    resolver: zodResolver(loginFormSchema),
  });

  const onSubmit = async (data: LoginFormSchema) => {
    clearError();
    setPassword(data.password);
    await login(data.email, data.password);
  };

  return (
    <div className="min-h-[calc(100vh-2.25rem)] bg-dark-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-primary-600 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <span className="text-white font-bold text-2xl">TV</span>
          </div>
          <h1 className="text-3xl font-bold text-white">Terra</h1>
          <p className="text-dark-400 mt-2">Self-hosted SSH client</p>
        </div>

        {pendingVerificationEmail ? (
          <EmailVerification password={password} />
        ) : (
          <div className="bg-dark-900 rounded-xl p-6 shadow-xl">
            <h2 className="text-xl font-semibold text-white mb-6">Sign In</h2>

            {error && (
              <div className="mb-4">
                <Alert variant="error">{error}</Alert>
              </div>
            )}

            <OAuthLogin />

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
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

              <div className="text-right">
                <Link
                  to="/recovery"
                  className="text-primary-500 hover:text-primary-400 text-xs"
                >
                  Forgot password?
                </Link>
              </div>

              <Button
                type="submit"
                disabled={isLoading || !isValid}
                variant="default"
                size="sm"
                className="w-full"
              >
                {isLoading ? "Loading..." : "Sign In"}
              </Button>
            </form>

            <div className="mt-6 text-center">
              <Link
                to="/register"
                onClick={() => clearError()}
                className="text-primary-500 hover:text-primary-400 text-sm"
              >
                Don't have an account? Create one
              </Link>
            </div>

            <ServerConfig />
          </div>
        )}
      </div>
    </div>
  );
}
