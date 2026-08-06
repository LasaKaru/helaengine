# Asset Authoring Conventions

Every asset that enters HelaEngine goes through `pnpm ingest-assets`. The ingest script enforces
what it can mechanically, but the rules below are the ones that have to be right **in Blender**,
before export — because the alternative is per-asset fixups inside the engine, and those get
inherited by every project a user exports. If an asset looks wrong in the editor, fix the source
file and re-ingest. Never special-case it in engine code.

---

## 1. Units and scale

- **1 Blender unit = 1 metre.** Set Scene Properties → Units → Unit System: Metric, Unit Scale 1.0.
- Apply all transforms before export (`Ctrl+A` → All Transforms). An asset must export with
  scale `(1,1,1)` and rotation `(0,0,0)`.
- Model at real-world scale. A door is ~2m tall, a pine tree 4–8m, a human-sized enemy ~1.7m.
  `defaultScale` in the manifest is for correcting _stylistic_ scale, not for fixing modelling
  mistakes.

## 2. Orientation and pivot

- **+Y is up, −Z is forward.** Blender is Z-up, so export with `+Y up` enabled (the default in
  Blender's glTF exporter). Characters and anything with a facing direction should look down −Z.
- **The pivot sits at the base of the object, centred in X and Z.** Placing an object at `y = 0`
  in a scene must rest it on the ground with no offset. This is what lets drag-and-drop placement
  (Sprint 4) snap to a terrain hit point without per-asset nudging.
- Exception: props designed to attach to a wall or ceiling pivot at their attachment face.

## 3. Polygon budgets

Low-poly is an aesthetic here, not just a performance target. Stay under these per asset:

| Tier              | Budget       | Examples                      |
| ----------------- | ------------ | ----------------------------- |
| Small prop        | < 500 tris   | rocks, crates, bushes, signs  |
| Standard prop     | < 2 000 tris | trees, barrels, carts, fences |
| Character / enemy | < 4 000 tris | goblins, guards, animals      |
| Building          | < 8 000 tris | huts, towers, walls, gates    |

The ingest script warns above budget and fails above 2× budget. If an asset genuinely needs more,
raise the budget in the pipeline config deliberately — don't bypass the check per asset.

## 4. Materials and textures

- **Prefer flat colours over textures.** The low-poly style reads better with faceted geometry and
  solid material colours, and untextured assets keep exports small.
- Use **one material per colour**, not one per object. Fewer materials means fewer draw calls, and
  the engine can batch identical assets (Sprint 12 instancing).
- If an asset does need texture maps, use **a single texture atlas** for the whole asset, power-of-two
  dimensions, 512×512 or 1024×1024. Multiple 4K maps on a low-poly rock will be rejected in review.
- Shading: mark faces flat (not smooth) unless the form is genuinely curved. Flat shading is most of
  the low-poly look.

## 5. Naming

Files are named `category_name_variant.glb`, all lowercase, underscores only:

```
tree_pine_01.glb
tree_pine_02.glb
rock_boulder_01.glb
building_hut_01.glb
enemy_goblin_01.glb
```

The filename stem becomes the `assetId`, and **the `assetId` is a permanent contract** — saved user
scenes reference it. Renaming an asset after release breaks every project that used it. Add a new
variant instead.

Valid categories: `trees`, `rocks`, `buildings`, `enemies`, `props`, `terrain`.

## 6. Hierarchy and cleanup

Before exporting:

- Delete cameras, lights, and helper/rig objects that aren't part of the asset.
- Delete unused materials, orphan meshes and loose vertices.
- Join meshes that will never move independently. A tree should be one object, not trunk + 40 leaf
  planes as separate objects.
- Name the root object the same as the file stem.

## 7. Colliders

`colliderType` in the manifest tells the engine (Sprint 10, Rapier) what shape to generate:

| Value     | Use for                                                             |
| --------- | ------------------------------------------------------------------- |
| `box`     | buildings, crates, walls — anything roughly rectangular             |
| `capsule` | characters, enemies, trees (trunk approximation)                    |
| `sphere`  | boulders, barrels, round props                                      |
| `mesh`    | terrain pieces and complex static geometry. Expensive — last resort |
| `none`    | purely decorative, non-blocking (grass tufts, decals)               |

Default to the cheapest shape that feels right when walking into it. `mesh` colliders on scattered
props are the fastest way to wreck physics performance in a dense scene.

Sizes come from the measured `bounds`, multiplied by the manifest's `defaultScale` and by whatever
the instance is scaled to, and every shape sits with its base at the object's pivot — the same
pivot-at-the-base convention as section 3. A placement can override the manifest with the
inspector's Physics section; `auto` (the default) means "whatever the asset says", which is where
the answer usually belongs.

## 8. Export settings (Blender glTF 2.0 exporter)

- Format: **glTF Binary (.glb)**
- Include: Selected Objects (export one asset at a time)
- Transform: **+Y Up** ✔
- Geometry: Apply Modifiers ✔, UVs ✔, Normals ✔, Vertex Colors ✔ (if used), Tangents ✘
- Compression: **off** — the ingest pipeline applies Draco itself, so raw sources stay editable
  and re-compressible as the pipeline improves
- Animation: only if the asset is animated; bake all keyframes

## 9. Importing a third-party pack

Most of the library came from CC0 packs rather than being modelled here. `pnpm import-pack` is the
path in:

```bash
pnpm import-pack -- --from /tmp/nature --pack nature-kit \
  --author Kenney --license CC0-1.0 --url https://kenney.nl/assets/nature-kit
pnpm ingest-assets
```

It **refuses to run without `--author`, `--license` and `--url`**, and stamps everything it writes
`origin: 'third-party'`. That is not paperwork: an export reads these fields to write its
`CREDITS.md`, so a pack imported without them ships somebody else's art uncredited in every game
built from it. Check the licence yourself against the file bundled in the pack — not against what
you remember about the publisher.

Three behaviours worth knowing before you run it:

- **Existing ids are never overwritten.** Several Kenney names collide with the hand-tuned starter
  assets (`grass`, `tree_log`, `tree_small`), whose bounds and colliders were set deliberately. The
  import skips them and says so.
- **Filenames become snake_case ids.** `tree_pineDefaultA.glb` → `tree_pine_default_a`, matching the
  `^[a-z0-9_]{3,60}$` the upload route already enforces on customers.
- **Models are re-encoded, not copied.** Some packs reference a sibling `Textures/colormap.png`
  rather than embedding it. Copying such a file produces a model that cannot be opened, and copying
  the texture alongside is worse — different packs ship _different_ atlases under that same name, so
  one shared path silently repaints one pack with another's textures. The import reads each model
  and rewrites it self-contained.

Category is guessed from the filename prefix (`tree_`, `cliff_`, `wall_`…) and anything unrecognised
becomes a prop. Fix any that land wrong by editing `asset-metadata.json` afterwards; the import will
not touch them again.

## 10. Ingest

Drop finished `.glb` files into `raw-assets/` and run:

```bash
pnpm ingest-assets
```

The pipeline deduplicates and welds vertices, prunes unused data, applies Draco geometry
compression, renders a thumbnail, and writes a manifest entry per asset. It is idempotent — re-run
it as often as you like. Everything it produces is generated output and is not committed; the raw
`.glb` sources are the artefacts under version control.

Per-asset metadata that can't be inferred from the file (category, tags, collider type, default
scale) lives in `tools/asset-pipeline/asset-metadata.json`, keyed by `assetId`. An asset with no
entry there gets conservative defaults and a warning.
