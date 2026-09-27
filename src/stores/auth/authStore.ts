import { load } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import {
  AuthApiError,
  authApi,
  getApiUrl,
  type KeyringRows,
  loadApiUrl,
  type TokenPair,
  type User,
} from "../../lib/api/auth";
import { onSessionRevoked } from "../../lib/api/http";
import { getDeviceId } from "../../lib/common/device";
import {
  buildKeyringRows,
  clearAuthTokens,
  clearKeychain,
  computeLoginProof,
  deriveKek,
  generateAccountMaterial,
  generateRecoveryCode,
  loadRefreshToken,
  lockSession,
  recoveryUnwrapDek,
  saveRefreshToken,
  setAuthTokens,
  setBaseUrl,
  setRefreshToken,
  signChallenge,
  unwrapDek,
  unwrapPrivateKey,
  wrapDek,
  wrapDekWithRecovery,
} from "../../lib/crypto/crypto";
import { wipeLocalData } from "../../lib/db/db";
import {
  deletePassword,
  loadPassword,
  savePassword,
} from "../../lib/keychain/keychain";
import { cancelOAuthFlow, startOAuthFlow } from "../../lib/oauth/oauth";

// A session revoked by Rust (refresh rejected server-side — recovery,
// password change elsewhere, or reuse detection) must end the local session
// immediately; teardownSession is defined below but only invoked at runtime.
onSessionRevoked(() => {
  void teardownSession();
});

interface AuthState {
  user: User | null;
  tokens: TokenPair | null;
  isAuthenticated: boolean;
  isUnlocked: boolean;
  unlockPending: boolean;
  isInitialized: boolean;
  isLoading: boolean;
  error: string | null;
  pendingOAuth: { provider: string; setupCode: string; userId: string } | null;
  pendingVerificationEmail: string | null;
  alwaysAsk: boolean;

