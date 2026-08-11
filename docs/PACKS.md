# Skill packs

A skill pack is a recipe for a level, written as a markdown file. Open one in the **Skill packs**
panel, read what it says it will do, and press Apply — the whole thing lands as a single change you
can undo with one Ctrl+Z.

"Forest atmosphere" sets a wind, grows two layers of ground cover and applies the realistic look.
"Locked door" declares a flag, adds the graph nodes that read and set it, and wires them together.
Neither does anything you could not do yourself through the panels. What a pack carries is the
_numbers_ — the part that takes an afternoon to get right, and which nobody should have to work out
twice.

Both ship in `packs/` in this repository.

## What a pack can and cannot do

A pack can change settings and add content:

| It may                                           | Patch                                              |
| ------------------------------------------------ | -------------------------------------------------- |
| Change environment settings                      | `setEnvironment`                                   |
| Set the wind                                     | `setWind`                                          |
| Apply a look preset                              | `applyLook`                                        |
| Change terrain **settings** — world size, layers | `setTerrain`                                       |
| Add ground cover                                 | `addScatterLayer`                                  |
| Add ambience, or bind a sound to an event        | `addAmbience`, `addSfx`                            |
| Place objects                                    | `addObject`                                        |
| Add graph variables, nodes and wires             | `addGraphVariable`, `addGraphNode`, `addGraphEdge` |

That table is the complete list. It is a closed vocabulary in the schema, so a pack naming anything
else is not a pack with a bad line in it — it is refused as a whole, before a single change is made.

A pack **cannot**:

- introduce a new node type, a new behaviour, or a new anything. Those are engine changes. An engine
  that could be extended by a file it downloaded would be an engine running code its author did not
  ship, which is the one thing HelaEngine does not do.
- ship a heightmap or a splatmap. It may say "this world is 512 metres"; it may not flatten a
  landscape you sculpted. That is destroying your work rather than adding to it.
- ship models or sounds. A pack is a text file. It _names_ assets, and the panel tells you before
  applying if your project does not have one.

Because of all that, a pack from a stranger is exactly as safe to open as a scene file from a
stranger — which is the guarantee the whole engine is built around.

## Writing one

Frontmatter for the identity, prose for the reasoning, fenced ` ```hela ` blocks for the patches:

````markdown
---
id: my_pack
name: My pack
description: One line on what applying it does.
tags: [outdoor]
author: You
---

Prose here is not decoration. A pack that explains _why_ the wind is 0.8 and not 2 teaches
something; the same numbers as bare JSON do not. The editor shows this before applying anything.

```hela
{ "op": "setWind", "value": { "strength": 0.8, "direction": 210 } }
```
````

Every block takes one patch or an array of them, and blocks apply in document order — so you can
explain each step next to the patches that perform it. Fenced blocks in any other language are left
alone as prose.

The frontmatter parser is deliberately not YAML: `key: value` lines, optional quotes, and one list
form (`tags: [a, b]`). YAML has anchors, merge keys and a history of instantiating arbitrary types,
and a pack header needs none of it.

### Ids inside a pack are local

Your `door` is a name meaningful only inside the pack. On the way in, every object and node id is
rewritten to something the level is not already using — which is what makes applying the same pack
twice add two doors rather than one door twice, and what stops a pack colliding with a level that
happened to call something the same thing.

Write edges against your own local ids and they are remapped consistently at both ends.

### Declare what you use

Two things are checked before a pack may be applied, and either one blocks the Apply button:

- **An edge to a node the pack does not add.** A dangling wire is a graph _error_, and an errored
  graph refuses to run — including the parts of the level's graph that were already working.
- **A node reading a variable the pack does not declare.** Same reasoning.

A pack must not be able to break a level by being applied to it, so both are refusals rather than
warnings. So is a missing asset: a scatter layer naming a model you do not have grows nothing, and a
spawn node naming one fails validation and stops the whole graph.

## What applying does not touch

- **A variable the level already declares** keeps the level's value. Overwriting `score` would reset
  progress the graph was tracking, from a recipe applied for an unrelated reason.
- **An ambience bed you already have** is not added twice. Beds are keyed by asset, so a duplicate
  would silently replace rather than stack.
- **Your hierarchy.** A pack's objects arrive at the root. Re-parenting is a decision a recipe is not
  in a position to make.
- **Your graph layout.** New nodes are laid out in a row _below_ whatever is already on the canvas,
  so an applied pack reads as a group rather than a pile on the origin.

## Packs and repository skills are different things

`.claude/skills/` in this repository holds instructions for whoever is _building_ HelaEngine —
where a graph node has to land, how to run the release gate. Those are read by a person or an
assistant working on the engine's source.

Skill packs are read by the editor and applied to a level. Nothing at runtime asks a model anything;
a pack is data from a closed vocabulary, start to finish.
