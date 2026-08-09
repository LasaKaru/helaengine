# Making a world feel alive

Wind, ground cover, world size, look presets and ambience. Everything here is off or empty by
default, so a level built before any of it existed is unchanged.

---

## Wind

**Rendering panel → Wind.**

One wind for the whole level: a strength in metres, a compass direction, a speed and a gustiness.
Every plant reads it. A sway setting per object would make a forest where every tree moves to its
own rhythm, which reads as broken rather than varied — real variation comes from _phase_, and phase
comes free from where a plant is standing, so a wave travels across a field without anything being
authored.

**Strength is metres of lean at the top of a two-metre plant**, not a 0–1 dial. A dial would move a
blade of grass and an oak by the same fraction of nothing.

**Zero is off, completely.** No material is patched, no shader is compiled, no uniform is updated.

### What moves, and how much

Grass whips, shrubs give a little, trees lean. One wind setting has to look right across all three,
so each group has its own amplitude.

Which group a model lands in is decided from its **asset id**, not its category — because the
categories cannot answer it. `trees` holds grass, flowers, crops and mushrooms as well as oaks, and
it also holds `log`, `tree_trunk` and `stump_round`, which are felled wood and must stand perfectly
still.

That rule will be wrong sometimes. **Every object has a Wind setting in its inspector** to fix it:
`Never moves` for the potted plant indoors, or a named group for a model the rule has not heard of.

|                               |                       |
| ----------------------------- | --------------------- |
| Automatic                     | Ask the rule          |
| Never moves                   | Stand still in a gale |
| Like grass / a shrub / a tree | Force a group         |

An object with an override is drawn separately from its instanced batch, so the override always
wins rather than depending on which object was placed last.

---

## Ground cover

**Ground cover panel.**

A field of grass is tens of thousands of blades. Placing them as objects would be megabytes of ids
and transforms describing something nobody positioned individually. A **scatter layer** is the rule
instead — a model, a density, a seed, and the limits on where it may land — in a few hundred bytes.

| Setting            | What it does                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------ |
| Density            | Instances per 100 m². The panel shows what that works out as.                              |
| Seed               | Chooses the arrangement. Change it if you don't like the one you got.                      |
| Scale              | A range, so the field is not wallpaper.                                                    |
| Max slope          | Keeps plants off cliffs, where the models intersect the ground rather than standing on it. |
| Only on            | Restricts it to one painted terrain layer.                                                 |
| Lie flat on slopes | Off for plants, on for rocks and debris.                                                   |

### Two things worth knowing

**It follows the terrain brush.** Set _Only on_ to a layer, paint that layer, and the cover appears
exactly where you painted — no second mask to keep in step. Paint sand over it and the grass
retreats.

**The seed makes it a description, not a compression scheme.** The same document grows the same
field in the editor, in an export and on a teammate's machine, without a single position being
written down. The cost is that individual blades cannot be nudged; if you want a specific plant in a
specific spot, place an object, which is what objects are for.

Ground cover moves in the wind like anything else, and a bigger world grows proportionally more of
it, because density is per unit area.

There is a hard cap of 40,000 instances per layer. Density is per area, so a setting that looked
fine on a 128 m map is millions on a 2 km one, and the failure mode without a cap is a tab that
never finishes loading. The panel says when the cap is what decided the count.

---

## World size

**Terrain panel → World size.** 64 m to 1024 m square.

**Sculpting survives it.** The heightmap is normalised heights stretched over the extent rather than
samples at fixed world positions, so resizing scales the landscape horizontally and keeps every
hill.

**Placed objects do not.** They hold world coordinates, so shrinking the world can leave them beyond
its edge. You get a warning naming how many, and the choice — silently dragging your level inward to
fit would be the worse surprise.

---

## Look presets

**Rendering panel → Look.** Two buttons: **Stylised** and **Realistic**.

