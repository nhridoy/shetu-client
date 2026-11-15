import { useId, useState } from "react";
import IdentityList from "@/components/identities/IdentityList";
import KeyList from "@/components/keys/lists/KeyList";

const TABS = ["Keys", "Identities"] as const;

export default function KeysPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Keys");
  const id = useId();
  return (
    <div className="flex-1 p-4 overflow-y-auto">
      <div
        role="tablist"
        aria-label="Keychain"
        className="flex gap-1 mb-3 border-b border-dark-700"
      >
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`${id}-tab-${name}`}
            aria-controls={`${id}-panel-${name}`}
            aria-selected={tab === name}
            onClick={() => setTab(name)}
            className={`px-3 py-1.5 text-sm -mb-px border-b-2 transition-colors ${
              tab === name
                ? "border-primary-500 text-white"
                : "border-transparent text-dark-400 hover:text-white"
            }`}
          >
            {name}
          </button>
        ))}
      </div>
      {TABS.map((name) => (
        <div
          key={name}
          role="tabpanel"
          id={`${id}-panel-${name}`}
          aria-labelledby={`${id}-tab-${name}`}
          hidden={tab !== name}
        >
          {name === "Keys" ? (
            <KeyList onNewKeyParam={() => setTab("Keys")} />
          ) : (
            <IdentityList />
          )}
        </div>
      ))}
    </div>
  );
}
