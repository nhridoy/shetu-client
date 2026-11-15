# Side panel section cards — short design

A follow-up to `2026-11-14-host-group-panel-ui-design.md`. The user asked for the side panel to
look like Termius/Termoso: grouped into sections, with the groups more prominent, while keeping
Shetu's design language.

## What changes

**Cards.**
- Each section is a titled card, styled like the app's existing Settings cards (Settings → SSH
  tab): `bg-dark-800 rounded-lg`, a subtle `border-dark-700/60` and `p-3`.
- Cards are spaced apart on the panel's darker background.
- Card header:
  - a phosphor icon in the app's existing icon weight and size (match AppSidebar/Settings);
  - a white `text-sm font-medium` title;
  - an optional muted summary on the right.

**Sections and order.**

| Section | Host | Group |
|---|---|---|
| Address | address + port, name | — |
| General | group, tags, colour | name |
| Credentials | username, login method (+ password/key and resolved line) | same, without "From group" |
| Connection | connect-through (jump host), keepalive, agent forwarding | keepalive, agent forwarding |
| On connect | startup | startup |
| Environment | env table | env table |

**Summaries (exact).**
- Credentials: "from {group}" when the login method is From group and a group supplies it.
- Connection and On connect: "from {group}" when their From-group value comes from a group.
- Environment: "{n} vars", counting host plus visible inherited rows. Omitted when 0.

**Stickiness.** The cards replace the sticky uppercase section headings (`SidePanel.Section`). The
panel header and the Save/Cancel footer stay pinned. The group panel keeps its intro line above
the cards.

## Unchanged

All fields, validation, submit mapping, inheritance hints, discard guard, focus and Esc
behaviour, and every behaviour test apart from section-placement queries. No new dependencies.

## Approaches

Titled cards (**chosen by the user**) versus divider-separated headed groups. Termius and Termoso
both use cards, and the app already has a card style in Settings.
