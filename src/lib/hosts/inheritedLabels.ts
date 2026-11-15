import type { InheritedDefaults } from "./inherited";

const LOGIN_NAMES = {
  password: "Password",
  both: "Password + key",
  none: "Ask when connecting",
} as const;

export function loginLine(i?: InheritedDefaults): string {
  if (!i?.authType || !i.authFrom)
    return "No group sets a login — uses agent/none";
  if (i.authType === "identity")
    return `Identity '${i.identityName ?? ""}' · ${i.authFrom}`;
  if (i.authType === "key")
    return `${i.keyName ? `SSH key '${i.keyName}'` : "SSH key"} · ${i.authFrom}`;
  return `${LOGIN_NAMES[i.authType]} · ${i.authFrom}`;
}

export function portLine(i?: InheritedDefaults): string {
  if (i?.port == null || !i.portFrom) return "22";
  return `${i.port} · ${i.portFrom}`;
}

export function keepalivePlaceholder(i?: InheritedDefaults): string {
  if (i?.keepaliveSecs == null || !i.keepaliveFrom) return "Default";
  return `${i.keepaliveSecs > 0 ? i.keepaliveSecs : "Off"} · ${i.keepaliveFrom}`;
}

export function startupLine(i?: InheritedDefaults): string {
  if (!i?.startupFrom) return "Nothing";
  if (i.startupKind === "command") return `runs a command · ${i.startupFrom}`;
  if (i.startupKind === "snippet") return `runs a snippet · ${i.startupFrom}`;
  return "Nothing";
}

export function forwardLine(i?: InheritedDefaults): string {
  if (i?.forwardAgent == null || !i.forwardAgentFrom) return "Off";
  return `${i.forwardAgent ? "On" : "Off"} · ${i.forwardAgentFrom}`;
}
