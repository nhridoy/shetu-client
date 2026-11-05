import type { Group } from "@/stores/hosts/hostStore";

export function getChildren(groups: Group[], parentId: string): Group[] {
  return groups.filter((g) => g.parentId === parentId);
}

export function getAncestors(groups: Group[], groupId: string): Group[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const ancestors: Group[] = [];
  let current = byId.get(groupId);
  while (current?.parentId) {
    const parent = byId.get(current.parentId);
    if (parent) {
      ancestors.unshift(parent);
      current = parent;
    } else break;
  }
  return ancestors;
}

/** The group to show, or null for the top level if it no longer exists, e.g.
 * deleted on another device. Otherwise new groups would be created inside it. */
export function openGroupId(
  groups: Group[],
  selectedGroupId: string | null,
): string | null {
  return selectedGroupId && groups.some((g) => g.id === selectedGroupId)
    ? selectedGroupId
    : null;
}
