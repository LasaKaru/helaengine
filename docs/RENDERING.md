# Lighting, materials and image effects

Everything under **Rendering** in the inspector, plus the per-object **Material** override.

All of it is off or neutral by default. A scene saved before any of this existed parses with these
defaults and looks exactly as it did — that is a requirement, not a coincidence, and there is a test
for it.

---

## Lighting

|                         |                                                                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Sun**                 | Colour, intensity, elevation and compass direction. One directional light; it also casts the shadows.                                                                                                                                      |
| **Ambient**             | A flat fill from every direction. Now has a **colour** as well as an intensity — a cool blue fill against a warm sun is most of what makes a low-poly scene look lit rather than flat.                                                     |
| **Sky and ground fill** | A hemisphere light: sky colour on upward faces, ground colour on downward ones. The cheapest approximation of bounced light there is, and at low-poly densities it does more for a scene than any amount of shadow tuning. Off by default. |

`ambientColor` sits _beside_ `ambient` rather than replacing it, because `ambient` is a number in
every scene saved so far and turning it into an object would break all of them.

## Shadows

Four steps rather than a pixel count, because the meaningful choice is a trade rather than a value:

| Quality | Shadow map                                            |
| ------- | ----------------------------------------------------- |
| Off     | none                                                  |
| Low     | 1024px                                                |
| Medium  | 2048px (the default, and what the engine always used) |
| High    | 4096px                                                |

**Off is a real option.** Shadows are the single most expensive thing in this renderer, and a
flat-lit stylised scene reads as deliberate rather than broken.

**Shadow distance** is the width of the box shadows are drawn in. The whole map is stretched over
it, so doubling the distance halves the detail everywhere. A large level does not want a large
number here.

**Bias** is the only fix for shadow acne — the stippled self-shadowing that appears on gently sloped
ground. Too much and shadows detach from their objects, which is why the range is small.

## Tone mapping and exposure

`none` clips anything brighter than white, which is what the engine did before this existed and what
a flat, stylised look wants. `aces` is the filmic curve most engines default to. Exposure only
applies when tone mapping is on.

Applied on the renderer, not as a pass: Three does tone mapping while shading a material, and doing
it afterwards would work on colours that had already been clipped — which is the thing tone mapping
exists to avoid.

## Image effects

Three, each with typed parameters:

- **Bloom** — threshold, strength, radius. Above the threshold, things glow.
- **Vignette** — strength and offset. Darkens the corners.
- **Colour grade** — brightness, contrast, saturation and a tint.

**With all three off, nothing is composed at all.** No render target, no full-screen passes, no
memory for either — the renderer draws straight to the canvas exactly as it always has. Ticking
"Image effects" without enabling one of them changes nothing, deliberately: somebody who has not
asked for bloom should not pay for the machinery that would deliver it. There is a test asserting
this, because a test that read the document would call it a bug.

### Why the effects are a fixed list

The same reason every vocabulary here is closed. A scene document that could carry a shader is a
scene that can hang a GPU driver in a collaborator's browser, and one the pre-delivery gate would
have to guess about. So the grading pass is a _fixed_ shader with validated uniforms — which is what
colour grading amounts to in practice, and which can be checked before it runs.

Built on Three's own passes rather than the `postprocessing` library. That is a size decision:
`three/examples` is already in the bundle, and the library would add another hundred kilobytes to
every exported game for effects most of them turn off. **The stack as built costs 28 KB** on the
engine runtime (1.05 → 1.08 MB), whether or not a scene uses it.

---

## Material overrides

Per object, in the inspector. Colour, roughness, metalness, emissive colour and intensity, opacity,
wireframe, and double-sided.

**Overrides rather than replaces.** Every field is optional, and an absent one keeps whatever the
model shipped with — so recolouring a crate does not also flatten its roughness.

**Per instance, not per asset.** One crate painted red does not repaint every other crate placed
from the same asset. That is the whole point, and it is also the hard part: a model is loaded once
and cloned per placement, so its materials are _shared_ across every copy — deliberately, since that
is why two hundred trees cost one material. Writing a colour onto the material found on a clone
repaints the level. So an override clones first, one clone per source material rather than one per
mesh, and the clones are freed when the object is deleted.

Two conveniences worth knowing:

- **Opacity switches transparency on for you.** Setting opacity on an opaque material does nothing
  at all, and is the commonest "why is this not working" in any engine that exposes the two
  separately. At full opacity it stays opaque, because a transparent material is sorted every frame.
