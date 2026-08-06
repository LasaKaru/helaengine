# Load and capacity

Sprint 36. What the system does under concurrent use, where each service stops meeting its target,
and what is not measured.

`PERFORMANCE.md` is the neighbouring document and covers a different question: the _engine's_ frame
rate against the stress scene. This one is about the platform — the API, the collaboration server,
the editor's initial download — under load.

Everything here was measured on the development container: a laptop-class cloud VM, one API
process, one collaboration server, Postgres 16 on the same host, all over loopback. **The absolute
numbers are worth little.** What is worth a lot is the shape of the distribution, the point where
each service stops meeting its target, and a repeatable command that produces the table again. A
change that moves these on the same machine is real information; a comparison against somebody
else's staging environment is not.

Reproduce with:

```bash
pnpm load                              # the API
pnpm load:collab -- --steps 5,10,25,50 # the collaboration server
pnpm budget                            # the editor's critical path
pnpm headers                           # cache headers on a running origin
pnpm --filter @helaengine/engine test  # includes the deterministic leak tests
```

---

## The API

`pnpm load` runs four scenarios at a fixed concurrency, each a thing users actually do. Targets and
their reasoning live in `tools/load/src/scenarios.ts`; briefly, 300 ms p95 for reads, 500 ms for a
save, 800 ms for an export submission — a read is one indexed row and has no excuse, while a save
writes a scene document, appends a version row and bumps a project.

Every autosave request sends a **500-object scene**, which is the point of that scenario: it is the
one endpoint where the body is the load.

| Scenario         | Target p95 | 25 concurrent      | 50 concurrent      | 100 concurrent            |
| ---------------- | ---------- | ------------------ | ------------------ | ------------------------- |
| list projects    | 300 ms     | **40 ms** (918/s)  | **52 ms** (1662/s) | **~60 ms**                |
| open a project   | 300 ms     | **79 ms** (402/s)  | **124 ms** (472/s) | **252 ms** (437/s)        |
| autosave a scene | 500 ms     | **233 ms** (128/s) | **439 ms** (132/s) | **795 ms** (137/s) — over |
| submit an export | 800 ms     | **68 ms** (436/s)  | **130 ms** (445/s) | **274 ms** (437/s)        |

**One API process meets all four targets at 50 concurrent editing sessions and misses one at 100.**
The one it misses is autosave, and the throughput column says why: autosave sits at roughly 130
requests per second at every concurrency level. That flat line is the signature of a saturated
process rather than a slow query — the work per request does not change, so past saturation extra
concurrency turns entirely into queueing and latency grows while throughput does not move. Reads
behave the same way from 50 onward (437/s at both 50 and 100); they simply have enough headroom
that it does not cost them the target.

The next capacity step is therefore **more API processes**, not a faster query. Nothing in these
numbers points at a missing index.

### What was fixed to get here

Two changes, both found by measuring rather than reading:

- **Scenes were re-validated on every read.** Loading a project ran the stored document back through
  the Zod schema (2.93 ms) where `JSON.parse` alone is 0.36 ms. Documents already at the current
  version are now returned as-is and only older ones are migrated. This helped less than expected —
  438 ms to 398 ms — which is why the next item exists.
- **Opening a project cost four round trips.** The remainder was not CPU, it was latency multiplied.
  A lateral join collapsed the project fetch and its latest scene version into one query.

The first hypothesis was wrong and the second was right, and the only way to tell was to fix the
first and measure again.

---

## The collaboration server

A different measurement, deliberately. This service holds a live socket and a whole `Y.Doc` per open
project for as long as somebody is editing, so requests per second is the wrong unit. Three numbers
instead: how long joining takes, how long an edit takes to reach another editor, and what a
connection costs in memory.

All editors join **one room**, because a room is where the work is — every edit fans out to every
other socket in it.

| Editors in one room | Join p95 | Edit to a peer p95 | Memory / connection | Server CPU |
| ------------------- | -------- | ------------------ | ------------------- | ---------- |
| 5                   | 95 ms    | 0 ms               | (too few to judge)  | 43%        |
| 10                  | 255 ms   | 1 ms               | 26 KiB              | 2%         |
| 25                  | 1458 ms  | 1 ms               | 67 KiB              | 1%         |
| 50                  | 6269 ms  | 4 ms               | 8 KiB               | 0%         |

**The join column past 10 editors measures the load generator, not the server**, and the tool says
so rather than reporting a failure. The harness holds one `Y.Doc` per simulated editor in a single
Node process; sampling CPU on both sides during a 50-editor run showed the server at 0–3% while the
generator sat at 110–120% of a core. `/health` now reports cumulative CPU micros so every run can
make that attribution itself, and the verdict refuses to fail the server when it can prove the
server was idle. A tool must not report a failure it caused itself, least of all in a format
designed to be quoted.

What can honestly be said: **at 50 editors in one room the collaboration server used under 1% of a
core, propagated an edit to another editor in 1–5 ms, and held tens of kilobytes per connection —
far inside the 2 MiB budget.** Its actual ceiling is not visible from one generator process and
remains unmeasured.

The 43% CPU at 5 editors is process start-up, not load: it is the first step of the ladder against a
freshly started server. It is also why per-connection memory is printed but not judged below 20
connections — RSS growth over a small denominator charged 2.4 MiB per connection at five and 24 KiB
at fifty, on the same server.

### What was fixed to get here

**The first join to a cold room hung, roughly one time in six.** A `y-websocket` client sends sync
step 1 the instant the socket opens; the server registered its message listener _after_ awaiting the
room load, which for a room nobody has open is a database round trip. The opening message arrived at
a socket with no listener and was dropped, and the client waited forever for a reply to a question
nobody heard. It only affected the _first_ person to open a project, and only against a real
database — the in-memory store the Sprint 31 tests use resolves in a microtask, too fast for a
message to land in the gap, which is why the suite was green and a load run found it.

