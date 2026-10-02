import { load } from "@tauri-apps/plugin-store";
import { HttpError, httpRequest } from "./http";

const AUTH_SETTINGS_FILE = "auth.json";
const API_URL_KEY = "apiUrl";
const DEFAULT_API_URL = "http://localhost:8080";

// API URL lives in the tauri store (auth.json) so Rust/other processes could
// read it too; a memory cache keeps per-request reads synchronous.
let cachedApiUrl: string | null = null;

export async function loadApiUrl(): Promise<void> {
  try {
    const store = await load(AUTH_SETTINGS_FILE, { autoSave: false });
    const saved = await store.get<string>(API_URL_KEY);
    cachedApiUrl = saved && saved.trim() !== "" ? saved : null;
  } catch {
    cachedApiUrl = null;
  }
}

export function getApiUrl(): string {
  if (cachedApiUrl !== null) return cachedApiUrl;
  const env = import.meta.env.VITE_API_URL;
  return typeof env === "string" && env.trim() !== "" ? env : DEFAULT_API_URL;
}

export async function setApiUrl(url: string): Promise<void> {
  cachedApiUrl = url;
  try {
    const store = await load(AUTH_SETTINGS_FILE, { autoSave: false });
    await store.set(API_URL_KEY, url);
    await store.save();
  } catch {
    // best-effort: the in-memory value still applies for this session
  }
}

export interface ApiError {
  code: string;
  message: string;
  requestId?: string;
  email?: string;
}

export class AuthApiError extends Error {
  constructor(
    public status: number,
    public apiError: ApiError,
  ) {
    super(apiError.message);
    this.name = "AuthApiError";
  }
}

// All traffic flows through the Rust http_request proxy: Rust holds the
// tokens, refreshes on 401 (single-flight, one retry) and classifies
// offline/rejected sessions. This layer only maps facade results onto the
// AuthApiError shape the stores and forms consume.
async function apiFetch<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { auth?: boolean } = {},
): Promise<T> {
  let res: { status: number; body: string };
  try {
    res = await httpRequest(method, path, body, opts);
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.kind === "network") {
        throw new AuthApiError(0, {
          code: "NETWORK_ERROR",
          message: err.message,
        });
      }
      throw new AuthApiError(401, {
        code: "AUTH_EXPIRED",
        message: err.message,
      });
    }
    throw err;
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const json = res.body ? tryParseJson(res.body) : null;

  if (res.status >= 400) {
    const error = (json as { error?: ApiError } | null)?.error || {
      code: "UNKNOWN",
      message: `Request failed (${res.status})`,
    };
    throw new AuthApiError(res.status, error);
  }

  return (json as { data?: T })?.data ?? (json as T);
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface PreloginResponse {
  nonce: string;
  kdf: { m: number; t: number; p: number };
  server_salt: string;
  salt_cl: string;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
}

export interface User {
  id: string;
  email: string;
  full_name?: string;
  public_key?: string;
  initialized: boolean;
  auth_provider: string;
  created_at: string;
}

export interface LoginResponse extends TokenPair {
  user: User;
  keyring?: {
    dek_wrapped_by_kek: string;
    dek_wrapped_by_recovery: string;
    private_key_wrapped_by_dek: string;
  };
}

export interface DefaultVaultResponse {
  id: string;
  owner_id: string;
  name: string;
  kind: string;
  sort_order: number;
  is_default: boolean;
}

export interface KeyringRows {
  dek_wrapped_by_kek: string;
  // Absent until the recovery kit is attached after first authentication.
  dek_wrapped_by_recovery?: string;
  private_key_wrapped_by_dek: string;
}

export interface RegisterRequest {
  user_id: string;
  device_id: string;
  email: string;
  full_name?: string;
  password_hash: string;
  recovery_code?: string;
  public_key?: string;
  keyring?: KeyringRows;
  nonce: string;
  kdf: { m: number; t: number; p: number };
  server_salt: string;
  salt_cl: string;
}

export interface RegisterResponse extends Partial<TokenPair> {
  user: User;
  verification_required?: boolean;
  keyring?: KeyringRows;
}

export interface VerifyEmailResponse extends TokenPair {
  user: User;
  keyring?: KeyringRows;
}

