import {
  CopyIcon,
  FileTextIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import ConfirmDeleteDialog from "@/components/ui/ConfirmDeleteDialog";
import { EmptyActionState } from "@/components/ui/EmptyActionState";
import { EmptyState } from "@/components/ui/EmptyState";
import Input from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { useModal } from "@/hooks/useModal";
import { accessibleClickHandler } from "@/lib/common/accessibleClickHandler";
import { formatRelativeTime } from "@/lib/format/relativeTime";
import { useSnippetStore } from "@/stores/snippets/snippetStore";
import { useVaultStore } from "@/stores/vault/vaultStore";

interface Snippet {
  id: string;
  name: string;
  command: string;
  description?: string;
  tags: string[];
  createdAt: string;
}

interface SnippetListProps {
  onNew: () => void;
  onEdit: (snippet: Snippet) => void;
}

export default function SnippetList({ onNew, onEdit }: SnippetListProps) {
  const snippets = useSnippetStore((s) => s.snippets);
  const fetchSnippets = useSnippetStore((s) => s.fetchSnippets);
  const deleteSnippet = useSnippetStore((s) => s.deleteSnippet);
  const currentVaultId = useVaultStore((s) => s.currentVaultId);
  const [searchQuery, setSearchQuery] = useState("");
  const deleteDialog = useModal();
  const [deleteTarget, setDeleteTarget] = useState<Snippet | null>(null);

  const loadSnippets = useCallback(() => {
    fetchSnippets(currentVaultId ?? undefined);
  }, [fetchSnippets, currentVaultId]);

  useEffect(() => {
    loadSnippets();
  }, [loadSnippets]);

  const filteredSnippets = snippets.filter(
    (s) =>
      s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.tags.some((tag) => tag.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (s.description || "").toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const handleDelete = (snippet: Snippet) => {
    setDeleteTarget(snippet);
    deleteDialog.show();
  };

  const confirmDeleteAction = async () => {
    deleteDialog.hide();
    const snippet = deleteTarget;
    setDeleteTarget(null);
    if (!snippet) return;
    await deleteSnippet(snippet.id);
    toast.success(`Deleted "${snippet.name}"`);
  };

  const handleCopy = async (snippet: Snippet) => {
    const decrypted = await useSnippetStore
      .getState()
      .getDecryptedSnippet(snippet.id);
    if (!decrypted) return;
    navigator.clipboard.writeText(decrypted.command);
    toast.success("Copied to clipboard");
  };

  const handleEdit = async (snippet: Snippet) => {
    const decrypted = await useSnippetStore
      .getState()
      .getDecryptedSnippet(snippet.id);
    onEdit(decrypted ?? snippet);
  };

  return (
    <div className="flex-1 p-4 space-y-6 overflow-y-auto">
      <div>
        <SectionHeader
          title="Snippets"
          level="h3"
          className="text-sm tracking-wider uppercase text-dark-400 mb-3"
        >
          <Button type="button" onClick={onNew} variant="default" size="sm">
            <PlusIcon className="w-3 h-3" weight="bold" />
            New Snippet
          </Button>
        </SectionHeader>

        {snippets.length > 0 && (
          <Input
            type="text"
            placeholder="Search snippets..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="px-3 py-2 text-sm mb-3"
          />
        )}

        {snippets.length === 0 ? (
          <EmptyActionState
            icon={PlusIcon}
            message="No snippets yet — click to create one"
            onClick={onNew}
          />
        ) : filteredSnippets.length === 0 ? (
          <EmptyState
            icon={FileTextIcon}
            title="No matches"
            description={`No snippets match "${searchQuery}"`}
          />
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {filteredSnippets.map((snippet) => (
              // biome-ignore lint/a11y/useSemanticElements: snippet card contains nested button elements
              <div
                key={snippet.id}
                role="button"
                tabIndex={0}
                onClick={() => handleEdit(snippet)}
                onKeyDown={accessibleClickHandler(() => handleEdit(snippet))}
                className="relative p-3 transition-colors rounded-lg cursor-pointer bg-dark-800/50 hover:bg-dark-800 border border-primary-500/10 group"
              >
                <div className="flex items-center gap-2">
                  <FileTextIcon className="w-3.5 h-3.5 text-dark-500 shrink-0" />
                  <span className="text-sm font-medium text-white truncate">
                    {snippet.name}
                  </span>
                </div>
                <p className="text-dark-500 text-xs mt-1 ml-[22px]">
                  {formatRelativeTime(Number(snippet.createdAt))}
                </p>
                {snippet.tags.length > 0 && (
                  <div className="flex gap-1 mt-2 ml-[22px]">
                    {[...new Set(snippet.tags)].slice(0, 3).map((tag) => (
                      <Badge key={tag}>{tag}</Badge>
                    ))}
                  </div>
                )}
                <div className="absolute flex items-center gap-1 transition-opacity opacity-0 top-2 right-2 group-hover:opacity-100">
                  <Button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCopy(snippet);
                    }}
                    variant="ghost"
                    size="icon-sm"
                    title="Copy command"
                  >
                    <CopyIcon className="w-3 h-3" />
                  </Button>
                  <Button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleEdit(snippet);
                    }}
                    variant="ghost"
                    size="icon-sm"
                    title="Edit snippet"
                  >
                    <PencilSimpleIcon className="w-3 h-3" />
                  </Button>
                  <Button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(snippet);
                    }}
                    variant="ghost"
                    size="icon-sm"
                    className="hover:text-red-500"
                    title="Delete snippet"
                  >
                    <TrashIcon className="w-3 h-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDeleteDialog
        open={deleteDialog.open}
        message={`Delete snippet "${deleteTarget?.name || ""}"? This cannot be undone.`}
        onConfirm={confirmDeleteAction}
        onCancel={() => {
          deleteDialog.hide();
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}

export type { Snippet };
