# Rigged characters and animation

Characters used to be statues that slid. This is how they walk.

---

## The one idea

**A scene names states, not clips.**

An object says "my `run` state is the clip called `Gallop`". Nothing in a scene document ever says
"play clip 3" or "advance to frame 40". Three things follow, and they are the reason for the extra
step:

- **The engine drives the animation, not the author.** The enemy AI already has an
  `idle | patrol | chase | attack | dead` state machine; the player controller already knows whether
  it is walking. Those map onto animation states, so a rigged enemy animates correctly the moment it
  is given a model — with no per-object scripting.
- **Models are interchangeable.** No two rigs agree on clip names. Mixamo says `Running`,
  Quaternius says `Run`, the Khronos fox says `Gallop`. The binding lives on the object, so swapping
  a character is a change in one place.
- **It stays data.** A state from a fixed list, and a clip name that is looked up rather than
  executed — the same property every other part of the scene schema has, and the one the release
  gate depends on.

The six states, and how each behaves:

| State    | Playback                                    | Driven by                  |
| -------- | ------------------------------------------- | -------------------------- |
| `idle`   | loops                                       | AI idling, player standing |
| `walk`   | loops                                       | AI patrolling              |
| `run`    | loops                                       | AI chasing                 |
| `attack` | **loops**                                   | AI in attack range         |
| `hit`    | plays over the top, then hands back         | taking damage              |
| `die`    | plays once, holds the last frame, permanent | health reaching zero       |

`attack` loops rather than firing once because the AI _stays_ in its attack state while it keeps
swinging — a one-shot would play a single blow and then freeze mid-swing while the enemy carried on
hitting. `hit` is the opposite: an enemy shot while running is still running, and has to still be
running when the flinch ends.

---

## Using it

1. **Import a rigged model.** Any glTF or GLB with a skeleton and animation clips. `pnpm
ingest-assets` records the clip names and whether the model is skinned.
2. **Select the object** and tick **Animate this object** in the Animation panel.
3. The clip for each state is **guessed** from its name — `Idle`, `Walking`, `Running`, `Punching`,
   `Hit Reaction`, `Death` all match — and every guess is a dropdown you can change. A model whose
   clips are called `Take 001` gets an idle and nothing else, which is the honest answer.
4. Attach **Chase on sight** and the AI drives the states for you.

**A state with no clip is skipped, not obeyed.** A model with only `idle` and `walk` keeps walking
when the AI starts an attack rather than snapping to a rest pose. Half-rigged models are the normal
case in a low-poly library, and continuing to move is the graceful failure.

### Mixamo characters

