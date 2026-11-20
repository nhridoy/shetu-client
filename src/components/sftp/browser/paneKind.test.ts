import { describe, expect, it } from "vitest";
import { forPaneKind } from "./FileBrowserList";

describe("forPaneKind", () => {
  const actions = {
    onCopy: () => {},
    onPermissions: () => {},
    onOpenInEditor: () => {},
    onOpenWithDefault: () => {},
    onOpenWith: () => {},
  };

  it("keeps every action for host panes", () => {
    expect(Object.keys(forPaneKind("host", actions)).sort()).toEqual(
      Object.keys(actions).sort(),
    );
  });

  it("drops editing, opening in an app and permissions for bucket panes", () => {
    const kept = forPaneKind("storage", actions);
    expect(kept.onCopy).toBeDefined();
    expect(kept.onPermissions).toBeUndefined();
    expect(kept.onOpenInEditor).toBeUndefined();
    expect(kept.onOpenWithDefault).toBeUndefined();
    expect(kept.onOpenWith).toBeUndefined();
  });
});
