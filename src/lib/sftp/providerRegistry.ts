import type { FileProvider } from "@/lib/sftp/fileTransfer";

const providers = new Map<string, FileProvider>();

export function registerProvider(paneId: string, provider: FileProvider) {
  providers.set(paneId, provider);
}

export function unregisterProvider(paneId: string) {
  providers.delete(paneId);
}

export function getProvider(paneId: string): FileProvider | undefined {
  return providers.get(paneId);
}
