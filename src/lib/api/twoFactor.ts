import { AuthApiError, apiFetch } from "./auth";

export interface TwoFactorStatus {
  enabled: boolean;
  /** False when the server has no TWO_FACTOR_KEY: two-factor can't be turned on. */
  available: boolean;
  backup_codes_left: number;
  email_verified: boolean;
}

export type SecondFactorKind = "totp" | "backup" | "email";

export const twoFactorApi = {
  status: () => apiFetch<TwoFactorStatus>("GET", "/api/v1/me/two-factor"),
  startSetup: () =>
    apiFetch<{ otpauth_url: string; secret: string; email_code_sent: boolean }>(
      "POST",
      "/api/v1/me/two-factor/setup",
      {},
    ),
  confirm: (code: string, emailCode?: string) =>
    apiFetch<{ backup_codes: string[] }>(
      "POST",
      "/api/v1/me/two-factor/confirm",
      emailCode ? { code, email_code: emailCode } : { code },
    ),
  disable: (code: string) =>
    apiFetch<void>("POST", "/api/v1/me/two-factor/disable", { code }),
  regenerateBackupCodes: (code: string) =>
    apiFetch<{ backup_codes: string[] }>(
      "POST",
      "/api/v1/me/two-factor/backup-codes",
      { code },
    ),
  /** Turns a sign-in challenge and a code into the response the first factor would have given. */
  verify: <T>(challenge: string, code: string, kind: SecondFactorKind) =>
    apiFetch<T>(
      "POST",
      "/api/v1/auth/two-factor",
      { challenge, code, kind },
      { auth: false },
    ),
  /** Recovery only: emails a code, the fallback when the authenticator is lost. */
  sendEmailCode: (challenge: string) =>
    apiFetch<void>(
      "POST",
      "/api/v1/auth/two-factor/email",
      { challenge },
      { auth: false },
    ),
};

/** A first factor that passed but needs the second: the error carries the challenge. */
export function isTwoFactorRequired(err: unknown): err is AuthApiError {
  return (
    err instanceof AuthApiError &&
    err.apiError.code === "TWO_FACTOR_REQUIRED" &&
    !!err.apiError.challenge
  );
}