- **Double-sided** is the fix for a model that vanishes when you walk into it — a room built from an
  inverted box, a skydome, a cave.

**An overridden object is never batched.** An `InstancedMesh` draws one geometry with one material,
so a batch cannot give two copies different colours; batching an overridden object would apply the
template's colour to all of them, silently, because it still draws.

---

## Surfaces

A wall in this engine is a box with about twelve triangles. Lighting it well makes it a
_convincingly lit_ box — the thing that separates a wall from a slab is that a wall has bricks in it,
and bricks are a surface property rather than a shape.

A **surface** is a set of PBR maps applied to one placed object: a normal map, a roughness and
metalness map, and an ambient-occlusion map. It sits inside the material override, and the vocabulary
is closed like every other one here:

| Kind         | What it is                                                               |
| ------------ | ------------------------------------------------------------------------ |
| **Brick**    | Running bond with recessed mortar. Walls, chimneys, the base of a house. |
| **Tile**     | A square grid with grouted joints. Floors, bathrooms, plazas.            |
| **Planks**   | Long boards with grain and gaps between them. Decking, crates, fences.   |
| **Stone**    | Irregular blocks with deep joints. Castle walls, cliffs, foundations.    |
| **Plaster**  | Fine render with a gentle unevenness. Interiors, rendered exteriors.     |
| **Concrete** | Coarse and pitted. Bunkers, kerbs, industrial floors.                    |
| **Metal**    | Brushed and reflective. Machinery, containers, anything meant to shine.  |

Three settings: **size** (fine, normal, coarse), **depth** — how deeply the pattern appears cut in,
and zero is genuinely flat — and **shadowing**, how dark the creases go.

The colour still comes from the model, or from the colour row above. A surface changes how light
comes off an object, not what colour it is.

### The maps are generated, not shipped

Nothing is downloaded and nothing is added to an export. The maps are a few hundred lines of
arithmetic run when a level loads, from a hashed noise function with no `Math.random` anywhere — so
the same kind produces identical bytes on every machine, and an export looks like the editor preview
it was made in.

Fifty brick walls at the same size are **one pair of textures**, shared and freed with the scene.
That is why size is three named steps rather than a slider: each distinct value needs its own
generated pair, and a slider dragged for a minute would leave a hundred of them on the GPU with only
one still reachable.

The trade is worth stating plainly: these are procedural patterns, not photographs. Brick here is a
regular running bond, not a scanned Victorian wall. It reads correctly at gameplay distance and it
will not survive a close-up. An asset that ships its own scanned maps keeps them, and the panel says
so before a surface replaces one.

### Two things that were silently doing nothing

Both were found by driving a browser, and neither would have failed a single unit test.

**Occlusion needs a second UV set.** Three reads `aoMap` from `uv1`, not `uv` — a glTF convention
from when lightmaps had their own unwrap. A model out of Blender almost never has one, so the map
bound successfully, sampled an attribute that did not exist, and contributed nothing. No warning; the
creases were simply not dark.

**Most of the shipped models have no texture coordinates at all.** Nothing had ever textured them, so
nothing had needed any. A material with a normal map and no `uv` attribute does not fail either:
every fragment samples texel zero, and the wall comes out uniformly tinted by one arbitrary pixel of
a brick. It looked like the feature working — until changing the size from fine to coarse rendered a
**byte-identical** frame, which is what the browser test measured and what nothing else could have.

The fix is a box projection generated where a model has no UVs of its own: each face projected down
the axis it most faces, in metres of the model's own space, so a brick is the same size on a small
crate and a large one. It is not a real unwrap and does not pretend to be — on a sphere it is visibly
wrong, which is why the panel says when it has been used. What it cannot know about is the
_placement_ scale: a crate stretched into a six-metre wall stretches its bricks with it, because the
geometry is shared with every other placement of that asset.

### What the manifest now records

Ingest measures which PBR maps each asset's own materials carry, and imports from disk measure the
same thing in the browser. The editor uses it for one thing: warning before a generated surface
replaces a normal map an artist actually authored. An empty list means _unmeasured_, not _has none_ —
every manifest built before this existed says the same thing, and inventing a measurement for them
would be worse than admitting the gap.

### What was verified

In a real browser, each claim against its control:

