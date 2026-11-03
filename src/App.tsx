import { emit } from "@tauri-apps/api/event";
import { type CSSProperties, useEffect } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router";
import { Toaster } from "sonner";
import AuthGuard from "@/components/auth/guard/AuthGuard";
import UnlockDialog from "@/components/auth/UnlockDialog";
import Layout from "@/components/layout/shell/Layout";
import TitleBar from "@/components/layout/shell/TitleBar";
import TeamManager from "@/components/teams/managers/TeamManager";
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
import { isLightTheme, useThemeStore } from "@/stores/themeStore";
import { useUpdateStore } from "@/stores/update/updateStore";

// Sonner reads these for neutral toasts; the active theme sets the --color-* values.
const TOAST_THEME_VARS = {
  "--normal-bg": "var(--color-dark-900)",
  "--normal-bg-hover": "var(--color-dark-800)",
  "--normal-border": "var(--color-dark-700)",
  "--normal-border-hover": "var(--color-dark-600)",
  "--normal-text": "var(--color-white)",
} as CSSProperties;

function App() {
  const restoreSession = useAuthStore((s) => s.restoreSession);
  const pendingRecoveryCode = useAuthStore((s) => s.pendingRecoveryCode);
  const pendingRecoveryContext = useAuthStore((s) => s.pendingRecoveryContext);
  const clearRecoveryCode = useAuthStore((s) => s.clearRecoveryCode);
  const initSettings = useSettingsStore((s) => s.initSettings);
  const initTheme = useThemeStore((s) => s.initTheme);
  const currentTheme = useThemeStore((s) => s.currentTheme);
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
      <Routes>
        <Route element={<PublicChrome />}>
          <Route element={<AuthGuard requireAuth={false} />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/setup" element={<SetupPage />} />
            <Route path="/recovery" element={<RecoveryPage />} />
          </Route>
        </Route>

        <Route element={<AuthGuard requireAuth={true} />}>
          <Route element={<Layout />}>
            <Route index element={<Navigate to="/hosts" replace />} />
            <Route path="hosts" element={<HostsPage />} />
            <Route path="workspaces" element={<WorkspacesPage />} />
            <Route path="snippets" element={<SnippetsPage />} />
            <Route path="keys" element={<KeysPage />} />
            <Route path="history" element={<HistoryPage />} />
            <Route path="teams" element={<TeamManager />} />
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
      <Toaster
        richColors
        theme={isLightTheme(currentTheme) ? "light" : "dark"}
        style={TOAST_THEME_VARS}
        toastOptions={{ classNames: { description: "!text-dark-300" } }}
      />
    </BrowserRouter>
  );
}

function PublicChrome() {
  return (
    <>
      <TitleBar />
      <div className="pt-9">
        <Outlet />
      </div>
    </>
  );
}

export default App;
