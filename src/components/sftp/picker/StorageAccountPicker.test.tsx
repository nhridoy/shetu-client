// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

import { useStorageAccountStore } from "@/stores/storage/storageAccountStore";
import StorageAccountPicker from "./StorageAccountPicker";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("shows buckets and servers with different icons", async () => {
  useStorageAccountStore.setState({
    accounts: [
      { id: "s3", name: "Backups", vaultId: "v1" },
      { id: "dav", name: "NAS", vaultId: "v1" },
      { id: "ftp", name: "Host", vaultId: "v1" },
    ],
    fetchStorageAccounts: async () => {},
    view: async (id: string) =>
      ({
        provider: id === "dav" ? "webdav" : id === "ftp" ? "ftp" : "aws",
      }) as never,
  } as never);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <MemoryRouter>
        <StorageAccountPicker onConnect={() => {}} onClose={() => {}} />
      </MemoryRouter>,
    ),
  );
  const kinds = [...host.querySelectorAll("[data-kind]")].map((el) =>
    el.getAttribute("data-kind"),
  );
  expect(kinds).toEqual(["s3", "webdav", "ftp"]);
  // Servers (WebDAV and FTP) share the server icon.
  const icons = [...host.querySelectorAll("[data-kind]")].map((el) =>
    el.outerHTML.slice(0, 40),
  );
  expect(icons[2].split(" ")[0]).toBe(icons[1].split(" ")[0]);
  act(() => root.unmount());
});
