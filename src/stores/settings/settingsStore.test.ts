import { describe, expect, it } from "vitest";
import { useSettingsStore } from "./settingsStore";

describe("terminal recording setting", () => {
  it("starts disabled so terminal output is never recorded without opt-in", () => {
    expect(useSettingsStore.getState().settings.recordTerminalOutput).toBe(
      false,
    );
  });
});
