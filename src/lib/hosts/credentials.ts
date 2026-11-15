export type HostAuthType =
  | "inherit"
  | "password"
  | "key"
  | "both"
  | "none"
  | "identity";

interface Fields {
  password?: string | null;
  keyId?: string | null;
  identityId?: string | null;
}

export const ownCredentials = (f: Fields) =>
  !!(f.password || f.keyId || f.identityId);

/** The stored login method for what the credential fields hold. Groups with nothing are "" (not set). */
export function deriveAuthType(
  f: Fields,
  ctx: {
    mode: "host" | "group";
    groupId?: string | null;
    stored?: string | null;
    touched: boolean;
  },
): HostAuthType | "" {
  if (f.identityId) return "identity";
  if (f.password && f.keyId) return "both";
  if (f.password) return "password";
  if (f.keyId) return "key";
  if (ctx.mode === "group") return "";
  // An untouched "Ask when connecting" host keeps asking even inside a group.
  if (!ctx.groupId || (ctx.stored === "none" && !ctx.touched)) return "none";
  return "inherit";
}

/** Form values for a stored login: a field shows its stored value only when the method uses it. */
export function loadedCredentials(
  stored: string | null | undefined,
  v: Fields,
) {
  const uses = (...types: string[]) => !!stored && types.includes(stored);
  return {
    password: (uses("password", "both") && v.password) || "",
    keyId: (uses("key", "both") && v.keyId) || "",
    identityId: (uses("identity") && v.identityId) || "",
  };
}
