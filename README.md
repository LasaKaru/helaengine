# HelaEngine

A low-poly game world builder: a browser editor that produces a scene document, a framework-free
runtime that renders it, and an exporter that hands the user a standalone, runnable project.

It is **not** an LLM that writes games. It is a schema-driven engine — the editor writes
`scene.json`, the runtime reads it, the exporter packages it, and the same runtime code runs in
both places, unmodified. Every architectural decision in this repo follows from that.

**Status:** Sprint 10 (Phase 2 — Physics). Everything from Phase 1, plus behaviours and a physics
world you can walk around in. Enemy AI is next; there is no backend yet, deliberately.

---

## Quick start

```bash
pnpm install
pnpm ingest-assets   # compress raw-assets/ -> generated/assets/
pnpm editor          # -> http://localhost:5174   the editor
pnpm demo            # -> http://localhost:5173   framework-free runtime harness
```

`ingest-assets` has to run first: the compressed GLBs, thumbnails and `manifest.json` are generated
output and are not committed. Both apps serve the same `generated/assets/` directory rather than
keeping private copies.

In the editor, drag an asset from the left rail onto the terrain to place it. A translucent ghost
follows the cursor and snaps to the surface under it; releasing off the terrain cancels rather than
guessing a position. Snap-to-grid, random rotation and align-to-surface are in the toolbar over the
viewport.

Click to select, shift-click to extend, drag on empty space to marquee-select. The gizmo moves,
rotates and scales the selection — **W/E/R** switch tools, Ctrl+D duplicates, Delete removes, and
`?` lists every shortcut. The inspector's numeric fields can be typed into or dragged to scrub.

The scene tree under the asset library nests objects: drag a row's grip onto another to parent it —
the object keeps its world position — and double-click or press F2 to rename. Ctrl+Z / Ctrl+Shift+Z
undo and redo up to 100 steps, with a whole gizmo drag counting as one.

Press **2** for the sculpt tool and **3** for paint (**1** returns to select). Sculpting raises,
lowers, smooths and flattens the ground; painting blends four terrain layers. A whole stroke is one
undo step. Height and paint data are stored in the scene document as base64 — about 33 KB at the
default 64×64 resolution — so a scene opens and exports without a second fetch.

Projects live in IndexedDB. The app opens on a projects screen with three starter templates; work
saves on Ctrl+S, on leaving the editor, and automatically 20 seconds after you stop editing. Every
project is validated against the schema on the way back in, so a document written by an older build
fails loudly at the boundary rather than halfway through a render.

`window.helaengine` in the browser console drives the editor directly, which is handy for scripting
a scene:

```js
helaengine.addObject('building_hut_01', [0, 0, 0], 25);
helaengine.assetIds();
helaengine.store.getState().scene;
```

Other commands:

```bash
pnpm lint             # includes the engine-isolation boundary rule
pnpm typecheck
pnpm test
pnpm build
pnpm e2e              # editor end-to-end suite (Playwright)
pnpm generate-assets  # regenerate the stand-in raw .glb sources
```

Requires Node 20+ and pnpm 10+. Thumbnail rendering needs a Chromium that Playwright can find; set
`CHROMIUM_PATH` to point at one, or `SKIP_THUMBNAILS=1` to skip that stage.

---

## Layout

```
packages/schema        The scene + asset schema, in Zod. The contract everything else agrees on.
packages/engine        Vanilla Three.js runtime. No React, no store, no DOM assumptions in the loader.
tools/asset-pipeline   Ingest: raw GLBs in, compressed GLBs + thumbnails + manifest out.
raw-assets/            Hand-authored .glb sources. The artefacts under version control.
apps/demo              Framework-free harness rendering a scene document. Proves the engine stands alone.
apps/editor            The editor: React + react-three-fiber shell around the engine.
apps/api               Empty until Sprint 16 (NestJS + Postgres).
docs/                  GUIDE, DEVELOPMENT-PLAN, SPRINT, ASSET-CONVENTIONS — the plan of record.
```

## The two rules that shape the codebase

**1. The engine never imports the editor.** `packages/engine` runs inside exported projects, where
React and Zustand do not exist. An import of either breaks every export, silently and late. This is
enforced by a lint rule, not by discipline — see the `packages/engine` block in `eslint.config.js`.

