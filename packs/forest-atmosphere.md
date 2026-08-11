---
id: forest_atmosphere
name: Forest atmosphere
description: A breeze, two layers of ground cover, and a warm afternoon look.
tags: [outdoor, forest, atmosphere]
author: HelaEngine
---

Everything here is a setting you could reach yourself. The value of the pack is the _numbers_ —
which are the part that takes an afternoon to get right.

## The look

Filmic tone mapping with a warm key against a cool sky fill. It is what stops a scene being
uniformly lit, which is the strongest "this is a toy" signal a low-poly world can have.

```hela
{ "op": "applyLook", "look": "realistic" }
```

## The wind

`0.8`, not `2`. A breeze moves a canopy; anything above about 1.5 reads as a storm and makes a calm
forest look like it is being filmed during a hurricane. `gustiness` at 0.45 is high enough to break
the rhythm — a perfectly even sway is picked out by the eye as artificial within seconds.

```hela
{
  "op": "setWind",
  "value": { "strength": 0.8, "direction": 210, "speed": 0.5, "gustiness": 0.45 }
}
```

## Ground cover

Two layers rather than one. A single density of grass reads as carpet; a dense low layer with a
sparser taller one on top reads as ground. The seeds differ so the two do not grow in the same
places.

`slopeMax` at 28° on the tall layer keeps it off the steeper banks, where the models intersect the
ground rather than standing on it.

```hela
[
  {
    "op": "addScatterLayer",
    "value": {
      "id": "undergrowth",
      "name": "Undergrowth",
      "assetId": "grass",
      "density": 55,
      "seed": 1204,
      "scaleMin": 0.7,
      "scaleMax": 1.1,
      "slopeMax": 38
    }
  },
  {
    "op": "addScatterLayer",
    "value": {
      "id": "tall_grass",
      "name": "Tall grass",
      "assetId": "grass_large",
      "density": 14,
      "seed": 7781,
      "scaleMin": 0.9,
      "scaleMax": 1.6,
      "slopeMax": 28
    }
  }
]
```

## Sound

The wind bed follows the wind, so what you can see you can also hear. Birds sit underneath at a
fixed level — they do not get louder in a gale.

```hela
[
  { "op": "addAmbience", "value": { "assetId": "audio_ambience_wind", "volume": 0.55, "followWind": 0.8 } },
  { "op": "addAmbience", "value": { "assetId": "audio_ambience_birds", "volume": 0.35 } }
]
```
