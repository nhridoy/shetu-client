import { useEffect, useRef, useState } from "react";
import {
  CaretRightIcon,
  MagnifyingGlassIcon,
  DesktopTowerIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { DraggableHostCard } from "@/components/hosts/cards/DraggableHostCard";
import { DroppableGroupCard } from "@/components/hosts/cards/DroppableGroupCard";
import { BreadcrumbDropTarget } from "@/components/hosts/panels/BreadcrumbDropTarget";
import { Button } from "@/components/ui/Button";
import { EmptyActionState } from "@/components/ui/EmptyActionState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import {
  filterHosts,
  getAncestors,
  getChildren,
  tagCounts,
} from "@/lib/hosts/helpers";
import { useHostPingStore } from "@/stores/hosts/hostPingStore";
import { type Group, type Host, useHostStore } from "@/stores/hosts/hostStore";

interface HostsPanelProps {
  selectedGroupId: string | null;
  onSelectGroup: (id: string | null) => void;
  onNewGroup: (parentId?: string) => void;
  onNewHost: (groupId?: string) => void;
  onEditGroup: (group: Group) => void;
  onEditHost: (host: Host) => void;
  onConnect: (host: Host) => void;
  onDeleteGroup: (id: string) => void;
  onDeleteHost: (id: string) => void;
}

