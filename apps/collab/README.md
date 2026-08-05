# @helaengine/collab-server

Real-time collaborative editing. One Yjs room per project, over websockets.

```bash
COLLAB_PORT=3200 DATABASE_URL=postgres://you@localhost/helaengine \
  pnpm --filter @helaengine/collab-server start
```

The editor connects when `VITE_COLLAB_ORIGIN` points at it **and** the open project lives in an
account. A project in this browser's IndexedDB has no room to join, and editing alone is not a
degraded mode — it is what the editor does by default.

## Not Liveblocks

`DEVELOPMENT-PLAN.md` recommends Liveblocks to save infrastructure time, with self-hosted Yjs as the
alternative. This is the alternative, because Liveblocks is a paid service with no account here and
nothing to point at. The trade is real: this file, `rooms.ts` and `store.ts` are infrastructure that
Liveblocks would have supplied, including the persistence boundary and the presence lifecycle.

What is _not_ a trade is the authorisation, which would have had to be written either way.

## Not y-websocket's server either

`y-websocket` ships a server. It will put anybody who knows a room name into that room.

A room here is a **project**, and a project belongs to an organisation, so membership is checked
**during the upgrade** — before a socket exists that could receive a byte of somebody's level. A
viewer is refused rather than admitted read-only: everybody in a room can write to the shared
document, so there is no read-only seat to offer.

Refusals do not distinguish "no such project" from "not your project". A socket that could tell
those apart is a project-existence oracle.

## Where the document actually lives

The CRDT is the working copy. **The version history is the durable store.**

- A room is seeded from the project's latest `scene_version` when the first person joins.
- It is written back as a _new version_ on a five-second debounce and when the last person leaves.
- A room that fails to parse is **not** written. Overwriting good history with a document that does
  not validate is the one unrecoverable outcome here.

So a collaborative session and a solo Ctrl+S produce the same kind of artefact, visible under
History like any other. There is no second source of truth to reconcile later.

Rooms are held in memory after they empty, rather than dropped: a reload takes a second or two, and
evicting the document in that window would make the returning client re-seed from the last saved
version and lose anything newer.

## What it does not do

- **No horizontal scaling.** Rooms live in this process's memory, so two instances behind a load
  balancer would each hold a different copy of the same project. Sharding by project id, or a Redis
  awareness/update relay, is the next step and is not here.
- **No presence timeout sweep.** A socket that closes cleanly has its presence removed immediately.
  A tab suspended by the OS relies on Yjs's own awareness timeout.
- **`hashToken` is restated, not imported**, so this service does not pull in the API's pool and
  route table to hash a token. Both packages assert the same digest literal, because the day they
  diverge every collaborative session silently stops authenticating.
