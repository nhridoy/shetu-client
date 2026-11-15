import { load } from "@tauri-apps/plugin-store";
import { findAllLeaves } from "@/lib/common/treeUtils";
import { useHostStore } from "@/stores/hosts/hostStore";
import {
  type PaneNode,
  serializeWorkspaceLayout,
  type TerminalTab,
  useTerminalStore,
} from "@/stores/terminal/terminalStore";
import { destroySession } from "./sessionManager";

/** Last open layout per account, local to this device. Host ids and names only, no secrets. */
const STORE_FILE = "session.json";
const SAVE_DELAY_MS = 500;
const key = (accountId: string) => `last:${accountId}`;

export interface SavedSession {
  tabs: Array<{ title: string; root: PaneNode }>;
  activeIndex: number;
  workspaceId: string | null;
  workspaceName: string | null;
}

export function snapshotSession(state: {
  tabs: TerminalTab[];
  activeTabId: string | null;
  activeWorkspaceId?: string | null;
  activeWorkspaceName?: string | null;
}): SavedSession {
  return {
    tabs: serializeWorkspaceLayout(state.tabs).tabs,
    activeIndex: Math.max(
      0,
      state.tabs.findIndex((t) => t.id === state.activeTabId),
    ),
    workspaceId: state.activeWorkspaceId ?? null,
    workspaceName: state.activeWorkspaceName ?? null,
  };
}

const optionalString = (v: unknown) => v === undefined || typeof v === "string";

/** A pane tree as saved: well-formed leaves and splits only, so junk never reaches the UI. */
function isPaneNode(value: unknown): value is PaneNode {
  const node = value as Record<string, unknown> | null;
  if (!node || typeof node !== "object") return false;
  if (node.type === "leaf")
    return (
      typeof node.hostName === "string" &&
      optionalString(node.hostId) &&
      optionalString(node.title) &&
      optionalString(node.shell) &&
      (node.size === undefined || typeof node.size === "number")
    );
  return (
    node.type === "split" &&
    Array.isArray(node.children) &&
    node.children.length >= 2 &&
    node.children.every(isPaneNode)
  );
}

function parseSaved(value: unknown): SavedSession | null {
  const v = value as Partial<SavedSession> | null;
  if (!v || typeof v !== "object" || !Array.isArray(v.tabs)) return null;
  const tabs = v.tabs.filter(
    (t): t is SavedSession["tabs"][number] =>
      !!t && typeof t.title === "string" && isPaneNode(t.root),
  );
  if (tabs.length === 0) return null;
  return {
    tabs,
    activeIndex: Number.isInteger(v.activeIndex)
      ? (v.activeIndex as number)
      : 0,
    workspaceId: typeof v.workspaceId === "string" ? v.workspaceId : null,
    workspaceName: typeof v.workspaceName === "string" ? v.workspaceName : null,
  };
}

async function openStore() {
  return load(STORE_FILE, { autoSave: false });
}

/** Saves the open layout after it stops changing for a moment. */
export function startSessionPersistence(accountId: string): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = useTerminalStore.subscribe((state, prev) => {
    if (
      state.tabs === prev.tabs &&
      state.activeTabId === prev.activeTabId &&
      state.activeWorkspaceId === prev.activeWorkspaceId &&
      state.activeWorkspaceName === prev.activeWorkspaceName
    )
      return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void openStore()
        .then(async (store) => {
          await store.set(key(accountId), snapshotSession(state));
          await store.save();
        })
        // Best-effort: losing one save only means an older layout comes back.
        .catch(() => {});
    }, SAVE_DELAY_MS);
  });
  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}

/**
 * Reopens the account's last layout if nothing is open yet. Hosts load first, or every
 * pane would show as a missing host. Panes connect on their own, as for a workspace.
 */
export async function restoreLastSession(
  accountId: string,
  vaultId: string | undefined,
): Promise<boolean> {
  let saved: SavedSession | null;
  try {
    saved = parseSaved(await (await openStore()).get(key(accountId)));
  } catch {
    return false;
  }
  if (!saved) return false;
  await useHostStore.getState().fetchHosts(vaultId);
  const terminal = useTerminalStore.getState();
  if (terminal.tabs.length > 0) return false;
  terminal.launchWorkspace(
    { tabs: saved.tabs },
    saved.workspaceId ?? undefined,
    saved.workspaceName ?? undefined,
  );
  const tabs = useTerminalStore.getState().tabs;
  const active =
    tabs[Math.min(Math.max(saved.activeIndex, 0), tabs.length - 1)];
  if (active) useTerminalStore.getState().setActiveTab(active.id);
  return true;
}

/** Forgets every saved layout on this device (logout). */
export async function clearSavedSessions(): Promise<void> {
  const store = await openStore();
  await store.clear();
  await store.save();
}

/**
 * Logout: close every tab, end its terminal session (nothing keeps running unseen for
 * the next account), and forget the saved layout.
 */
export async function endAllSessions(): Promise<void> {
  const panes = useTerminalStore
    .getState()
    .tabs.flatMap((t) => findAllLeaves(t.root).map((l) => l.id));
  useTerminalStore.getState().closeAllTabs();
  await Promise.allSettled(panes.map((id) => destroySession(id)));
  await clearSavedSessions();
}
