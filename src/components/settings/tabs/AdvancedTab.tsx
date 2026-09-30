import { useRef, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import type { AdvancedTabProps } from "@/types/settings/types";

export default function AdvancedTab({
  currentTheme,
  fontSize,
  fontFamily,
  cursorStyle,
  cursorBlink,
  scrollback,
  bellStyle,
  setTheme,
  setFontSize,
  setFontFamily,
  setCursorStyle,
  setCursorBlink,
  setScrollback,
  setBellStyle,
}: AdvancedTabProps) {
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExportSettings = () => {
    const settings = {
      theme: currentTheme,
      fontSize,
      fontFamily,
      cursorStyle,
      cursorBlink,
      scrollback,
      bellStyle,
    };
    const blob = new Blob([JSON.stringify(settings, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "termvault-settings.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportSettings = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const settings = JSON.parse(event.target?.result as string);
        if (settings.theme) setTheme(settings.theme);
        if (settings.fontSize) setFontSize(settings.fontSize);
        if (settings.fontFamily) setFontFamily(settings.fontFamily);
        if (settings.cursorStyle) setCursorStyle(settings.cursorStyle);
        if (settings.cursorBlink !== undefined)
          setCursorBlink(settings.cursorBlink);
        if (settings.scrollback) setScrollback(settings.scrollback);
        if (settings.bellStyle) setBellStyle(settings.bellStyle);
        setSuccess("Settings imported successfully");
        setError(null);
      } catch {
        setError("Invalid settings file");
        setSuccess(null);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  return (
    <div className="space-y-6">
      {error && <Alert variant="error">{error}</Alert>}
      {success && <Alert variant="success">{success}</Alert>}

      <div>
        <h3 className="text-sm font-medium text-white mb-3">
          Import / Export Settings
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-dark-800 rounded-lg p-4">
            <p className="text-sm text-white font-medium mb-1">
              Export Settings
            </p>
            <p className="text-xs text-dark-400 mb-3">
              Download current settings as JSON
            </p>
            <Button
              type="button"
              onClick={handleExportSettings}
              variant="secondary"
              size="sm"
            >
              Export
            </Button>
          </div>
          <div className="bg-dark-800 rounded-lg p-4">
            <p className="text-sm text-white font-medium mb-1">
              Import Settings
            </p>
            <p className="text-xs text-dark-400 mb-3">
              Load settings from a JSON file
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              onChange={handleImportSettings}
              className="hidden"
            />
            <Button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              variant="secondary"
              size="sm"
            >
              Import
            </Button>
          </div>
        </div>
      </div>

      <div className="border-t border-dark-700 pt-6">
        <h3 className="text-sm font-medium text-white mb-3">Data deletion</h3>
        <p className="text-xs text-dark-400">
          Account-wide data deletion is not available yet. Signing out clears
          this device's local account data after pending changes are synced.
        </p>
      </div>
    </div>
  );
}