  prelogin: (email: string) => Promise<{
    nonce: string;
    kdf: { m: number; t: number; p: number };
    serverSalt: string;
    saltCl: string;
  }>;
  register: (email: string, name: string, password: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  unlock: (password: string) => Promise<void>;
  updateProfile: (data: {
    full_name?: string;
    email?: string;
  }) => Promise<void>;
  changePassword: (
    currentPassword: string,
    newPassword: string,
  ) => Promise<void>;
  recovery: (recoveryCode: string, newPassword: string) => Promise<void>;
  pendingRecoveryCode: string | null;
  pendingRecoveryContext: "signup" | "recovery" | null;
  pendingRecoveryEmail: string | null;
  clearRecoveryCode: () => void;
  clearError: () => void;
  restoreSession: () => Promise<void>;
  oauthStartFlow: (provider: string) => Promise<{ needsSetup: boolean }>;
  cancelOAuth: () => Promise<void>;
  oauthSetup: (password: string) => Promise<void>;
  verifyEmail: (email: string, otp: string, password?: string) => Promise<void>;
  resendVerification: (email: string) => Promise<void>;
  clearPendingVerification: () => void;
  ensureRecoveryKit: (
    existingKeyring?: KeyringRows | null,
  ) => Promise<string | null>;
  setAlwaysAsk: (flag: boolean) => Promise<void>;
}

async function persistTokens(tokens: TokenPair | null): Promise<void> {
  // In-memory mirror for anything still reading it; Rust owns the operative
  // custody (access token in memory, refresh token in the OS keychain).
  setRefreshToken(tokens?.refresh_token ?? null);
  try {
    if (tokens?.refresh_token) {
      await saveRefreshToken(tokens.refresh_token);
    } else {
      await clearKeychain();
    }
  } catch {
    // ignore keychain errors
  }
}

// Fully tear down a session: zeroize in-memory keys, purge the saved
// keychain password, clear the store, drop persisted tokens, and reset the
// local cache. Best-effort end-to-end so no single failure blocks logout.
async function teardownSession(): Promise<void> {
  await lockSession();
  try {
    await deletePassword();
  } catch {
    // ignore keychain purge errors
  }
  useAuthStore.setState({
    user: null,
    tokens: null,
    isAuthenticated: false,
    isUnlocked: false,
    pendingOAuth: null,
    pendingVerificationEmail: null,
  });
  await persistTokens(null);
  try {
    await clearAuthTokens();
  } catch {
    // ignore: Rust token state is best-effort on teardown
  }
  try {
    await wipeLocalData();
  } catch {
    // ignore local cache wipe errors
  }
}

let _restoreSessionLock: Promise<void> | null = null;

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

const ALWAYS_ASK_KEY = "alwaysAsk";
const AUTH_SETTINGS_FILE = "auth.json";

async function loadAlwaysAsk(): Promise<boolean> {
  try {
    const store = await load(AUTH_SETTINGS_FILE, { autoSave: false });
    return (await store.get<boolean>(ALWAYS_ASK_KEY)) === true;
  } catch {
    return false;
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  tokens: null,
  isAuthenticated: false,
  isUnlocked: false,
  unlockPending: false,
  isInitialized: false,
  isLoading: false,
  error: null,
  pendingRecoveryCode: null,
  pendingRecoveryContext: null,
  pendingRecoveryEmail: null,
  pendingOAuth: null,
  pendingVerificationEmail: null,
  alwaysAsk: false,

  prelogin: async (email: string) => {
    const res = await authApi.prelogin(email);
    return {
      nonce: res.nonce,
      kdf: res.kdf,
      serverSalt: res.server_salt,
      saltCl: res.salt_cl,
    };
  },

  register: async (email: string, name: string, password: string) => {
    set({ isLoading: true, error: null });
    try {
      const prelogin = await authApi.prelogin(email);

      const material = await generateAccountMaterial();
      await deriveKek(password, material.salt_cl);
      // Recovery material is deferred: the kit attaches (and is shown) on the
      // first authenticated moment — right after signup when verification is
      // not required, or after OTP verification when it is.
      const fullKeyring = await buildKeyringRows(material.recovery_code);
      const keyring = {
        dek_wrapped_by_kek: fullKeyring.dek_wrapped_by_kek,
        dek_wrapped_by_recovery: "",
        private_key_wrapped_by_dek: fullKeyring.private_key_wrapped_by_dek,
      };
      const proof = await computeLoginProof(
        prelogin.server_salt,
        prelogin.nonce,
      );

      const res = await authApi.register({
        user_id: crypto.randomUUID(),
        email,
        full_name: name,
        password_hash: proof.verifier,
        recovery_code: "",
        public_key: material.public_key,
        keyring,
        nonce: prelogin.nonce,
        kdf: { m: 32768, t: 2, p: 1 },
        server_salt: prelogin.server_salt,
        salt_cl: material.salt_cl,
      });

      if (res.verification_required) {
        set({
          pendingVerificationEmail: email,
          isLoading: false,
        });
        return;
      }

      // Verification not required: tokens are guaranteed by the server contract
      const pair = res as TokenPair;
      await setAuthTokens(pair.access_token, pair.refresh_token);
      set({
        user: res.user,
        tokens: pair,
        isAuthenticated: true,
        isUnlocked: true,
        isLoading: false,
      });
      await persistTokens(pair);
      if (!get().alwaysAsk) {
        await savePassword(password);
      }
      const recoveryCode = await get().ensureRecoveryKit(res.keyring ?? null);
      if (recoveryCode) {
        set({
          pendingRecoveryCode: recoveryCode,
          pendingRecoveryContext: "signup",
        });
      }
    } catch (err) {
      const message =
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "Registration failed";
      set({ error: message, isLoading: false });
      throw err;
    }
  },

  verifyEmail: async (email: string, otp: string, password?: string) => {
    set({ isLoading: true, error: null });
    try {
      const res = await authApi.verifyEmail({
        email,
        otp,
        device_id: await getDeviceId(),
      });

      if (res.keyring) {
        await unwrapDek(res.keyring.dek_wrapped_by_kek);
      }

      const newTokens = {
        access_token: res.access_token,
        refresh_token: res.refresh_token,
      };
      await setAuthTokens(newTokens.access_token, newTokens.refresh_token);
      set({
        user: res.user,
        tokens: newTokens,
        isAuthenticated: true,
        isUnlocked: true,
        pendingVerificationEmail: null,
        isLoading: false,
      });
      await persistTokens(newTokens);
      if (password && !get().alwaysAsk) {
        await savePassword(password);
      }
      const recoveryCode = await get().ensureRecoveryKit(res.keyring ?? null);
      if (recoveryCode) {
        set({
          pendingRecoveryCode: recoveryCode,
          pendingRecoveryContext: "signup",
        });
      }
    } catch (err) {
      const message =
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "Verification failed";
      set({ error: message, isLoading: false });
      throw err;
    }
  },

  resendVerification: async (email: string) => {
    set({ isLoading: true, error: null });
    try {
      await authApi.resendVerification(email);
      set({ isLoading: false });
    } catch (err) {
      const message =
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "Resend failed";
      set({ error: message, isLoading: false });
      throw err;
    }
  },

  clearPendingVerification: () => set({ pendingVerificationEmail: null }),

  // Recovery kits are created at the first authenticated moment (see
  // register): this attaches one if the account has none yet. Best-effort —
  // failures self-heal on the next successful auth, and a kit that already
  // exists on the server is never re-created. Callers that already hold the
  // keyring (login/verify responses) pass it in to skip a round trip.
  ensureRecoveryKit: async (existingKeyring?: KeyringRows | null) => {
    const { user, tokens } = get();
    if (!user || !tokens) return null;
    try {
      let keyring = existingKeyring ?? null;
      if (!keyring) {
        const res = await authApi.fetchKeyring();
        keyring = res.keyring;
      }
      if (keyring?.dek_wrapped_by_recovery) return null;
      const recoveryCode = await generateRecoveryCode();
      const dekWrappedByRecovery = await wrapDekWithRecovery(recoveryCode);
      await authApi.attachRecoveryMaterial({
        recovery_code: recoveryCode,
        dek_wrapped_by_recovery: dekWrappedByRecovery,
      });
      return recoveryCode;
    } catch {
      return null;
    }
  },

  login: async (email: string, password: string) => {
    set({ isLoading: true, error: null });
    try {
      const prelogin = await authApi.prelogin(email);

      await deriveKek(password, prelogin.salt_cl);
      const proof = await computeLoginProof(
        prelogin.server_salt,
        prelogin.nonce,
      );

      const res = await authApi.login({
        email,
        proof: proof.proof,
        nonce: prelogin.nonce,
        device_id: await getDeviceId(),
        client_pubkey: "",
      });

      if (res.keyring) {
        await unwrapDek(res.keyring.dek_wrapped_by_kek);
      }

      const newTokens = {
        access_token: res.access_token,
        refresh_token: res.refresh_token,
      };
      await setAuthTokens(newTokens.access_token, newTokens.refresh_token);
      set({
        user: res.user,
        tokens: newTokens,
        isAuthenticated: true,
        isUnlocked: true,
        pendingVerificationEmail: null,
        isLoading: false,
      });
      await persistTokens(newTokens);
      if (!get().alwaysAsk) {
        await savePassword(password);
      }
      const recoveryCode = await get().ensureRecoveryKit(res.keyring ?? null);
      if (recoveryCode) {
        set({
          pendingRecoveryCode: recoveryCode,
          pendingRecoveryContext: "signup",
        });
      }
    } catch (err) {
      if (
        err instanceof AuthApiError &&
        err.apiError.code === "VERIFICATION_REQUIRED"
      ) {
        set({
          pendingVerificationEmail: err.apiError.email ?? email,
          isLoading: false,
        });
        return;
      }
      const message =
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "Login failed";
      set({ error: message, isLoading: false });
      throw err;
    }
  },

  logout: async () => {
    const { tokens } = get();
    if (tokens?.refresh_token) {
      try {
        await authApi.logout(tokens.refresh_token);
      } catch {
        // ignore logout errors
      }
    }
    await teardownSession();
  },

  unlock: async (password: string) => {
    set({ error: null });
    try {
      const { user, tokens } = get();
      if (!user || !tokens) {
        throw new Error("Not authenticated");
      }
      const { keyring, salt_cl } = await authApi.fetchKeyring();
      await deriveKek(password, salt_cl);
      await unwrapDek(keyring.dek_wrapped_by_kek);
      set({ isUnlocked: true });
      if (!get().alwaysAsk) {
        try {
          await savePassword(password);
        } catch {
          // best-effort keychain refresh
        }
      }
      const recoveryCode = await get().ensureRecoveryKit(keyring);
      if (recoveryCode) {
        set({
          pendingRecoveryCode: recoveryCode,
          pendingRecoveryContext: "signup",
        });
      }
    } catch (err) {
      const message =
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "Unlock failed";
      set({ error: message });
      throw err;
    }
  },

  updateProfile: async (data) => {
    set((state) => ({
      user: state.user ? { ...state.user, ...data } : null,
    }));
  },

  changePassword: async (currentPassword: string, newPassword: string) => {
    const { user, tokens } = get();
    if (!user || !tokens) throw new Error("Not authenticated");

    // 1. Get fresh prelogin data
    const prelogin = await authApi.prelogin(user.email);

    // 2. Derive KEK from current password, compute old proof
    await deriveKek(currentPassword, prelogin.salt_cl);
    const oldProof = await computeLoginProof(
      prelogin.server_salt,
      prelogin.nonce,
    );

    // 3. Generate new KDF params + a fresh server salt, but KEEP the current
    // salt_cl: the recovery kit's dek_wrapped_by_recovery is wrapped under a
    // recovery-KEK derived from salt_cl, so rotating it would break recovery
    const newKdf = {
      m: 32768,
      t: 2,
      p: 1,
    };
    const newSaltCl = prelogin.salt_cl;
    const rand16 = new Uint8Array(16);
    crypto.getRandomValues(rand16);
    const newServerSalt = btoa(String.fromCharCode(...rand16)).replace(
      /=+$/,
      "",
    );

    // 4. Derive new KEK from new password, compute new verifier
    await deriveKek(newPassword, newSaltCl);
    const newVerifier = await computeLoginProof(newServerSalt, prelogin.nonce);

    // 5. Re-wrap DEK with new KEK
    const newEncryptedDek = await wrapDek();

    // 6. Send to server
    await authApi.passwordChange({
      old_proof: oldProof.proof,
      old_nonce: prelogin.nonce,
      new_verifier: newVerifier.verifier,
      new_encrypted_dek: newEncryptedDek,
      new_nonce: prelogin.nonce,
      new_kdf: newKdf,
      new_server_salt: newServerSalt,
      new_salt_cl: newSaltCl,
    });

    // 7. Refresh the OS keychain entry with the new password
    if (!get().alwaysAsk) {
      try {
        await savePassword(newPassword);
      } catch {
        // best-effort keychain refresh
      }
    }
  },

  clearError: () => set({ error: null }),

  clearRecoveryCode: () =>
    set({
      pendingRecoveryCode: null,
      pendingRecoveryContext: null,
      pendingRecoveryEmail: null,
    }),

  recovery: async (recoveryCode: string, newPassword: string) => {
    set({ isLoading: true, error: null });
    try {
      const prefetch = await authApi.recoveryPrefetch(recoveryCode);

      // 1. Unwrap the DEK with the recovery code (recovery-KEK = Argon2id(code, salt_cl))
      await recoveryUnwrapDek(
        recoveryCode,
        prefetch.salt_cl,
        prefetch.dek_wrapped_by_recovery,
      );

      // 2. Load the account private key so the nonce signature is a real
      // proof of possession of the recovered identity
      await unwrapPrivateKey(prefetch.private_key_wrapped_by_dek);

      // 3. Derive the new KEK from the new password
      await deriveKek(newPassword, prefetch.salt_cl);

      // 4. Rotate the recovery code: fresh code + re-wrap the DEK under it and the new KEK
      const newCode = await generateRecoveryCode();
      const keyring = await buildKeyringRows(newCode);

      // 5. Compute new verifier and sign the nonce (proof of possession)
      const newProof = await computeLoginProof(
        prefetch.server_salt,
        prefetch.nonce,
      );
      const signature = await signChallenge(prefetch.nonce);

      // 6. Send to server
      await authApi.recovery({
        recovery_code: recoveryCode,
        signature,
        new_recovery_code: newCode,
        new_verifier: newProof.verifier,
        new_encrypted_dek: keyring.dek_wrapped_by_kek,
        new_dek_wrapped_by_recovery: keyring.dek_wrapped_by_recovery,
        new_nonce: prefetch.nonce,
        new_kdf: { m: 32768, t: 2, p: 1 },
        new_server_salt: prefetch.server_salt,
        new_salt_cl: prefetch.salt_cl,
      });

      set({
        pendingRecoveryCode: newCode,
        pendingRecoveryContext: "recovery",
        pendingRecoveryEmail: prefetch.email,
        error: null,
      });
    } catch (err) {
      const message =
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "Recovery failed";
      set({ error: message, isLoading: false });
      throw err;
    } finally {
      set({ isLoading: false });
    }
  },

  restoreSession: async () => {
    // Deduplicate concurrent calls (e.g., React.StrictMode double-mount)
    if (_restoreSessionLock) return _restoreSessionLock;

    _restoreSessionLock = (async () => {
      try {
        await loadApiUrl();
        const alwaysAsk = await loadAlwaysAsk();
        set({ alwaysAsk });
        try {
          await setBaseUrl(getApiUrl());
        } catch {
          // ignore: Rust falls back to the compiled-in default URL
        }

        const refreshToken = await loadRefreshToken();

        if (refreshToken) {
          try {
            const newTokens = await authApi.refresh(refreshToken);
            const tokens = {
              access_token: newTokens.access_token,
              refresh_token: newTokens.refresh_token,
            };
            await setAuthTokens(tokens.access_token, tokens.refresh_token);
            set({ tokens, isAuthenticated: true });
            await persistTokens(tokens);

            const user = await authApi.me();
            set({ user });

            // D6: auto-unlock via OS keychain unless the user opted out
            let autoKeyring: KeyringRows | null = null;
            if (!alwaysAsk) {
              set({ unlockPending: true });
              try {
                const { keyring, salt_cl } = await authApi.fetchKeyring();
                autoKeyring = keyring;
                const savedPassword = await loadPassword();
                if (savedPassword) {
                  await deriveKek(savedPassword, salt_cl);
                  await unwrapDek(keyring.dek_wrapped_by_kek);
                  set({ isUnlocked: true });
                }
              } catch {
                // stale or wrong entry — user unlocks manually; self-heal on next ask
              } finally {
                set({ unlockPending: false });
              }
            }

            // Self-heal a missing recovery kit (e.g. verify-time attach failed).
            // Needs a live session; otherwise the manual unlock covers it.
            if (get().isUnlocked) {
              const recoveryCode = await get().ensureRecoveryKit(autoKeyring);
              if (recoveryCode) {
                set({
                  pendingRecoveryCode: recoveryCode,
                  pendingRecoveryContext: "signup",
                });
              }
            }
          } catch {
            await teardownSession();
          }
        }
      } catch {
        // ignore
      } finally {
        _restoreSessionLock = null;
        set({ isLoading: false, isInitialized: true });
      }
    })();

    return _restoreSessionLock;
  },

  oauthStartFlow: async (provider: string) => {
    set({ isLoading: true, error: null });
    try {
      const result = await startOAuthFlow(provider, await getDeviceId());

      if (result.dest === "error") {
        throw new Error(result.message ?? "OAuth sign-in failed");
      }

      if (result.dest === "setup") {
        set({
          pendingOAuth: {
            provider,
            setupCode: result.setupCode ?? "",
            userId: result.userId ?? "",
          },
          isLoading: false,
        });
        return { needsSetup: true };
      }

      // Existing user: tokens come back in the callback URL
      const newTokens = {
        access_token: result.accessToken ?? "",
        refresh_token: result.refreshToken ?? "",
      };
      await setAuthTokens(newTokens.access_token, newTokens.refresh_token);
      set({
        tokens: newTokens,
        isAuthenticated: true,
        isUnlocked: false,
        user: null,
        isLoading: false,
      });
      await persistTokens(newTokens);
      const user = await authApi.me();
      set({ user });

      // If this device has the account's password, auto-unlock.
      if (!get().alwaysAsk) {
        try {
          const { keyring, salt_cl } = await authApi.fetchKeyring();
          const savedPassword = await loadPassword();
          if (savedPassword) {
            await deriveKek(savedPassword, salt_cl);
            await unwrapDek(keyring.dek_wrapped_by_kek);
            set({ isUnlocked: true });
          }
        } catch {
          // wrong password for this account — user unlocks manually
        }
      }
      return { needsSetup: false };
    } catch (err) {
      const message =
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "OAuth sign-in failed";
      set({ error: message, isLoading: false });
      throw err;
    }
  },

  cancelOAuth: async () => {
    try {
      await cancelOAuthFlow();
    } catch {
      // no active attempt — nothing to cancel
    }
  },

  oauthSetup: async (password: string) => {
    const pending = get().pendingOAuth;
    if (!pending) {
      throw new Error("No pending OAuth setup");
    }
    set({ isLoading: true, error: null });
    try {
      const material = await generateAccountMaterial();
      await deriveKek(password, material.salt_cl);
      const keyring = await buildKeyringRows(material.recovery_code);
      const serverSalt = randomHex(32);
      const nonce = randomHex(32);
      const proof = await computeLoginProof(serverSalt, nonce);

      const res = await authApi.oauthSetup({
        setup_token: pending.setupCode,
        auth_verifier: proof.verifier,
        recovery_code: material.recovery_code,
        public_key: material.public_key,
        keyring,
        server_salt: serverSalt,
        salt_cl: material.salt_cl,
        kdf: { m: 32768, t: 2, p: 1 },
      });

      const newTokens = {
        access_token: res.access_token,
        refresh_token: res.refresh_token,
      };
      await setAuthTokens(newTokens.access_token, newTokens.refresh_token);
      set({
        user: res.user,
        tokens: newTokens,
        isAuthenticated: true,
        isUnlocked: true,
        pendingRecoveryCode: material.recovery_code,
        pendingRecoveryContext: "signup",
        pendingOAuth: null,
        isLoading: false,
      });
      await persistTokens(newTokens);
      if (!get().alwaysAsk) {
        await savePassword(password);
      }
    } catch (err) {
      const message =
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "OAuth setup failed";
      set({ error: message, isLoading: false });
      throw err;
    }
  },

  setAlwaysAsk: async (flag: boolean) => {
    set({ alwaysAsk: flag });
    try {
      const store = await load(AUTH_SETTINGS_FILE, { autoSave: false });
      await store.set(ALWAYS_ASK_KEY, flag);
      await store.save();
    } catch {
      // best-effort persist
    }
    if (flag) {
      // "never remember" should forget: purge the saved entry so a later
      // toggle-off can't silently auto-unlock. Next unlock re-saves it.
      try {
        await deletePassword();
      } catch {
        // best-effort purge; entry stays ignored while the flag is on
      }
    }
  },
}));