A look is a set of settings **written into the document once**, when you press the button. Nothing
remembers which one you pressed. Afterwards every field is an ordinary field: editable, undoable,
yours. Press the button again to re-apply it.

That is deliberate. A stored `look` field would be a second source of truth about lighting, and it
would lose an argument with the panel the first time you nudged the exposure — either the preset
silently stops applying, or it fights your edit on every reload.

### What Realistic honestly is

Filmic tone mapping, a warm key light against a cool sky-and-ground fill, sharper shadows over a
shorter distance, and a restrained grade. It is a **lighting-and-grade preset**. It is not a
different renderer, and it will not turn flat-shaded low-poly models into photographs — the shipped
models carry no roughness or metalness maps and no preset can invent them.

What it does do is stop everything being uniformly lit, which is the strongest "this is a toy"
signal a scene can have. Most of the difference in a low-poly world comes from contrast between a
warm sun and a cool fill, and that is what these numbers are.

It costs two extra full-screen passes. Stylised is the cheapest thing to draw.

Neither preset moves the sun. Elevation and azimuth are the time of day — a decision about your
level, not about how it is lit.

---

## Ambience

**Audio panel → Ambience.**

Looping beds of sound: wind, birds, water, night, cave. Several play at once, which is how a river
in a forest sounds like both rather than like whichever the engine picked.

This is a third thing, next to music and sound effects, because it answers a different question.
Music is a _state_ — menu, explore, combat — and exactly one plays. Sound effects are triggered by
events. Ambience is a _place_, and it never stops.

### Following the wind

Each layer has a **Follows wind** dial. At zero it plays at its volume regardless. At one it is
silent in still air and reaches full volume in a gale.

This is the one place sound and rendering share a setting, and it earns the coupling: wind you can
see but not hear reads as a rendering trick, and a howling gale over motionless grass reads as a
broken level. The panel shows the volume a layer is _actually_ playing at right now.

Ambience rides the music slider rather than getting one of its own — a player turning the music down
is asking for a quieter background, and a third slider they have to find is not a feature.

### The sounds that ship

Beds: wind, birds, water, night, cave. Effects: pickup, damage, death, checkpoint, secret, shoot,
reload, footstep, jump, land, swing, door, heal, and a UI click.

All of them are synthesised — real waveforms in real files, so every stage downstream has something
genuine to work with, but not sound design. Replace them with commissioned audio and nothing else
has to change, because everything refers to them by asset id.

---

## Testing a level: Play From Here

The loop this removes is the whole point. Testing the far corner of a level otherwise means walking
there from the spawn point, every single time you change something.

**Right-click the ground → Play from here.** Play Preview starts with the player standing where you
clicked.

It **does not move the spawn point**. Somebody testing the boss room twenty times has not decided
the game should start there, so the override is editor state and is cleared the moment you leave the
preview — the next plain Walk begins where the level says.

### Ejecting

**F8** while playing detaches the camera. The world keeps running: physics steps, enemies think,
triggers fire, and only the camera stops following. Drag to look around, then press **F8** again to
take control back.

Pausing to look at a patrol is precisely what makes a patrol unobservable, which is why ejecting is
not a pause. While ejected the player takes no input at all — no movement, no firing — because an
ejected pawn is nobody's, and one left driveable gets walked blindly into a wall while you are
looking somewhere else.

Leaving the preview always returns control, so the next run never starts ejected with the keys
mysteriously dead.

---

## Reference

- Wind: `packages/schema/src/wind.ts`, `packages/engine/src/render/wind.ts`
- Ground cover: `packages/schema/src/scatter.ts`, `packages/engine/src/scatter/ScatterField.ts`
- Looks: `packages/schema/src/looks.ts`
- Ambience: `packages/schema/src/audio.ts`, `packages/engine/src/audio/AmbiencePlayer.ts`
- Play From Here: `apps/editor/src/components/PlayFromHere.tsx`
