import {
  ClockCounterClockwiseIcon,
  DesktopTowerIcon,
  FileTextIcon,
  FolderOpenIcon,
  GearSixIcon,
  KeyIcon,
  SignOutIcon,
  UserIcon,
  UsersIcon,
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
  { path: "/teams", label: "Teams", icon: UsersIcon },
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

  const rowClass =
    "w-full h-7 justify-start gap-2 px-2 rounded-md text-sm font-normal text-dark-300 hover:bg-dark-800 hover:text-white";

  return (
    <aside
      className={`chrome fixed left-0 top-[var(--toolbar-height)] bottom-0 z-40 w-56 bg-dark-900 border-r border-dark-800 transform transition-transform duration-300 ease-in-out flex flex-col ${
        isMobile
          ? isOpen
            ? "translate-x-0"
            : "-translate-x-full"
          : "translate-x-0"
      }`}
    >
      <nav aria-label="Vault" className="flex-1 px-2 pb-2 overflow-y-auto">
        <p className="px-2 pt-3 pb-1 text-[11px] font-semibold text-dark-400">
          Vault
        </p>
        <div className="space-y-px">
          {sidebarItems.map((item) => {
            const active = isActive(item.path);
            return (
              <Button
                type="button"
                variant="ghost"
                key={item.path}
                aria-current={active ? "page" : undefined}
                onClick={() => {
                  navigate(item.path);
                  if (isMobile) onClose();
                }}
                className={`${rowClass} ${
                  active
                    ? "bg-primary-600/20 text-white font-semibold hover:bg-primary-600/20"
                    : ""
                }`}
              >
                <item.icon className="w-4 h-4 shrink-0 text-primary-400" />
                <span className="flex-1 text-left truncate">{item.label}</span>
              </Button>
            );
          })}
        </div>
      </nav>

      <div className="p-2 space-y-1 border-t border-dark-800">
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            onOpenSettings();
            if (isMobile) onClose();
          }}
          className={rowClass}
        >
          <GearSixIcon className="w-4 h-4 shrink-0 text-primary-400" />
          <span className="flex-1 text-left">Settings</span>
        </Button>

        <div className="flex items-center gap-2 px-2 py-1">
          <div className="flex items-center justify-center shrink-0 w-6 h-6 rounded-full bg-primary-600/20">
            <UserIcon className="w-3 h-3 text-primary-400" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-white truncate">
              {user?.full_name || "User"}
            </p>
            <p className="text-[11px] truncate text-dark-400">{user?.email}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={logout}
            aria-label="Log Out"
            title="Log Out"
            className="shrink-0"
          >
            <SignOutIcon size={14} />
          </Button>
        </div>
      </div>
    </aside>
  );
}
