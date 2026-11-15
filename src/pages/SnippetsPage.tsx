import { useState } from "react";
import SnippetForm from "@/components/snippets/forms/SnippetForm";
import SnippetList, {
  type Snippet,
} from "@/components/snippets/lists/SnippetList";
import { useModal } from "@/hooks/useModal";
import { useNewParam } from "@/hooks/useNewParam";

export default function SnippetsPage() {
  const formModal = useModal();
  const [editingSnippet, setEditingSnippet] = useState<Snippet | null>(null);
  const openNew = () => {
    setEditingSnippet(null);
    formModal.show();
  };
  useNewParam({ snippet: openNew });

  return (
    <div className="flex-1 p-4 overflow-y-auto">
      <SnippetList
        onNew={openNew}
        onEdit={(snippet) => {
          setEditingSnippet(snippet);
          formModal.show();
        }}
      />

      {formModal.open && (
        <SnippetForm
          snippet={editingSnippet ?? undefined}
          onClose={() => {
            formModal.hide();
            setEditingSnippet(null);
          }}
        />
      )}
    </div>
  );
}
