# HelaEngine

A low-poly game world builder: a browser editor that produces a scene document, a framework-free
runtime that renders it, and an exporter that hands the user a standalone, runnable project.

It is **not** an LLM that writes games. It is a schema-driven engine — the editor writes
`scene.json`, the runtime reads it, the exporter packages it, and the same runtime code runs in
both places, unmodified. Every architectural decision in this repo follows from that.

**Status:** Sprint 21 — Phase 2B complete, export under way. A working editor, behaviours, physics, enemies, trigger
volumes, a measured performance baseline, first/third/top-down cameras with one input layer covering
keyboard, touch and gamepad, a schema-driven menu/HUD shell, and now combat: a weapon catalogue in
the document, hitscan firing, ammo and reloading, pickups, player damage and respawn — plus secrets
that hide areas, grant weapons or teleport the player, and checkpoints whose progress survives
closing the tab, and sound — state-driven music with a crossfade, effects bound to engine events,
a volume mixer, and a co-op multiplayer slice with a server-authoritative Colyseus service. The
**Skirmish** template is a playable level built from all of it, and **Export** produces a folder you
can unzip and serve.

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
pnpm generate-assets  # regenerate the stand-in raw .glb sources and .wav clips
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
apps/realtime          Colyseus co-op server. Runs the engine's own physics, in Node.
apps/api               Empty until Sprint 28 (NestJS + Postgres).
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

The ten starter models and ten starter audio clips are **stand-ins generated in code**
(`pnpm generate-assets`), not modelled art or sound design. They exist so the pipeline has real GLBs
and real waveforms to chew on; Sprint 37 replaces them with commissioned assets, and nothing
downstream has to change when it does, because everything refers to them by `assetId`.

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
character controller handles gravity, slopes and stepping over low ledges. WASD moves, **Shift**
sprints, **C** crouches, Space jumps, **V** switches camera, clicking captures the mouse to look
around, and Escape returns to editing.

### Cameras and input

Three rigs — first person, third person, top-down — chosen by the document's `gameConfig` and
switchable at runtime unless the author turns that off. The first-person head bob is driven by
distance travelled rather than by elapsed time, so it slows when you do and stops in mid-air. The
third-person arm pulls in the instant something gets between the camera and the character, and eases
back out when the way clears.

Every source of input goes through one `InputManager` and comes out as one abstract action set, so
nothing downstream ever asks "was W pressed" — it asks whether the player wants to move forward.
Keyboard, mouse, the Gamepad API and an on-screen joystick for touch devices are four ways of
answering that, and the engine builds the touch overlay itself in plain DOM, because an exported
game on a phone has no React to build it with.

Crouching really shrinks the physics capsule rather than only lowering the camera, and standing up
is refused when there is no headroom — otherwise a player could stand up inside a ceiling and be
ejected through it.

Colliders come from the asset manifest — a pine is a capsule, a hut is a box — so a scene has
sensible physics without anyone configuring anything. The inspector's Physics section overrides that
per placement when the default is wrong: a body type (static, dynamic, kinematic) and a collider
shape, with `auto` meaning "whatever the asset says".

Walking is a rehearsal, not an edit. The simulation moves Three.js nodes and never the document, so
leaving the mode puts everything back exactly where the document says it is.

Rapier is WebAssembly and loads asynchronously. That happens once at startup rather than being
checked for at every call site; until it finishes, the Walk button says so.

## Enemies and triggers

`chaseOnSight` gives an object a small state machine — idle, patrol, chase, attack, dead. It checks
range, then field of view, then line of sight with a physics raycast, throttled to about seven
checks a second so a scene full of enemies does not become a scene full of raycasts. Yuka drives the
steering; the result is applied to the object's Rapier body rather than straight to its transform,
so an enemy is stopped by the same walls the player is.

Attach `patrol` and `chaseOnSight` to the same object and it walks its route until it spots you.
That works because moving is a **claim**: the highest-priority behaviour holding an object's
movement gets to write its transform, and everyone else does nothing. Two behaviours fighting over
one transform is the oldest bug in component systems, and it is worth a few lines to make it
impossible rather than a convention nobody remembers.

Trigger volumes are placed like props, from the **Logic** category. A volume is sized by the ordinary
scale gizmo — there is no second size field, because there should not be two answers to how big it
is — and it runs a list of actions on enter, on exit, or when a named event reaches the bus. Actions
are a closed set (`emit`, `spawn`, `destroy`) for the same reason behaviours are: an exported
project must never run something its author did not put in the document.

## Performance

`docs/PERFORMANCE.md` holds the acceptance bar and the last measurement. The short version: repeated
static props are batched into instanced meshes, which takes the 520-object stress scene from **530
draw calls to 57**, and the whole simulation — 520 colliders, twenty AI state machines, a character
controller — costs about **2 ms of CPU per frame**.

There is a benchmark for it, and it is meant to be re-run:

