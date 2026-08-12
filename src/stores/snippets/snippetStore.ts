import { create } from "zustand";
import { decryptRowData } from "@/lib/crypto/crypto";
import type { SyncRow } from "@/lib/db/db";
import { deleteRow, getRow, listRows, upsertRow } from "@/lib/db/db";
import { useVaultStore } from "@/stores/vault/vaultStore";

interface Snippet {
  id: string;
  name: string;
  command: string;
  description?: string;
  tags: string[];
  vaultId?: string;
  createdAt: string;
  /** @internal encrypted payload blob — kept for on-demand decrypt, never render */
  data?: string;
}

interface SnippetState {
  snippets: Snippet[];
  selectedSnippet: Snippet | null;
  isLoading: boolean;
  error: string | null;
  searchQuery: string;

  fetchSnippets: (vaultId?: string) => Promise<void>;
  selectSnippet: (snippet: Snippet | null) => void;
  getDecryptedSnippet: (id: string) => Promise<Snippet | null>;
  createSnippet: (snippet: Partial<Snippet>) => Promise<void>;
  updateSnippet: (id: string, snippet: Partial<Snippet>) => Promise<void>;
  deleteSnippet: (id: string) => Promise<void>;
  setSearchQuery: (query: string) => void;
  getFilteredSnippets: () => Snippet[];
}

interface SnippetPayload {
  command: string;
}

function parseTags(tags: string | null | undefined): string[] {
  if (!tags) return [];
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function newId(): string {
  return crypto.randomUUID();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** List-safe mapping: reads plaintext columns only, no decryption.
 * command stays empty until getDecryptedSnippet. */
function snippetFromRow(row: SyncRow): Snippet {
  return {
    id: row.id,
    name: row.name ?? "",
    command: "",
    description: row.description ?? undefined,
    tags: parseTags(row.tags),
    vaultId: row.vault_id,
    createdAt: String(row.created_at),
    data: row.data ?? "",
  };
}

/** Full snippet with the decrypted command — decrypt on demand. */
async function decryptSnippetRow(row: SyncRow): Promise<Snippet> {
  const payload = ((await decryptRowData(row.data)) ??
    {}) as Partial<SnippetPayload>;
  return {
    ...snippetFromRow(row),
    command: payload.command ?? "",
  };
}

export const useSnippetStore = create<SnippetState>((set, get) => ({
  snippets: [],
  selectedSnippet: null,
  isLoading: false,
  error: null,
  searchQuery: "",

  fetchSnippets: async (vaultId) => {
    const vid = vaultId ?? useVaultStore.getState().currentVaultId;
    if (!vid) {
      set({ isLoading: false });
      return;
    }
    set({ isLoading: true, error: null });
    try {
      const rows = await listRows("snippets", vid);
      const snippets = rows.map((row) => snippetFromRow(row));
      set({ snippets, isLoading: false });
    } catch (err) {
      set({ isLoading: false, error: errorMessage(err) });
    }
  },

  selectSnippet: (snippet) => set({ selectedSnippet: snippet }),

  getDecryptedSnippet: async (id) => {
    const cached = get().snippets.find((s) => s.id === id);
    if (cached?.data) {
      const payload = ((await decryptRowData(cached.data)) ??
        {}) as Partial<SnippetPayload>;
      return { ...cached, command: payload.command ?? "" };
    }
    const row = await getRow("snippets", id);
    if (!row) {
      return null;
    }
    return decryptSnippetRow(row);
  },

  createSnippet: async (snippet) => {
    const vaultId = snippet.vaultId ?? useVaultStore.getState().currentVaultId;
    if (!vaultId) {
      set({ isLoading: false, error: "No vault selected" });
      return;
    }
    set({ isLoading: true, error: null });
    try {
      const row = await upsertRow(
        "snippets",
        {
          id: newId(),
          vault_id: vaultId,
          name: snippet.name ?? "",
          description: snippet.description ?? null,
          tags: JSON.stringify(snippet.tags ?? []),
          sort_order: 0,
        },
        {
          plaintext: JSON.stringify({
            command: snippet.command ?? "",
          }),
          recordType: "snippets",
        },
      );
      const created: Snippet = {
        id: row.id,
        name: row.name ?? "",
        command: snippet.command ?? "",
        description: row.description ?? undefined,
        tags: snippet.tags ?? [],
        vaultId,
        createdAt: String(row.created_at),
      };
      set({ snippets: [created, ...get().snippets], isLoading: false });
    } catch (err) {
      set({ isLoading: false, error: errorMessage(err) });
    }
  },

  updateSnippet: async (id, patch) => {
    set({ isLoading: true, error: null });
    try {
      const row = await getRow("snippets", id);
      if (!row) {
        set({ isLoading: false, error: "Snippet not found" });
        return;
      }
      const existing = ((await decryptRowData(row.data)) ?? {}) as Record<
        string,
        unknown
      >;
      const sensitive: Record<string, unknown> = {};
      if (patch.command !== undefined) sensitive.command = patch.command;
      await upsertRow(
        "snippets",
        {
          id: row.id,
          vault_id: row.vault_id,
          name: patch.name ?? row.name,
          description:
            patch.description !== undefined
              ? patch.description
              : (row.description ?? null),
          tags:
            patch.tags !== undefined
              ? JSON.stringify(patch.tags)
              : (row.tags ?? "[]"),
          sort_order: row.sort_order,
        },
        {
          plaintext: JSON.stringify({ ...existing, ...sensitive }),
          recordType: "snippets",
        },
      );
      set({
        snippets: get().snippets.map((s) =>
          s.id === id ? { ...s, ...patch } : s,
        ),
        isLoading: false,
      });
    } catch (err) {
      set({ isLoading: false, error: errorMessage(err) });
    }
  },

  deleteSnippet: async (id) => {
    set({ isLoading: true, error: null });
    try {
      await deleteRow("snippets", id);
      set((s) => ({
        snippets: s.snippets.filter((snp) => snp.id !== id),
        selectedSnippet:
          s.selectedSnippet?.id === id ? null : s.selectedSnippet,
        isLoading: false,
      }));
    } catch (err) {
      set({ isLoading: false, error: errorMessage(err) });
    }
  },

  setSearchQuery: (query) => set({ searchQuery: query }),
  getFilteredSnippets: () => {
    const { snippets, searchQuery } = get();
    if (!searchQuery) return snippets;
    const q = searchQuery.toLowerCase();
    return snippets.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.tags.some((tag) => tag.toLowerCase().includes(q)) ||
        (s.description || "").toLowerCase().includes(q),
    );
  },
}));
