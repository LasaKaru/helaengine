# Becoming a general-purpose engine

A roadmap from what HelaEngine is — a level editor for low-poly first-person games, with a
verified export pipeline — toward what people mean when they say "like Unity".

It is organised around one question that has to be answered before any feature list matters, then a
ranked plan, then an explicit list of things not to build.

**Nothing here breaks what exists.** The last section says how that is enforced rather than
promised.

---

## 1. The question that decides everything else

**Unity's power is arbitrary C#. HelaEngine's architecture forbids arbitrary code.**

That is not an oversight to be corrected. It is the load-bearing decision, and four things rest
directly on it:

- **The pre-delivery gate.** Every export is played by a robot before a human may download it. That
  is possible because a scene is _data_ interpreted by a known set of behaviours. A scene that could
  contain a script is a scene whose behaviour cannot be predicted, and the gate degrades from "this
  build works" to "this build did not crash in the ninety seconds we watched".
- **Real-time collaboration.** Two people editing one document is safe because the document is data.
  If a scene could carry code, opening a shared project would be executing a collaborator's code in
  your browser.
- **The validation-repair loop.** A model proposes schema-validated patches from a closed
  vocabulary. If patches could carry code, that is a model writing executable code into somebody
  else's game.
- **Exports are safe to host.** A `.hela` file somebody downloads from a forum is a document, not a
  program.

There is a lint rule failing the build on `eval` or `new Function`, and `docs/SECURITY.md` states the
guarantee. **Adding a scripting language would trade the single genuine differentiator for a worse
copy of an engine that already exists.**

### The resolution: graphs, not scripts

The expressiveness gap is real, and it is closable without giving it up. A **node graph that compiles
to a validated data structure** — the Unreal Blueprints model, not the Unity C# model — buys most of
the flexibility while keeping every property above.

A graph is data: nodes from a closed vocabulary, typed ports, edges. It is diffable, mergeable by the
CRDT, patchable by the repair loop, and statically checkable before it ever runs. The runtime
interprets it exactly the way it interprets a behaviour today. There is no `eval` anywhere in it.

What it enables that behaviours cannot: "when the player picks up the key **and** the boss is dead,
open the gate, play a sound, and start a timer that fails the level after 60 seconds." Today that
needs a new behaviour written in TypeScript. With a graph it is a level designer's afternoon.

**This is the highest-leverage single feature on the list**, and it is where "like Unity" should be
aimed. Item 2.3 below.

### Where real code still belongs

Two tiers, and keeping them apart is the whole trick:

| Tier        | Who                                   | What they write                            | How it ships                                             |
| ----------- | ------------------------------------- | ------------------------------------------ | -------------------------------------------------------- |
| **Engine**  | HelaEngine developers, plugin authors | TypeScript behaviours, node types, systems | Compiled into `packages/engine`, reviewed, in the bundle |
| **Content** | Everybody making a game               | Scenes, graphs, prefabs — data only        | Validated documents                                      |

A behaviour SDK — "publish a node pack" — is a good thing to build. It is a _build-time_ extension
of the runtime, reviewed like any dependency, not a script a scene downloads. Item 2.12.

---

## 2. The plan, ranked by how many games it unblocks

Not by Unity feature parity. Ordered so each phase is shippable on its own and the one before it
makes the next easier.

### Phase 1 — Make characters move (the largest single gap)

**2.1 Skeletal animation.** _The most important item on this page._

Every character in every HelaEngine game is currently a statue that slides. An enemy that chases you
without a walk cycle reads as broken to a player before they can name why. No amount of lighting,
scripting or tooling compensates for it, and nothing else on this list is as visible.

- glTF skinned meshes and animation clips through the existing asset pipeline (`three` already
  imports them; `AnimationMixer` already exists)
- An animation state machine in the schema — a closed vocabulary of states and transitions, driven by
  the same conditions triggers already use. `packages/engine/src/ai/StateMachine.ts` is the shape to
  follow
- Blending between clips, root motion optional
- Editor: a preview scrubber on the asset card

**Blocked on content, not code.** No CC0 pack sourced so far ships animated characters —
`docs/SPRINT.md` records this. Options, in order of cost: Mixamo (free, requires an Adobe account,
licence needs reading); Quaternius (CC0, has animated characters); commissioning a small set. **This
is a sourcing decision to make before the engineering starts**, because the schema should be shaped
by real clips.

**2.2 A character controller worth the name.** Slopes, steps, crouch clearance, ledge handling,
push-out. The Rapier controller exists; the polish is what separates "walks" from "feels right".

### Phase 2 — Make it expressive

**2.3 The node graph.** As argued in §1. Suggested slice for a first version:

- Events: on start, on trigger enter/exit, on damage, on pickup, on death, on timer
- Conditions: comparisons, boolean logic, inventory contains, flag set
- Actions: everything a trigger can do today, plus set flag, spawn, despawn, play sound, move to,
  show HUD message
