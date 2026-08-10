---
name: add-behaviour
description: "Use when teaching HelaEngine's runtime something new that the node graph cannot express — a movement model, an AI state machine, custom maths. Behaviours are real code in packages/engine, unlike graph nodes which are data. Covers the definition shape, why the params schema is the whole safety story, and the two things that must be true for an export to still work. Triggers: 'add a behaviour', 'the engine should be able to X', editing builtins.ts or BehaviorRegistry."
---

# Adding a behaviour

## First: is this a behaviour?

|                |                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------- |
| **Graph node** | Wiring a level together — a door, a counter, a trigger chain. Data.                            |
| **Behaviour**  | Teaching the engine something new — a movement model, an AI state machine, custom maths. Code. |

If it can be built from nodes that already exist, it is not a behaviour. Adding one is adding to the
engine's vocabulary permanently.

## The definition

Behaviours live in `packages/engine/src/behaviors/` (or `ai/` for the thinking ones). A definition
carries a `type`, a Zod `params` schema, and a factory.

```ts
export const patrolDefinition = {
  type: 'patrol',
  params: z.object({
    waypoints: z.array(Vec3Schema).min(2).max(64),
    speed: z.number().min(0).max(50).default(2),
  }),
  create: (params) => ({
    onUpdate(object, delta, context) {
      /* … */
    },
  }),
};
```

Register it in `builtins.ts`.

## Why `params` is a Zod schema and not a TypeScript type

It is the entire safety story, and it does two jobs:

1. **A document can only ask for a registered `type` with params satisfying that schema.** Nothing
   in a scene is ever interpreted as code, so an exported project cannot be made to run something
   its author did not put there.
2. **The editor's inspector renders the form from it.** Adding a behaviour does not mean
   hand-writing UI, and a field you add appears automatically.

Bound every number and every array. `z.number()` unbounded is a document that can ask for a patrol
at ten million metres per second.

## The lifecycle

`onInit`, `onUpdate`, `onEvent`, `onDestroy` — all optional.

- **Reach the world through `BehaviorContext` and `GameObject`, never Three.js directly.** If the
  world cannot do what you need, add a method to `WorldHandle` _and_ to `INERT_WORLD`, so a headless
  test gets a truthful "nothing there" rather than a crash.
- **`onDestroy` must release everything `onInit` took.** `leaks.test.ts` asserts the engine disposes
  what it deletes, and a behaviour holding a texture defeats it.
- **Speak through the event bus.** Emitting `enemyAlerted` means audio, the music state machine and
  any graph listening all react without a single new call site. Reaching into another system
  directly means three of them to keep in step.

## Two things that must stay true

**The engine has no editor imports.** A lint rule enforces the direction. If a behaviour needs
something React-shaped, it belongs in the editor, not here.

**Exports register only what a scene uses.** Keep the definition self-contained — a behaviour that
imports half the engine to do one thing makes every export carry it.

## Testing

`behaviors.test.ts` builds a registry with exactly the types it means to exercise, rather than
using the global one. Do the same: a test that depends on `registerBuiltinBehaviors` passes for
reasons unrelated to the behaviour under test.

Drive real frames. A patrol asserted by calling `onUpdate` once with a two-second delta is not a
patrol, it is arithmetic.

## Finally

- `docs/BEHAVIOURS.md` is **generated** from the schemas — run `pnpm gen-docs`, do not hand-edit it.
- `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm smoke:test`

The smoke gate matters here specifically: it exports scenes and plays them, which is the only check
that a new behaviour survives the trip into a standalone build.
