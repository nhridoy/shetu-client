import { useCallback, useEffect, useRef, useState } from "react";
import settingsTabs from "@/components/settings/modal/SettingsTabs";
import AdvancedTab from "@/components/settings/tabs/AdvancedTab";
import AppearanceTab from "@/components/settings/tabs/AppearanceTab";
import SecurityTab from "@/components/settings/tabs/SecurityTab";
import SshTab from "@/components/settings/tabs/SshTab";
import TerminalTab from "@/components/settings/tabs/TerminalTab";
import { Button } from "@/components/ui/Button";
import ConfirmDeleteDialog from "@/components/ui/ConfirmDeleteDialog";
import { useModal } from "@/hooks/useModal";
import { useSettingsStore } from "@/stores/settings/settingsStore";
import { useTerminalStore } from "@/stores/terminal/terminalStore";
import { type Theme, useThemeStore } from "@/stores/themeStore";

interface KnownHost {
  host: string;
  port: number;
  fingerprint: string;
}

export default function SettingsPanel() {
  const { currentTheme, setTheme } = useThemeStore();
  const { settings, updateSetting } = useSettingsStore();
  const closeAllTabs = useTerminalStore((s) => s.closeAllTabs);
  const tabs = useTerminalStore((s) => s.tabs);

  const [activeTab, setActiveTab] = useState<
    "appearance" | "terminal" | "ssh" | "security" | "advanced"
  >("appearance");

  const [knownHosts, setKnownHosts] = useState<KnownHost[]>([]);
  const [knownHostsLoading, setKnownHostsLoading] = useState(false);

  const deleteDialog = useModal();
  const [deleteMessage, setDeleteMessage] = useState("");
  const pendingDeleteAction = useRef<(() => void) | null>(null);

  const loadKnownHosts = useCallback(async () => {
    try {
      setKnownHostsLoading(true);
      setKnownHosts([]);
    } catch (err) {
      console.error("Failed to load known hosts:", err);
    } finally {
      setKnownHostsLoading(false);
    }
  }, []);

  const requestDelete = (message: string, action: () => void) => {
    setDeleteMessage(message);
    pendingDeleteAction.current = action;
    deleteDialog.show();
  };

  const confirmDeleteAction = () => {
    deleteDialog.hide();
    const action = pendingDeleteAction.current;
    pendingDeleteAction.current = null;
    action?.();
  };

  const cancelDelete = () => {
    deleteDialog.hide();
    pendingDeleteAction.current = null;
  };

  const handleRemoveKnownHost = (host: string, port: number) => {
    requestDelete(
      `Remove known host for ${host}:${port}? You will be prompted to verify their identity on next connection.`,
      () => {
        setKnownHosts((prev) =>
          prev.filter((h) => !(h.host === host && h.port === port)),
        );
      },
    );
  };

  const handleClearAllKnownHosts = () => {
    requestDelete(
      "Clear ALL known hosts? You will be prompted to verify identity for every host on next connection.",
      () => setKnownHosts([]),
    );
  };

  useEffect(() => {
    if (activeTab === "ssh") loadKnownHosts();
  }, [activeTab, loadKnownHosts]);

  const handleSetTheme = (theme: Theme) => {
    setTheme(theme);
  };

  const handleFontSizeChange = (value: number) => {
    updateSetting("fontSize", value);
  };

  const handleFontFamilyChange = (value: string) => {
    updateSetting("fontFamily", value);
  };

  const handleCursorStyleChange = (value: string) => {
    updateSetting("cursorStyle", value as "block" | "underline" | "bar");
  };

  const handleCursorBlinkChange = (value: boolean) => {
    updateSetting("cursorBlink", value);
  };

  const handleScrollbackChange = (value: number) => {
    updateSetting("scrollback", value);
  };

  const handleBellStyleChange = (value: string) => {
    updateSetting("bellStyle", value as "none" | "sound" | "visual");
  };

  const handleClearAllSessions = () => {
    requestDelete(
      "Are you sure you want to close all active terminal sessions?",
      closeAllTabs,
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Settings Navigation */}
      <div className="flex flex-row border-b border-dark-700">
        {settingsTabs.map((tab) => (
          <Button
            key={tab.id}
            variant="ghost"
            onClick={() => setActiveTab(tab.id as typeof activeTab)}
            className={`gap-2 px-4 py-2.5 rounded-none flex-1 justify-start ${
              activeTab === tab.id
                ? "text-primary-500 bg-dark-800 border-b-2 border-primary-500"
                : "text-dark-400 hover:text-white"
            }`}
          >
            {tab.icon}
            {tab.label}
          </Button>
        ))}
      </div>

      {/* Settings Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {activeTab === "appearance" && (
          <AppearanceTab
            currentTheme={currentTheme}
            fontSize={settings.fontSize}
            fontFamily={settings.fontFamily}
            setTheme={handleSetTheme}
            setFontSize={handleFontSizeChange}
            setFontFamily={handleFontFamilyChange}
          />
        )}
        {activeTab === "terminal" && (
          <TerminalTab
            cursorStyle={settings.cursorStyle}
            cursorBlink={settings.cursorBlink}
            scrollback={settings.scrollback}
            bellStyle={settings.bellStyle}
            recordTerminalOutput={settings.recordTerminalOutput}
            setCursorStyle={handleCursorStyleChange}
            setCursorBlink={handleCursorBlinkChange}
            setScrollback={handleScrollbackChange}
            setBellStyle={handleBellStyleChange}
            setRecordTerminalOutput={(enabled) =>
              updateSetting("recordTerminalOutput", enabled)
            }
          />
        )}
        {activeTab === "ssh" && (
          <SshTab
            knownHosts={knownHosts}
            knownHostsLoading={knownHostsLoading}
            onLoadKnownHosts={loadKnownHosts}
            onRemoveKnownHost={handleRemoveKnownHost}
            onClearAllKnownHosts={handleClearAllKnownHosts}
          />
        )}
        {activeTab === "security" && (
          <SecurityTab
            tabs={tabs}
            onClearAllSessions={handleClearAllSessions}
          />
        )}
        {activeTab === "advanced" && (
          <AdvancedTab
            currentTheme={currentTheme}
            fontSize={settings.fontSize}
            fontFamily={settings.fontFamily}
            cursorStyle={settings.cursorStyle}
            cursorBlink={settings.cursorBlink}
            scrollback={settings.scrollback}
            bellStyle={settings.bellStyle}
            setTheme={handleSetTheme}
            setFontSize={handleFontSizeChange}
            setFontFamily={handleFontFamilyChange}
            setCursorStyle={handleCursorStyleChange}
            setCursorBlink={handleCursorBlinkChange}
            setScrollback={handleScrollbackChange}
            setBellStyle={handleBellStyleChange}
          />
        )}
      </div>

      <ConfirmDeleteDialog
        open={deleteDialog.open}
        message={deleteMessage}
        onConfirm={confirmDeleteAction}
        onCancel={cancelDelete}
      />
    </div>
  );
}
