# HelaEngine

A low-poly browser game engine: a schema-driven editor that produces `scene.json`, a
framework-free Three.js runtime that consumes it, and an exporter that produces standalone runnable
projects.

**It is not an LLM game generator.** Nothing at runtime asks a model anything.

---

## The rules that are not negotiable

These are load-bearing. Breaking one does not produce a worse version of the engine, it produces a
different engine.

### No dynamic execution

No `eval`, no `new Function`, no dynamic `import()` of author-supplied paths. A lint rule enforces
this. A scene file is untrusted input — somebody sends you a level, or you open one from the
internet — and a document that could name a function to call would be a document that could run
code you did not ship.

### Closed vocabularies, validated at the boundary

Every extensible thing is a Zod discriminated union. A document naming something outside it is not
a document with a bad field, it is not a document. Parse at every trust boundary: file load, network
response, stored row.

Both ends have to close. Zod rejects unknown tags at parse time; TypeScript's exhaustive switch
rejects a missing implementation at compile time. **A switch over a union needs a `default` arm that
assigns to `never`** — without it a new variant compiles fine and silently does nothing, which is a
feature absent from every existing game and found by a player rather than the compiler.

### `packages/engine` is plain Three.js

No React, no editor imports. The same built engine is consumed unmodified by the editor's preview
and by every export. A lint rule enforces the dependency direction.

### Every new field defaults so old documents behave identically

`wind.strength` at zero is not a wind blowing nothing — it is the absence of the system, with no
material patched and no uniform updated. Adding a field must be invisible to a scene saved before it
existed.

---

## Layout

|                                                 |                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| `packages/schema`                               | Zod schemas. The single source of truth for every document shape.   |
| `packages/engine`                               | The runtime. Three.js only.                                         |
| `packages/export`                               | Turns a scene into a standalone folder.                             |
| `apps/editor`                                   | React + react-three-fiber.                                          |
| `apps/api`, `apps/collab`, `apps/export-worker` | Cloud services.                                                     |
| `tools/smoke`                                   | The pre-delivery gate: exports a scene, plays it headless, reports. |
| `docs/`                                         | User-facing documentation. Keep it current with the feature.        |

---

## Commands

```
pnpm format        # prettier --write
pnpm lint          # eslint
pnpm typecheck     # turbo, every package
pnpm test          # turbo, every package
pnpm smoke:test    # the release gate: real exports, played headless
```

Run all five before committing. `pnpm format` first — lint will otherwise fail on formatting.

### End-to-end tests

```
CHROMIUM_PATH=/opt/pw-browsers/chromium pnpm --filter @helaengine/editor exec \
  playwright test <spec> --project=chromium --reporter=line
```

`CHROMIUM_PATH` is **required** in this container: the pre-installed Chromium build does not match
the one Playwright expects, and without it the web server fails to start with a confusing message
about installing browsers. The asset ingest needs it too, for the same reason.

### Services

Postgres and Redis die regularly in this container. The e2e web server needs both.

```
PGBIN=$(ls -d /usr/lib/postgresql/*/bin | head -1)
su postgres -c "$PGBIN/pg_ctl -D /tmp/hela-pg -o '-p 5433 -k /tmp' -l /tmp/pg.log start"
redis-server --daemonize yes --port 6379 --save '' --appendonly no
```

If `@helaengine/export-worker` fails on queue timing, check whether an e2e run is holding Redis —
it has failed for that reason and not for a code reason more than once.

---

## Testing

**Prove it, do not assert it.** A rendering or gameplay claim is made against pixels or against the
running simulation, never against the document. This codebase has been bitten repeatedly by a
setting that saved, exported and round-tripped perfectly while doing nothing at all in the viewport
— the worst shape a bug can take, because everything about it says it worked.

**Include the control case.** "The pixels changed" proves nothing without "and they did not change
when the feature was off". A comparison of two frames of empty sky passes both halves.

**Mutation-test the guard.** After writing a test for something that must not happen, break the
thing deliberately and confirm the test fails. Several tests in this repo were vacuous until that
was done.

---

## Prose

Comments explain **why**, not what. The interesting content is the decision: what the alternative
was, and what would go wrong if it had been taken. A comment restating the line below it is noise.

Where a bug was fixed, say what the failure looked like. `// The cap belongs on the grid size, not
the loop — walking the grid in row order means stopping early drops the last rows, a bald strip
along one edge` is worth ten lines of description of the algorithm.

British English in user-facing prose and comments.
