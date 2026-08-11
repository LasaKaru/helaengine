---
id: locked_door
name: Locked door
description: A door that stays shut until the player picks up a key, with a message either way.
tags: [gameplay, graph, puzzle]
author: HelaEngine
---

The smallest complete puzzle: a thing you need, a thing it opens, and feedback when you try it
without.

Everything here is graph. The pack declares its own variable rather than assuming one, because a
node reading an undeclared variable is a graph _error_ — it would stop the whole level's scripting,
including whatever was already working.

## The flag

```hela
{ "op": "addGraphVariable", "value": { "name": "hasKey", "type": "boolean", "initial": false } }
```

## Picking the key up

Listens for a `keyPickup` event. Emit that from a pickup's `sfxEvent`, or from a trigger's **Emit
event** action — the pack does not place the key, because where it goes is the level designer's
decision and not a recipe's.

```hela
[
  { "op": "addGraphNode", "value": { "id": "on_key", "type": "onEvent", "event": "keyPickup" } },
  {
    "op": "addGraphNode",
    "value": { "id": "take_key", "type": "setVariable", "name": "hasKey", "value": { "kind": "boolean", "value": true } }
  },
  {
    "op": "addGraphNode",
    "value": { "id": "say_got_key", "type": "showMessage", "text": "You found a key.", "seconds": 2.5 }
  },
  { "op": "addGraphEdge", "value": { "from": "on_key", "port": "then", "to": "take_key" } },
  { "op": "addGraphEdge", "value": { "from": "take_key", "port": "then", "to": "say_got_key" } }
]
```

## Trying the door

Wire a trigger volume at the door to emit `tryDoor`. The branch reads the flag and answers either
way — a locked door that says nothing is indistinguishable from a wall.

```hela
[
  { "op": "addGraphNode", "value": { "id": "on_door", "type": "onEvent", "event": "tryDoor" } },
  {
    "op": "addGraphNode",
    "value": { "id": "check_key", "type": "branch", "condition": { "type": "flag", "name": "hasKey", "expected": true } }
  },
  {
    "op": "addGraphNode",
    "value": { "id": "open_door", "type": "showMessage", "text": "The door swings open.", "seconds": 2 }
  },
  {
    "op": "addGraphNode",
    "value": { "id": "refuse", "type": "showMessage", "text": "It is locked. Something opens this.", "seconds": 2.5 }
  },
  { "op": "addGraphEdge", "value": { "from": "on_door", "port": "then", "to": "check_key" } },
  { "op": "addGraphEdge", "value": { "from": "check_key", "port": "true", "to": "open_door" } },
  { "op": "addGraphEdge", "value": { "from": "check_key", "port": "false", "to": "refuse" } }
]
```

After applying, replace the two `Show message` nodes with whatever the door actually does — a
**Show / hide** or a **Move object** pointed at it.
