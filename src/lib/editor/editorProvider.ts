import { invoke } from "@tauri-apps/api/core";
import { type FileProvider, LocalFileProvider } from "@/lib/sftp/fileTransfer";
import { getProvider, registerProvider } from "@/lib/sftp/providerRegistry";
import { RemoteFileProviderImpl } from "@/lib/sftp/remoteFs";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export interface EditorConnectionConfig {
  connectionType: "host" | "local" | null;
  hostId?: string;
  hostAddress?: string;
  hostPort?: number;
  hostUsername?: string;
  sessionId?: string;
}

export function getEditorProvider(state: EditorConnectionConfig): FileProvider {
  if (state.connectionType === "local") {
    return new LocalFileProvider();
  }
  if (state.connectionType === "host" && state.hostId && state.sessionId) {
    const existing = getProvider(state.sessionId);
    if (existing) return existing;
    const provider = new RemoteFileProviderImpl(state.hostId, state.sessionId);
    registerProvider(state.sessionId, provider);
    return provider;
  }
  throw new Error("No active editor connection");
}

export async function ensureRemoteSession(
  state: EditorConnectionConfig,
): Promise<RemoteFileProviderImpl> {
  if (state.connectionType !== "host" || !state.hostId || !state.sessionId) {
    throw new Error("No active remote connection");
  }
  if (state.hostId.startsWith("direct_")) {
    await invoke("sftp_connect", {
      sessionId: state.sessionId,
      config: {
        host: state.hostAddress || "",
        port: state.hostPort || 22,
        username: state.hostUsername || "",
      },
    });
  } else {
    await invoke("sftp_connect_saved", {
      sessionId: state.sessionId,
      hostId: state.hostId,
    });
  }
  const existing = getProvider(state.sessionId);
  if (existing && existing.type === "remote") {
    return existing as RemoteFileProviderImpl;
  }
  const provider = new RemoteFileProviderImpl(state.hostId, state.sessionId);
  registerProvider(state.sessionId, provider);
  return provider;
}

export async function providerReadText(
  provider: FileProvider,
  path: string,
): Promise<string> {
  const bytes = await provider.readFile(path);
  return textDecoder.decode(bytes);
}

export async function providerWriteText(
  provider: FileProvider,
  path: string,
  text: string,
): Promise<void> {
  await provider.writeFile(path, textEncoder.encode(text));
}
