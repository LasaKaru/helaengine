# Physics

Everything in this page runs on the same solver, in the same fixed-timestep loop, in the editor's
Play Preview and in every export. There is no "editor physics" and no "export physics" — the
preview is the runtime with a viewport attached.

The solver steps at a fixed 1/60 with an accumulator, never at the frame rate. Feeding a solver
whatever delta the last frame happened to take makes collision resolution depend on how fast the
machine is, which is how a character walks through a wall on a slow laptop.

- [How a thing collides](#how-a-thing-collides)
- [Movement feel](#movement-feel)
- [Joints](#joints)
- [Breakable things](#breakable-things)
- [Ragdolls](#ragdolls)
- [Vehicles](#vehicles)
- [What is not here](#what-is-not-here)

---

## How a thing collides

Every placed object has a **body type** and a **collider**, under Physics in the inspector.

| Body        | What it means                                                             |
| ----------- | ------------------------------------------------------------------------- |
| `static`    | Never moves. Buildings, rocks, trees — most of a level, and the cheapest. |
| `dynamic`   | Falls, and is pushed around by contacts.                                  |
| `kinematic` | Moved by gameplay. Pushes others; is not pushed.                          |

The collider defaults to `auto`, which asks the asset manifest — the shape of a pine tree is a
property of the tree, not of the fourteenth copy of it. Override it when placement changes the
answer: a building the player walks inside needs `mesh` where the manifest says `box`.

Colliders are built with their **pivot at the base**, matching the asset convention. An object at
y=0 with a height of 2 occupies 0 to 2. This catches people out constantly — including while these
features were being written — so it is worth reading twice.

---

## Movement feel

Slopes, step-over and crouch have always worked. Four settings under **Player → Feel** forgive the
mistakes a player is usually not making. All four default to off, so a level tuned before they
existed plays exactly as it did.

| Setting          | What it forgives                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| **Coyote time**  | A jump pressed just _after_ walking off a ledge. Around 0.1s is invisible and forgiving.                   |
| **Jump buffer**  | A jump pressed just _before_ landing. Fires on the frame they touch down.                                  |
| **Air control**  | How far the player may steer away from the direction they left the ground in. 1 is floaty; 0 commits them. |
| **Mantle up to** | Chest-high ledges they haul themselves onto when they press jump against one.                              |

The first two are the same mistake from two sides. A player pressing jump at the lip of a platform
is almost always a frame or two late; without coyote time their press is silently eaten, and they do
not conclude they mistimed it — they conclude the controls are unreliable.

**Mantling is an assisted jump**, not a scripted climb: the engine picks a launch speed that clears
the ledge and hands the character back to the solver immediately. It looks like a strong hop rather
than a hand-over-hand pull, and that is the trade — the scripted version is a second movement system
with its own collision story, and every one of its edge cases (mantling into a low ceiling, onto
something that then moves, while something else pushes you) has to be solved separately. This one
cannot get the player stuck.

Below the step height a ledge is a kerb the controller already walks over, so `mantleHeight` only
does anything above it.

---

## Joints

A joint pins two objects together and says how they may still move. Six kinds:

| Kind            | For                                                        |
| --------------- | ---------------------------------------------------------- |
| **Fixed**       | Welded. Assembling one rigid thing out of several models.  |
| **Hinge**       | One axis of rotation. Doors, lids, levers, wheels.         |
| **Ball socket** | Turns freely in every direction. Chains, hanging things.   |
| **Slider**      | One axis of translation. Pistons, drawers, lift platforms. |
| **Spring**      | Pulls toward a rest length. Suspension, bouncy platforms.  |
| **Rope**        | Does nothing until taut. Hanging signs, tow lines.         |

Select two objects and press **Join the two selected**. Hinges and sliders can also have a **limit**
(a door that opens 100° and stops) and a **motor** (a powered door that holds its angle, or a
turntable that spins at a rate).

### Two mistakes the panel calls out

Both look identical to a joint that is simply broken, which is why they are warnings rather than
something to discover by pushing a door.

- **Neither end is Dynamic.** The single most common way to build a door that does not open: the
  hinge is right in every respect and nothing in the world can move either end.
- **Both pivots are at the centre.** A hinge through a body's own origin lets it _spin_ rather than
  swing. A door's hinge belongs on its edge.

Anchors are in each object's own local space, which is what makes them survive being moved: a hinge
pinned to the edge of a door stays on the edge wherever the door is dragged to.

Deleting an object deletes its joints in the same undo step. A joint outliving its own end is a
constraint the runtime skips forever.

---

## Breakable things

Tick **Breakable** on an object to give it hit points. Damage comes from weapons, from impact, or
from both — and the distinction matters: a crate that only breaks when shot is a puzzle piece, while
one that also breaks on impact is a hazard.

Three outcomes:

- **Vanish** — it disappears. Glass, rotten planks, anything whose point is to stop being in the way.
- **Swap** — replaced by another model in place. A wall becoming a broken wall: the cheapest
  convincing break there is.
- **Fragments** — replaced by several dynamic pieces of a debris asset, thrown outward and upward.

### Why fragments are an asset you name

The tempting version slices the model into convex pieces at the moment it breaks. Doing that
honestly needs a convex decomposition, which is a heavy offline step belonging in the asset pipeline
rather than in a frame — and doing it dishonestly, by chopping the bounding box, looks worse than
not breaking at all. So a destructible names a debris model, which is a decision an artist makes
once and a level designer reuses.

### Impact damage needs a speed floor

Resting contact registers as a continuous stream of tiny impacts. Without a threshold, anything
standing on anything else grinds itself to nothing within seconds — and it reads as a bug in the
physics rather than as a number somebody chose. The default is 4 m/s.

### Talking to the rest of the game

A destructible raises an event you name. A graph **On event** node listening for it is how a crate
opens a door, without either of them knowing about the other. `destructibleBroken` is raised for
every break, so one Audio binding covers a whole level's worth of crates.

Set a **fragment lifetime**. Zero leaves the pieces for good, and a level where the player breaks a
hundred crates then simulates several hundred pieces nobody can see.

---

## Ragdolls

Tick **Ragdoll** on a rigged character and it goes limp when it dies — built from the pose it died
in, so a body that dies mid-stride falls from mid-stride.

Press **Detect bones**. The engine knows the Mixamo convention (`mixamorig:LeftUpLeg`) and the
underscore convention (`Thigh_L`), and binds eleven parts: hips, spine, head, two arms, two forearms,
two thighs, two shins. **Check what it matched.** A wrong binding folds a corpse inside out, and
that is much easier to fix while looking at the list than after seeing it happen.

### Eleven parts, not every bone

A hand has twenty bones and simulating them buys nothing a viewer can see, while costing twenty
bodies and twenty joints per corpse — so a level with six kills would be animating fingers nobody is
looking at. Eleven is where a ragdoll stops reading as a mannequin and more stops being visible. It
is also what makes it authorable: eleven named parts is a form you can fill in.

### Settings worth knowing

- **Keeps momentum** — how much of the character's motion the corpse carries into the fall. Zero
  drops them on the spot, which reads as the animation having been switched off. That is exactly
  what happened, and exactly what should not be visible.
- **Clear after** — eleven rigid bodies per kill adds up. Zero is right for a set piece and wrong
  for a horde.

Going limp listens for the `enemyDied` event, so anything that kills something gets ragdolls for
free by raising it.

**Honest limit:** the joints are unlimited ball sockets. Limbs bend further than a real one would —
elbows can go backwards. Cone limits are a project of their own, and this is a rag doll.

---

## Vehicles

Tick **Vehicle** on an object with a **Dynamic** body and it becomes a chassis: four suspension rays,
an engine, and a seat. Press the interact key (E by default) near it to get in, and again to get out.

The whole car is **one rigid body**. Each wheel is a downward ray from the chassis, the suspension is
a spring along that ray, and grip is a force at the contact point. There are no wheel bodies and no
joints — which is why it cannot come apart. A jointed car has an unbounded number of ways to fail
(wheels catching on seams, suspension resonating, an axle popping on a landing), and every one of
them is a solver problem you have no vocabulary to describe, let alone fix.

Wheel models are placed at each ray's contact point and spun by how far the car actually travelled,
so a braked wheel locks. They collide with nothing — the ray already decided where the wheel is.

### Settings that matter most

- **Time to lock.** Instant steering is the single thing that makes a car feel like a toy: the tyre
  force changes direction in one step and the chassis jerks sideways.
- **Lock lost at speed.** Zero leaves full lock available at 100 km/h, which spins the car on any
  input. Real cars solve this with steering-rack geometry; games solve it with this number.
- **Suspension stiffness.** Too soft and the car wallows and grounds out on every rise; too stiff and
  it skips off bumps and loses grip exactly when it needs it.

### The trap worth knowing about

The engine's default gravity is **24**, not 9.81 — the character controller wants a heavier-feeling
world than Earth. A 900 kg car there weighs 21.6 kN, so springs that would hold it up on Earth do
not. When they lose, the chassis sinks until its own collider rests on the ground, which puts the
wheel hubs _below_ the surface where their rays find nothing at all. The car is then dead for good,
sitting at full throttle with no traction — and nothing about it looks like a suspension problem.

The panel warns using the object's actual mass and the level's gravity, because that failure cannot
be seen from the vehicle settings alone.

### Known gap

Driving is proven against the solver — a default car drives 45 metres, brakes, steers and holds its
top speed under test. **Inside the editor's Play Preview it does not**: the chassis settles onto its
belly with no wheel in contact. Getting in and out works, and the throttle reaches the solver. This
is tracked and not yet fixed.

---

## What is not here

Stated plainly, because a list of features reads as a list of promises.

- **No joint angle limits.** Hinges and sliders have travel limits; ball sockets do not, which is
  why ragdoll elbows bend backwards.
- **No runtime mesh fracture.** Destructibles name a debris asset; nothing is cut at runtime.
- **No cloth, no soft bodies, no fluids.**
- **No continuous collision detection.** A very fast small object can pass through a thin wall
  between two steps.
- **Physics runs on the main thread.** A long garbage collection stalls the simulation with
  everything else.

---

## Where the code is

| Area                       | File                                               |
| -------------------------- | -------------------------------------------------- |
| The world, bodies, joints  | `packages/engine/src/physics/PhysicsWorld.ts`      |
| Walking, jumping, mantling | `packages/engine/src/physics/PlayerController.ts`  |
| Driving                    | `packages/engine/src/physics/VehicleController.ts` |
| Going limp                 | `packages/engine/src/physics/Ragdoll.ts`           |
| Breaking                   | `packages/engine/src/combat/DestructibleSystem.ts` |
| Building it from a scene   | `packages/engine/src/physics/buildScenePhysics.ts` |
