# Phone Username-Password Routing

**Date:** 2026-10-11
**Status:** Design (pending review)
**Scope:** mn-rt server + PC client + web console + fr app (cross-repo)

## Background & Goal

Today the phone picks a PC by name from a `/clients` list, then enters a
shared `key` (K). The flow has two ergonomic problems:

- Every time the phone opens, the user re-selects a PC and re-types the key.
- The K is a separate secret from the device identity — easy to mistype,
  no memory of "which device was this for".

Replace the **device selection** with **direct username + password login**,
where the *username is the device name* and the *password is the K*.
The phone remembers paired devices locally; the home screen becomes
"my saved devices" → tap to connect, no retyping.

The RT1 crypto and key semantics stay the same — only the routing identity
and the phone UX change.

## Non-Goals

- No multi-tenant shared account: one PC = one user/password. Phone is a
  *client* of the PC's account.
- No server-side persistent user database. PC reports `user` + `password`
  on each connection; server keeps an in-memory map for the lifetime of
  the PC's session. Restart → forget.
- No account registration flow. The PC IS the account source of truth.
- Old `--key` device-selection mode is **fully preserved** (back-compat
  for existing deployments). New `--user`/`--password` mode runs alongside.

## Design

### 1. Server routing (mn-rt `server/`)

Keep the existing WebSocket frames and `/clients`, `/push`, `/health`
HTTP endpoints. Extend the `register` frame with optional fields:

```jsonc
// PC side
{ "type": "register", "role": "pc", "clientId": "laptop-1bkctmo0-x",
  "user": "office-laptop", "password": "MYK", "token": "..." }

// Phone side
{ "type": "register", "role": "phone", "phoneId": "phone-x",
  "user": "office-laptop", "password": "MYK", "token": "..." }
```

In-memory map maintained by the server while sessions are alive:

```ts
// User → currently online PC
const userToPc = Map<user, { clientId, password, ws }>;
// Phone routing: each phone's user → phone's ws (for ACK reverse path)
const phoneByUser = Map<user, Set<{ phoneId, ws }>>;  // many phones per user
```

Routing changes:

- **PC register**: if `user` already online with same `password`,
  replace old (kick previous PC — same as existing clientId kick). If
  *different* password, reject with `{type:'error', code:'auth_failed',
  msg:'user already in use with a different password'}`.
- **Phone register**: look up `userToPc`. If absent → reject
  `pc_offline`. If `password` mismatch → reject `auth_failed`. If OK,
  register phone under that user's PC for ACK routing.
- **Text forwarding**: phone-side text frames now carry target implicit
  by `user` — server finds the PC via `userToPc.get(phone.user)`. Phone
  no longer specifies `clientId` for the device-selection path.
- **ACK reverse routing**: PC → ACK → server finds phones for the
  source user → forwards. (Same shape as today, just keyed on user.)
- **HTTP `/push`** is unchanged (still takes explicit `clientId`; legacy).

When a PC disconnects, drop its entry from `userToPc`. Connected phones
receive `{type:'disconnected', reason:'pc_offline'}`.

### 2. PC client (`client/`)

`nx-rt serve` gains two optional flags and saves them like the other
connection params:

```
nx-rt serve --user office-laptop --password MYK
nx-rt serve --user office-laptop                   # password from file/env
nx-rt serve --user office-laptop --password-stdin  # CI / vault scenarios
```

- `--user` and `--password` are both optional. If absent, fall back to
  the current anonymous + `--key` behavior — fully back-compat.
- Extend `saveConnectionConfig` to persist `user` / `password` to
  `~/.nx-rt/config.json` (alongside `url` / `key` / `token`). Same
  rules: only write when present; never wipe existing fields.
- The first-run hint updates: `nx-rt serve --user X --password Y --url ws://...`.
- Bare `npx nx-rt` reuses saved values.
- WS register frame (in `lib/ws-client.js`) emits the new `user` /
  `password` fields when present.

### 3. Web console (`server/public/index.html`)

Replace the current 01-选电脑 → 填 key → 连接 flow with:

- **Login form** at the top: server URL (pre-filled, editable) +
  username + password + 连接 button.
- **Saved devices** list (from `localStorage`): each row shows name,
  last-used, "tap to reconnect". Click → fill the form with that
  device's creds → connect.
- **Save device** checkbox on first connect: persists `serverUrl +
  user + key` to `localStorage` under a new `rt-saved-devices` key
  (array of `{name, serverUrl, user, password, lastUsed}`).
- The 02-实时同步 section, the RT1 sync logic, and the mode toggle
  (发送/换行) are unchanged.