---

## The engine's memory

The sprint plan asks for a two-hour Play Preview session watched in Chrome's memory profiler. That
was replaced with the same question asked deterministically, in `packages/engine/src/leaks.test.ts`:
patch `dispose` on the Three.js prototypes and count. A profiler tells you memory grew; this tells
you _which_ resource was not released, and fails a build over it.

Four checks: a whole-scene control, twenty load/dispose cycles asserting every cycle frees exactly
the same amount, a released-object check, and a double-free check comparing resource identities
rather than counts — two owners each freeing one thing looks identical to one owner freeing two.

**This found the pitfall the plan names by name.** `LoadedScene.release` detached the node and left
everything it had built on the scene-wide disposables list, which is drained only when the project
closes — so placing and deleting fifty trigger volumes in one session held fifty edges geometries
and fifty line materials that nothing could reach again.

The fix is an ownership split rather than "dispose on release", because disposing everything would
have been worse than the leak: placeholder geometries and materials are cached per asset and shared
by every object using that asset, so freeing one on delete would blank every other tree in the
level. Only resources built for one object, and reachable from nowhere else, are freed by `release`.

---

## The editor bundle

`pnpm budget` measures what a browser downloads before the editor is usable, from the Vite manifest,
walking the entry through **static imports only** — so a lazy chunk is correctly not charged against
the critical path. A tool that adds up `dist/` and reports one total cannot tell the two apart,
which is how "our bundle is 4 MB" becomes a sentence nobody can act on.

|                       | Measured              | Budget  |
| --------------------- | --------------------- | ------- |
| Initial JS (gzipped)  | **311 KiB**           | 400 KiB |
| Initial CSS (gzipped) | **5 KiB**             | 30 KiB  |
| Largest lazy chunk    | **810 KiB** (physics) | 900 KiB |

It started at **559 KiB** of initial JS, because the whole editor — Three.js, react-three-fiber, the
gizmos — sat in the entry chunk: signing in to read a project list downloaded a 3D engine before
anything rendered. The workspace moved behind `React.lazy`, taking the physics init with it.

**Stated precisely, because the imprecise version would be flattering:** the projects screen no
longer _waits_ on the engine — it renders from a 311 KiB entry chunk — but it does still fetch the
asset library, and therefore Three.js, shortly afterwards. That is the dev API's doing: the e2e
suite reaches for `window.helaengine` on the projects screen, since opening a `.hela` file is a
projects-screen gesture, so the shell publishes it from a dynamic import once it has painted. The
win is real and it is a first-render win, not a never-downloads-it win.

The budgets are a ratchet set near today's numbers with headroom, not aspirational figures: a budget
the project cannot currently meet is a red build everybody learns to ignore. They should come down
over time, deliberately. `pnpm budget` runs in CI and fails the build.

---

## Cache headers

`pnpm headers` checks a **running origin** rather than reading headers off the source, because the
question is what a real response carries after every middleware and error branch has had its turn.

| Route                         | Policy                                | Verified by                                      |
| ----------------------------- | ------------------------------------- | ------------------------------------------------ |
| `/assets/<hash>` (GET)        | `public, max-age=31536000, immutable` | `pnpm headers` and integration test              |
| `/assets/<hash>` (HEAD)       | same                                  | `pnpm headers` and integration test, after a fix |
| `/exports/<id>/download`      | `no-store`                            | integration test                                 |
| share service, public build   | `public, max-age=300`                 | integration test                                 |
| share service, unlisted build | `private, no-store`                   | integration test                                 |

**This found one.** `/assets/*` matched `method === 'GET'`, so HEAD fell through to the
authenticated routes and answered 401 — a deliberately public, CDN-facing URL telling a cache it
needed to log in. HEAD is how a cache revalidates and how most uptime probes ask, so it would have
surfaced as a cold CDN and a monitor that never went green, neither pointing at the cause.

---

## What this does not cover

Stated plainly, because a performance document that only lists what went well is marketing.

- **No staging environment.** Everything above is loopback on one container. Real network latency, a
  load balancer, TLS termination and cross-AZ database hops are all absent, and every one of them
  costs milliseconds these numbers do not contain. The plan's definition of done says "runs against
  staging"; there is no staging.
- **No CDN.** The plan asks for a Cloudflare cache hit ratio. There is no CDN in front of anything
  here, so that number does not exist. What is checked is the origin behaviour that determines it —
  an origin answering `no-store` has a zero percent hit rate no matter how good the CDN is.
- **No Lighthouse run.** The bundle budget covers transfer size on the critical path, which is the
  part of a Lighthouse report that applies to a single-`div` application. Interaction latency,
  layout stability and the rest are not measured.
- **The collaboration server's ceiling is unknown.** The generator saturates before the server does.
  Finding the real limit needs the editors spread across processes or machines.
- **The engine's long-session behaviour is inferred, not observed.** Twenty load/dispose cycles is a
  compressed soak. It would catch a leak that grows per cycle; it would not catch one that appears
  only after an hour of continuous play.
- **These are single-run figures**, not medians of repeated runs, and there is no confidence
  interval anywhere in this document. Treat a 10% movement as noise.
- **k6 was the plan's suggestion and this is not k6.** k6 is a Go binary distributed outside npm and
  this environment installs from npm, so the choice was a tool that cannot run here or a few hundred
  lines that can. What is lost is real: k6's VU model, its thresholds language, its output plugins.
  What is kept is the part that earns a pass mark — a fixed concurrency, a percentile, and a
  documented target to compare against.