[Mixamo](https://www.mixamo.com) is the fastest way to get a rigged, animated humanoid, and the
guesser is tuned for its naming. Its download formats are FBX and Collada — neither of which this
engine loads — so the conversion step is real:

1. Pick a character, then add the animations you want to it (Idle, Walking, Running, Punching, Hit
   Reaction, Death is a good set).
2. Download each as **FBX Binary**, _without_ skin for the extra animations and _with_ skin for the
   first.
3. Convert to glTF. Blender does it: File → Import → FBX, then File → Export → glTF 2.0. Combining
   several clips onto one rig is a Blender step — export them as separate actions with **Group by
   NLA Track** on, and each becomes a named glTF animation.
4. **Import it.** Either drop the `.glb` on the editor's **Import models** panel — no account, no
   pipeline run, and the clip names appear in the dropdowns immediately — or, to add it to the
   shipped library, put it in `raw-assets/`, add an entry to `asset-metadata.json` and run
   `pnpm ingest-assets`. See [`IMPORTING-MODELS.md`](IMPORTING-MODELS.md).

**Check the licence for your use.** Mixamo's terms are permissive for use in projects, and they are
Adobe's to change; read them rather than taking this sentence as advice.

**Scale is the thing that goes wrong.** Mixamo characters are authored in centimetres, so a
character arrives 175 units tall. The import panel spots this and says so; set the object's scale
to 0.01, or `defaultScale` to `[0.01, 0.01, 0.01]` in the metadata if you are adding it to the
shipped library, exactly as `enemy_fox` does. Otherwise the first thing you place is a skyscraper.

---

## What the engine does with it

### Clips are kept at load

`GltfModelSource` used to return `gltf.scene` and drop `gltf.animations` — so every animation in
every model was thrown away before anything could use it. Clips are now parked on the shared model
and read per placement. They are immutable, so sharing them is safe.

### Skinned models are cloned differently

`Object3D.clone(true)` copies the graph but **shares the `Skeleton`**. Place three enemies with a
plain clone and all three are driven by one set of bones: they play whatever the last one was told
to play, usually in the wrong place. `SkeletonUtils.clone` rebuilds the bone graph and re-binds each
mesh.

It is not used unconditionally, because it costs materially more than a plain clone and most of an
asset library is rocks. Whether an asset is skinned is **recorded in the manifest at ingest**, not
detected per placement — the loader needs the answer before it builds the object, and traversing a
model to find out repeats work for something that cannot change.

### Rigged objects are never instanced

An `InstancedMesh` draws one geometry many times with per-instance matrices. A skinned mesh's pose
lives in bone matrices the batch cannot vary, so instancing a rigged asset renders every copy in the
same pose — and does so silently, because it still draws. Animated objects are excluded from
batching. Nothing is lost: there are ten of a character, not two hundred.

### Animations tick in the frame loop

In `Viewport`, after the frame callbacks and before the render. That placement is the design:

- **After the callbacks**, because the game runtime is a callback. An animator plays the state it
  was last told about, so ticking first would show every character one frame behind its own
  behaviour.
- **In the viewport rather than the game runtime**, because it is the only loop all three cases
  share. A static export has no game runtime, and neither does the editor's viewport — so a torch or
  a windmill would stand still while you built the level around it, and stand still in the export
  too. Ticking in both places instead would run every clip at double speed in a game export, which
  is a bug that gets blamed on the model.

---

## What was verified

Against the Khronos Fox — a real Draco-compressed, skinned glTF, in a real browser:

|                               |                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Clips survive compression** | `Survey`, `Walk`, `Run` present after `dedup`, `prune`, `weld` and Draco, with their original durations.                                                     |
| **The rig actually moves**    | 59 of 168 bone channels changed over one second of the run cycle, across 24 bones.                                                                           |
| **It moves on screen**        | 18,887 pixels differ between two rendered frames half a second apart. Nothing weaker than this distinguishes "animating" from "loaded, rendered and frozen". |
| **Clones are independent**    | Two instances have different `Skeleton` objects, and ticking one leaves the other untouched — the lockstep bug, absent.                                      |
| **The manifest is measured**  | `animations: ["Survey","Walk","Run"]`, `skinned: true`, written by the pipeline from the source file.                                                        |

Plus 13 unit tests on the `Animator` and the clone, and 7 on the clip-name guesser. The two that
matter most are negative: deleting the containment on `die` lets a corpse stand up, and passing
`skinned: false` for a rigged model reproduces the shared-skeleton bug on purpose, so the manifest
field's necessity is pinned rather than asserted.

**Not verified:** nothing has been run against a real Mixamo character, because that needs an Adobe
account. The clip-name guesser is tested against Mixamo's naming, and the pipeline is tested against
a real skinned glTF, but the FBX-to-glTF conversion step above is written from documentation rather
than from having done it here.

---

## Still missing

- **Root motion.** A run cycle moves the legs; the character is moved by its behaviour. A clip that
  translates the root will fight the AI's steering.
- **Blend trees.** Crossfading between two clips is all there is. No blending a walk and a run by
  speed, no additive layers, no partial-body masks.
- **Player animation.** The states exist and the AI drives them; the player controller does not yet.
  A third-person player is a statue that slides, exactly as every character was before this.
- **IK.** No foot placement on slopes, no look-at.
- **An animation preview in the editor.** The panel binds clips; it does not play them on the asset
  card.