```bash
pnpm build && pnpm --filter @helaengine/editor preview &
pnpm bench
```

Draw calls and CPU cost are the numbers to hold to account, because they are the same on every
machine. Frame rate is not, and the document is explicit about what has and has not been verified.

## The game shell

Pressing Walk no longer drops you straight into the world — it opens the game's **home screen**,
built from the document's `uiConfig` by a `UIRenderer` that stands in the same relation to that
config as `SceneLoader` does to the scene. Data in, interface out, no per-project code. Home → menu
→ play → pause → resume is a complete loop, and Escape pauses rather than quitting.

DOM and CSS rather than meshes in the 3D scene: text quality, accessibility and the ability to
restyle a whole menu with one custom property all argue for it. Menu buttons name an action from a
**closed vocabulary** — `startGame`, `resume`, `restartCheckpoint`, `openSettings`, `mainMenu`,
`quit` — for the same reason behaviours and trigger actions do.

Four themes ship (midnight, parchment, neon, mono) with three panel styles. Swapping one restyles
every surface at once, because a theme that needed each button updating is a stylesheet with extra
steps.

All of it is editable from the **Game UI** panel without touching JSON: title, subtitle, play-button
text, a home-screen background and intro video you upload from your machine, both menus' buttons
(rename, reorder, reassign, add, remove), HUD toggles, and custom HUD elements anchored to a corner
with an optional binding to health, ammo, score or the play clock. Uploads live in the browser
alongside your projects — there is no server yet, and a home screen should work before anyone has
signed in.

## Combat

Weapons live in the document as a **catalogue** — `inventory.weapons` — and objects grant them by id.
A pistol is described once and the nine crates that give you one all point at the same description,
so a rebalance is one edit rather than a search. Firing is hitscan: a ray with a range, a damage
number and an optional spread cone. That is the shape almost every low-poly shooter actually needs,
it costs one query per shot, and it is exactly reproducible in an export.

A shot that lands leaves as a `damage` event carrying a `targetId` — the same message an enemy
already answers to, and the same one a trigger can raise. Nothing in the weapon system imports an
enemy behaviour, so a weapon hurts anything that listens, including things it has never heard of.
It takes its ray cast as a callback rather than a physics world, which keeps combat testable without
WebAssembly and keeps physics ignorant of weapons.

The **Pickup** behaviour is the interesting one. It *asks* the world to take the item and does what
the answer says: a medkit at full health, or an ammo box for a gun you are not carrying, refuses and
the pickup stays exactly where it is. Swallowing an item and giving nothing is the single most
annoying bug this kind of behaviour has. Pickups can respawn on a timer, in which case they hide
rather than being destroyed and rebuilt.

Death is recoverable. Damage respects a cooldown — without it two enemies swinging in the same frame
do double damage and a crowd kills you in a way that reads as a bug — and running out of health
respawns you at the spawn point after a delay. Sprint 18 points that at the last checkpoint instead;
nothing about its shape changes.

The **Skirmish** template is all of it in one level: a pistol on a crate, ammo, a medkit, and two
goblins that fight back.

## Secrets

`unlockables` is a list of "when this happens, do that". A secret is found by a **button sequence**
(Konami-style, enterable on a keyboard or a gamepad), by **entering a trigger volume**, by **any
named event** on the bus, or by **collecting a number of pickups**. Finding one can teleport the
player, grant a weapon, reveal hidden objects, or raise an event.

Both halves are a Zod discriminated union, and that union *is* the closed vocabulary — the same
guarantee behaviours and trigger actions get, obtained at both ends at once. A document naming a
method the engine has never heard of is rejected when it is parsed, and a runtime that failed to
handle one of the arms would not compile. There is no expression to evaluate and no snippet to run,
which matters most for exactly the feature whose whole appeal is being sneaky.

Hidden objects start hidden *because* something reveals them: the runtime hides everything a
`revealArea` names at startup rather than asking the author to keep a second flag in sync. Hiding
takes the collider with it, so a secret area is not an invisible wall.

The **Secrets** panel builds both its pickers from the schema, so it can offer exactly what the
runtime can do and nothing else.

## Checkpoints and saved progress

A checkpoint is a `checkpoint` behaviour with a radius — the same shape as a pickup, because they
are the same gesture. Reaching one makes it the place death sends you, and each one says what coming
back restores: full, partial or no health, and whether the ammo comes back with it. Per checkpoint
rather than per game, because the two ends of a level want different answers.

Reaching a checkpoint writes a save, keyed by scene id. Saving on the checkpoint rather than on a
timer is the point: a checkpoint *is* the author saying this moment is worth keeping.

A save holds **state, never structure** — health, weapons, which checkpoint, which secrets. Nothing
in one names an object, an asset or a behaviour, so no save can change what a scene contains. And it
is validated on the way *in*: `localStorage` is a text field the player can edit, so a save that
fails to parse is discarded and the run starts fresh, and counts are clamped to each weapon's own
ceilings so a hand-edited save cannot mint ammo.

