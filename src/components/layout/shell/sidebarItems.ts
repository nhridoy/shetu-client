import {
  ClockCounterClockwiseIcon,
  DesktopTowerIcon,
  FileTextIcon,
  FolderOpenIcon,
  KeyIcon,
  UsersIcon,
} from "@phosphor-icons/react";

/** The sidebar's pages, also offered by the command palette as "Go to …". */
export const SIDEBAR_ITEMS = [
  { path: "/hosts", label: "Hosts", icon: DesktopTowerIcon },
  { path: "/workspaces", label: "Workspaces", icon: FolderOpenIcon },
  { path: "/snippets", label: "Snippets", icon: FileTextIcon },
  { path: "/keys", label: "Keychain", icon: KeyIcon },
  { path: "/history", label: "History", icon: ClockCounterClockwiseIcon },
  { path: "/teams", label: "Teams", icon: UsersIcon },
] as const;
