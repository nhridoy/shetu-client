# Credentials as plain fields (Termius-style) — short design

**Intent.** The host and group forms ask the user to pick an "Authentication" method before showing fields. Termius (and termoso, which follows it) just show the login fields and work the method out from what is filled. The user wants the same in Shetu. Clean-room: UX only, no code from termoso (AGPL).

**What the user sees (Credentials card, host and group).**
```
 👤 Username   [deploy · prod            ]   ← focus/typing: matching identities + "+ New identity"
 🔒 Password   [•••••• · prod         👁 ]
 🔑 [+ Key]                                  ← picked key shows as a chip "deploy-key ×"
```
- Picking an identity turns the Username row into a chip "🪪 deploy@prod (deploy) ×". The Password and Key rows hide. × clears the identity.
- Hosts only: empty fields show the inherited group value greyed:
  - username: "deploy · prod";
  - password: "•••••• · prod" when the group has one;
  - key: a greyed "deploy-key · prod" chip;
  - identity: a greyed "Identity 'x' · prod" chip.
- No Authentication dropdown in either form.

**Login method, worked out on save** (the stored `authType` values and Rust stay unchanged):
- identity chosen → `identity` (+ `identityId`);
- password and key → `both`;
- password only → `password`;
- key only → `key`;
- nothing:
  - host in a group → `inherit`;
  - host without a group → `none` (asks when connecting);
  - group → not set.

**Calls (approved).**
1. A host's own login replaces the group's as a whole; there is no per-field mixing. This matches `host_inherit::resolve`.
2. "Ask when connecting" is no longer an explicit choice for a host in a group. An empty host uses the group's login.
   - An existing host stored as `none` in a group keeps `none` until its credential fields are edited and saved (designer's call: an untouched form must not change behaviour).

**Approaches considered.** (a) Plain fields with the method derived on save (**chosen**). (b) Keep the dropdown and restyle it: rejected, it isn't what was asked. (c) Per-field inheritance: rejected by the user; it would also need Rust changes.

**Non-goals.** Certificates/FIDO2, per-field inheritance, any change to the Rust resolution or the stored data.

**Left to the builder.** Combobox details (keyboard navigation, filtering), the chip and placeholder styling within the app's design language, and test updates.
