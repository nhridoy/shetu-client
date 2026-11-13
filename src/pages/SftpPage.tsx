import SftpLayout from "@/components/sftp/views/SftpLayout";
import { useShortcutContext } from "@/hooks/useShortcutContext";

export default function SftpPage() {
  useShortcutContext("files");
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <SftpLayout />
    </div>
  );
}