The editor's **Progress** panel reports what is saved and throws it away, because testing a level
that keeps resuming from halfway through it is worse than a level with no checkpoints at all.

## Sound

Music has three states — menu, exploring, and a fight — and crossfades between them. A scene that
only supplies one track simply never crossfades; one that has no combat track falls silent for a
fight rather than carrying exploration music through it. Leaving combat waits out a **hold**,
because without one the track flickers every time an enemy blinks.

Sound effects are bound to **event names**, not to a fixed list of occasions. Behaviours already
raise `pickup`, `checkpoint` and `enemyDied`; a scene binds a name to a clip and that is the entire
integration — no gameplay code anywhere knows that any of it makes a noise. A binding can be
positional, in which case the sound plays at the object whose id the event carried.

`pnpm ingest-assets` now has an audio step: it decodes WAV, measures RMS and peak in dBFS, and
levels each clip towards a target with the gain capped so a spiky sample is quieted rather than
clipped. It does **not** transcode — that needs ffmpeg, which is not part of this toolchain — so
what it publishes is levelled WAV, and it says so rather than implying a web-optimised codec.

The settings menu has master, music and effects sliders. Those are the *player's*, stored on their
machine and not in `scene.json`: how loud somebody likes their music is a property of that person,
and putting it in the document would carry one player's preference to everyone the project reaches.
The author's own defaults live in the scene, and the two multiply.

## Co-op multiplayer

`apps/realtime` is a Colyseus server, and its own deployable service rather than a route on the API
— it holds thousands of open sockets and runs a fixed physics tick, while an API answers short
bursty requests. They scale on different axes and fail in different ways.

It runs **the engine's own physics, in Node**. `PhysicsWorld`, `PlayerController` and `SceneLoader`
— the same classes that draw the editor's preview — build and step with no browser and no DOM. That
is the engine-isolation rule checked somewhere it cannot be faked, and it means geometry the client
can see is geometry the server enforces.

A client sends **intent only**: there is no "set position" message, so authority is the shape of the
protocol rather than a rule the server applies. Inputs are clamped and out-of-order packets dropped.
Remote players are interpolated towards wherever the server last said they were — never predicted,
because a received position is a fact and a predicted one is a guess.

**Scope, stated rather than implied.** This is co-op: shared world, shared enemies, everyone sees
everyone move. It is not competitive netcode. There is no client-side prediction, no rollback and no
lag compensation on shots, so a player with 150 ms of latency sees themselves move 150 ms late. For
two friends exploring a level that is unremarkable; for a deathmatch it would be unplayable, which
is why `mode: 'deathmatch'` exists in the schema and is refused by the runtime rather than silently
treated as co-op.

`colyseus.js` lives in the editor, behind an interface the engine defines. A networking dependency
inside `packages/engine` would put a socket client in the bundle of every single-player game anybody
ever makes.

```bash
pnpm --filter @helaengine/realtime start   # ws://localhost:2567
```

## Export

**Export** in the top bar writes a zip you can unzip, serve and open. Inside: `index.html`, a
thirty-line `main.js` that is yours to change, `scene.json`, the assets this scene actually uses —
not the whole library — and `engine/runtime.js`, the engine with Three.js bundled in as one file
with no dependencies.

That last file is why `packages/engine` has two builds. The editor and the co-op server import
`index.js` with `three` left external, so there is one copy of Three in any app that also uses it
directly. An export gets `runtime.js` with everything inlined, because a folder somebody unzips has
no package manager, no bundler and no import map — every dependency has to already be in the file.

Paths inside an export are relative throughout, which is checked by extracting the archive, serving
it over HTTP and opening it rather than by reading the code. Browsers refuse ES modules over
`file://`, so the README inside each export says to run `npx serve .` and why.

Today this is a **static** export: it renders the world. Behaviours, physics, menus and sound are
not started — the same `runtime.js` contains all of it, and Sprint 22 is what turns the export from
a scene into a game.

## Where this is going

`docs/SPRINT.md` is the working backlog, sprint by sprint. In short: editor MVP (Sprints 3–8),
behaviours/physics/AI (9–12), **the gameplay runtime — menus, HUD, combat, checkpoints, audio,
co-op (13–20)**, the export system (21–23), **pre-delivery validation and hosted play (24–27)**,
the cloud platform (28–32), enterprise hardening (33–36), then content and beta (37–38).

The two bolded phases were added after Sprint 12 and pushed everything after them back by twelve
sprints. `docs/GAMEPLAY-RUNTIME-AND-QA-PLAN.md` has the reasoning: exporting a world you can walk
around, with no menu, no HUD, no way to win or lose and no sound, is shipping a viewer rather than
a game.

## License

MIT. See `LICENSE`.
