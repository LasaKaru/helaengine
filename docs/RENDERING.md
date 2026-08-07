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
- **Ambient occlusion.** The most valuable effect not in the list; it needs a depth pass and is the
  first candidate for a fourth entry.
- **Authored materials as assets.** An override belongs to one object. A named material reused
  across fifty objects is a different feature, and the one to build before somebody hand-edits
  fifty overrides.
- **Antialiasing as a setting.** On in the editor and in exports, not exposed.
