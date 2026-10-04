import {
  ClockCounterClockwiseIcon,
  DesktopTowerIcon,
  FileTextIcon,
  FolderOpenIcon,
  GearSixIcon,
  KeyIcon,
  SignOutIcon,
  UserIcon,
} from "@phosphor-icons/react";
import { useLocation, useNavigate } from "react-router";
import { Button } from "@/components/ui/Button";
import { useAuthStore } from "@/stores/auth/authStore";

const sidebarItems = [
  { path: "/hosts", label: "Hosts", icon: DesktopTowerIcon },
  { path: "/workspaces", label: "Workspaces", icon: FolderOpenIcon },
  { path: "/snippets", label: "Snippets", icon: FileTextIcon },
  { path: "/keys", label: "Keys", icon: KeyIcon },
  { path: "/history", label: "History", icon: ClockCounterClockwiseIcon },
] as const;

interface AppSidebarProps {
  isOpen: boolean;
  isMobile: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
}

export default function AppSidebar({
  isOpen,
  isMobile,
  onClose,
  onOpenSettings,
}: AppSidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();

  const isActive = (path: string) => location.pathname === path;

  return (
    <aside
      className={`fixed left-0 top-10 bottom-0 z-40 w-72 bg-dark-900 border-r border-dark-800 transform transition-transform duration-300 ease-in-out flex flex-col ${
        isMobile
          ? isOpen
            ? "translate-x-0"
            : "-translate-x-full"
          : "translate-x-0"
      }`}
    >
      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 space-y-1 overflow-y-auto">
        {sidebarItems.map((item) => (
          <Button
            type="button"
            variant="ghost"
            key={item.path}
            onClick={() => {
              navigate(item.path);
              if (isMobile) onClose();
            }}
            className={`w-full justify-start px-3 py-2.5 rounded-lg text-sm font-medium ${isActive(item.path) ? "bg-dark-800 text-primary-500" : ""}`}
          >
            <span className="flex items-center justify-center shrink-0 w-5 h-5">
              <item.icon className="w-5 h-5" />
            </span>
            <span className="flex-1 text-left">{item.label}</span>
          </Button>
        ))}
      </nav>

      {/* Bottom: Settings, UserInfo & Actions */}
      <div className="p-3 space-y-2 border-t border-dark-800">
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            onOpenSettings();
            if (isMobile) onClose();
          }}
          className="w-full justify-start px-3 py-2.5 rounded-lg text-sm font-medium"
        >
          <span className="flex items-center justify-center shrink-0 w-5 h-5">
            <GearSixIcon className="w-5 h-5" />
          </span>
          <span className="flex-1 text-left">Settings</span>
        </Button>

        <div className="flex items-center gap-3 p-2 rounded-lg bg-dark-800/50">
          <div className="flex items-center justify-center shrink-0 w-8 h-8 rounded-full bg-primary-600/20">
            <UserIcon className="w-4 h-4 text-primary-500" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white truncate">
              {user?.full_name || "User"}
            </p>
            <p className="text-xs truncate text-dark-400">{user?.email}</p>
          </div>
        </div>

        <div className="flex gap-2">
          <Button
            type="button"
            variant="destructive"
            onClick={logout}
            className="flex-1 gap-2 px-3 py-2 text-sm font-medium rounded-lg"
          >
            <SignOutIcon className="w-4 h-4" />
            <span>Logout</span>
          </Button>
        </div>
      </div>
    </aside>
  );
}