|                              |                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A surface changes pixels** | Two frames of the same static wall are byte-identical; applying brick changes 99% of them; clearing it returns to the _exact_ first frame, byte for byte.    |
| **Depth is the normal map**  | Depth 0 and depth 1.5 have every map bound and the same roughness pattern, and differ — which isolates the normal map from everything else the surface does. |
| **Occlusion reaches it**     | Shadowing 0 against 1 differs. This is the test the `uv1` bug would have failed.                                                                             |
| **Size reaches it**          | Fine against coarse differs. This is the test the missing-UV bug did fail, before the projection existed.                                                    |

Plus 10 unit tests on the generated maps themselves — asserted byte by byte, which is only possible
because generation is deterministic: that the pattern tiles without a seam, that a flat texel encodes
as pointing straight out and a joint as pointing sideways, that occlusion actually varies, that
concrete is rougher than glazed tile and only metal is metallic, and that every texture is freed. And
16 on how they are bound to a material.

Every one of those guards was mutation-tested: flattening the normal map, making occlusion uniform,
dropping the scale from the cache key, applying the surface _after_ the explicit roughness, leaving
the material scalars where the model had them, and removing the UV projection each break exactly the
test that claims to cover them.

---

## A bug this turned up

Adding the panel exposed something that had been true since the beginning: **no environment change
had ever reached the editor's viewport.**

The editor rebuilds its scene when objects or terrain change, and nothing was keyed on the
environment. So a sun colour, an ambient intensity, a fog setting — all of it was written to the
document, saved, survived a reload and exported correctly, and did nothing while you were looking at
it. It was invisible because there was no UI for those fields; the moment there was, it was the first
thing to fail.

Fixed with an incremental `syncEnvironment`, the same shape as the terrain sync that already
existed. Incremental rather than a full rebuild because a colour picker moves sixty times a second
while it is dragged, and rebuilding every object per frame would destroy the node a gizmo is
attached to, mid-drag.

The editor also runs the **same `PostStack`** as an export, driven from a react-three-fiber frame
callback that takes rendering over from r3f. Wiring effects into only the export would have meant
authoring a look you cannot see — the editor/export divergence the visual-regression suite exists to
catch, introduced deliberately. Using `@react-three/postprocessing` here and Three's passes there
would have been two implementations of one feature, and they would have drifted on the third change.

---

## What was verified

In a real browser:

|                                               |                                                                                                                                                                                                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Nothing composes until asked**              | `enabled` with every effect off leaves the viewport with no chain — asserted against the viewport, not the document.                                                                                                                                  |
| **Effects reach the editor's canvas**         | A vignette, a colour grade and switching shadows off each change the rendered image. Screenshots compared after the frame settles, not after a fixed frame count.                                                                                     |
| **The composer path matches the direct path** | A composer running a _neutral_ grade produces the same image as no composer: mean brightness 53.23 against 53.19, with 0.37% of pixels differing at antialiased edges. Without the final `OutputPass` this is where a washed-out image would show up. |
| **Effects do what they say**                  | A vignette darkens the frame (53.2 → 46.0 mean); a −1 saturation grade takes red-dominant pixels from 23,125 to **0**.                                                                                                                                |
| **The panel edits the document**              | Shadow quality, tone mapping and the hemisphere fill set through the real controls.                                                                                                                                                                   |

Plus 8 unit tests on material overrides — the first two are about the shared-material bug and
nothing else — and 6 on the lighting the loader builds.

## Still missing

- **Placed lights.** One sun and the ambient terms. A torch you can put in a room is an object with
  a light component, which is a scene-schema feature rather than a rendering one.
- **Baked lighting.** Lightmaps would transform how a scene looks at no runtime cost, which matters
  more here than anywhere else because the target is a browser. Ranked next on the roadmap.
- **Screen-space ambient occlusion.** Surfaces bake occlusion into the _pattern_, which darkens a
  mortar joint but knows nothing about the corner where two walls meet. Contact shadows between
  objects need a depth pass, and remain the most valuable effect not in the list.
- **Authored materials as assets.** An override belongs to one object. A named material reused
  across fifty objects is a different feature, and the one to build before somebody hand-edits
  fifty overrides.
- **A real UV unwrap.** The box projection is right for the boxy shapes this engine is full of and
  wrong for organic ones. Seam-minimising unwrapping belongs in the ingest pipeline, not the
  renderer.
- **Antialiasing as a setting.** On in the editor and in exports, not exposed.
- **Levels of detail on instanced objects.** Batched copies share one geometry, so there is no
  per-copy level to swap — see `PERFORMANCE.md`.
