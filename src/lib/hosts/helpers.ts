import type { Group, Host } from "@/stores/hosts/hostStore";

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

type FilterableHost = Pick<Host, "name" | "address" | "tags" | "username">;

/** Hosts matching the search text (name, address, user or tag) and any of the selected tags. */
export function filterHosts<T extends FilterableHost>(
  hosts: T[],
  query: string,
  tags: ReadonlySet<string>,
): T[] {
  const q = query.trim().toLowerCase();
  return hosts.filter(
    (h) =>
      (tags.size === 0 || h.tags.some((t) => tags.has(t))) &&
      (!q ||
        [h.name, h.address, h.username ?? "", ...h.tags].some((v) =>
          v.toLowerCase().includes(q),
        )),
  );
}

/** Each tag with how many hosts carry it, sorted by tag. */
export function tagCounts(hosts: FilterableHost[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const h of hosts)
    for (const t of new Set(h.tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a.localeCompare(b));
}
