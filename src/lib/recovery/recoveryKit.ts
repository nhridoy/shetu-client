import { writeTextFile } from "@tauri-apps/plugin-fs";
import { toast } from "sonner";
import { isTauriAvailable } from "@/lib/common/utils";
import { saveFilePicker } from "@/lib/sftp/localFs";

function sanitizeFileNamePart(input: string): string {
  const cleaned = Array.from(input)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 32 && !/[<>:"/\\|?*]/.test(ch);
    })
    .join("")
    .replace(/[. ]+$/g, "")
    .trim();
  return cleaned || "unknown";
}

export function buildRecoveryKitContent(
  recoveryCode: string,
  account: string,
): string {
  return [
    "Terra Recovery Kit",
    "=====================",
    "",
    `Account: ${account}`,
    `Recovery Code: ${recoveryCode}`,
    "",
    "Keep this code safe. You will need it to recover your account if you forget your password.",
    "This code provides access to your encrypted data.",
  ].join("\n");
}

export function buildRecoveryKitFilename(account: string): string {
  return `terra-recovery-kit-(${sanitizeFileNamePart(account)}).txt`;
}

export async function downloadRecoveryKit(
  recoveryCode: string,
  account: string,
): Promise<string | null> {
  const content = buildRecoveryKitContent(recoveryCode, account);
  const fileName = buildRecoveryKitFilename(account);

  if (isTauriAvailable()) {
    const path = await saveFilePicker(fileName);
    if (!path) return null;
    try {
      await writeTextFile(path, content);
      toast.success(`Recovery kit saved to ${path}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to save recovery kit: ${message}`);
      throw err;
    }
    return path;
  }

  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
  return null;
}
