import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/db/db");
vi.mock("../../lib/crypto/crypto");
vi.mock("../auth/authStore", () => ({
  useAuthStore: {
    getState: () => ({ user: { id: "u1", email: "a@b.c" } }),
  },
}));

import { decryptRowData } from "../../lib/crypto/crypto";
import { deleteRow, getRow, listRows, upsertRow } from "../../lib/db/db";
import { useVaultStore } from "../vault/vaultStore";
import { useSnippetStore } from "./snippetStore";

const mockList = vi.mocked(listRows);
const mockGet = vi.mocked(getRow);
const mockUpsert = vi.mocked(upsertRow);
const mockDelete = vi.mocked(deleteRow);
const mockDecrypt = vi.mocked(decryptRowData);

const snippetRow = {
  id: "s1",
  revision: 1,
  vault_id: "v1",
  created_at: 1000,
  updated_at: 1000,
  deleted_at: null,
  name: "deploy",
  description: "ship to prod",
  tags: '["ci","prod"]',
  sort_order: 0,
  data: "enc",
};

beforeEach(() => {
  useSnippetStore.setState({
    snippets: [],
    selectedSnippet: null,
    isLoading: false,
    error: null,
    searchQuery: "",
  });
  vi.restoreAllMocks();
  vi.clearAllMocks();
  useVaultStore.setState({ currentVaultId: null });
});

