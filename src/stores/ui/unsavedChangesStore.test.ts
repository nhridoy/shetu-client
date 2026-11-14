import { describe, expect, it } from "vitest";
import { useUnsavedChanges } from "./unsavedChangesStore";

describe("useUnsavedChanges", () => {
  it("confirmLeave resolves true when clean", async () => {
    useUnsavedChanges.getState().setDirty(false);
    expect(await useUnsavedChanges.getState().confirmLeave()).toBe(true);
    expect(useUnsavedChanges.getState().asking).toBe(false);
  });

  it("confirmLeave asks when dirty and resolves with the answer", async () => {
    useUnsavedChanges.getState().setDirty(true);
    const p = useUnsavedChanges.getState().confirmLeave();
    expect(useUnsavedChanges.getState().asking).toBe(true);
    useUnsavedChanges.getState().answer(false);
    expect(await p).toBe(false);
    expect(useUnsavedChanges.getState().asking).toBe(false);
    useUnsavedChanges.getState().setDirty(false);
  });
});
