// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestAccountDeletion = vi.fn();
const state = {
  user: { id: "u1", email: "Me@Example.com" },
  teams: [] as unknown[],
};

vi.mock("@/stores/auth/authStore", () => ({
  useAuthStore: () => ({ user: state.user, requestAccountDeletion }),
}));
vi.mock("@/stores/teams/teamStore", () => ({
  useTeamStore: () => ({ teams: state.teams }),
}));

import DeleteAccountDialog from "./DeleteAccountDialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
beforeEach(() => {
  requestAccountDeletion.mockReset();
  state.teams = [];
});
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
});

function setup() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<DeleteAccountDialog onClose={() => {}} />));
}

const input = (label: string) =>
  document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  ) as HTMLInputElement;
const confirmBtn = () =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === "Delete my account",
  ) as HTMLButtonElement;

function type(el: HTMLInputElement, value: string) {
  act(() => {
    const set = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("DeleteAccountDialog", () => {
  it("lists_owned_teams_with_member_counts", () => {
    state.teams = [
      { id: "t1", name: "Mine", ownerId: "u1", members: [{}, {}] },
      { id: "t2", name: "Other", ownerId: "u2", members: [{}] },
      { id: "t3", name: "Solo", ownerId: "u1" },
    ];
    setup();
    const text = document.body.textContent;
    expect(text).toContain("Mine (2 members) — deleted for everyone");
    expect(text).toContain("Solo — deleted for everyone");
    expect(text).not.toContain("0 members");
    expect(text).not.toContain("Other");
    expect(text).toContain(
      "You have 30 days to change your mind — sign in again and choose “Keep my account” to cancel.",
    );
  });

  it("confirm_disabled_until_email_matches", () => {
    setup();
    expect(confirmBtn().disabled).toBe(true);
    type(input("Password"), "pw");
    expect(confirmBtn().disabled).toBe(true);
    type(input("Type your email to confirm"), "wrong@example.com");
    expect(confirmBtn().disabled).toBe(true);
    type(input("Type your email to confirm"), "me@example.com");
    expect(confirmBtn().disabled).toBe(false);
  });

  it("email_match_ignores_case_and_spaces", () => {
    setup();
    type(input("Password"), "pw");
    type(input("Type your email to confirm"), "  ME@example.COM ");
    expect(confirmBtn().disabled).toBe(false);
  });

  it("shows_server_error_and_stays_open", async () => {
    requestAccountDeletion.mockRejectedValue(
      new Error("That password is incorrect."),
    );
    setup();
    type(input("Password"), "pw");
    type(input("Type your email to confirm"), "me@example.com");
    await act(async () => confirmBtn().click());
    expect(document.body.textContent).toContain("That password is incorrect.");
    expect(document.body.textContent).toContain("Delete your account?");
    expect(confirmBtn().disabled).toBe(false);
  });

  it("submits_password_and_email", async () => {
    requestAccountDeletion.mockResolvedValue(undefined);
    setup();
    type(input("Password"), "pw");
    type(input("Type your email to confirm"), " me@example.com ");
    await act(async () => confirmBtn().click());
    expect(requestAccountDeletion).toHaveBeenCalledWith("pw", "Me@Example.com");
  });
});