describe("snippetStore", () => {
  it("fetchSnippets reads plaintext columns without decrypting", async () => {
    mockList.mockResolvedValue([snippetRow]);
    await useSnippetStore.getState().fetchSnippets("v1");
    expect(mockList).toHaveBeenCalledWith("snippets", "v1");
    expect(mockDecrypt).not.toHaveBeenCalled();
    const snippet = useSnippetStore.getState().snippets[0];
    expect(snippet.id).toBe("s1");
    expect(snippet.name).toBe("deploy");
    expect(snippet.description).toBe("ship to prod");
    expect(snippet.command).toBe("");
    expect(snippet.tags).toEqual(["ci", "prod"]);
    expect(snippet.vaultId).toBe("v1");
    expect(snippet.createdAt).toBe("1000");
    expect(snippet.data).toBe("enc");
  });

  it("getDecryptedSnippet decrypts on demand from state, no db_get", async () => {
    mockList.mockResolvedValue([snippetRow]);
    await useSnippetStore.getState().fetchSnippets("v1");
    mockDecrypt.mockResolvedValue({
      command: "pnpm build && pnpm deploy",
    });
    const snippet = await useSnippetStore
      .getState()
      .getDecryptedSnippet("s1");
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockDecrypt).toHaveBeenCalledWith("enc");
    expect(snippet?.command).toBe("pnpm build && pnpm deploy");
    expect(snippet?.tags).toEqual(["ci", "prod"]);
  });

  it("getDecryptedSnippet falls back to db_get when not in state", async () => {
    mockGet.mockResolvedValue(snippetRow);
    mockDecrypt.mockResolvedValue({
      command: "pnpm build && pnpm deploy",
    });
    const snippet = await useSnippetStore
      .getState()
      .getDecryptedSnippet("s1");
    expect(mockGet).toHaveBeenCalledWith("snippets", "s1");
    expect(snippet?.command).toBe("pnpm build && pnpm deploy");
  });

  it("createSnippet passes plaintext payload with AAD snippets and upserts with vault fallback", async () => {
    mockUpsert.mockResolvedValue({
      id: "new",
      revision: 1,
      vault_id: "v1",
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
      name: "deploy",
      sort_order: 0,
      data: "enc",
    });
    useVaultStore.setState({ currentVaultId: "v1" });
    await useSnippetStore.getState().createSnippet({
      name: "deploy",
      command: "pnpm build",
      tags: ["ci"],
    });
    expect(mockUpsert).toHaveBeenCalledWith(
      "snippets",
      expect.objectContaining({ name: "deploy", vault_id: "v1", tags: '["ci"]' }),
      {
        plaintext: JSON.stringify({ command: "pnpm build" }),
        recordType: "snippets",
      },
    );
    expect(useSnippetStore.getState().snippets.length).toBe(1);
  });

  it("createSnippet keeps command out of plaintext columns and whitelist fields out of the encrypt payload", async () => {
    mockUpsert.mockResolvedValue({
      id: "new",
      revision: 1,
      vault_id: "v1",
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
      name: "deploy",
      description: "ship to prod",
      sort_order: 0,
      data: "enc",
    });
    useVaultStore.setState({ currentVaultId: "v1" });
    await useSnippetStore.getState().createSnippet({
      name: "deploy",
      description: "ship to prod",
      command: "pnpm build",
      tags: ["ci"],
    });
    const opts = mockUpsert.mock.calls[0][2] as {
      plaintext: string;
      recordType: string;
    };
    const payloadArg = JSON.parse(opts.plaintext) as Record<string, unknown>;
    expect(payloadArg).toHaveProperty("command", "pnpm build");
    expect(payloadArg).not.toHaveProperty("tags");
    expect(payloadArg).not.toHaveProperty("name");
    expect(payloadArg).not.toHaveProperty("description");
    expect(payloadArg).not.toHaveProperty("sort_order");
    const rowArg = mockUpsert.mock.calls[0][1];
    expect(rowArg).not.toHaveProperty("command");
    expect(rowArg).toHaveProperty("tags", '["ci"]');
    expect(mockUpsert).toHaveBeenCalledWith(
      "snippets",
      expect.not.objectContaining({
        name: "pnpm build",
        description: "pnpm build",
        sort_order: "pnpm build",
      }),
      expect.objectContaining({ recordType: "snippets" }),
    );
  });

  it("updateSnippet preserves unpatched command/tags", async () => {
    useSnippetStore.setState({
      snippets: [
        {
          id: "s1",
          name: "deploy",
          command: "pnpm build",
          description: "ship to prod",
          tags: ["ci"],
          createdAt: "1000",
        },
      ],
    });
    mockGet.mockResolvedValue(snippetRow);
    mockDecrypt.mockResolvedValue({
      command: "pnpm build",
      tags: ["ci"],
    });
    await useSnippetStore
      .getState()
      .updateSnippet("s1", { name: "deploy2", description: "new" });
    const opts = mockUpsert.mock.calls[0][2] as {
      plaintext: string;
      recordType: string;
    };
    expect(JSON.parse(opts.plaintext)).toMatchObject({
      command: "pnpm build",
      tags: ["ci"],
    });
    expect(mockUpsert).toHaveBeenCalledWith(
      "snippets",
      expect.objectContaining({ name: "deploy2" }),
      expect.objectContaining({ recordType: "snippets" }),
    );
    expect(useSnippetStore.getState().snippets[0]).toMatchObject({
      name: "deploy2",
    });
  });

  it("deleteSnippet tombstones and clears selection", async () => {
    useSnippetStore.setState({
      snippets: [
        {
          id: "s1",
          name: "x",
          command: "ls",
          tags: [],
          createdAt: "",
        },
      ],
      selectedSnippet: {
        id: "s1",
        name: "x",
        command: "ls",
        tags: [],
        createdAt: "",
      },
    });
    await useSnippetStore.getState().deleteSnippet("s1");
    expect(mockDelete).toHaveBeenCalledWith("snippets", "s1");
    expect(useSnippetStore.getState().snippets).toEqual([]);
    expect(useSnippetStore.getState().selectedSnippet).toBeNull();
  });

  it("getFilteredSnippets filters by search query", async () => {
    useSnippetStore.setState({
      snippets: [
        {
          id: "a",
          name: "deploy",
          command: "pnpm build",
          tags: [],
          createdAt: "",
        },
        {
          id: "b",
          name: "backup",
          command: "pg_dump",
          tags: [],
          createdAt: "",
        },
      ],
      searchQuery: "deploy",
    });
    const filtered = useSnippetStore.getState().getFilteredSnippets();
    expect(filtered.map((s) => s.id)).toEqual(["a"]);
  });
});
