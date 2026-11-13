import { zodResolver } from "@hookform/resolvers/zod";
import { XIcon } from "@phosphor-icons/react";
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
  type LoginFormSchema,
  loginFormDefaultValues,
  loginFormSchema,
  requiredFields,
} from "@/lib/schema/auth/loginFormSchema";
import { useAuthStore } from "@/stores/auth/authStore";

function noticeDate(iso: string): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime()))
    return "Your account is scheduled for deletion. Sign in to cancel.";
  const date = d.toLocaleDateString(undefined, { dateStyle: "long" });
  return `Your account will be deleted on ${date}. Sign in to cancel.`;
}

export default function LoginPage() {
  const {
    login,
    isLoading,
    error,
    clearError,
    pendingVerificationEmail,
    deletionNotice,
    clearDeletionNotice,
  } = useAuthStore();
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

  if (pendingVerificationEmail) {
    return <EmailVerification password={password} />;
  }

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to sync your hosts and keys."
    >
      {deletionNotice && (
        <div className="mb-4">
          <Alert
            variant="error"
            className="flex items-start justify-between gap-2"
          >
            <span>
              {deletionNotice.kind === "deleted"
                ? "This account has been deleted."
                : noticeDate(deletionNotice.date)}
            </span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={clearDeletionNotice}
              className="shrink-0 hover:text-red-300"
            >
              <XIcon size={12} weight="bold" aria-hidden="true" />
            </button>
          </Alert>
        </div>
      )}

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
            className="text-primary-400 hover:text-primary-300 text-xs"
          >
            Forgot password?
          </Link>
        </div>

        <Button
          type="submit"
          disabled={isLoading || !isValid}
          variant="default"
          className="w-full"
        >
          {isLoading ? "Signing in..." : "Sign in"}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-dark-400">
        New to Shetu?{" "}
        <Link
          to="/register"
          onClick={() => clearError()}
          className="text-primary-400 hover:text-primary-300"
        >
          Create an account
        </Link>
      </p>

      <ServerConfig />
    </AuthLayout>
  );
}
