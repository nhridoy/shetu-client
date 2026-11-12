import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router";
import AuthLayout from "@/components/auth/AuthLayout";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { FormOTPInput } from "@/components/ui/forms/FormOTPInput";
import {
  type EmailVerificationFormSchema,
  emailVerificationFormDefaultValues,
  emailVerificationFormSchema,
} from "@/lib/schema/auth/emailVerificationFormSchema";
import { useAuthStore } from "@/stores/auth/authStore";

export default function EmailVerification({ password }: { password?: string }) {
  const navigate = useNavigate();
  const {
    pendingVerificationEmail,
    verifyEmail,
    resendVerification,
    clearPendingVerification,
    isLoading,
    error,
    clearError,
  } = useAuthStore();
  const [cooldown, setCooldown] = useState(0);
  const [resent, setResent] = useState(false);
  const timerRef = useRef<number | null>(null);

  const { control, handleSubmit, watch } = useForm<EmailVerificationFormSchema>(
    {
      defaultValues: emailVerificationFormDefaultValues,
      resolver: zodResolver(emailVerificationFormSchema),
    },
  );
  const otp = watch("otp") ?? "";

  const startCooldown = () => {
    setCooldown(60);
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
    }
    timerRef.current = window.setInterval(() => {
      setCooldown((s) => {
        if (s <= 1) {
          clearInterval(timerRef.current ?? undefined);
          timerRef.current = null;
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: cooldown starts once on mount
  useEffect(() => {
    startCooldown();
    return () => {
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const email = pendingVerificationEmail ?? "";

  const onSubmit = async (data: EmailVerificationFormSchema) => {
    clearError();
    await verifyEmail(email, data.otp, password);
  };

  const handleResend = async () => {
    clearError();
    setResent(false);
    startCooldown();
    await resendVerification(email);
    setResent(true);
  };

  const handleBackToLogin = () => {
    clearPendingVerification();
    navigate("/login");
  };

  return (
    <AuthLayout
      command="verify"
      title="Verify your email"
      subtitle={
        <>
          Enter the 6-digit code sent to{" "}
          <span className="text-white">{email}</span>
        </>
      }
    >
      {error && (
        <div className="mb-4">
          <Alert variant="error">{error}</Alert>
        </div>
      )}

      {resent && (
        <div className="mb-4">
          <Alert variant="success">A new code has been sent to {email}</Alert>
        </div>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <FormOTPInput
          control={control}
          name="otp"
          label="Verification code"
          required
          otpLength={6}
        />

        <Button
          type="submit"
          disabled={isLoading || otp.length !== 6}
          variant="default"
          className="w-full"
        >
          {isLoading ? "Verifying..." : "Verify"}
        </Button>
      </form>

      <div className="mt-4 space-y-4 mb-0">
        <Button
          type="button"
          disabled={cooldown > 0}
          variant="outline"
          size="sm"
          className="w-full"
          onClick={handleResend}
        >
          {cooldown > 0 ? `Resend code (${cooldown}s)` : "Resend code"}
        </Button>

        <Button
          type="button"
          variant="link"
          size="sm"
          className="w-full"
          onClick={handleBackToLogin}
        >
          Back to sign in
        </Button>
      </div>
    </AuthLayout>
  );
}