- Variables: scene-scoped and object-scoped, typed
- Editor: a canvas with typed ports that refuse invalid connections

The schema is the deliverable, not the canvas. A graph that validates is a graph the repair loop and
the smoke gate already understand.

**2.4 Prefabs.** An object with children, behaviours and overrides, saved once and placed many times;
editing the prefab updates every instance. This is the feature that makes a large level buildable by
one person, and its absence is felt from about the two-hundredth object onward.

Nested prefabs and per-instance overrides are where this gets genuinely hard — that is the part to
design carefully rather than discover.

**2.5 Multiple scenes and level transitions.** A game is currently one level. Doors between levels,
persistent player state across them, a hub. Mostly schema work; the runtime already has save state.

### Phase 3 — Make it look better

**2.6 Baked lighting.** Real-time shadows from one directional light is the current ceiling.
Lightmaps baked in the editor and shipped as textures would transform how a scene looks at no runtime
cost — which matters more here than anywhere else, because the target is a browser.

**2.7 A post-processing stack.** Bloom, ambient occlusion, colour grading, anti-aliasing, as a closed
vocabulary of effects with typed parameters. `postprocessing` is the obvious library. Cheap to build,
large visual return, and directly relevant to the export visual regression currently open in
`docs/SPRINT.md`.

**2.8 A material system.** Objects currently take the material inside their model. Authored
materials — colour, roughness, metalness, emissive, a texture slot — placed in the schema and
reusable across objects.

**2.9 Level of detail and occlusion culling.** Instancing exists and works. LOD and culling are what
let a scene get ten times bigger, and they are what the stress-test template is for.

### Phase 4 — Reach and ecosystem

**2.10 Desktop builds.** **Done** — see `docs/DESKTOP-EXPORT.md`. Next: an installer (MSI or NSIS),
code signing, auto-update, and a Steam depot layout.

**2.11 Mobile.** The runtime already runs in a mobile browser; what it lacks is touch controls and a
performance budget for a phone GPU. A Capacitor wrapper reaches the app stores with the same
"wrap the export unchanged" trick the desktop target uses.

**2.12 A behaviour and node-pack SDK.** The tier-1 extension path from §1. A published package, a
registry entry, review before listing.

**2.13 An asset marketplace.** Only worth building when there are creators to fill it. The licence
and attribution machinery it needs — per-asset licence, author, origin, enforced by a test — already
exists (Sprint 37).

---

## 3. What not to build

Each of these looks like Unity parity and is a trap for a browser engine with a small team.

- **A scripting language.** §1. This is the important one.
- **A general-purpose renderer.** Deferred rendering, real-time GI, virtualised geometry. The target
  is low-poly in a browser; competing with a native renderer means losing slowly.
- **A visual shader graph.** Enormous surface, and the aesthetic this engine serves needs perhaps
  six materials. Authored materials (2.8) cover it.
- **Consoles.** Devkits, certification, NDAs. Not a feature — a business.
- **An ECS rewrite.** Tempting when object counts grow. The scene format is the public contract, not
  the internal representation; optimise inside `SceneLoader` when a profile says to, and leave the
  documents alone.
- **A second renderer** (WebGPU alongside WebGL). Two renderers means every visual bug exists twice
  and the export gate has to test both. Migrate when WebGPU support is universal; do not straddle.

---

## 4. How none of this breaks what exists

The constraint is "existing things must work". It is enforceable rather than merely intended,
because the mechanisms are already in place:

**Scene documents are versioned and migrated.** `packages/schema/src/migrations.ts` holds a registry
keyed by the version being migrated _from_, deliberately built empty at commit #1 so the first real
migration is a one-line addition rather than a retrofit across saved projects. Every feature above
that changes the document adds a migration and a test that an old document still loads.

**Every new field is optional with a default.** A scene saved today must parse against tomorrow's
schema unchanged. Zod defaults make this the path of least resistance, and the round-trip tests in
`scene.test.ts` make a violation fail.

**The engine boundary is lint-enforced.** `/packages/engine` may not import UI or editor code — the
rule is in `eslint.config.js` and it is why exports work at all. Every item above respects it or
fails CI.

**The release gate protects exports.** Five starter worlds plus three deliberately broken ones are
played on every change to the engine, exporter, schema or templates. A change that breaks exports
cannot merge quietly; that is what `tools/smoke` is for.

**The desktop target adds nothing to the runtime.** It copies an export in unchanged. That is the
pattern for every future platform: wrap the artefact, never fork it.

**Additive, behind a default.** A scene with no graph, no prefabs and no animation is exactly the
scene it is today, and the runtime paths it takes are the ones it takes today.

---

## 5. If only three things get done

1. **Skeletal animation** (2.1). Sourcing decision first, then the schema.
2. **The node graph** (2.3). The differentiator, extended rather than abandoned.
3. **Prefabs** (2.4). What makes a large level survivable.

Those three change what can be built with the engine. Everything else on this page changes how
nicely it can be built — which matters, but only afterwards.
