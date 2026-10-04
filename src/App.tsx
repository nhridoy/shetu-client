import { emit } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { Toaster } from "sonner";
import AuthGuard from "@/components/auth/guard/AuthGuard";
import UnlockDialog from "@/components/auth/UnlockDialog";
import Layout from "@/components/layout/shell/Layout";
import TitleBar from "@/components/layout/shell/TitleBar";
import UpdateNotification from "@/components/update/UpdateNotification";
import LoginPage from "@/pages/auth/LoginPage";
import RecoveryPage from "@/pages/auth/RecoveryPage";
import RecoveryRevealModal from "@/pages/auth/RecoveryRevealModal";
import RegisterPage from "@/pages/auth/RegisterPage";
import SetupPage from "@/pages/auth/SetupPage";
import EditorPage from "@/pages/EditorPage";
import HistoryPage from "@/pages/HistoryPage";
import HostsPage from "@/pages/HostsPage";
import KeysPage from "@/pages/KeysPage";
import SftpPage from "@/pages/SftpPage";
import SnippetsPage from "@/pages/SnippetsPage";
import TerminalPage from "@/pages/TerminalPage";
import WorkspacesPage from "@/pages/WorkspacesPage";
import { useAuthStore } from "@/stores/auth/authStore";
import { useSettingsStore } from "@/stores/settings/settingsStore";
import { useShellStore } from "@/stores/terminal/shellStore";
import { useThemeStore } from "@/stores/themeStore";
import { useUpdateStore } from "@/stores/update/updateStore";

function App() {
  const restoreSession = useAuthStore((s) => s.restoreSession);
  const pendingRecoveryCode = useAuthStore((s) => s.pendingRecoveryCode);
  const pendingRecoveryContext = useAuthStore((s) => s.pendingRecoveryContext);
  const clearRecoveryCode = useAuthStore((s) => s.clearRecoveryCode);
  const initSettings = useSettingsStore((s) => s.initSettings);
  const initTheme = useThemeStore((s) => s.initTheme);
  const detectShells = useShellStore((s) => s.detect);
  const checkForUpdates = useUpdateStore((s) => s.checkForUpdates);

  useEffect(() => {
    const init = async () => {
      initTheme();
      initSettings();
      restoreSession();
      await detectShells();
      emit("main-ready");
    };
    init();
  }, [restoreSession, initSettings, initTheme, detectShells]);

  useEffect(() => {
    void checkForUpdates(false);
  }, [checkForUpdates]);

  return (
    <BrowserRouter>
      <TitleBar />
      <div className="pt-9">
        <Routes>
          <Route element={<AuthGuard requireAuth={false} />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/setup" element={<SetupPage />} />
            <Route path="/recovery" element={<RecoveryPage />} />
          </Route>

          <Route element={<AuthGuard requireAuth={true} />}>
            <Route element={<Layout />}>
              <Route index element={<Navigate to="/hosts" replace />} />
              <Route path="hosts" element={<HostsPage />} />
              <Route path="workspaces" element={<WorkspacesPage />} />
              <Route path="snippets" element={<SnippetsPage />} />
              <Route path="keys" element={<KeysPage />} />
              <Route path="history" element={<HistoryPage />} />
              <Route path="terminal" element={<TerminalPage />} />
              <Route path="sftp" element={<SftpPage />} />
              <Route path="editor" element={<EditorPage />} />
              <Route path="*" element={<Navigate to="/hosts" replace />} />
            </Route>
          </Route>
        </Routes>
        <RecoveryRevealModal
          open={!!pendingRecoveryCode}
          recoveryCode={pendingRecoveryCode ?? ""}
          onClose={clearRecoveryCode}
          context={pendingRecoveryContext ?? "signup"}
        />
        <UnlockDialog />
        <UpdateNotification />
        <Toaster richColors />
      </div>
    </BrowserRouter>
  );
}

export default App;
