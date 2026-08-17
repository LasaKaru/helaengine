# Performance

The acceptance bar for Phase 2, the scene it is measured against, and what the numbers mean.

This document is about the **engine's frame rate**. For the platform under concurrent use — API
latency targets, collaboration-server connection scaling, the editor's initial download and cache
headers — see [`LOAD-TESTING.md`](LOAD-TESTING.md).

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

**Level of detail** (`packages/engine/src/render/lod.ts`, `render/simplify.ts`). Coarse copies of
each mesh, generated when the level loads and swapped by distance. Off by default, because every new
field has to leave old documents rendering exactly as they did; `balanced` is the setting to use on a
level with real geometry in it.

This paragraph used to say the opposite — that LOD was not implemented and had nothing to apply it
to, because the heaviest asset was 8,000 triangles against an 8,000 budget. That was a defensible
reading of a starter library, and it stopped being true the moment somebody imported their own
models, which is now a supported path with a panel behind it. A budget the engine cannot enforce on
a file from somebody's hard drive is not a reason to have no mechanism.

- **Generated, not authored.** Vertex clustering: the bounding box is divided into a grid, vertices
  sharing a cell are averaged into one, and triangles that collapse to a line are dropped. No
  meshoptimizer, which produces better meshes and is another WebAssembly module in every exported
  game — a gap that matters least exactly where a coarse mesh is used, forty metres away and thirty
  pixels tall.
- **The grid resolution is searched for, not calculated.** The closed form — resolution is the
  square root of the target vertex count, since a surface mesh is a shell — is wrong by a
  shape-dependent factor: "decimate to 15%" gave 54% on a sphere. Counting occupied cells at a
  resolution is one pass over the vertices, and seven probes of that cost less than the clustering
  they size.
- **Switching distances are multiples of the object's own radius.** Forty metres is far away for a
  crate and close for a cathedral, so a number in metres would pop on one and never trigger on the
  other. With a floor of six metres, because an object that coarsens while you look straight at it
  is what makes people switch this off and never switch it back on.
- **One decimation per distinct mesh**, cached for the scene and freed with it. A hundred crates
  share one geometry and therefore one decimation.
- **Rigged characters keep every triangle.** Clustering merges vertices that may belong to different
  bones, and averaging weights across a joint gives an elbow that tears when it bends — far more
  noticeable at forty metres than the triangles saved. Refused in `canSimplify`, so there is no list
  of exceptions to keep in step elsewhere.
- **Per object, `never` is an escape hatch rather than a knob.** The decimator is bad at smooth
  silhouettes, and the one landmark it makes a mess of should not force the level back to `off`.

Measured in Chromium against `renderer.info.render.triangles` — the renderer's own count of what it
submitted — with six unbatched 1,598-triangle models in a row. From 220 metres, `balanced` submits
**less than half** the triangles those objects cost with it off; from 12 metres it submits _exactly_
the same number, byte for byte, which is the control that says the levels are not coarsening things
in your face. `aggressive` submits fewer than `balanced` from the same pose. The terrain is
subtracted from both sides, because it is a large mesh drawn identically either way and leaving it in
would hide a 66% saving on the objects behind a 32% saving overall.

**World chunks and a draw distance** (`packages/engine/src/streaming/ChunkGrid.ts`). The level is
divided into a uniform grid over X and Z, each object filed under the chunk containing its origin,
and chunks further from the camera than the draw distance are not drawn — one distance test per
chunk instead of one frustum test per mesh. Off by default: a draw distance is visible, so a scene
saved before this existed draws everything it always drew.

- **A grid, not an octree or a BVH**, which is what the task asked for. A game level is a shell on a
  plane: a few hundred metres wide and about twenty tall. An octree spends its first subdivision
  splitting a volume that is empty above and below, and every level after that rediscovers that the
  interesting axis is horizontal. A BVH is better for ray queries against irregular geometry and
  worse for the question actually being asked — "what is near this point" — which a uniform grid
  answers by arithmetic, with no tree to walk and nothing to rebalance.
- **Conservative at the boundary.** The distance test is widened by each chunk's half-diagonal plus
  the largest object radius in it, so nothing is culled while any part of it is still inside. A
  chunk's centre can be well outside the distance while its near corner is inside; culling on the
  centre alone is a building that vanishes as you walk towards it.
- **Measured horizontally.** Including the camera's height would cull the ground beneath a camera
  looking straight down at it, which is a camera mode this engine ships.
- **Recomputed on movement, not on time.** The answer is a function of camera position alone, so a
  still camera costs one distance compare per frame, and a step shorter than a quarter of a chunk
  cannot change any chunk's verdict.

**What the draw distance does not bound is memory**, and that gap is worth understanding before
anybody relies on the word "streaming". Placed objects are clones sharing one geometry and one
material per asset — that sharing is why two hundred trees cost one material — so unloading a
placement frees almost nothing. A level's memory ceiling is set by how many _distinct assets_ it
uses, not by how many objects it has. Lowering it means evicting assets, which cannot happen while
any placement still references them, which needs the placements unloaded first. That chain is real
work and is not done: the task asked for a budget that keeps a large world inside the tab's memory
ceiling, and what is delivered is the drawing half plus the statistics to see the other half.

**Instanced objects get neither levels of detail nor chunk culling.** An `InstancedMesh` draws one geometry many times,
so there is no per-copy level to swap — and the batching threshold is 8, which means the case where
level of detail would pay best is the case it does not cover. An `InstancedMesh` draws one geometry many times: there is no per-copy level to swap, and hiding one
instance by collapsing it to zero scale saves rasterisation but not vertex work, so a chunk of
hidden instances still submits every triangle. Both want the same fix — **a batch per chunk per
level**, rather than one batch per asset — which is a different structure and a separate piece of
work. Since batching starts at 8 copies, this is the case both features would pay best on. Recorded
here rather than left to be discovered from a triangle count that did not move.

## Boundary check

`packages/engine/src/boundaries.test.ts` is the Phase 2 wrap check, run as an ordinary test rather
than trusted to a lint config: the runtime imports nothing from React, r3f, Zustand, Immer, Dexie or
the editor, never reaches outside its own package, uses only dependencies its `package.json`
declares, and contains no `eval`, `new Function`, or string-bodied timers.
