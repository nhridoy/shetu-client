import { invoke } from "@tauri-apps/api/core";

export interface InheritedDefaults {
  username?: string;
  usernameFrom?: string;
  port?: number;
  portFrom?: string;
  authType?: "password" | "key" | "both" | "none" | "identity";
  authFrom?: string;
  identityName?: string;
  identityFrom?: string;
  identityUsername?: string;
  hasPassword: boolean;
  keyName?: string;
  keepaliveSecs?: number;
  keepaliveFrom?: string;
  startupKind: "none" | "snippet" | "command" | null;
  startupFrom?: string;
  env: { name: string; value: string; from: string }[];
  forwardAgent?: boolean;
  forwardAgentFrom?: string;
}

export function fetchInheritedDefaults(
  groupId: string | null,
  vaultId: string,
): Promise<InheritedDefaults> {
  return invoke<InheritedDefaults>("inherited_host_defaults", {
    groupId,
    vaultId,
  });
}