In the editor this shows up as `EngineBridge`: it reads the scene document from the store and calls
`SceneLoader.loadInto` on react-three-fiber's scene. It would be shorter to emit a `<mesh>` per
object and let React reconcile it — and that placement logic would then be unexportable, because the
exported project has no React. r3f owns the canvas and the loop; the engine owns everything about
what is in the world.

**2. Every editable property has a field in the schema.** No hidden state in a component, no
gameplay value that only exists at runtime. If the editor can change it, `scene.json` records it, or
it will not survive save/load or export.

## Scene documents

`packages/schema` is the single source of truth: Zod schemas generate the TypeScript types _and_ the
runtime validators, so the editor, engine, exporter and (later) the API all validate identically.

- Rotations are stored in **degrees**; the engine converts to radians exactly once, at instantiation.
- Objects reference an `assetId`, never a file path — that indirection is what lets assets be
  recompressed, re-versioned or relocated without rewriting saved scenes.
- Documents carry a `version`, and `migrateScene()` walks a registered migration chain before
  validating. The registry is empty today; it exists so the first real migration is an addition
  rather than a retrofit across saved user projects.

## Assets

Raw `.glb` files in `raw-assets/` are the source of truth; everything under
`apps/demo/public/assets/` is generated. `pnpm ingest-assets` dedupes and welds geometry, prunes
unused data, applies Draco compression, renders a thumbnail per asset in headless Chromium, and
writes `manifest.json`. It is idempotent — re-run it whenever sources or metadata change.

`docs/ASSET-CONVENTIONS.md` is the authoring contract: metre scale, +Y up, pivot at the base, flat
shading, per-category polygon budgets, and the `category_name_variant.glb` naming rule. The pipeline
enforces what it can (budgets, pivot drift, absurd scale) and warns about the rest. When an asset
looks wrong, fix the source file — never special-case it in engine code, because every exported
project inherits engine code.

The ten starter assets are **stand-ins generated in code** (`pnpm generate-assets`), not modelled
art. They exist so the pipeline has real GLBs to chew on; Sprint 25 replaces them with commissioned
assets, and nothing downstream has to change when it does.

Texture compression (KTX2/Basis) is wired but inert: it needs `toktx` from KHRONOS KTX-Software on
PATH, and the current assets are untextured. Ingest says so rather than skipping silently.

## Behaviours

Objects get gameplay from a **closed vocabulary** of behaviours. A scene document names a
registered `type` and carries plain `params`; that name is the only thing that selects code, and it
only ever selects from types registered ahead of time. Nothing in a document is interpreted — no
expression strings, no callbacks — which is what makes an exported project safe to hand to someone
else, and why the export story never needs a sandbox.

Each behaviour ships a Zod schema for its params, and the inspector builds its form from that
schema. Adding a behaviour to the engine gives it an editor UI for free; there is no per-type form
code to drift.

Press **P** to run the scene's behaviours in the viewport. The runtime moves the Three.js nodes and
never touches the document, so stopping restores everything and a preview can never become an edit.
It is the same `BehaviorRuntime` an exported project will run.

## Physics and Play Preview

Press **Shift + P**, or the **Walk** button, to drop into the world as a person: a Rapier physics
world is built from the scene, the sculpted terrain becomes a static heightfield, and a kinematic
character controller handles gravity, slopes and stepping over low ledges. WASD moves, Space jumps,
clicking captures the mouse to look around, and Escape returns to editing.

Colliders come from the asset manifest — a pine is a capsule, a hut is a box — so a scene has
sensible physics without anyone configuring anything. The inspector's Physics section overrides that
per placement when the default is wrong: a body type (static, dynamic, kinematic) and a collider
shape, with `auto` meaning "whatever the asset says".

Walking is a rehearsal, not an edit. The simulation moves Three.js nodes and never the document, so
leaving the mode puts everything back exactly where the document says it is.

Rapier is WebAssembly and loads asynchronously. That happens once at startup rather than being
checked for at every call site; until it finishes, the Walk button says so.

## Where this is going

`docs/SPRINT.md` is the working backlog, sprint by sprint. In short: editor MVP (Sprints 3–8),
behaviors/physics/AI (9–12), the export system (13–15), the cloud platform (16–20), enterprise
hardening (21–24), then content and beta (25–26).

## License

MIT. See `LICENSE`.
