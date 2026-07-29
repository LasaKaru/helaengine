# Performance

The acceptance bar for Phase 2, the scene it is measured against, and what the numbers mean.

Run it:

```bash
pnpm build                      # the benchmark drives the built editor, not the dev server
pnpm --filter @helaengine/editor preview &
pnpm bench                      # human-readable
pnpm bench -- --json            # machine-readable, for a regression check
```

## The benchmark scene

**Stress Test**, available from the projects screen like any other template, and generated from a
fixed seed so it is the same scene every time (`apps/editor/src/templates.ts`, `buildStressScene`):

- **500 static props** drawn from eight assets — trees, rocks, barrels, crates, fences — scattered
  across the full 128 × 128 m terrain
- **20 goblins**, each with a `patrol` route, a `chaseOnSight` state machine and a kinematic
  physics body
- **sculpted, painted terrain** at 64 × 64 segments, so the heightfield collider is realistic

It is shaped like a level rather than like a synthetic torture test. Five hundred props give
instancing something to batch; twenty thinking enemies cost CPU rather than draw calls. A benchmark
that stressed only one of the two would hide the other.

## The bar

| Measure                        | Target               | Why this one                                                          |
| ------------------------------ | -------------------- | --------------------------------------------------------------------- |
| Draw calls, stress scene       | **≤ 80**             | Hardware-independent. The first thing a browser renderer runs out of. |
| Simulation CPU, stress scene   | **≤ 4 ms/frame**     | Hardware-comparable. Leaves ~12 ms of a 16.7 ms budget for rendering. |
| Frame rate, reference hardware | **60 fps sustained** | The user-facing promise.                                              |

**Reference hardware** for the frame-rate line: a 2021-or-later laptop with integrated graphics
(Apple M1, or Intel Iris Xe), at 1440 × 900, in Chrome or Firefox.

The first two lines are the ones a regression check should assert on, because they are the same
number on every machine. Frame rate is not: it depends on the GPU, the window size and what else the
machine is doing.

## Measured, 2026-07-29

From `pnpm bench` in the CI container. **The GPU here is SwiftShader**, Chromium's software
rasteriser — roughly two orders of magnitude slower than any real GPU. Its frame times are a floor
and are recorded for trend, never as evidence the frame-rate bar is met.

| Configuration     | Draw calls | Triangles | Instanced objects | Median frame (SwiftShader) |
| ----------------- | ---------- | --------- | ----------------- | -------------------------- |
| Batching off      | 530        | 17,932    | 0                 | 116.7 ms                   |
| Editing (batched) | **57**     | 36,624    | 500               | 116.7 ms                   |
| Play preview      | **49**     | 36,502    | 500               | 100.0 ms                   |

Simulation cost per frame, in play preview with all twenty enemies active:

- **physics 1.56 ms** — Rapier's fixed step, 520 colliders, terrain heightfield, character controller
- **gameplay 0.18 ms** — twenty patrols, twenty AI state machines, trigger occupancy
- **peak 26.7 ms** — the very first step, which is not a per-frame cost (see below)

Total **~1.7 ms of CPU per frame**, comfortably inside the 4 ms bar and leaving about 15 ms of a
60 fps budget for rendering.

The average excludes the first ten frames, and `peakMs` is reported separately so that decision is
visible rather than hidden. The first step of a simulation is genuinely not representative of the
ones after it: Rapier builds its broad phase, all twenty enemies happen to run their first
line-of-sight trace on the same frame, and nothing has been JIT-compiled yet. Averaging that in
would report a cost the game never actually pays every frame — but a real spike still shows up in
the peak.

### What the numbers say

**Draw calls fell by 89%**, from 530 to 57. That is the whole point of the sprint and it is the
number to protect. Fifty-seven is one per distinct mesh in each batched asset, plus the terrain, the
handful of props below the batching threshold, and the twenty goblins — which cannot be batched
because they move.

**Triangles rose, from 17.9k to 36.6k.** This is a real trade and worth stating plainly: an
`InstancedMesh` has a single bounding sphere covering every instance, so a batch is drawn whenever
any part of it is on screen. Without batching, Three culls the roughly half of the props that are
behind the camera. Splitting each batch into spatial buckets would restore culling at the cost of
multiplying draw calls — and at 36k triangles that is the wrong trade by a wide margin. Modern
hardware does not notice 36k triangles; it very much notices 530 draw calls. Revisit only if a scene
appears where the triangle count, not the call count, is the constraint.

**SwiftShader frame times barely moved** between batched and unbatched. That is expected and is not
evidence against the change: a software rasteriser is fill-rate bound, so it is insensitive to
exactly the thing being optimised. It is why the bar above is written in draw calls.

## What is optimised, and what is deliberately not

**Instancing** (`packages/engine/src/InstanceManager.ts`). Repeated static objects are batched into
one `InstancedMesh` per distinct mesh. An object is eligible only when nothing ever touches it
individually: no behaviours, no trigger, a static body, and no parent or child. Batched objects keep
a node in `LoadedScene.objects` — detached from the scene graph, so it costs nothing to draw — so
selection, framing and transform sync all keep working, and a raycast hit on a batch maps back to
the object the user thinks they clicked. Threshold: 8 copies (`DEFAULT_INSTANCE_THRESHOLD`).

**Node pooling** (`SceneLoader.recycle` / `instantiateInto`). Objects spawned and destroyed at
runtime are recycled rather than rebuilt, so a wave-spawner produces no steady drip of garbage. The
pool is capped at 64 nodes per asset, because an uncapped pool is a leak with a friendlier name.

**Frustum culling** is Three's, per mesh, and it works: nested groups do not defeat it, since culling
is decided per `Mesh` rather than per group. `instancing.test.ts` pins both halves — every drawn mesh
keeps `frustumCulled` on and has a bounding sphere, and an object behind the camera is confirmed
outside the frustum.

**LOD is not implemented.** The task said to add distance-based LOD "for high-poly assets if any
exceed budget". None do: the heaviest asset in the library is 8,000 triangles against an 8,000
budget, and the whole stress scene is 36k. Adding an LOD system now would mean writing, testing and
maintaining a mechanism with nothing to apply it to. The budgets in `ASSET-CONVENTIONS.md` are what
keeps that true; when an asset breaks them, this is the paragraph to come back to.

## Boundary check

`packages/engine/src/boundaries.test.ts` is the Phase 2 wrap check, run as an ordinary test rather
than trusted to a lint config: the runtime imports nothing from React, r3f, Zustand, Immer, Dexie or
the editor, never reaches outside its own package, uses only dependencies its `package.json`
declares, and contains no `eval`, `new Function`, or string-bodied timers.
