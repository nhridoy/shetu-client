# Storage connect attempts — short design

Follow-up from client PR #54 (CodeRabbit thread 4641201210).

## Intent

A storage pane's connect can still be running when the pane is disconnected, and the pane can
then reconnect (possibly to another account). The abandoned connect must never replace or close
the newer pane's session. Today the backend keeps one session per pane id with no notion of which
attempt it belongs to; the web side cleans up after the fact, and two orderings remain open:

- the stale connect inserts after the newer one (replacing its session, maybe another account's);
- the stale connect's cleanup runs after the newer one inserted but before it registered its
  provider (closing the newer session).

## Goals

- A connect saves its session only if it is still the pane's latest attempt and the pane hasn't
  been disconnected or signed out since it started.
- Disconnect closes the session and invalidates every connect still running for that pane.
- Sign-out invalidates every connect still running (replaces the generation counter).
- The web side drops its post-hoc cleanup; a connect refused because the pane moved on stops
  quietly (no error box).

## Non-goals

- Changing how commands find a pane's session (`op(sid, account_id)` stays account-bound).
- SSH/SFTP panes.

## Approaches

- **Backend attempt tickets (chosen).** `StorageSessions` mints an attempt number per connect
  and remembers the pane's latest; insert checks it; disconnect and sign-out forget it. One
  mechanism, decided where the session map lives, no new command arguments.
- **Web-minted attempt id passed to `storage_connect`/`storage_disconnect`.** Rejected: more
  plumbing through both commands, and the backend still has to decide which attempt is newest.
- **Keep the web-side guard.** Rejected: it can't close the "inserted but not yet registered"
  window.

## Design

- `StorageSessions` gains `latest: HashMap<pane id, u64>` (under the same lock as `open`) and a
  global attempt counter.
  - `begin(sid) -> u64`: next attempt number, recorded as the pane's latest.
  - `insert_if(attempt, sid, r, remote) -> bool`: stores only if `latest[sid] == attempt`.
  - `remove(sid)`: removes the session and `latest[sid]`.
  - `clear()` (sign-out): clears both maps.
  - The `generation` counter and `generation()` go away.
- `storage_connect` calls `begin` first; when `insert_if` refuses, it returns an error (the web
  side won't show it, below).
- Web `useFileOperations`: on a storage connect error, if the pane was disconnected since the
  connect started, throw `ConnectCancelled` instead of reporting the error. The post-hoc
  `storage_disconnect` cleanup and its `getProvider` guard are removed (the backend never stored
  the stale session).

## Left to the builder

- Error text for a refused insert; test names.
- Tests: stale insert after disconnect refused; older attempt refused after a newer `begin`;
  newer attempt accepted; sign-out refuses in-flight attempts; `remove` forgets the ticket. Web:
  a refused retry after disconnect is `ConnectCancelled` with no error modal and no extra
  `storage_disconnect`.