export interface RecoveryPrefetchResponse {
  nonce: string;
  email: string;
  kdf: { m: number; t: number; p: number };
  server_salt: string;
  salt_cl: string;
  dek_wrapped_by_recovery: string;
  private_key_wrapped_by_dek: string;
}

export const authApi = {
  async prelogin(email: string): Promise<PreloginResponse> {
    return apiFetch("POST", "/api/v1/auth/prelogin", { email });
  },

  async register(req: RegisterRequest): Promise<RegisterResponse> {
    return apiFetch("POST", "/api/v1/auth/register", req);
  },

  async verifyEmail(params: {
    email: string;
    otp: string;
    device_id: string;
  }): Promise<VerifyEmailResponse> {
    return apiFetch("POST", "/api/v1/auth/verify-email", params);
  },

  async resendVerification(email: string): Promise<{
    verification_required: boolean;
  }> {
    return apiFetch("POST", "/api/v1/auth/resend-verification", { email });
  },

  async login(params: {
    email: string;
    proof: string;
    nonce: string;
    device_id: string;
    client_pubkey: string;
  }): Promise<LoginResponse> {
    return apiFetch("POST", "/api/v1/auth/login", params);
  },

  async refresh(refreshToken: string): Promise<TokenPair> {
    return apiFetch(
      "POST",
      "/api/v1/auth/refresh",
      {
        refresh_token: refreshToken,
      },
      { auth: false },
    );
  },

  async logout(refreshToken: string): Promise<void> {
    return apiFetch("POST", "/api/v1/auth/logout", {
      refresh_token: refreshToken,
    });
  },

  async me(): Promise<User> {
    return apiFetch("GET", "/api/v1/me");
  },

  async passwordChange(params: {
    old_proof: string;
    old_nonce: string;
    new_verifier: string;
    new_encrypted_dek: string;
    new_nonce: string;
    new_kdf: { m: number; t: number; p: number };
    new_server_salt: string;
    new_salt_cl: string;
  }): Promise<void> {
    return apiFetch("POST", "/api/v1/auth/password-change", params);
  },

  async recoveryPrefetch(
    recoveryCode: string,
  ): Promise<RecoveryPrefetchResponse> {
    return apiFetch("POST", "/api/v1/auth/recovery/prefetch", {
      recovery_code: recoveryCode,
    });
  },

  async recovery(params: {
    recovery_code: string;
    signature: string;
    new_recovery_code: string;
    new_verifier: string;
    new_encrypted_dek: string;
    new_dek_wrapped_by_recovery: string;
    new_nonce: string;
    new_kdf: { m: number; t: number; p: number };
    new_server_salt: string;
    new_salt_cl: string;
  }): Promise<void> {
    return apiFetch("POST", "/api/v1/auth/recovery", params);
  },

  async oauthExchange(params: {
    setup_code: string;
    user_id: string;
  }): Promise<TokenPair & { user: User; initialized: boolean }> {
    return apiFetch("POST", "/api/v1/auth/oauth/exchange", params);
  },

  async oauthStart(params: {
    provider: string;
    device_id: string;
    app_callback: string;
  }): Promise<{ auth_url: string }> {
    const qs = new URLSearchParams({
      device_id: params.device_id,
      app_callback: params.app_callback,
      format: "json",
    });
    return apiFetch(
      "GET",
      `/api/v1/auth/oauth/start/${params.provider}?${qs.toString()}`,
    );
  },

  async oauthSetup(params: {
    setup_token: string;
    auth_verifier: string;
    recovery_code: string;
    public_key: string;
    keyring: KeyringRows;
    server_salt: string;
    salt_cl: string;
    kdf: { m: number; t: number; p: number };
  }): Promise<TokenPair & { user: User }> {
    return apiFetch("POST", "/api/v1/auth/oauth/setup", params);
  },

  async fetchDefaultVault(): Promise<DefaultVaultResponse> {
    return apiFetch("GET", "/api/v1/vaults/default");
  },

  async fetchKeyring(): Promise<{
    keyring: KeyringRows;
    salt_cl: string;
  }> {
    return apiFetch("GET", "/api/v1/auth/keyring");
  },

  async attachRecoveryMaterial(params: {
    recovery_code: string;
    dek_wrapped_by_recovery: string;
  }): Promise<{ recovery_attached: boolean }> {
    return apiFetch("POST", "/api/v1/auth/recovery-material", params);
  },
};
