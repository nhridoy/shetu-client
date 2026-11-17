import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { authApi } from "../api/auth";

export type OAuthDest = "setup" | "success" | "two_factor" | "error";

export interface OAuthCallbackResult {
  dest: OAuthDest;
  setupCode?: string;
  userId?: string;
  accessToken?: string;
  refreshToken?: string;
  /** dest two_factor: the challenge to verify with the code. */
  challenge?: string;
  message?: string;
}

export function parseCallbackUrl(rawUrl: string): OAuthCallbackResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { dest: "error", message: "The OAuth callback URL is invalid." };
  }

  const dest = url.searchParams.get("dest");

  if (dest === "setup") {
    const setupCode = url.searchParams.get("setup_code");
    const userId = url.searchParams.get("user_id");
    if (!setupCode || !userId) {
      return {
        dest: "error",
        message: "OAuth setup callback is missing required parameters.",
      };
    }
    return { dest: "setup", setupCode, userId };
  }

  if (dest === "success") {
    const accessToken = url.searchParams.get("access_token");
    const refreshToken = url.searchParams.get("refresh_token");
    const userId = url.searchParams.get("user_id");
    if (!accessToken || !refreshToken || !userId) {
      return {
        dest: "error",
        message: "OAuth success callback is missing required parameters.",
      };
    }
    return { dest: "success", accessToken, refreshToken, userId };
  }

  if (dest === "two_factor") {
    const challenge = url.searchParams.get("challenge");
    const userId = url.searchParams.get("user_id");
    if (!challenge || !userId) {
      return {
        dest: "error",
        message: "OAuth two-factor callback is missing required parameters.",
      };
    }
    return { dest: "two_factor", challenge, userId };
  }

  if (dest === "error") {
    return {
      dest: "error",
      message: url.searchParams.get("message") ?? "Authentication failed.",
    };
  }

  return { dest: "error", message: "Unknown OAuth callback destination." };
}

let activeAttempt: number | null = null;

export async function startOAuthFlow(
  provider: string,
  deviceId: string,
): Promise<OAuthCallbackResult> {
  const { port, attempt } = await invoke<{ port: number; attempt: number }>(
    "bind_oauth_listener",
  );
  const appCallback = `http://127.0.0.1:${port}/oauth/callback`;
  activeAttempt = attempt;
  try {
    const { auth_url } = await authApi.oauthStart({
      provider,
      device_id: deviceId,
      app_callback: appCallback,
    });
    await openUrl(auth_url);
    const callbackUrl = await invoke<string>("await_oauth_callback", {
      attempt,
    });
    return parseCallbackUrl(callbackUrl);
  } finally {
    activeAttempt = null;
    try {
      await invoke("cancel_oauth_listener", { attempt });
    } catch {
      // ignore cleanup errors
    }
  }
}

export async function cancelOAuthFlow(): Promise<void> {
  const attempt = activeAttempt;
  if (attempt === null) return;
  await invoke("cancel_oauth_listener", { attempt });
}
