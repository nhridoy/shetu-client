// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));

import ImportKeyModal from "./ImportKeyModal";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PPK = "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n";

const text = () => document.body.textContent ?? "";

function setValue(el: Element, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function submitPpk(onImport: () => Promise<void>, passphrase?: string) {
  const root = createRoot(
    document.body.appendChild(document.createElement("div")),
  );
  await act(async () =>
    root.render(<ImportKeyModal onClose={() => {}} onImport={onImport} />),
  );
  const paste = [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("paste key manually"),
  );
  await act(async () => paste?.click());
  await act(async () => {
    setValue(document.querySelector('input[name="name"]') as Element, "k");
    setValue(document.querySelector("textarea") as Element, PPK);
    if (passphrase)
      setValue(
        document.querySelector('input[name="passphrase"]') as Element,
        passphrase,
      );
  });
  await act(async () => {
    (
      document.getElementById("import-key-form") as HTMLFormElement
    ).requestSubmit();
  });
  await act(async () => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("ImportKeyModal PPK", () => {
  it("converts PPK text before importing", async () => {
    h.invoke.mockResolvedValue("OPENSSH-TEXT");
    const onImport = vi.fn().mockResolvedValue(undefined);
    await submitPpk(onImport, "pw");
    expect(h.invoke).toHaveBeenCalledWith("convert_ppk", {
      text: PPK,
      passphrase: "pw",
    });
    expect(onImport).toHaveBeenCalledWith(
      expect.objectContaining({
        encryptedPrivateKey: "OPENSSH-TEXT",
        passphrase: "pw",
      }),
    );
  });

  it("shows wrong passphrase and does not import", async () => {
    h.invoke.mockRejectedValue("PPK_BAD_PASSPHRASE");
    const onImport = vi.fn();
    await submitPpk(onImport, "bad");
    expect(text()).toContain("Wrong passphrase");
    expect(onImport).not.toHaveBeenCalled();
  });

  it("asks for a passphrase when the key is encrypted", async () => {
    h.invoke.mockRejectedValue("PPK_ENCRYPTED");
    const onImport = vi.fn();
    await submitPpk(onImport);
    expect(text()).toContain(
      "This PuTTY key is encrypted — enter its passphrase",
    );
    expect(onImport).not.toHaveBeenCalled();
  });
});