export default function HostsPanel({
  selectedGroupId,
  onSelectGroup,
  onNewGroup,
  onNewHost,
  onEditGroup,
  onEditHost,
  onConnect,
  onDeleteGroup,
  onDeleteHost,
}: HostsPanelProps) {
  const { hosts, groups } = useHostStore();

  const selectedGroup = selectedGroupId
    ? groups.find((g) => g.id === selectedGroupId)
    : null;
  const displayGroups = selectedGroupId
    ? getChildren(groups, selectedGroupId)
    : groups.filter((g) => !g.parentId);
  const displayHosts = selectedGroupId
    ? hosts.filter((h) => h.groupId === selectedGroupId)
    : hosts;

  const reachable = useHostPingStore(
    (st) => hosts.filter((h) => st.pings[h.id]?.status === "reachable").length,
  );
  const [query, setQuery] = useState("");
  const [selectedTags, setSelectedTags] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const filtering = query.trim() !== "" || selectedTags.size > 0;
  const shownHosts = filterHosts(displayHosts, query, selectedTags);
  const tags = tagCounts(displayHosts);
  const clearFilters = () => {
    setQuery("");
    setSelectedTags(new Set());
  };
  const toggleTag = (tag: string) =>
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (!next.delete(tag)) next.add(tag);
      return next;
    });

  // "/" focuses search, unless the user is already typing somewhere.
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (
        e.key !== "/" ||
        el.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)
      )
        return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div>
      <header className="sticky top-0 z-10 flex items-center gap-2 h-12 px-4 border-b border-dark-800 bg-dark-950/85 backdrop-blur">
        <h1 className="mr-1 text-[15px] font-semibold text-white">Hosts</h1>
        {[
          `${hosts.length} host${hosts.length === 1 ? "" : "s"}`,
          `${reachable} reachable`,
          `${groups.length} group${groups.length === 1 ? "" : "s"}`,
        ].map((label, i) => (
          <span
            key={label}
            className="hidden sm:flex items-center gap-1.5 h-[22px] px-2 rounded-md border border-dark-800 bg-dark-900 font-mono text-[11px] text-dark-400 whitespace-nowrap"
          >
            {i === 1 && (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            )}
            {label}
          </span>
        ))}
        <label className="flex items-center gap-2 h-7 w-60 ml-auto px-2 rounded-md border border-dark-700 bg-dark-900 text-dark-500 focus-within:border-primary-500">
          <MagnifyingGlassIcon className="w-3.5 h-3.5 shrink-0" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder="Search hosts…"
            aria-label="Search hosts"
            className="flex-1 min-w-0 bg-transparent text-xs text-white outline-none placeholder:text-dark-500"
          />
          <kbd className="px-1 rounded border border-dark-700 font-mono text-[10px] text-dark-400">
            /
          </kbd>
        </label>
      </header>
      <div className="p-4 space-y-6">
        {/* Breadcrumb — only in group detail */}
        {selectedGroup &&
          selectedGroupId &&
          (() => {
            const ancestors = getAncestors(groups, selectedGroupId);
            return (
              <div className="flex items-center gap-1.5 flex-wrap">
                <BreadcrumbDropTarget
                  groupId={null}
                  onClick={() => onSelectGroup(null)}
                >
                  All Groups
                </BreadcrumbDropTarget>
                {ancestors.map((a) => (
                  <span key={a.id} className="flex items-center gap-1.5">
                    <CaretRightIcon
                      className="w-3.5 h-3.5 text-dark-500"
                      weight="bold"
                    />
                    <BreadcrumbDropTarget
                      groupId={a.id}
                      onClick={() => onSelectGroup(a.id)}
                    >
                      {a.name}
                    </BreadcrumbDropTarget>
                  </span>
                ))}
                <CaretRightIcon
                  className="w-3.5 h-3.5 text-dark-500"
                  weight="bold"
                />
                <span className="px-2.5 py-1 text-xs font-medium rounded-md bg-primary-600/20 text-primary-400">
                  {selectedGroup.name}
                </span>
              </div>
            );
          })()}

        {/* Groups Section */}
        <div>
          <SectionHeader
            title="Groups"
            level="h3"
            className="text-sm tracking-wider uppercase text-dark-400 mb-3"
          >
            <Button
              type="button"
              onClick={() => onNewGroup(selectedGroupId ?? undefined)}
              variant="secondary"
              size="sm"
            >
              <PlusIcon className="w-3 h-3" weight="bold" />
              New Group
            </Button>
          </SectionHeader>
          {displayGroups.length === 0 ? (
            <EmptyActionState
              message="No groups yet — click to create one"
              onClick={() => onNewGroup(selectedGroupId ?? undefined)}
            />
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {displayGroups.map((group) => (
                <DroppableGroupCard
                  key={group.id}
                  group={group}
                  hostCount={hosts.filter((h) => h.groupId === group.id).length}
                  colors={hosts
                    .filter((h) => h.groupId === group.id)
                    .map((h) => h.color || "#64748b")}
                  childCount={getChildren(groups, group.id).length}
                  onClick={() => onSelectGroup(group.id)}
                  onEdit={onEditGroup}
                  onDelete={onDeleteGroup}
                />
              ))}
            </div>
          )}
        </div>

        {/* Hosts Section */}
        <div>
          <SectionHeader
            title={`Hosts${filtering ? ` (${shownHosts.length} of ${displayHosts.length})` : selectedGroupId ? ` (${displayHosts.length})` : ""}`}
            level="h3"
            className="text-sm tracking-wider uppercase text-dark-400 mb-3 gap-3"
          >
            {tags.length > 0 && (
              <div className="flex flex-1 flex-wrap items-center gap-1.5 normal-case tracking-normal">
                {tags.map(([tag, count]) => {
                  const on = selectedTags.has(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleTag(tag)}
                      className={`flex items-center gap-1.5 h-6 px-2.5 rounded-full border font-mono text-xs transition-colors ${
                        on
                          ? "border-primary-500 bg-primary-500/15 text-white"
                          : "border-dark-700 bg-dark-900 text-dark-300 hover:border-dark-600 hover:text-white"
                      }`}
                    >
                      #{tag}
                      <span
                        className={on ? "text-primary-300" : "text-dark-500"}
                      >
                        {count}
                      </span>
                    </button>
                  );
                })}
                {filtering && (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="text-xs text-dark-500 hover:text-white"
                  >
                    Clear ✕
                  </button>
                )}
              </div>
            )}
            <Button
              type="button"
              onClick={() => onNewHost(selectedGroupId ?? undefined)}
              variant="default"
              size="sm"
            >
              <PlusIcon className="w-3 h-3" weight="bold" />
              New Host
            </Button>
          </SectionHeader>
          {displayHosts.length === 0 ? (
            <EmptyActionState
              icon={DesktopTowerIcon}
              message="No hosts yet — click to add one"
              onClick={() => onNewHost(selectedGroupId ?? undefined)}
            />
          ) : shownHosts.length === 0 ? (
            <div className="p-6 text-sm text-center border border-dashed rounded-lg border-dark-700 text-dark-500">
              No hosts match ·{" "}
              <button
                type="button"
                onClick={clearFilters}
                className="text-primary-400 hover:text-primary-300"
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {shownHosts.map((host, index) => (
                <DraggableHostCard
                  key={host.id}
                  host={host}
                  index={index}
                  onConnect={onConnect}
                  onEdit={onEditHost}
                  onDelete={onDeleteHost}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
