// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Select from "@/components/ui/Select";
import { useUnsavedChanges } from "@/stores/ui/unsavedChangesStore";
import SidePanel from "./SidePanel";
import UnsavedChangesDialog from "./UnsavedChangesDialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let width = 1200;
let roReports = true;
class RO {
  constructor(private cb: (e: unknown[]) => void) {}
  observe() {
    if (roReports) this.cb([{ contentRect: { width } }]);
  }
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO;

const roots: Root[] = [];
beforeEach(() => {
  width = 1200;
  roReports = true;
});
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
  useUnsavedChanges.getState().answer(false);
  useUnsavedChanges.getState().setDirty(false);
});

function Harness({
  dirty = false,
  onClose,
}: {
  dirty?: boolean;
  onClose: () => void;
}) {
  const [v, setV] = useState("a");
  return (
    <div>
      <SidePanel
        title="Edit host · web"
        open
        dirty={dirty}
        onClose={onClose}
        footer={<button type="button">Save</button>}
      >
        <SidePanel.Card icon={<span />} title="General">
          <input aria-label="Name" />
          <Select
            value={v}
            onValueChange={setV}
            options={[
              { value: "a", label: "A" },
              { value: "b", label: "B" },
            ]}
          />
        </SidePanel.Card>
      </SidePanel>
      <UnsavedChangesDialog />
    </div>
  );
}

function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(node));
}
const q = (s: string) => document.querySelector(s) as HTMLElement;
const byText = (t: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === t,
  ) as HTMLElement;
const click = (el: HTMLElement) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
const key = (k: string, shiftKey = false) =>
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true }),
    );
  });
const flush = () => act(async () => {});

describe("SidePanel", () => {
  it("renders title, sections and footer", () => {
    mount(<Harness onClose={() => {}} />);
    expect(q("h2")?.textContent).toBe("Edit host · web");
    expect(q("h3")?.textContent).toBe("General");
    expect(byText("Save")).toBeTruthy();
    expect(q('[aria-label="Close panel"]')).toBeTruthy();
  });

  it("close without changes calls onClose", async () => {
    const onClose = vi.fn();
    mount(<Harness onClose={onClose} />);
    click(q('[aria-label="Close panel"]'));
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("close with changes asks and Keep editing keeps it open", async () => {
    const onClose = vi.fn();
    mount(<Harness dirty onClose={onClose} />);
    click(q('[aria-label="Close panel"]'));
    await flush();
    expect(document.body.textContent).toContain("Discard changes?");
    click(byText("Keep editing"));
    await flush();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Discard calls onClose", async () => {
    const onClose = vi.fn();
    mount(<Harness dirty onClose={onClose} />);
    click(q('[aria-label="Close panel"]'));
    await flush();
    click(byText("Discard"));
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("escape inside panel closes", async () => {
    const onClose = vi.fn();
    mount(<Harness onClose={onClose} />);
    expect(document.activeElement).toBe(q('input[aria-label="Name"]'));
    key("Escape");
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("escape in open select keeps panel", async () => {
    const onClose = vi.fn();
    mount(<Harness onClose={onClose} />);
    const combo = q('[role="combobox"]');
    act(() => combo.focus());
    click(combo);
    expect(q('[role="listbox"]')).toBeTruthy();
    key("Escape");
    await flush();
    expect(q('[role="listbox"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("escape closes an overlay panel despite its own dialog role", async () => {
    width = 800;
    const onClose = vi.fn();
    mount(<Harness onClose={onClose} />);
    key("Escape");
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("escape with focus outside panel does nothing", async () => {
    const onClose = vi.fn();
    mount(<Harness onClose={onClose} />);
    const outside = document.createElement("button");
    document.body.append(outside);
    act(() => outside.focus());
    key("Escape");
    await flush();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("overlays from the first paint, before ResizeObserver reports", () => {
    roReports = false;
    const clientWidth = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(800);
    mount(<Harness onClose={() => {}} />);
    expect(q("aside").getAttribute("role")).toBe("dialog");
    clientWidth.mockRestore();
  });

  it("overlay mode under 900px", async () => {
    width = 800;
    const onClose = vi.fn();
    mount(<Harness dirty onClose={onClose} />);
    const backdrop = q('[data-testid="side-panel-backdrop"]');
    expect(backdrop).toBeTruthy();
    const aside = q("aside");
    expect(aside.getAttribute("role")).toBe("dialog");
    expect(aside.getAttribute("aria-modal")).toBe("true");
    // Tab from the last focusable (Save) wraps to the first (Close).
    act(() => byText("Save").focus());
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(q('[aria-label="Close panel"]'));
    click(backdrop);
    await flush();
    expect(document.body.textContent).toContain("Discard changes?");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("no backdrop at 900px or wider", () => {
    mount(<Harness onClose={() => {}} />);
    expect(q("aside").getAttribute("role")).toBeNull();
    expect(q('[data-testid="side-panel-backdrop"]')).toBeNull();
  });

  it("focus moves to first field and returns to opener", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    mount(<Harness onClose={() => {}} />);
    expect(document.activeElement).toBe(q('input[aria-label="Name"]'));
    act(() => roots.pop()?.unmount());
    expect(document.activeElement).toBe(opener);
  });

  it("marks the store dirty only while dirty", () => {
    mount(<Harness dirty onClose={() => {}} />);
    expect(useUnsavedChanges.getState().dirty).toBe(true);
  });

  it("Card renders a labelled region with summary", () => {
    mount(
      <SidePanel title="t" open dirty={false} onClose={() => {}} footer={null}>
        <SidePanel.Card icon={<span />} title="Credentials" summary="from prod">
          <input aria-label="x" />
        </SidePanel.Card>
      </SidePanel>,
    );
    const region = document.querySelector("section[aria-labelledby]");
    const id = region?.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(id)?.textContent).toBe("Credentials");
    expect(region?.textContent).toContain("from prod");
  });

  it("Card keeps its title whole and truncates a long summary", () => {
    const long = `from ${"g".repeat(60)}`;
    mount(
      <SidePanel title="t" open dirty={false} onClose={() => {}} footer={null}>
        <SidePanel.Card icon={<span />} title="Credentials" summary={long}>
          <input aria-label="x" />
        </SidePanel.Card>
      </SidePanel>,
    );
    const h3 = q("section h3");
    expect(h3.textContent).toBe("Credentials");
    expect(h3.parentElement?.className).toContain("shrink-0");
    const sum = q("[data-card-summary]");
    expect(sum.className).toContain("truncate");
    expect(sum.getAttribute("title")).toBe(long);
  });
});
