# The node graph

Wiring up what happens in a level, without writing code. Open it from **Graph** in the top bar.

A graph is a set of **nodes** joined by **wires**. Execution starts at a _when_ node and follows the
wires. That is the whole model — there is no hidden order, no script file, and nothing to compile.

---

## The three kinds of node

The palette on the left is grouped by what a node is for, and each group has a colour that the nodes
on the canvas share.

**When…** (blue) — where a chain starts. Nothing connects _into_ one.

| Node     | Runs                                                                                    |
| -------- | --------------------------------------------------------------------------------------- |
| On start | Once, as the level loads                                                                |
| On event | Every time an event with that name is raised — by a trigger, a weapon, or another graph |
| On timer | After N seconds, once or repeatedly                                                     |

**Flow** (amber) — decides where execution goes next.

| Node     | Outputs                                     |
| -------- | ------------------------------------------- |
| Branch   | `true` and `false`, chosen by its condition |
| Wait     | `then`, but on a later frame                |
| Sequence | `0`, `1`, `2`… run in that order            |

**Actions** (green) — everything else. Each has a single `then` output, so chains read top to
bottom. They cover variables (set, add to), objects (spawn, destroy, show/hide, move, set
animation), the player (damage, heal, teleport) and signals (emit an event, show a message).

## Variables

Named values the graph reads and writes, declared in the right-hand panel. Each has a type — number,
true/false, or text — and a starting value that a fresh run restores.

They are scene-scoped: one `doorUnlocked` for the level, not one per object. Anywhere a node takes a
value you can give it a constant or a variable, chosen with the **Number / True-false / Text /
Variable** dropdown.

## Conditions

A **Branch** node holds a condition, edited as a small tree rather than as a chain of boxes:

- **Player health below** a number
- **Flag is set** — a true/false variable
- **Player has item** — at least N of weapon, ammo or health
- **Compare** — two values and one of `== != < <= > >=`
- **All of… / Any of… / Not…** — combining the above

"The player has the key **and** the boss is dead" is one thought, so it is one node with a nested
condition, not three nodes and two wires.

Ordering comparisons (`<`, `>`, `<=`, `>=`) between things that are not both numbers are **false**,
never an error and never a coerced guess. Comparing a label to a number with `<` is a question
without an answer.

---

## Wiring

Click an output port — the small pill on a node's right edge — then click the node it should run
next. The port highlights while it is armed; click it again, or click empty canvas, to cancel.

Two clicks rather than a dragged wire, because both ends are ordinary buttons: the same interaction
works from a keyboard, and it does not fight the drag that moves nodes around.

Drag a node by its header. Delete one — with every wire attached to it — from the right-hand panel.

## Problems

Underneath the inspector is a live list of everything wrong with the graph, recomputed as you draw
it. Clicking a problem selects the node it names.

**Errors** stop the graph running. **Warnings** do not — a half-built graph is a normal state to be
in while authoring, so an unreachable node is worth mentioning and not worth blocking on.

The checks:

| Problem                                                            | Severity |
| ------------------------------------------------------------------ | -------- |
| A wire to a node that does not exist                               | error    |
| A wire from a port a node does not have                            | error    |
| A wire _into_ a when-node                                          | error    |
| A variable read or written but not declared                        | error    |
| A dropdown left unchosen — no target object, no asset, no variable | error    |
| Two nodes with the same id, or two variables with the same name    | error    |
| **A loop with no Wait in it**                                      | error    |
| A node nothing can reach                                           | warning  |

### The loop check

This is the one that a text scripting language cannot have.

`while (true) {}` in C# is a hung game you discover by playing it. Here it is a load error naming
the nodes, before anything runs — because the whole program is inspectable data rather than a string
that becomes a function.

A loop _through_ a Wait node is fine, and is how a repeating behaviour is written. The distinction
is whether the chain yields the frame:

```
On start ──▶ Spawn ──▶ Wait 2s ─┐   legal: a spawner
              ▲                  │
              └──────────────────┘

On start ──▶ Emit ──▶ Branch ───┐   refused: nothing lets a frame finish
              ▲                  │
              └──────────────────┘
```

There is also a **step budget**: any one event may run 512 nodes before the runtime stops it and
warns. Cycle detection covers loops; it does not cover a graph that fans out through nested Sequence
nodes into an exponential number of steps. Eight nested three-way sequences is 6,561 steps in a
single frame, and nothing in the schema forbids drawing that. The budget turns it into a slow frame
and a message rather than a hang.

---

## Playing it

Press **Walk**. The graph starts with the level and stops when you leave, and variables reset to
their starting values each time.

If the graph has errors it is **refused rather than run partially** — a graph with a dangling wire
means something the runtime cannot guess, and running the reachable half of it produces a level that
is subtly wrong instead of visibly broken. The reason appears in the browser console, and in the
Problems list before you ever press Walk.

Graphs are part of the scene document, so they save, export and round-trip with everything else. An
exported game runs the same interpreter the editor preview does.

## Why a graph and not a scripting language

The engine ships no `eval` and no `new Function`, and a lint rule keeps it that way. A scene file is
untrusted input — somebody sends you a level, or you open one from the internet — and a document
that could name a function to call would be a document that could run code you did not ship.

A node graph gives up almost nothing for that. Every node type comes from one closed list, checked
when the document is parsed; a file naming `runShellCommand` is not a document with a bad node, it
is not a document. The interpreter's switch over that list is exhaustive, so a node type added to
the format without a matching implementation fails to compile.

What you get back is everything on this page: the loop check, the unreachable-node warning, the
unset-dropdown error. None of them are possible against a wall of text.

### What a graph is not for

Bespoke maths, custom shaders, a new movement model. Those are real code, and the answer there is a
behaviour in `packages/engine` — see [BEHAVIOURS.md](BEHAVIOURS.md). A graph is for wiring the level
together; a behaviour is for teaching the engine something new.

---

## Reference

- Schema and static checks: `packages/schema/src/graph.ts`
- Interpreter: `packages/engine/src/graph/GraphRuntime.ts`
- Editor canvas: `apps/editor/src/components/GraphEditor.tsx`
