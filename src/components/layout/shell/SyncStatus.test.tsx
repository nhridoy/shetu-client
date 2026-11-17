// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const sync = vi.hoisted(() => ({
  state: "synced",
  pendingCount: 0,
  lastSyncAt: null,
  error: null,
  live: false,
  retry: () => {},
}));
vi.mock("@/stores/sync/syncStore", () => ({
  useSyncStore: (pick: (s: typeof sync) => unknown) => pick(sync),
}));
vi.mock("@/stores/vault/vaultStore", () => ({
  useVaultStore: (pick: (s: { currentVaultId: string }) => unknown) =>
    pick({ currentVaultId: "v1" }),
}));
vi.mock("@/stores/ui/unsavedChangesStore", () => ({
  useUnsavedChanges: { getState: () => ({ confirmLeave: async () => true }) },
}));

import SyncStatus from "./SyncStatus";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
});

function render() {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  roots.push(root);
  act(() =>
    root.render(
      <MemoryRouter>
        <SyncStatus />
      </MemoryRouter>,
    ),
  );
  return el.textContent;
}

describe("SyncStatus", () => {
  it("shows Live while connected", () => {
    sync.state = "synced";
    sync.live = true;
    expect(render()).toBe("Live");
  });

  it("keeps the other states while live", () => {
    sync.live = true;
    sync.state = "pending";
    expect(render()).toBe("Pending");
  });

  it("says Synced when not live", () => {
    sync.live = false;
    sync.state = "synced";
    expect(render()).toBe("Synced");
  });
});
