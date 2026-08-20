import {
  FilesIcon,
  GitBranchIcon,
  type Icon,
  MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import type { SidebarTool } from "@/stores/editor/editorStore";

const TOOLS: {
  id: SidebarTool;
  label: string;
  title: string;
  icon: Icon;
}[] = [
  { id: "explorer", label: "Explorer", title: "Explorer", icon: FilesIcon },
  {
    id: "search",
    label: "Search",
    title: "Search",
    icon: MagnifyingGlassIcon,
  },
  {
    id: "source-control",
    label: "Source Control",
    title: "Source Control",
    icon: GitBranchIcon,
  },
];

interface ActivityBarProps {
  active: SidebarTool;
  onSelect: (tool: SidebarTool) => void;
  hiddenTools?: SidebarTool[];
}

export default function ActivityBar({
  active,
  onSelect,
  hiddenTools = [],
}: ActivityBarProps) {
  return (
    <div className="flex flex-col items-center gap-1 w-11 h-full shrink-0 bg-dark-900 border-r border-dark-800 py-2">
      {TOOLS.filter(({ id }) => !hiddenTools.includes(id)).map(
        ({ id, label, title, icon: ItemIcon }) => {
          const isActive = active === id;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={isActive}
              aria-label={label}
              title={title}
              onClick={() => onSelect(id)}
              className={`relative flex items-center justify-center w-9 h-9 rounded-md text-dark-400 transition-colors ${
                isActive
                  ? "text-primary-400"
                  : "hover:text-white hover:bg-dark-700/60"
              }`}
            >
              {isActive && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-primary-400 rounded-full" />
              )}
              <ItemIcon
                className="w-5 h-5"
                weight={isActive ? "fill" : "duotone"}
              />
            </button>
          );
        },
      )}
    </div>
  );
}