- Old `/clients` selector flow is removed from the path (the endpoint
  stays available for diagnostics but the UI doesn't call it).

### 4. fr app (`fr/lib/lab/demos/remotetype/`)

Rewrite the page top section:

- **Home page** (instead of `_buildPairing` as the first paint):
  - Top: form for `serverUrl` (default hardcoded `kRemoteTypeServerUrl`,
    editable), `user`, `password`, 连接 button.
  - Below: saved-devices list from `SharedPreferences` (key
    `rt-saved-devices`, JSON array of devices). Each entry: name,
    serverUrl, user, last-used → tap to fill form and connect.
  - Existing 实时同步 section (TextField + SegmentedButton + ASR) stays.
- `_RtSession.connect()` takes `{serverUrl, user, password}` instead
  of `{key}`. The session sends `user` + `password` in the register
  frame.
- **Persistence**: SharedPreferences (likely already a transitive
  dep; add `shared_preferences` to `pubspec.yaml` if missing). Key
  `rt-saved-devices`, value JSON-encoded array. On successful connect,
  upsert the device record with `lastUsed = DateTime.now()`.
- **Crypto**: `key` parameter of `rtSyncPlaintext` / `syncText` /
  crypto derivation becomes `password`. RT1's PBKDF2 → HKDF path is
  unchanged — `password` is just a string fed through the same pipeline
  that `key` used to feed.
- Remove the "select PC from /clients list" UI (page entry no longer
  fetches it). Keep `RtSession.listClients` exported for any
  diagnostic use.

### 5. Backward compatibility matrix

| Path | Phone sends | Server action | PC sends | Works? |
|---|---|---|---|---|
| **Old device-selection** (existing) | `register role:phone, key:K`, text `clientId: X` | routes by explicit clientId | `register role:pc, clientId: X, key:K` | ✓ unchanged |
| **New user/password** | `register role:phone, user:U, password:P` | routes via `userToPc` | `register role:pc, user:U, password:P` | ✓ new |
| **Mixed (PC old, phone new)** | user/password | server has no `userToPc` entry (PC registered anonymously) | anonymous | phone gets `pc_offline` — expected; user must connect via old mode OR upgrade PC |
| **Mixed (PC new, phone old)** | anonymous + key | server has `userToPc`, but phone not keyed on user | user/password | phone sends `clientId` → routes by clientId. Old phone keeps working; both styles coexist on the same server |

### 6. Security properties

- The password travels in plaintext on the WS (already true for the
  current `--key`). RT1 crypto integrity still derives from it.
- Server-side impersonation while a real PC is online is rejected:
  second register with same `user` and **different** password fails.
- PC disconnect → user mapping forgotten → next phone login gets
  `pc_offline` until the PC reconnects.
- Password is stored in plaintext in `~/.nx-rt/config.json` on PC
  (consistent with the existing `--key` storage model) and on fr
  in `SharedPreferences` (consistent with the existing key storage
  in `localStorage` on the web console). Same threat model as today.

### 7. Tests

**server (node):**
- Unit: PC register with `user`/`password` populates `userToPc`.
- Unit: phone register with matching password binds to that PC.
- Unit: phone register with wrong password rejected (`auth_failed`).
- Unit: phone register when PC not online → `pc_offline`.
- Unit: same `user` registered twice with same password → second
  replaces first (kick).
- Unit: same `user` registered twice with different password → second
  rejected (`auth_failed`).
- Unit: PC disconnect drops `userToPc`; phone receives
  `disconnected` event.
- E2E: spin local server, fake-PC + fake-phone using the same WS,
  assert text forwarding reaches the right PC.

**PC client (node):**
- `lib/config.js` saveConnectionConfig round-trips `user` and
  `password` (extension of existing tests).
- WS register frame contains `user`/`password` when configured.
- Bare `npx nx-rt` reuses saved user/password.

**web console:** manual smoke (no local equivalent of a headless browser
  test bed in this repo).

**fr (dart):**
- Widget test: home page renders login form + saved-devices list
  (mock SharedPreferences).
- Persistence round-trip: encode → write → read → decode yields
  same list.
- `RtSession.connect({serverUrl, user, password})` sends the new
  register frame; integration test mocks the WS.

## Files Touched

| Repo | Path | Change |
|---|---|---|
| mn-rt | `server/src/server.js` | register handler accepts `user`/`password`; `userToPc` map; routing updated |
| mn-rt | `server/public/index.html` | rewrite 01 section to login form + saved-devices list |
| mn-rt | `client/lib/config.js` | extend `saveConnectionConfig` for `user`/`password` |
| mn-rt | `client/lib/ws-client.js` | emit `user`/`password` in register frame |
| mn-rt | `client/bin/index.js` | `--user`/`--password` CLI flags; first-run hint update |
| mn-rt | `client/test/unit.js` | new tests (save, register frame, default flow) |
| mn-rt | `README.md` | new flow section + `--user` flag docs |
| fr | `lib/lab/demos/remotetype/rt_page.dart` | new home page; remove PC selector |
| fr | `lib/lab/demos/remotetype/rt_session.dart` | connect signature; register frame |
| fr | `lib/lab/demos/remotetype/rt_constants.dart` (or new file) | saved-devices storage helpers |
| fr | `test/lab/demos/remotetype/` | widget + persistence tests |

## Phasing

Implementation will be sequenced via writing-plans, suggested order:

1. **server** — protocol + routing (the contract everything else binds to)
2. **PC client** — CLI + register frame
3. **web console** — login UX + localStorage
4. **fr app** — login UX + SharedPreferences (last because it depends
   on the server contract being stable)

At each step the existing paths keep working (back-compat matrix).

## Open Questions

- (None pending; clarified in discussion.)