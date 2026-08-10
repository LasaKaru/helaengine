---
name: add-graph-node
description: "Use when adding, changing or removing a node type in HelaEngine's visual scripting graph — anything touching packages/schema/src/graph.ts, GraphRuntime, or the editor's node palette. A node type has to land in five places or it half-exists, and two of the five fail silently rather than at compile time. Triggers: 'add a graph node', 'new node type', 'the graph should be able to X', editing NODE_OUTPUTS or the GraphNodeSchema union."
---

# Adding a graph node type

A node type is not one change. It is five, and the compiler only catches three of them.

## The five places

### 1. The schema union — `packages/schema/src/graph.ts`

Add a variant to `GraphNodeSchema`. Every field is bounded: strings get `.max()`, numbers get
`.min().max()`, ids use `IdSchema` — or `UnsetIdSchema` if the editor needs to hold the node while
the author has not chosen yet.

### 2. `NODE_OUTPUTS` — same file

`Readonly<Record<GraphNodeType, readonly string[]>>`, so **the compiler catches a missing entry.**

- One output is `['then']`.
- A decision is `['true', 'false']`.
- **Nothing after it is `[]`** — `loadLevel` has no outputs because the level it lives in is about
  to stop existing.

### 3. Validation — `validateGraph`, same file

If the node names something that must exist — a variable, an object, an asset, a level — check it
and push a problem. Use `checkSet` for a field the author may not have filled in yet: an unchosen
dropdown is an _error_, because a Destroy node with no target destroys nothing and says nothing,
which is worse than either alternative.

### 4. The interpreter — `packages/engine/src/graph/GraphRuntime.ts`

Add a `case` to `#step`. The switch has a `default` arm that assigns `node` to `never`, so **this
one fails to compile if you forget it.** That guard was added after a node type silently fell
through and did nothing.

Rules for the arm:

- **Reach the world through `WorldHandle`, never Three.js directly.** If the world cannot do what
  the node needs, add a method to `WorldHandle` _and_ to `INERT_WORLD`.
- **Anything needing an asset loader or the frame loop is a request, not an action.** Record it on
  the runtime and let the host act between frames — see `requestLevel` / `pendingLevel`. Doing it
  inline frees memory a running behaviour is holding.
- `break` to continue down `then`; `return` if nothing follows.

### 5. The editor — `apps/editor/src/graph/nodes.ts` and `components/GraphNodeFields.tsx`

- `NODE_LABELS` is `Record<GraphNodeType, string>` — **compiler-checked.**
- `NODE_GROUPS` is a plain array — **not checked.** A type missing here exists in the schema, the
  runtime and the docs, and cannot be reached by a user. `nodes.test.ts` asserts the palette covers
  the vocabulary exactly; keep that test passing.
- `describeNode` and `newNode` are exhaustive switches — compiler-checked.
- `GraphNodeFields` renders the form. Also exhaustive.

## What to test

`apps/editor/src/graph/nodes.test.ts` already iterates every type and asserts `newNode` produces
something `GraphNodeSchema` accepts, with and without scene context. That covers most mistakes for
free — run it first.

Then add, in `packages/engine/src/graph/graph.test.ts`:

- the node doing its job, against a fake `WorldHandle` that records calls
- whatever it refuses to do, and why

## The two checks not to break

`findInstantCycles` treats `DELAY_NODES` as yielding the frame. **If the new node lets time pass,
add it to that list** — otherwise a legitimate repeating chain through it is refused as a hang.

The step budget bounds one event's execution. A node that fans out needs to respect `budget`.

## Finally

- `docs/GRAPH.md` — the tables there are user-facing and go stale silently.
- `pnpm format && pnpm lint && pnpm typecheck && pnpm test`
