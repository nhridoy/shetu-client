import type { ShortcutId } from "./registry";

/** Mounted shortcut handlers, so the command palette can list and run them by id. */
const handlers = new Map<ShortcutId, Set<() => void>>();

export function registerShortcutHandler(
  id: ShortcutId,
  run: () => void,
): () => void {
  const set = handlers.get(id) ?? new Set();
  set.add(run);
  handlers.set(id, set);
  return () => {
    set.delete(run);
    if (set.size === 0 && handlers.get(id) === set) handlers.delete(id);
  };
}

/** Runs every mounted handler for `id`; false when none is mounted. */
export function runShortcutAction(id: ShortcutId): boolean {
  const set = handlers.get(id);
  if (!set?.size) return false;
  for (const run of [...set]) run();
  return true;
}

export function liveShortcutIds(): ReadonlySet<ShortcutId> {
  return new Set(handlers.keys());
}
