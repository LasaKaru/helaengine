# SPRINT.md — Full Sprint-by-Sprint Execution Plan (Phase 0 → GA Launch)

### Companion to GUIDE.md (architecture overview) and DEVELOPMENT-PLAN.md (stack/infra rationale). This file is the actual day-to-day backlog — every sprint has: Goal, Detailed Tasks, Tech Notes, Deliverables, Definition of Done (DoD), and Watch-outs.

**Sprint length:** 2 weeks. **Total:** 26 sprints to public beta (~13 months) + Phase 7 GA (2 sprints, ~2 months).

**Progress:** Sprints 1–29 complete. Phase 4 (Backend Platform) is under way: accounts, organisations and role-gated access in Sprint 28, cloud save with append-only version history in Sprint 29. Phase 3 (Export) is done — build a world visually, get real runnable code, verified in three browsers by a suite that exports it, serves it and compares the pixels — and **Phase 3B (Pre-Delivery Validation & Hosted Play, Sprints 24–27) has begun**: every build is now played by a robot before anybody can have it, which found a starter template whose player spawned inside a building on the very first run. Phases 1 (Editor MVP), 2 (Behaviours, Physics, AI) and 2B (Gameplay Runtime & UI) done — 2B was inserted ahead of the export system because exporting a world with no menus, HUD, combat or sound would be shipping a viewer rather than a game. Everything from the old Sprint 13 onward has been renumbered accordingly; see `GAMEPLAY-RUNTIME-AND-QA-PLAN.md`. Checkboxes below are ticked as each sprint lands — this file is the live backlog, not a snapshot of the original plan.

---

## PHASE 0 — FOUNDATIONS

**Duration:** Sprints 1–2 (1 month) | **Outcome:** Engine skeleton + asset pipeline working locally, zero React involved yet.

### Sprint 1 — Repo, Schema, Engine Skeleton

**Goal:** Prove the core architectural bet (schema-driven, framework-free engine) before building any UI.

**Tasks:**

- [x] Set up monorepo with Turborepo or Nx: `/apps/editor` (empty for now), `/packages/engine`, `/packages/schema`, `/apps/api` (empty for now)
- [x] Configure shared TypeScript config, ESLint, Prettier across packages
- [x] Install and configure `eslint-plugin-boundaries` (or similar) with a rule: `/packages/engine` must never import from `/apps/editor` or any React package — enforce this from commit #1
- [x] Define the scene schema in `/packages/schema` using Zod: `SceneSchema`, `ObjectSchema`, `TransformSchema`, `TerrainSchema`, `EnvironmentSchema` (start minimal — position/rotation/scale + assetId only, expand in later sprints)
- [x] Generate TypeScript types from Zod schemas (`z.infer<>`) — single source of truth for types across engine, editor, and future backend
- [x] `/packages/engine`: build `SceneLoader` class — takes parsed scene.json, instantiates a Three.js `Scene`, `PerspectiveCamera`, basic `WebGLRenderer`, adds a ground plane, iterates `objects[]` and places placeholder meshes (boxes) at correct transform
- [x] Write a hardcoded `demo-scene.json` (3-5 objects) by hand
- [x] Build a bare `index.html` + `main.js` in a `/apps/demo` folder that imports the engine package and renders `demo-scene.json` with zero build tooling beyond a simple dev server (Vite in library mode, or plain ES modules + import maps)
- [x] Set up GitHub Actions CI: install deps, typecheck, lint, run unit tests on every PR
- [x] Write initial unit tests for `SceneLoader` (Vitest) — does it place objects at correct world coordinates given a schema

**Tech notes:**

- Use Vite for the demo app's dev server, but make sure the _built_ engine output is plain ES modules with no bundler-specific runtime requirement — this matters later for the exporter (Sprint 13) which needs to ship engine code that runs in any static HTML page.
- Keep `SceneLoader` synchronous-friendly at this stage (no async asset loading yet — that's Sprint 2+).

**Deliverables:** Monorepo scaffold, Zod schema v0, working `SceneLoader`, CI pipeline green.

**Definition of Done:** Running `npm run demo` (or `pnpm dev` in `/apps/demo`) opens a browser tab showing 3-5 colored boxes positioned per `demo-scene.json`, using zero React, zero Redux/Zustand — pure Three.js driven entirely by the JSON.

**Watch-outs:** Don't over-build the schema yet. Resist the urge to add behaviors/physics fields now — schema grows sprint by sprint as features need it. Premature schema completeness just means more migration work later.

---

### Sprint 2 — Asset Pipeline v0

**Goal:** Get real glTF assets (not placeholder boxes) flowing from Blender through compression into the engine, with a manifest system.

**Tasks:**

- [x] Write the Blender export convention doc: unit scale (1 unit = 1 meter), pivot at object base/origin, max poly budget per asset tier (e.g., <2k tris for props, <8k for buildings), naming convention (`category_name_variant.glb`), texture atlas guidance for low-poly style
- [x] Source or model 10 starter assets: 3 tree variants, 2 rocks, 1 building, 1 enemy (rigged if animated, static if not), 1 terrain texture set, 2 misc props
- [x] Install and script `gltf-transform` CLI pipeline: `gltf-transform optimize` with Draco geometry compression + KTX2/Basis texture compression as a Node script (`scripts/ingest-assets.ts`)
- [x] Define `AssetManifestEntry` schema in Zod: `{ id, category, tags[], glbPath, thumbnailPath, defaultScale, colliderType, polyCount }`
- [x] Write a headless thumbnail generator: spin up Three.js + `WebGLRenderer` in a headless/offscreen context (e.g., via `node-canvas` + `gl`, or Puppeteer screenshot of a local render page) to produce a PNG thumbnail per asset automatically
- [x] Script `pnpm ingest-assets ./raw-assets ./public/assets` that: reads raw GLBs → compresses → writes thumbnail → appends manifest.json entry
- [x] Extend `SceneLoader` (from Sprint 1) to actually load real GLBs via `GLTFLoader` + `DRACOLoader`/`KTX2Loader`, replacing the placeholder boxes, using `assetId` to look up manifest entries
- [x] Add loading state handling (promise-based async load, basic loading spinner in demo page)

**Tech notes:**

- Keep manifest.json local/static for now (no backend) — it's just a JSON file the demo app fetches. Backend-driven manifest comes in Phase 4.
- Test compression quality visually — low-poly style is forgiving, but verify Draco compression doesn't introduce visible artifacts at your poly budgets.

**Deliverables:** 10 production-usable compressed assets, ingest script, manifest.json v0, engine loads real GLBs.

**Definition of Done:** Running the ingest script on a folder of 10 raw GLBs produces compressed GLBs + thumbnails + a valid manifest.json automatically, and `demo-scene.json` referencing these `assetId`s renders the real trees/building/enemy models (not boxes) in the browser.

**Watch-outs:** Don't hand-pick asset scale/rotation fixes inside the engine code — if an asset's pivot/scale is wrong, fix it at the Blender/export step per the convention doc, or your exported projects will inherit hacky per-asset special cases.

---

## PHASE 1 — EDITOR MVP

**Duration:** Sprints 3–8 (3 months) | **Outcome:** Full local-only editor — place, transform, terrain, save/load — no backend required yet.

### Sprint 3 — Editor Shell + Viewport

**Goal:** Stand up the React editor app and prove it renders the same scene via the same engine package, live-reactive to state changes.

**Tasks:**

- [x] Scaffold `/apps/editor`: React + Vite + TypeScript
- [x] Install react-three-fiber + drei; set up `<Canvas>` with `OrbitControls`, `Grid` helper, basic three-point lighting rig (key/fill/ambient)
- [x] Set up Zustand `sceneStore` mirroring the Zod scene schema exactly (start with `objects[]`, `terrain`, `environment`)
- [x] Build a thin r3f wrapper component `<EngineBridge>` that reads `sceneStore` state and calls into `/packages/engine`'s `SceneLoader`/object-spawning logic — critical: the _logic_ for instantiating objects lives in the engine package, r3f is just the render-loop host
- [x] Verify: mutate `sceneStore` from Redux DevTools (Zustand supports devtools middleware) and confirm viewport updates live without manual refresh
- [x] Basic top bar UI shell (logo, project name placeholder, save button placeholder) and empty side panel containers (asset library, inspector — populated in later sprints)
- [x] Set up Vitest + React Testing Library for component tests; Playwright scaffold for e2e (even if only 1 smoke test exists so far)

**Tech notes:**

- Resist putting object-spawning logic directly in a React component via `useEffect` + raw Three.js calls — route everything through the shared engine package's classes/functions so editor and export stay in sync architecturally from the start.

**Deliverables:** Editor app renders empty scene; state-driven rendering proven.

**Definition of Done:** Opening `/apps/editor` shows an empty grid/ground viewport with working orbit camera; manually dispatching an "add object" action via devtools makes a real GLB asset (from Sprint 2's manifest) appear correctly positioned in the viewport.

---

### Sprint 4 — Asset Library Panel + Drag-Drop Placement

**Goal:** User can browse assets and place them in the world by dragging.

**Tasks:**

- [x] Build Asset Library side panel: category tabs (Trees, Rocks, Buildings, Enemies, Props), search input, virtualized grid (react-window or react-virtuoso) showing thumbnail + name per manifest entry
- [x] Implement native HTML5 drag events (`dragstart` on asset card, `dragover`/`drop` on canvas) OR pointer-based drag (recommend pointer-based for consistency with the transform gizmos coming in Sprint 5 — avoids mixing two different interaction paradigms)
- [x] On drag-over-canvas: raycast from pointer through camera against the terrain mesh; show a semi-transparent "ghost" preview mesh at the hit point, oriented to surface normal
- [x] On drop: generate a new object ID (uuid), push a new entry into `sceneStore.objects[]` with position = hit point, rotation aligned to normal (or locked to Y-up if you prefer non-tilted placement — decide and document)
- [x] Add a "snap to grid" toggle (rounds position to nearest 0.5m/1m) and a "random rotation on place" toggle (useful for scattering foliage naturally)
- [x] Handle edge case: drop with no terrain hit (e.g., dropped in open sky) — either reject the drop or place at a default ground Y

**Tech notes:**

- Use `THREE.Raycaster` against a dedicated invisible collision proxy for terrain if your visual terrain mesh is high-poly — cheaper raycasting target.

**Deliverables:** Working asset panel + drag-drop-to-place flow.

**Definition of Done:** User can drag each of the 5+ asset categories from the panel onto the terrain and see them appear, correctly grounded and oriented, with snap-to-grid and random-rotation toggles both functioning.

---

### Sprint 5 — Transform Gizmos + Inspector

**Goal:** Full select/move/rotate/scale/duplicate/delete workflow.

**Tasks:**

- [x] Wire up drei's `<TransformControls>` to the currently-selected object; support translate/rotate/scale modes
- [x] Decide and implement keybind scheme — **chose Unity/PlayCanvas-style W/E/R**, documented in `apps/editor/src/useShortcuts.ts` and surfaced in an in-app reference modal (`?`). Rationale: the audience is browser-game makers, most of whom meet Unity or PlayCanvas before Blender.
- [x] Build click-to-select (raycast against object meshes, not just terrain) with visual selection outline/highlight (e.g., outline post-processing pass or simple bounding-box helper)
- [x] Build Inspector panel: numeric X/Y/Z fields for position/rotation/scale bound two-way to `sceneStore`, with drag-to-scrub number inputs (common editor UX pattern)
- [x] Implement multi-select: shift-click to add to selection, marquee/box-select (drag on empty canvas draws a selection rectangle, raycasts/projects all objects inside it)
- [x] Group transform: when multiple objects selected, gizmo operates on the group's pivot, applying deltas to all selected objects' transforms
- [x] Implement Duplicate (Ctrl+D — offsets position slightly) and Delete (Del key, with confirmation for multi-select of 5+ objects to prevent accidental mass-delete)

**Tech notes:**

- Keep the "snap to grid" toggle from Sprint 4 also applicable during gizmo drags, not just initial placement.

**Deliverables:** Full manipulation toolkit.

**Definition of Done:** User can select single or multiple objects, move/rotate/scale via gizmo or numeric inspector fields, duplicate, and delete — tested against at least 20 objects in a scene without gizmo lag or selection bugs.

---

### Sprint 6 — Undo/Redo + Scene Graph Tree

**Goal:** Non-destructive editing confidence + hierarchical organization.

**Tasks:**

- [x] Implement command-pattern middleware wrapping every `sceneStore` mutation: each command has `do()` and `undo()` — NOT full-state snapshots (snapshots get expensive/memory-heavy past a few hundred objects)
- [x] Wire Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) to a command history stack with a reasonable depth limit (e.g., 100 steps)
- [x] Build Scene Graph tree panel: hierarchical list view of all objects, supporting drag-to-reparent (e.g., attach a lamp prop as a child of a building object)
- [x] Update schema to support `parentId` on objects; ensure transforms are applied in parent-local space when nested, world space when root-level
- [x] Sync selection state bidirectionally between viewport clicks and scene graph tree clicks/highlights
- [x] Add rename-in-place for objects in the tree (double-click to edit label, stored as `metadata.label`, distinct from `assetId`)

**Tech notes:**

- Test with rapid consecutive actions (drag gizmo generates many small deltas) — consider debouncing/batching drag-in-progress into a single undo command on drag-end, not one command per mouse-move frame.

**Deliverables:** Robust undo/redo, hierarchical scene graph.

**Definition of Done:** 50+ consecutive undo/redo operations complete without state corruption or visual desync; dragging an object onto another in the scene tree correctly nests it and preserves its world-space visual position (compensating the local transform).

---

### Sprint 7 — Terrain Tools

**Goal:** Sculptable, paintable terrain — the "base" the user builds on.

**Tasks:**

- [x] Implement heightmap-based terrain: a plane geometry with vertex displacement driven by a heightmap texture (canvas-based, editable)
- [x] Build sculpt brush tool: raise/lower/smooth/flatten modes, adjustable brush radius + strength, applied via raycast-hit-point painting onto the heightmap canvas, re-uploaded to GPU each stroke (throttled/debounced for performance)
- [x] Build layer painting: splat weights for 4 layers (grass/rock/sand/dirt), blended **per vertex** into `MeshStandardMaterial`'s vertex colours rather than per pixel through a custom shader. Reason: there are no terrain _textures_ in the library yet — assets are flat-shaded and untextured — so there is nothing to sample. At low-poly vertex densities the grid is the paint resolution, and it keeps the material something any exported project renders with no shader plumbing. Swap to a texture-space splat map when textured terrain assets exist; the stored weights are the same either way.
- [x] Add terrain configuration on new-project creation: size (e.g., 128x128, 256x256), resolution/subdivision count
- [x] Persist heightmap + splatmap as data in `scene.json` (base64-encoded PNG or a compact float array — decide based on size tradeoffs; likely store as an uploaded/generated texture asset reference rather than inline for large terrains)
- [x] Performance check: ensure sculpting at expected brush sizes doesn't drop frame rate below acceptable threshold on target hardware

**Tech notes:**

- This is one of the more technically involved sprints — budget extra buffer. If timeline is tight, a v0 fallback is "flat terrain only, texture painting only, no sculpting" and defer height sculpting to a later sprint — document this as a deliberate scope cut if taken.

**Deliverables:** Sculptable + paintable terrain system.

**Definition of Done:** User can raise a hill, smooth it, and paint a grass/rock blend across it; terrain data round-trips correctly through save/serialize (verify by exporting scene.json, reloading, terrain looks identical).

---

### Sprint 8 — Save/Load (Local-First)

**Goal:** Persistence without needing the backend yet — proves the schema is solid before more features pile on.

**Tasks:**

- [x] Integrate Dexie.js (IndexedDB wrapper) for local project storage
- [x] Build save flow: serialize `sceneStore` → validate against Zod schema → write to IndexedDB keyed by project ID
- [x] Build load flow: read from IndexedDB → Zod-validate → hydrate `sceneStore`; handle validation failure gracefully (surface error, don't silently corrupt state)
- [x] Add a schema `version` field and a stub migration registry (`migrations/v1-to-v2.ts` etc.) even if empty right now — establishes the pattern before real migrations are needed
- [x] Build "New Project" flow: blank template vs. pick-from-starter-template (hand-build 2-3 starter `scene.json` files representing different scenarios — e.g., "empty field," "small village layout," "forest clearing")
- [x] Build a basic Projects list/home screen (local-only for now) showing saved projects with thumbnail (can be a simple canvas screenshot capture of the viewport at save time) and last-modified date
- [x] Add autosave (debounced, e.g., every 30-60 seconds of inactivity, or on major actions) to reduce risk of data loss during long sessions

**Deliverables:** Full local persistence loop, template picker.

**Definition of Done:** Close the browser tab mid-edit, reopen, project state auto-restores correctly including terrain, all objects, and their behaviors-to-be (schema slot reserved even if behaviors aren't implemented until Phase 2). Starter template picker loads a real, non-trivial starter scene correctly.

**Phase 1 wrap check:** At this point you should be able to demo a genuinely usable (if behavior-less) world editor end-to-end. This is a good internal milestone to pause and get outside eyes (even 2-3 informal testers) on basic usability before piling on Phase 2 complexity.

---

## PHASE 2 — BEHAVIORS, PHYSICS, AI

**Duration:** Sprints 9–12 (2 months) | **Outcome:** Enemies, physics, triggers working in live preview.

### Sprint 9 — Behavior System Architecture

**Goal:** Build the plugin system that keeps "code generation" honest — behaviors are a closed, registered vocabulary, not free-form scripts.

**Tasks:**

- [x] Design the `Behavior` base interface in `/packages/engine`: `onInit(gameObject, params)`, `onUpdate(gameObject, deltaTime)`, `onEvent(gameObject, eventName, payload)`, `onDestroy(gameObject)`
- [x] Build a `BehaviorRegistry` (simple `Map<string, BehaviorClass>`) with a `registerBehavior(typeName, class)` function
- [x] Implement first behavior: `PatrolBehavior` (moves object along a list of waypoints, looping or ping-pong mode, configurable speed)
- [x] Extend scene schema: `objects[].behaviors[]` array, each entry `{ type: string, params: Record<string, unknown> }`
- [x] Define a **per-behavior params schema** (Zod) so the editor can auto-generate a property form (e.g., `PatrolParamsSchema = z.object({ waypoints: z.array(Vec3Schema), speed: z.number() })`) — this is what lets you add new behaviors later without hand-writing custom UI each time
- [x] Build editor UI: "Add Behavior" dropdown on Inspector panel (lists registered behavior types), dynamically renders the property form from the behavior's Zod schema (use a simple schema-to-form renderer — write a small one or evaluate `react-jsonschema-form` adapted for Zod via `zod-to-json-schema`)
- [x] Build waypoint-editing UX specifically for Patrol: click-to-add waypoint markers directly in the 3D viewport (a common "path editing" interaction pattern)

**Tech notes:**

- This sprint sets the ceiling for how safe/sandboxed your export ever is — do not let any behavior's `params` contain executable code strings (no `eval`, no `new Function()`). If you eventually want a "custom script" power-user feature, that's a deliberate, separately-sandboxed future feature (see DEVELOPMENT-PLAN.md future roadmap), not something to sneak in here.

**Deliverables:** Behavior plugin architecture + first working behavior (Patrol) with auto-generated UI.

**Definition of Done:** Attaching "Patrol" to an object via the Inspector, defining 3 waypoints by clicking in the viewport, produces correct looping movement in the live preview — and the exact same `PatrolBehavior` class (unmodified) is what will later run in exported projects.

---

### Sprint 10 — Physics Integration (Rapier)

**Goal:** Real collision and gravity so objects/characters interact believably with terrain and each other.

**Tasks:**

- [x] Integrate `@dimforge/rapier3d-compat` (WASM); build a `PhysicsWorld` wrapper class in `/packages/engine` that steps the Rapier world in sync with the Three.js render loop — fixed timestep with an accumulator, so collision resolution does not depend on frame rate
- [x] Add `colliderType` handling from asset manifest (box/capsule/mesh/none) — auto-generate Rapier colliders when objects are instantiated based on their manifest default, with per-instance override option in Inspector (`object.physics.collider`, defaulting to `auto`)
- [x] Implement static vs. dynamic vs. kinematic body types; terrain itself should be a static trimesh (or heightfield) collider matching the sculpted terrain from Sprint 7 — heightfield, transposed from the field's row-major layout into Rapier's
- [x] Build a basic character controller (using Rapier's `KinematicCharacterController`) for a "player" template object — WASD movement + gravity + slope handling, used for the "test play" mode in the editor (a play-in-editor button that lets you walk around your world)
- [x] Sync Rapier rigid body transforms back to Three.js object transforms each frame (position/rotation) — including converting a parented node's result back into its parent's space
- [x] Add a "Play Preview" mode toggle in the editor UI: switches from edit-camera to first/third-person player-controlled camera, runs the physics/behavior simulation live, Escape to exit back to edit mode — **first-person only**; a third-person rig is a camera change, not a physics one, and was left for when there is a character model worth looking at

**Tech notes:**

- Rapier's WASM module needs async initialization — handle this cleanly at engine bootstrap (loading screen) rather than scattering readiness checks through the codebase.

**Deliverables:** Working physics world + playable test-preview mode.

**Definition of Done:** Entering Play Preview mode lets the user walk a character around the terrain, collide correctly with static props/buildings, and not fall through terrain or floating objects — verified across at least one hilly terrain scene from Sprint 7.

---

### Sprint 11 — Enemy AI (Yuka.js) + Triggers

**Goal:** Enemies that sense and react, and event-driven world logic (doors, spawns, scene transitions).

**Tasks:**

- [x] Integrate Yuka.js steering behaviors (seek, flee, pursue, wander, arrive) into the engine's per-frame update loop, driving Rapier kinematic bodies (not raw mesh transforms, so physics/collision stays consistent) — `SteeringAgent` re-seats the Yuka vehicle from the body each frame and hands back a target position; **seek, arrive and wander** are wired, pursue/evade wait for something that needs them
- [x] Build a simple FSM (finite state machine) wrapper for enemy AI states: `idle → patrol → chase → attack → dead`, using Yuka's built-in `StateMachine` utility or a lightweight custom one — the custom one, because Yuka's is generic over `GameEntity` and our states need the whole enemy context
- [x] Implement `ChaseOnSightBehavior`: uses a distance/line-of-sight check (raycast against terrain/obstacles to detect if the player is actually visible, not just in range) to trigger state transition from patrol to chase — range, then field of view, then a Rapier raycast, throttled to ~7 checks a second
- [x] Implement basic combat stub: `attack` state deals damage to player on proximity/timer, player has a `health` stat, `dead` state on enemy triggers a despawn/ragdoll-stub/loot-drop event — despawn and an `enemyDied` event; loot drops are a listener away and were left for whoever needs one
- [x] Build Trigger Volumes: new object type (box/sphere gizmo, non-rendering in play mode) with `onEnter`/`onExit`/`onEvent` schema fields; wire a simple in-engine event bus (`EventEmitter`-style) so triggers can fire named events (`spawnWave`, `openDoor`, `loadScene`, custom)
- [x] Editor UI: place trigger volumes like any other object (via a dedicated "Logic" category in the asset panel, even though triggers aren't visual assets), configure their event bindings via Inspector (dropdown of available event types + target object picker)

**Tech notes:**

- Line-of-sight raycasting every frame for every enemy can get expensive — throttle checks (e.g., every 100-200ms per enemy, not every frame) once you have dozens of active enemies; revisit in Sprint 12's perf pass if needed.

**Deliverables:** Working enemy AI FSM + trigger volume system.

**Definition of Done:** Placing an enemy with Patrol + ChaseOnSight behaviors, plus a trigger volume wired to "spawn additional enemy on enter," produces the expected behavior in Play Preview: enemy patrols until player is seen, then chases; entering the trigger volume spawns a new enemy.

---

### Sprint 12 — Behavior QA + Performance Pass

**Goal:** Make sure the system holds up with realistic scene density before moving to export.

**Tasks:**

- [x] Convert repeated static assets (trees, rocks, generic props) to `InstancedMesh` rendering — write an instancing manager in the engine that batches identical `assetId` static (non-animated, non-physics-dynamic) objects into single draw calls — **530 -> 57 draw calls** on the stress scene, with batched objects still selectable and movable in the editor
- [x] Implement object pooling for anything spawned/destroyed at runtime (projectiles, particle effects, loot pickups) to avoid GC churn from frequent allocation — `SceneLoader.recycle`, capped at 64 nodes per asset
- [x] Implement frustum culling verification (Three.js does this by default per-object, but verify it's actually effective with your scene structure — nested groups can sometimes defeat automatic culling) — verified in `instancing.test.ts`; nested groups do not defeat it. **LOD deliberately not built**: no asset is anywhere near its triangle budget, so there is nothing to swap. Reasoning recorded in `docs/PERFORMANCE.md`
- [x] Build a stress-test scene: 500+ static props (using instancing), 20+ active enemies with AI/physics, sculpted terrain — the **Stress Test** template, plus `pnpm bench` to measure it
- [x] Profile in Chrome DevTools (Performance + Memory tabs): identify and fix any obvious bottlenecks — profiled via the benchmark rather than DevTools (this is a headless container); simulation costs **2.0 ms/frame** of CPU with 20 enemies, and the render path is down to 57 calls
- [x] Document target performance bar (e.g., "60fps sustained on [reference hardware] with the 500-prop/20-enemy stress scene") — `docs/PERFORMANCE.md`. **The 60fps line is not verified here**: the only GPU in this container is SwiftShader, which is ~100x slower than real hardware. The two hardware-independent bars (draw calls, simulation CPU) are measured and met

**Deliverables:** Instancing, pooling, culling/LOD, documented perf benchmark scene + target.

**Definition of Done:** The stress-test scene holds the documented target frame rate on reference hardware, verified and recorded (screenshot/video of Chrome perf profile) as a baseline for future regression comparisons.

**Phase 2 wrap check:** This is your last checkpoint before building the export system — any behavior/physics/AI code that still has React or Zustand imports anywhere in its call chain must be refactored out now. Audit the `/packages/engine` import graph explicitly before Sprint 13.

- [x] Done as a test rather than a one-off audit: `packages/engine/src/boundaries.test.ts` walks every runtime source and fails on an import of React, r3f, Zustand, Immer, Dexie or the editor, on any path leaving the package, on a dependency the manifest does not declare, and on `eval`/`new Function`. It runs with the ordinary test suite, so it cannot rot.

---

## PHASE 2B — GAMEPLAY RUNTIME & UI

**Duration:** Sprints 13–20 (4 months) | **Outcome:** An exported project is a _game_ — menus, HUD, combat, checkpoints, audio, optional co-op — not a scene you can walk around in.

**Why this sits here and not after export:** exporting today would hand someone a world with no way to start it, no way to lose, no way to pause and no sound. That is a world viewer, not a game. Full detail in `GAMEPLAY-RUNTIME-AND-QA-PLAN.md`; this section is the backlog form of it.

---

### Sprint 13 — Camera & Player Controller System

**Goal:** A player who can actually be controlled — in first or third person, with keyboard, touch or a gamepad.

**Tasks:**

- [x] Build the FPS camera rig on top of Sprint 10's Rapier kinematic controller: head-height offset, pointer-lock mouse-look, optional head-bob — the bob is driven by distance travelled rather than elapsed time, so it slows when the player does and stops in mid-air
- [x] Build the TPS camera rig: spring-arm follow with collision avoidance, so the camera never ends up inside a wall — pulls in instantly, eases back out
- [x] Build `InputManager` — one abstract action set fed by keyboard/mouse, touch (virtual joystick + buttons) and the Gamepad API. Plus a `topdown` rig, since the schema names three modes and shipping two would have left one lying
- [x] Add `gameConfig` to the schema (`cameraMode`, `allowModeSwitch`, multiplayer settings) and select the rig at scene load; implement the runtime toggle when `allowModeSwitch` is on (**V**)
- [x] Extend the character controller with sprint and crouch — crouch really resizes the capsule, and standing up is refused when there is no headroom
- [x] **Added, not in the original task list:** a capsule stand-in body for the player. Third person with nothing to look at is not a camera mode, it is a bug; a real character model waits on Sprint 37's asset library

**Tech notes:**

- The input abstraction has to be designed once, generically. Bolting touch on per-platform later is how an engine ends up with three divergent control paths.
- Pointer lock and the Gamepad API are both browser features a headless test cannot fully drive; plan on a dev-API hook for automated verification, as Sprint 10 needed for look.

**Deliverables:** Three camera rigs, one input layer, `gameConfig` in the schema.

**Definition of Done:** A test scene is playable end to end in both FPS and TPS with keyboard and mouse, and verified functional with touch input on a mobile browser and with a connected gamepad.

**Met, with one gap stated plainly:** keyboard/mouse is verified end to end in a real browser across all three rigs. **Touch and gamepad are verified by unit test, not on hardware** — this container has neither a touchscreen nor a controller, and Chromium's headless mode reports no gamepads. The touch overlay is exercised in jsdom (it builds, its buttons raise actions, it tears down) and the gamepad path is driven through a synthetic `Gamepad` covering sticks, deadzone, the standard button map and the refusal of non-standard mappings. Someone with the hardware should confirm before this is called done for real.

---

### Sprint 14 — Menu/UI Renderer Foundation

**Goal:** The shell around the game: a home screen, menus, and a pause loop, all driven by the document.

**Tasks:**

- [x] Build `UIRenderer` — a DOM+CSS overlay driven entirely by `uiConfig`, mounted alongside the WebGL canvas. Structurally the same idea as `SceneLoader`: data in, interface out, no per-project code
- [x] Home screen: background image, optional intro video (skippable, autoplay-muted then unmuted on interaction, respecting browser autoplay policy), title, Play button
- [x] Main menu and pause menu as button lists bound to a registered **UI action** vocabulary (`startGame`, `openSettings`, `quit`, `resume`, `restartCheckpoint`, `mainMenu`, `closeSettings`) — closed, exactly like behaviours
- [x] Theme system: four presets plus optional accent/font overrides and three panel styles, applied as CSS custom properties so one swap restyles every surface
- [x] **Added, not in the original list:** a HUD — crosshair, health bar, ammo counter and schema-described custom elements with value bindings. The `playing` screen had to render _something_, and a shell that showed menus but no HUD would have needed rebuilding in Sprint 16 anyway

**Tech notes:**

- DOM overlay rather than in-3D UI meshes: text quality, accessibility and customisation all favour the DOM, and an in-world menu is a niche the engine can add later without redoing this.

**Deliverables:** `UIRenderer`, home/main/pause screens, theme presets.

**Definition of Done:** A full home → main menu → play → pause → resume loop works in preview, and swapping the theme preset restyles every menu without touching any individual button config.

**Met.** Verified in a real browser end to end. Two notes: the intro-video path is covered by unit test rather than by a real file, because the asset pipeline has no video ingest until Sprint 19; and the editor-side authoring UI is deliberately minimal here — title, theme, panel style, HUD toggles — because building it properly is Sprint 15's entire job.

---

### Sprint 15 — Editor-Side UI Customization Tools

**Goal:** All of Sprint 14's configuration editable by someone who has never seen JSON.

**Tasks:**

- [x] Build the in-editor "Game UI" panel: home screen image/video/title, menu button list (add, remove, reorder, relabel, reassign action), HUD toggles
- [x] Custom HUD elements (`hud.customElements[]`): text and image overlays with anchor/position controls and variable binding (health, ammo, score, timer)
- [x] Extend the asset upload flow to accept images and video for UI use — stored as Blobs in IndexedDB, because there is no server yet and the editor is local-first by design. Sprint 30 swaps the storage without any of this UI changing
- [x] **Added:** the play clock behind the `timer` binding, and per-file validation on upload (accepted types, a 24 MB ceiling) with the reason shown rather than a silent refusal

**Definition of Done:** A non-technical tester can change the home screen image, swap the intro video, rename and reorder menu buttons and add a custom HUD text element without help, and see it all in Play Preview.

**Met**, with one honest gap: the _intro video_ path is exercised end to end as an upload, a reference and a skip, but there is no real video in the repository to play, so actual playback is not verified. Media ingest proper is Sprint 19's job. Everything else is driven in a browser — an uploaded PNG becomes the home screen background, buttons rename and reorder, and a bound HUD element shows a live value.

---

### Sprint 16 — Weapons, Health, Ammo, Combat

**Goal:** Something to do in the world besides walk around it.

**Tasks:**

- [x] Add `inventory` to the schema (a weapon catalogue plus a starting loadout) and implement runtime inventory state — held weapon, clip, reserve, carry limit. **`playerConfig` already exists as `scene.player`**, so the sprint's combat settings (`respawnSeconds`, `damageCooldown`) were added there rather than as a second, overlapping section
- [x] Wire weapon firing through `InputManager`: fire action → hitscan ray → hit check → `damage` event on the existing bus, which is the message enemies already answer to
- [x] Extend the health/damage flow from Sprint 11 to the player; death triggers a respawn stub (full checkpoint integration lands in Sprint 18)
- [x] Pickup behaviour: adds to inventory or health, despawns or hides itself, raises a named SFX event
- [x] Inspector support for weapon stats and starting inventory — a Weapons panel over the catalogue, and the Pickup behaviour's form generated from its schema like every other behaviour's
- [x] **Added:** `reload` and `nextWeapon` input actions (R, Q, shoulder buttons, touch buttons); a `damageCooldown` so a crowd cannot chain-kill the player in one frame; and a **Skirmish** scene template that is this sprint's definition of done made into a level

**Tech notes:**

- **Hitscan only.** A ray with a range and a damage number is the shape almost every low-poly shooter needs, it costs one query per shot, and it is exactly reproducible in an export. Projectiles are a different simulation — travel time, gravity, a body per bullet — and folding them in as a `kind` field would leave half the weapon schema meaning nothing for one of the two options.
- Damage leaves the weapon as a `damage` event with a `targetId`, so a weapon can hurt anything that listens, including things it has never heard of. Nothing in `WeaponSystem` imports an enemy behaviour, and it takes its ray cast as a callback rather than a `PhysicsWorld` — which keeps combat testable without WASM and keeps physics ignorant of weapons.
- A pickup **asks** the world to take it and obeys the answer. A medkit at full health and an ammo box for a gun the player is not carrying both stay where they are. Swallowing the item and giving nothing is the single most annoying bug this kind of behaviour has.

**Definition of Done:** A test scene with a weapon pickup, an enemy and health/ammo pickups is fully playable: pick up a weapon, shoot an enemy, take damage, heal with a medkit, all reflected in the HUD.

**Met.** The Skirmish template is that scene, and it is played end to end in a real browser: walk onto the crate and the pistol arrives with eight rounds, shoot a goblin dead, R reloads out of the reserve, a medkit refuses to be taken at full health and heals 30 → 70 once the player is hurt, and dying respawns rather than throwing the player out to the editor.

Two things worth recording. First, aiming turns out to be genuinely vertical: the player's eye sits at 1.65 m and a goblin capsule is 1.70 m tall, so a perfectly level shot grazes the tapering top of the capsule and misses. A human aims at the chest without thinking about it; a test has to be told to, which is why the dev API grew a `setPlayerLook(yaw, pitch)`. Second, the weapon **switch** path is only covered with one weapon carried, because nothing in the shipped content grants a second — the multi-weapon cycle is unit-tested rather than played.

---

### Sprint 17 — Unlockables / Secret Methods

**Goal:** Secrets, as data rather than as code.

**Tasks:**

- [x] Build the `unlockables` vocabulary — `inputSequence` (Konami-style) and `triggerVolume`, plus `event` and `itemCount`, which the plan's "etc." named and which cost almost nothing once the bus is in play
- [x] Build the unlock actions: `teleportPlayer`, `unlockInventoryItem`, `revealArea`, plus `emit`
- [x] Editor "Secrets" panel so none of it requires touching raw JSON — both pickers are built from the schema's unions rather than a hand-kept list, so the panel cannot offer something the runtime cannot do
- [x] **Added:** `triggerEntered` / `triggerExited` on the bus, so entering a volume is observable whether or not the author gave it any actions; `InputManager.sequenceKeys`, a named-button stream (keyboard, gamepad d-pad and faces, touch); and two secrets in the Skirmish template — a Konami code that grants a rifle, and an alcove that reveals a hidden hut

**Tech notes:**

- The closed vocabulary is a **Zod discriminated union plus an exhaustive switch**, not a `register()` map. That is the same guarantee behaviours get, obtained at both ends at once: Zod rejects a `type` it has never heard of when the document is parsed, and TypeScript refuses to compile a runtime that fails to handle every arm. A string-keyed registry can silently drift open; this cannot. `scene.test.ts` pins it by feeding the parser `{"type": "runScript", "source": "alert(1)"}` and asserting the document is rejected.
- A `revealArea` action is _why_ its objects start hidden — the runtime hides everything named by an unfired reveal at startup rather than making the author maintain a separate "hidden" flag that could disagree with the list. Hiding takes the collider with it, because an invisible wall the player still walks into is the most confusing possible reading of a secret area.
- `unlockInventoryItem` goes through `world.collect`, the same door a pickup uses, so a secret weapon arrives with its ammo and obeys the carry limit instead of bypassing both.
- Sequences are matched against a rolling window rather than by tracking an index. Index tracking gets the self-overlapping case wrong: `Up Up Down` against the sequence `Up Down` must succeed on the third key, and an index resets on the second `Up` and never matches.

**Definition of Done:** A scene with both an input-sequence secret and a hidden-trigger secret works in Play Preview and is configurable entirely through the editor.

**Met.** The Skirmish template carries one of each and both are played in a real browser: the hut is genuinely absent from the viewport until the player walks into the alcove, and the Konami code grants a rifle with 24 rounds in it. A third secret is authored from scratch through the panel — label, method, event name, a teleport action with coordinates — and the document saves, which is the only real proof it is valid.

One thing recorded rather than fixed: a stray key **does** break a sequence in progress, because the window is the last N presses. `Up X Down` is not `Up Down`. That is a decision (it is what a rolling window means) rather than an accident, and there is a test asserting it so nobody has to guess later. Unlocks are also **not persisted** — finding a secret and reloading loses it. Persistence is Sprint 18's save system, and `unlockedIds` is already the shape it will want.

---

### Sprint 18 — Checkpoints & Save System

**Goal:** Losing means something, and progress survives closing the tab.

**Tasks:**

- [x] Checkpoint objects, placeable and triggerable — a `checkpoint` behaviour, shaped exactly like `pickup`, because they are the same gesture: walk into a thing, something happens
- [x] Respawn at the current checkpoint on death, with per-checkpoint reset rules (full, partial or no health; ammo refilled or not)
- [x] Persistence: `SaveStore` over `localStorage`, with the storage injectable so hosted play (Sprint 27) swaps it without touching a caller
- [x] Editor placement and per-checkpoint config — the behaviour's form is generated from its schema like every other behaviour's, plus a **Progress** panel that reports the save and can throw it away
- [x] **Added:** `SaveState` as a schema, validated on read; `Inventory.snapshot/restore/refillAll`; `UnlockRuntime.restore`; and two checkpoints in the Skirmish template, the deeper one more generous than the first

**Tech notes:**

- **A save is validated on the way in.** `localStorage` is a text field the player can edit, so an exported game reading one back is reading untrusted input in exactly the sense the rest of this codebase means. A save that does not parse is discarded and the run starts fresh — worse than resuming, far better than a crash on load. Counts are clamped to the weapon's own ceilings on restore, so a hand-edited save cannot mint ammo or health.
- **A save holds state, never structure.** Health, weapons, checkpoint, secrets found. Nothing in it names an object, an asset or a behaviour, so no save — however edited — can change what a scene _contains_.
- The reset rules travel with the checkpoint request rather than being looked up at respawn time, so a checkpoint reached before its rules were edited keeps the rules it was reached under. A save records what happened, not what the document says now.
- Restoring a save does **not** re-run the unlock actions: a teleport on load would drop the player somewhere they did not ask to be, and a granted weapon is already in the restored inventory. Only `revealArea` has a lasting world effect, and that is applied directly.
- Saving happens on the checkpoint rather than on a timer. A checkpoint _is_ the author saying "this moment is worth keeping"; a periodic autosave would second-guess them.

**Definition of Done:** The player reaches a checkpoint, dies, respawns there with correctly reset stats; closing and reopening an exported build resumes from the last checkpoint.

**Met for the first half and for everything the second half can currently be**, and the distinction is worth being precise about. Reaching a checkpoint, dying and coming back with the right stats is played end to end in a browser, including a checkpoint that refills ammo and one that does not. Progress surviving a **full page reload** is also played end to end — but through the editor's Play Preview, because there is no exporter until Sprint 21. That is the same `SaveStore`, the same `captureSave`/`restoreSave` and the same `localStorage` key an export will use, so Sprint 21 inherits an exercised save system rather than a blind one; what it does not yet prove is the export wrapper around it.

Two things found by playing it. A checkpoint marker made from a fence **blocks the player** — a checkpoint you bounce off is a wall with a saving throw attached, so the template's markers now carry `collider: 'none'`. And the Progress panel's "Clear saved progress" button broke two long-standing tests, because Playwright's `name` option is a substring match and "Clear saved progress" matches "Save"; the locators are anchored with `exact: true` now.

---

### Sprint 19 — Audio System

**Goal:** Sound, which is half of what makes a scene feel like a game.

**Tasks:**

- [x] Howler.js for music, with a state-driven crossfade between menu, exploration and combat tracks; positional one-shots placed at the object that raised the event
- [x] Bind SFX to engine events: damage, pickup, checkpoint, weapon fire, reload, death, secrets — as a **list of bindings** rather than a fixed `onDamage`/`onPickup` map, because the event bus is already what everything talks through
- [x] Extend the ingest pipeline with an audio step: format normalisation and loudness levelling
- [x] Settings-menu volume mixer (master/music/SFX) plus editor-side defaults
- [x] **Added:** a combat _hold_ so the track does not flicker every time an enemy blinks; per-binding rate limiting; a stand-in audio generator (`pnpm generate-assets` now writes ten synthesised WAVs); and audio excluded from the placement library, because a sound is not something you drag onto the terrain

**Tech notes:**

- **No gameplay code knows that any of this makes a noise.** Behaviours already raise `pickup`, `checkpoint` and `enemyDied`; a scene binds a name to a clip and that is the whole integration. It is also why an author can put a sound on an event the engine has never heard of, from a pickup's `sfxEvent` or a trigger's `emit`.
- The music player takes its track factory as an option, so the crossfade is unit-tested without a sound card — which matters, because neither CI nor headless Chromium has one.
- Two audio graphs are in play and it is worth being honest: Howler owns one `AudioContext`, and positional sources would own another. The same master gain is applied to both. One shared context would be tidier and is not worth reimplementing Howler to get.
- The player's mixer settings live in `localStorage`, deliberately **not** in `scene.json`: how loud somebody likes their music is a property of that person, and writing it into the document would carry one player's preference to everyone the project is exported to. Validated on read like every other stored blob — a tampered value would otherwise produce a volume of 40.

**Definition of Done:** A scene has distinct menu and gameplay music with a clean crossfade, correct SFX on damage/pickup/checkpoint, and a working in-game mixer that persists for the session.

**Met, with one limitation that has to be stated plainly: nothing here has been _heard_.** Headless Chromium has no output device and this container has no sound card, so every audio claim in this sprint is a claim about wiring, not about acoustics. What _is_ verified, in a real browser: the music state machine moves menu → explore → combat as the game does, pausing switches to menu music without ending the fight, the mixer takes a value and keeps it across a reload without touching the document, and the ingested WAVs are served as real RIFF/WAVE files rather than 404s. The crossfade itself — old track falling while the new one rises, over the configured duration — is asserted against a recording test double, which pins the sequence and the timings but not the sound.

Two further gaps, both real. **There is no transcoding**: ffmpeg is not installed, so the pipeline normalises WAV to one sample format and levels its loudness (measured in dBFS, peak-limited so a spiky clip is quieted rather than clipped) but cannot produce Ogg or AAC. The music beds are therefore ~700 KB each, which is fine for a stand-in and wrong for a shipped game; Sprint 23's export hardening is where that has to be fixed. And **footsteps are not implemented** — the plan lists them, but there is no `footstep` event to bind to and inventing one would mean a per-frame distance accumulator in the character controller, which belongs with movement polish rather than with audio.

---

### Sprint 20 — Multiplayer Runtime (Co-op Slice)

**Goal:** Two people in the same world. Deliberately not a competitive shooter.

**Tasks:**

- [x] Stand up a Colyseus server as its own deployable service — `apps/realtime`, a different workload shape from the API
- [x] Authoritative room state: positions, health, shared world state. Clients send inputs; the server simulates and broadcasts
- [x] Wire `gameConfig.multiplayer` (enabled, maxPlayers, mode, and a new `serverUrl`/`inputHz`) through to the runtime's networking
- [x] Scope explicitly to co-op/shared-world. **Lag-compensated competitive combat — client prediction, rollback — is an explicit future item**, and `mode: 'deathmatch'` is refused rather than silently treated as co-op
- [x] **Added:** input sanitisation and clamping on the server; a scene-id check at join; remote-player interpolation with short-way-round angle blending; and a graceful drop to single player when the server cannot be reached

**Tech notes:**

- **The server runs the engine's own physics, in Node.** `PhysicsWorld`, `PlayerController` and `SceneLoader` — the very same classes that draw the editor's preview — build and step with no browser, no renderer and no DOM. That is the strongest test the "engine never imports the editor" rule has had, checked somewhere it cannot be faked. It also means geometry the client can see is geometry the server enforces: walking through a wall is not something a modified client can do.
- A client sends **intent only**. There is no "set position" message at all, so the authority model is not a policy the server applies but a shape it has. Inputs are clamped (`forward: 1e9` is not a faster player) and out-of-order arrivals are dropped.
- **No client-side prediction, deliberately.** A remote player's position is a fact received, never a guess. There is a test asserting that a client with no new packets holds still rather than extrapolating — a guard against somebody quietly adding simulation, which would be the first step of a competitive-netcode project rather than a tweak.
- `colyseus.js` lives in the _editor_, behind a `CoopTransport` interface the engine defines. A hard networking dependency in `packages/engine` would put a socket client in the bundle of every single-player game anybody ever makes; there is a test asserting the import is absent.

**Definition of Done:** Two browser clients join the same session and see each other move in real time, server-authoritative, with no obvious desync under normal network conditions.

**Met.** Two _separate Playwright browser contexts_ — not two tabs sharing a process, which would prove far less than it appears to — connect to a real Colyseus server, see each other in the player list, and one walks while the other watches the position change. The position the second browser reads came off the wire from a server that computed it. Leaving removes the player from the other browser's view, and an unreachable server drops to single player rather than refusing to start.

What is **not** verified: behaviour under real network conditions. Everything here runs over loopback, so latency is microseconds and there is no packet loss, no jitter and no reordering in practice. "No obvious desync under normal network conditions" is therefore asserted against the best possible conditions, and the interpolation that would hide a 100 ms round trip has never had one to hide. Two further scope lines worth stating: enemies and triggers are still simulated **per client** rather than by the server — only players and destroyed objects are shared, so two people will see the same goblin in slightly different places — and the room takes its scene document from whichever client opens it, which is fine among invited players and is not a security model. Sprint 27's hosted play, where the server fetches a scene by id, is where that becomes one.

---

**Phase 2B wrap check — done.** The runtime is now a complete playable game: home screen, menus, HUD, first/third/top-down cameras, weapons and combat, pickups, secrets, checkpoints with progress that survives a reload, music and sound, and optional co-op. What it is _not_ yet is exportable — everything above runs in the editor's Play Preview, which is the same code an export will run but is not itself an export. Phase 3 is what turns it into something a user can be handed.

---

## PHASE 3 — EXPORT SYSTEM

**Duration:** Sprints 21–23 (1.5 months) | **Outcome:** Standalone playable exports, cross-browser verified.

### Sprint 21 — Static Export (No Behaviors Yet)

**Goal:** Prove the fundamental export mechanism works before layering in the harder behavior/physics export case.

**Tasks:**

- [x] Build Export Wizard UI: project name, include-source toggle, minify toggle, and a summary of what will ship _before_ it ships
- [x] Write the **bundler**: a pre-built self-contained engine bundle, only the assets this scene references, `scene.json`, and a generated `index.html` + `main.js`
- [x] Integrate JSZip client-side to package it into a downloadable `.zip`
- [x] Handle relative path correctness — verified by extracting the archive with `unzip`, serving it over real HTTP and opening it, not by inspecting the plan
- [x] Add a README.md inside the export explaining how to run it and what each file is for
- [x] **Added:** the Draco decoder is shipped alongside the models (without it every model silently fails to appear); audio assets are followed too, since they are referenced from `audioConfig` rather than placed; and the project name is slugified so `../../etc` cannot write outside the extracted folder

**Tech notes:**

- **The editor cannot build the engine — it is a browser tab.** So `packages/engine` now produces _two_ builds: `index.js` with `three` external, for the editor and the co-op server, and `runtime.js` with everything inlined, for exports. An exported project is a folder somebody unzips; it has no package manager, no bundler and no import map, so every dependency has to already be in the file. The editor serves that bundle as a static asset and an export copies it verbatim, which is also what makes an export reproducible.
- Rapier stays _out_ of the runtime bundle. A static export never presses Play, and two megabytes of physics WASM in every one of them would be a poor trade. Sprint 22, which exports behaviours, is where it starts being worth paying for.
- `buildExport` is a pure function from a scene and a manifest to a list of files — no JSZip, no `fetch`, no DOM. That is what makes the interesting half of the exporter testable without unzipping anything.

**Deliverables:** Working static export pipeline.

**Definition of Done:** Export a scene with terrain + 10+ static props (no behaviors), unzip, run `npx serve` on the folder, and the browser renders an identical scene to the editor's preview.

**Met, and verified the hard way.** The e2e test exports the Village Outpost, saves the archive Playwright receives, extracts it with `unzip` (a different tool than the one that wrote it), serves the folder over a real HTTP server and opens it in a second page. It asserts a WebGL context, the scene's own name in the title — proof it read `scene.json` rather than a hardcoded page — and that nothing 404'd.

Two real bugs, both caught by looking rather than by asserting. The first: the hand-rolled "minify" stripped `*`-prefixed lines _before_ removing block comments, which deleted the `*/` terminators and left an unclosed `/**` that swallowed the import list. The export still built, still zipped, and shipped a `main.js` with no imports. There is now a test that parses the minified output rather than pattern-matching it. The second was only visible in a screenshot: everything rendered as **placeholder boxes**. `load()` is synchronous and takes whatever is in the model cache at that moment, so preloading afterwards filled a cache nothing ever read. The generated `main.js` now builds twice — once immediately from the manifest's bounds so the world is there while models download, once after they arrive.

**Scope, stated:** this is a _static_ export. It renders the world; it does not start behaviours, physics, the menu shell or sound. The README inside every export says so. Sprint 22 is the one that makes an export a game.

---

### Sprint 22 — Full Behavior Export + Readability Layer

**Goal:** Extend export to cover the harder cases — behaviors, physics, AI — and add a "human-readable" option for power users.

**Tasks:**

- [x] **Behaviour tree-shaking: measured, then deliberately not done.** The whole behaviour registry — patrol, chase, pickup, checkpoint, and the AI and steering they pull in — is a small part of a bundle whose bulk is Three.js and Rapier. Splitting the registry per scene would mean a different engine bundle per export, which costs the property that makes an export reproducible: today every export of the same editor build ships a byte-identical runtime. The size saved did not come close to justifying that, so the full registry ships and the reason is recorded rather than the decision being quietly reversed later
- [x] Verify Rapier's WASM is correctly included — and the finding is worth stating plainly: **there is no Rapier `.wasm` file**. The `rapier3d-compat` build encodes its WebAssembly as base64 inside the JavaScript, which is most of why the game bundle is 3 MB. The only real `.wasm` in an export is Draco's model decoder, and the README now says exactly that instead of warning about a file that does not exist
- [x] Build the optional **"readable code" export mode**
- [x] Auto-generate `CREDITS.md` and `LICENSE.md`, with per-asset attribution from new optional `license` / `author` / `sourceUrl` fields on the manifest
- [x] Test a scene combining terrain, static props, enemy AI, a trigger volume and a physics character controller, exported and run standalone
- [x] **Added:** an export **mode** — `static` or `game` — because the two need different engine bundles, and shipping two megabytes of physics into a level somebody wants to _show_ rather than play is a poor trade

**Tech notes:**

- Two runtime bundles rather than one file plus a chunk. A chunk gets a content-hashed name, and the exporter would then have to _discover_ it — but the exporter runs in a browser tab, which cannot list a directory. An explicit second entry is a string both sides already know.
- The engine now re-exports `THREE`. An exported project has no package manager, so somebody hand-editing one needs a `Vector3` and has nowhere else to get it. In the editor and the co-op server it is the same module instance, because `three` is external in that build.
- The readable-code mode is **cosmetic and says so in its own output**: the engine is data-driven, and the emitted `describeLevel()` reproduces exactly the document sitting next to it. It exists because somebody who opens an export and finds `SceneLoader.load('scene.json')` learns nothing about their own level, while a list of `place('tree_pine_01', …)` calls is something they can edit.

**Deliverables:** Full-feature export (behaviors/physics/AI included), optional readable-code mode, licensing file generation.

**Definition of Done:** A scene with active enemy AI, physics, and a trigger-based scene event, once exported and served standalone, behaves identically to the in-editor Play Preview — verified by side-by-side manual comparison, and later automated in Sprint 23.

**Met.** The Skirmish scene — terrain, props, two goblins running `chaseOnSight`, pickups, checkpoints, a trigger volume, secrets and audio — is exported as a game, extracted with `unzip`, served over HTTP with real content types, and **played**: the home screen appears, Play starts the world, the HUD reads 100 HP, walking moves the character, and Escape pauses. A screenshot shows a first-person view of the level from inside the export.

The honest qualifier is on the word _identically_. What is verified is that the exported build starts, simulates and responds — physics initialised, the shell wired to the loop, no console errors and no 404s. What is **not** verified is frame-by-frame equivalence with the editor's preview; the sprint plan says "side-by-side manual comparison, and later automated in Sprint 23", and automating it is Sprint 23's job rather than something quietly claimed here.

---

### Sprint 23 — Export Hardening + Cross-Browser QA

**Goal:** Make export trustworthy enough to be a core product promise, not a fragile demo feature.

**Tasks:**

- [x] Build a Playwright-based automated pipeline: (1) programmatically construct or load a known test scene, (2) trigger export, (3) serve the resulting export folder locally, (4) screenshot it, (5) compare against a screenshot of the same scene in editor Play Preview — flag any pixel-diff beyond a tolerance threshold (visual regression, e.g., via `pixelmatch` or Chromatic if wired in)
- [x] Run this pipeline across Chrome, Firefox, Safari (via WebKit in Playwright), and Edge for at least 5 representative template scenes — **three of the four**; Edge is wired behind `PW_EDGE=1` and is not run, see below
- [x] Test on a throttled network profile (Playwright supports this) — verify loading states/spinners behave reasonably and nothing breaks with slow asset loads
- [x] Add export size budgeting: warn the user pre-export if total bundle size exceeds a threshold (e.g., >150MB), suggest compression setting adjustments
- [x] Handle and test edge cases explicitly: scene with zero objects, scene with a missing/broken asset reference (should fail gracefully with a clear error, not silently produce a broken export), extremely large heightmap terrain export size
- [x] Write export troubleshooting docs (common issues: WASM MIME type on certain static hosts, CORS issues if assets reference external URLs instead of bundled local paths)
- [x] **Added:** a debug handle on the export (`window.helaengineExport.cameraPose()`) and a matching `setCameraPose` on the editor, so the two frames being compared are the same camera rather than two similar defaults; and a dedicated CI workflow that runs the suite as a three-browser matrix

**Tech notes:**

- **Screenshots, not `canvas.toDataURL()`.** A WebGL canvas without `preserveDrawingBuffer` returns a _blank_ image to `drawImage` and `toDataURL`, because the back buffer is discarded the instant it has been presented. The editor sets that flag for its thumbnails; an export has no reason to and does not. The first version of the harness read the canvas in-page and reported every single export as blank — a false failure that looks exactly like a catastrophic real one.
- The two frames are compared **at the same size and from the same camera**. The editor draws into a panel inset in its workspace and an export fills the page, so the exported page's viewport is set to the editor canvas's bounding box; and the export publishes the pose it framed itself with, which the editor is then moved to. Neither is a detail: different aspect ratios are different projections, and two cameras that merely default similarly are a test of the defaults.
- Throttling is **real**, not emulated — a delay and a 16 KB chunk size on the test's own HTTP server. Playwright's network emulation is CDP-only, and "does this work on a slow connection" has to be a question Firefox and WebKit can answer too.
- The archive is extracted with `unzip`, deliberately. An archive only its own author can read is not an archive, and that is precisely the class of bug a JSZip-based check cannot see.
- **Firefox needs an X server, even headless.** It finds its GL driver by running a GLX-based helper; with no display there is no driver, and WebGL fails with `FEATURE_FAILURE_WEBGL_EXHAUSTED_DRIVERS` — every canvas in the editor dead, the Export button never rendered. Chromium carries SwiftShader and WebKit brings its own software path, so neither notices. The suite runs under `xvfb-run`, and Firefox is given `webgl.force-enabled` because llvmpipe is on Mozilla's driver blocklist — correctly, for anyone who has a real GPU.

**Deliverables:** Automated export QA suite, documented edge-case handling, size budgeting.

**Definition of Done:** The Playwright visual-regression suite runs in CI on every PR touching engine/export code, passes on all 5 template scenes across all 4 browsers, and catches at least one real regression during this sprint's own development (proving the suite has teeth, not just green-checkmark theater).

**Met, with one qualification on the browser count.** The suite is 11 tests — five template comparisons, four edge cases, a throttled load, a documentation check — and it passes **11/11 in Chromium, 11/11 in Firefox and 11/11 in WebKit**, run separately, all five templates green in each. `.github/workflows/export-qa.yml` runs it as a three-browser matrix on every pull request touching `packages/engine`, `packages/schema`, `apps/editor/src/export`, the suite itself or the asset pipeline, with the editor frame, the export frame and the pixel diff uploaded whenever one fails.

The qualification is **Edge**. It is wired up (`PW_EDGE=1`) but not run, and that is a decision rather than an oversight: Playwright's `msedge` channel needs Microsoft's own build installed, which this container and the Linux CI image do not have — and Edge is Chromium's engine with a different badge, so a fourth run would cost wall-clock time and tell us nothing new about WebGL. Three genuinely different rendering engines is the claim; four browsers is not.

**The suite has teeth, and it proved it on itself.** Three real findings during this sprint, none of which any amount of code reading would have produced. The first: the harness read the canvas with `toDataURL` and reported _every export as blank_ — a WebGL back buffer is discarded once presented, so an in-page read of an export returns nothing, and a suite that "fails catastrophically" for a reason that has nothing to do with the product is worse than no suite. The second: 73% of pixels differed on the first comparison that ran at all, because the export dialog was still open over the editor's canvas and the toolbar overlays sit inside the canvas region — the test was photographing the editor's furniture. The third, and the only one that is a bug in something other than the test: **Firefox could not render the editor at all** in a headless container, because its GL driver probe speaks GLX and there was no display; every canvas was dead and the export button never appeared. That is a genuine "works in Chrome" finding, found the only way it can be — by running Firefox.

**Phase 3 wrap check — done.** The product's core promise — "build a world visually, get real runnable code" — is proven end-to-end with no backend anywhere in the picture. A user opens a template, builds, presses Export, and gets a folder that unzips into a playable game which renders what the editor rendered, in three browsers, on a slow connection, with documentation for the two ways hosting it silently goes wrong. What is still missing is everything about _confidence before delivery_ — nothing yet plays the exported game to see whether it is winnable, reachable or broken by design — which is Phase 3B, starting with Sprint 24's headless smoke-test harness.

---

## PHASE 3B — PRE-DELIVERY VALIDATION & SHAREABLE DEPLOY

**Duration:** Sprints 24–27 (2 months) | **Outcome:** Nothing reaches a user until it has been proved to run, and a build can be shared as a link rather than a zip.

**Why this matters commercially:** most tools in this space hand over a bundle and wish you luck. Auto-testing every export, repairing what it can, and disclosing what it changed is a genuine differentiator — and it is only safe because every repair goes through the same closed-vocabulary, schema-validated discipline as the rest of the product. Full detail in `GAMEPLAY-RUNTIME-AND-QA-PLAN.md` §4.

---

### Sprint 24 — Headless Smoke Test Harness

**Goal:** A deterministic robot that plays every build before a human can.

**Tasks:**

- [x] Playwright-based sandbox runner: loads a staged, non-public export and captures console errors and failed network requests
- [x] Implement the scripted checklist — deliberately deterministic checks, **not** "an AI plays it and judges":
  - [x] page loads with zero uncaught JS errors
  - [x] every asset request resolves (no 404s on GLB, texture or audio)
  - [x] the engine reports "scene loaded" within a timeout (catches hangs)
  - [x] synthetic WASD and look input for N seconds actually moves the player (catches spawning stuck or falling through the world — the most common export-breaking bug)
  - [x] player health does not hit zero while idle (catches damage triggers misplaced at spawn)
  - [x] Rapier's WASM actually initialises (catches the MIME-type hosting problem flagged in Sprint 23)
  - [x] memory does not climb without bound over a short window
- [x] Wire it as a required step: the export worker writes to a private staging path first, never straight to a download or a public deploy — **partly**; there is no export worker yet, see the scope note below
- [x] **Added:** the exporter and the starter templates are now packages (`@helaengine/export`, `@helaengine/templates`) rather than editor internals, because a gate that cannot build what it tests is not a gate; and the export publishes its state in stages so a build that dies halfway says where

**Tech notes:**

- **The harness stages real exports.** It calls the same `buildExport` the Export button calls, with the same asset library and the same engine bundle, then serves the folder over HTTP with the content types a real host would use. Testing a hand-assembled approximation of an export would test the approximation — and the failures worth catching (a decoder that did not ship, a path that only works in the editor) live exactly in the gap between the two. That is what forced `packages/export`: the exporter had been sitting inside a React app, and the first thing this sprint needed was to call it from Node.
- **The export publishes itself in stages.** `sceneReady` goes up the moment the world is built, before physics is even attempted; `physicsReady` after Rapier compiles; `ready` when the loop is running. A build that dies during physics init therefore reports _where_ it died rather than looking identical to a scene that never loaded — which is the difference between "it is broken" and "it is broken here", and the whole reason a per-check report beats a pass/fail.
- **`skipped` and `not-applicable` are different outcomes and the schema keeps them apart.** A skip means an earlier check failed and this one could not run — never a soft pass, and a build with one is not releasable, because "nothing failed" is not the same claim as "it works". Not-applicable means the question is meaningless for this build: a static export has no player to move, and failing it for that would be failing it for doing exactly what it was asked.
- The check ids are a **closed vocabulary** in Zod, for the same reason behaviours and trigger actions are. Sprint 25 maps a failed check to a repair strategy, and that mapping has to be exhaustive — a `switch` that forgets an arm is a compile error, where a free-form string would mean a failure nobody wrote a repair for quietly becoming a failure nobody notices.
- Idle health is measured _before_ the movement test but reported after it. Walking into a hazard and being damaged at spawn produce the same health number afterwards, and only one of them is a bug. It is compared against the scene's declared maximum rather than a reading taken a moment earlier, because a damage volume on the spawn does its work in the first frame and two readings taken after it would agree perfectly about a player who is already hurt.

**Definition of Done:** Five known-good templates pass cleanly; three deliberately broken scenes (spawn inside terrain, missing asset reference, broken WASM path) each fail with specific, identifiable output.

**Met — and it found something on its first full run.** The **Village Outpost's player spawned inside its own hut.** The hut stands at the origin; the schema's default spawn is `[0, 0, 0]`; the character controller came up wedged in a static collider and moved 0.00 m under two seconds of held input. That template has been in the repo since Sprint 6, is offered on the projects screen, and has been opened, exported, screenshotted and pixel-compared in three browsers — and every one of those tests was satisfied, because a player stuck in a wall renders perfectly. Nothing found it until something tried to _walk_. The fix is a spawn point in front of the hut, and a `player` field on the template builder so a scene can say where its player starts rather than inheriting the origin by accident.

The rest: all five templates pass, and each of the three deliberate breakages fails on its own check — a spawn off the edge of the terrain on `player-moves` ("the player fell out of the world … the spawn point is probably inside or under the terrain", with the spawn and the ending position as evidence), a model deleted from the folder on `assets-resolve`, and a corrupted inlined WebAssembly payload on `physics-initialises`. Two further cases are asserted because they are the ways a gate quietly stops being one: a static export reports `not-applicable` rather than failing for having no player, and a build whose `scene.json` is missing reports `skipped` for everything downstream rather than a clean sheet.

**Scope, stated plainly.** The task says "wire it as a required step: the export worker writes to a private staging path first". There is no export worker — export runs in the browser, and there is no server at all until Sprint 28. What exists is the gate itself and a CI workflow that runs it on every change to the engine, exporter, templates or asset pipeline. The staging path is real (the harness builds into a temporary folder and serves it on an ephemeral loopback port, never anywhere reachable), but the thing being gated is CI rather than a download button. Gating the button is Sprint 26; a server doing it is Sprint 28. Calling that "wired as a required step in the deploy pipeline" today would be describing a pipeline that does not exist yet.

One more honest limit: this runs in **Chromium only**. The export QA suite covers three browsers for rendering, and adding two more browsers here would triple a two-minute gate to catch a class of bug — a scene that plays in one engine and not another — that has not been seen once. Worth revisiting the day it is.

**Known debt, found while verifying this sprint and deliberately not fixed in it.** Four of the editor's save-and-reload e2e tests are **flaky on first attempt and pass on retry** — `edits survive a full page reload`, `leaving the editor saves first`, `the whole shell config survives a save and reload`, `progress survives a full page reload`, and occasionally `music follows the game`. They were suspected as fallout from moving the templates out of the editor, so the same tests were run against the previous commit: **three of them flake there too**, before any of this sprint's changes existed. It is pre-existing, and the retry has been hiding it since roughly Sprint 18.

The likely cause is test isolation rather than product behaviour: these tests reopen a project by name with `.first()`, and when a previous test in the same file has left an identically-named project in IndexedDB, the ordering of the list decides which one gets opened. That would explain why the failing set moves between runs and why a retry — with a different database state — passes. Worth fixing as its own piece of work, because a suite that goes green on the second try is a suite that will one day hide a real regression; it is not worth doing inside a sprint about validating exports, and pretending it is Sprint 24's finding would be pretending it is Sprint 24's fault.

---

### Sprint 25 — AI Diagnosis + Auto-Repair Loop

**Goal:** Fix what can be fixed, automatically, without ever running model-authored code.

**Tasks:**

- [x] Error-context extraction: given a failure, isolate the _relevant slice_ of `scene.json` — spawn position and terrain collider for a fall-through, not the whole object list
- [x] Request a targeted patch through the shared `ModelRouter` (same routing layer as AI-PROTOTYPE-PLAN.md), in structured form — **the seam, not the router**: `ModelRouter` does not exist yet, so the transport is a single injected function and the language-model proposer is tested against stubs. See the scope note.
- [x] Zod-validate every proposed patch before applying it; bounded retry loop, max 3 attempts, re-running the Sprint 24 harness after each
- [x] Auto-repair audit log: what changed, why, on which attempt — including the attempts that were **refused**, which are the entries that make it an audit trail rather than a changelog
- [x] **Added:** a deterministic rule-based proposer, so the loop runs in CI with no API key and no spend; a revert when a patch does not measurably improve the report; and a refusal to touch failures that are not scene problems at all

**Tech notes:**

- The safety argument is the same one behaviours make: the model proposes into a schema it cannot escape, the patch is narrow, the result is re-verified by a deterministic test, and the whole thing is logged. At no point does model output become executable code.
- **The vocabulary is where the safety lives, not the prompt.** Five operations — `setPlayerSpawn`, `setObjectPosition`, `setObjectCollider`, `clearObjectTrigger`, `removeObject` — each of them data describing a field to set. There is deliberately no "replace the scene", no "set this JSON path", no "merge this object", and nothing that carries a string to be evaluated. A model cannot widen that by being persuasive, and the tests assert it: a proposal naming `runScript` is refused, and code smuggled in beside a legitimate `setPlayerSpawn` is stripped by the parse rather than carried through.
- **The proposer does not decide whether it helped.** A patch is applied to a copy, the build is rebuilt and _played again_, and it is kept only if the report improved. Otherwise it is reverted. Three attempts that each leave an unhelpful edit behind would be a loop that degrades a level while reporting progress.
- **Refusals are recorded, not merely absent.** "Did the model try to do something it should not have been able to do" is the first question anybody evaluating this will ask, and a log listing only successful edits cannot answer it.
- The rule-based proposer is arithmetic: a deterministic spiral search for a clear point, not a model asked to compute one. It exists because a validation step that only works when a paid service answers is a validation step that gets switched off — and because "three broken scenes are repaired" has to be a reproducible claim rather than a report on what a model said this morning.
- **Not every failure is a scene problem.** `page-loads`, `scene-loaded`, `physics-initialises` and `memory-stable` are broken _builds_; no document patch reaches them. The loop stops rather than spending its budget rearranging somebody's level to fix a corrupted bundle, and there is a test asserting it edits nothing when handed one.

**Definition of Done:** All three deliberately broken scenes from Sprint 24 are detected and repaired within the retry budget, verified by the harness passing afterwards.

**Met, with the third scene reinterpreted — deliberately, and here is why.** Sprint 24's three breakages were a spawn off the terrain, a model missing from the folder, and a corrupted WebAssembly payload. The first two are repairable and are repaired. **The third is not a scene problem at all.** No edit to a scene document fixes a damaged engine bundle, and a loop that responded to one by moving spawn points would spend three attempts degrading somebody's level and then report that it had tried. So the loop refuses it — and that refusal is the test: it must end with zero attempts, zero patches applied, and the scene it started with, unchanged.

The repairable set is therefore **four scene-level faults**, each built, played, patched, rebuilt and played again:

| Broken scene                      | Detected as            | Repaired by                             |
| --------------------------------- | ---------------------- | --------------------------------------- |
| Spawn off the edge of the terrain | `player-moves`         | `setPlayerSpawn` back over the terrain  |
| Spawn inside the hut              | `player-moves`         | `setPlayerSpawn` clear of the building  |
| Spawn on top of a goblin          | `player-survives-idle` | `setPlayerSpawn` out of its reach       |
| Model missing from the build      | `assets-resolve`       | `removeObject`, disclosed as a deletion |

The second of those is **Sprint 24's own finding, put back on purpose**: a fix nobody can re-break is a fix nobody can prove still works.

Two further cases are asserted because they are how this feature would go wrong rather than how it goes right. A **healthy build is left completely alone** — zero attempts, nothing proposed. And a **hostile proposer changes nothing**: a stub returning `{"op":"runScript","code":"fetch('http://evil.invalid')"}` is refused on the schema, twice, with both refusals in the audit log and the scene returned byte-for-byte as it arrived.

**Scope, stated plainly.** The task says "request a targeted patch through the shared `ModelRouter`". There is no `ModelRouter` — it belongs to AI-PROTOTYPE-PLAN.md's Phase 8, and no part of it exists. What is built is the seam it will plug into: a one-function transport, a prompt that asks for one of five named operations, JSON extraction that tolerates fences and prose, and validation that does not care where the reply came from. **No language model was called during this sprint**, because there is no provider configured here; the LLM proposer is exercised against stubs, including hostile ones. The claim "all four scenes are repaired" is a claim about the _rule-based_ proposer, which is the one that runs in CI — and which was chosen as the default precisely so that this claim does not depend on a paid service being up.

---

### Sprint 26 — Release Gating + User-Facing Reporting

**Goal:** The gate, and being honest about it.

**Tasks:**

- [x] Gate access on the pipeline outcome: the download button and play link appear only after a pass — the Export button is now **Check and export**, and nothing is written until the scene has been played
- [x] Build the report UI — auto-fixes applied, stated plainly ("Your start point was inside the Hut, so the player spawned stuck and could not walk. We moved the start point to [6, 0, 0], just clear of it."), or a specific human-readable failure with a suggested manual fix
- [x] Handle unrecoverable failure explicitly: never a spinner that never resolves
- [x] **Added:** the repair is applied to the _project_, not only to the exported copy, as a single undoable edit; and the check list is shown in the user's words rather than as check ids

**Tech notes:**

- **There are now two gates, and they check different things.** `tools/smoke` builds a real export, serves it and plays it in a real browser: it is the authority on whether a _build_ works — bundles, paths, content types, the decoder shipping — and it needs Node and Playwright, so it lives in CI. The editor's gate drives **Play Preview**, which is the same engine, the same physics and the same document: it is the authority on whether a _level_ works. The overlap is the part users actually hit, and the editor can answer it _before_ the download starts rather than after the zip has landed on somebody's disk.
- Both produce the same `SmokeReport` and both are graded by the same `isReleasable`, so there is one definition of "may this be handed to somebody" rather than one per surface. The repair loop's policy moved into `@helaengine/repair` for the same reason: the Node harness and the editor now hand in a `verify` function and get identical guarantees.
- **The editor's gate says what it cannot answer.** `page-loads` is reported `not-applicable` rather than passed, because Play Preview shares the editor's page — "the page loaded without throwing" is a question about the editor, and answering it here under the same name would be answering a different question. The CI gate is where that one is real.
- The suggestions are a `Record` keyed on the closed check vocabulary, so a new check cannot ship without somebody writing the sentence that goes with it. That is how "never an unexplained rejection" survives the gate growing.
- Input is dispatched as real keyboard events into the real preview rather than by calling the character controller, and the gate presses the shell's own **Play** button rather than setting the screen. A validation step that runs its own private copy of the world can pass while the thing users press Play on fails, and the drift would be invisible until somebody reported it. Both of those were bugs before they were principles — see below.
- A repair kept by the gate is committed through `replaceScene`, which lands it in the undo stack. `setScene` clears history, which is right for _loading_ a document and wrong for editing the one somebody is working on: a tool that changes your level and leaves you no way back has not asked permission, it has taken it. Candidate scenes that get rejected use `setScene` and are restored afterwards, so a rejected guess never reaches the undo stack at all.

**Definition of Done:** A good scene shows a brief validating state and then the download; a broken one either shows a transparent auto-fix notice with working output or a clear, specific failure — never a silent hang or an unexplained rejection.

**Met, and asserted as three cases in the editor's own e2e suite** — because "never a spinner" is a claim about the state machine, and a state machine is only as honest as its worst path:

1. **A good scene** (Forest clearing) shows "Playing your game…", then downloads, and says nothing about having changed anything, because it did not.
2. **A broken scene** — the Village Outpost with its spawn put back inside the hut, Sprint 24's bug on purpose — is repaired, discloses "We changed your scene to make it work" with the reason in plain words, downloads, and the new spawn is in the _project_ rather than only in the zip.
3. **An unrepairable scene** — a hut every three metres for sixty metres, so there is nowhere clear to move the spawn to — is refused with the failing check named in the user's words ("The player can move"), a suggestion, and a button that says **Check again** rather than sitting on "Checking…".

**Two bugs the e2e suite found in this sprint's own work**, both the same shape — the gate measuring something other than what it claimed to:

1. Every scene reported "The player could not move — 0.00m", including templates the CI harness passes. `setWalking(true)` opens the game's **home screen**, not the world; nothing responds to input until Play is pressed. The gate was measuring a player standing on a menu.
2. With that fixed, a repairable scene still failed after three attempts. Play Preview builds the world from the **store**, and the loop was handing candidate scenes to `verify` without ever putting them there — so all three attempts re-tested the original document and got the same answer. Playing a candidate means loading it.

Neither would have been caught by a unit test with an injected preview, which is exactly why the three cases above are driven through the real editor.

One behaviour deliberately changed rather than preserved: a scene naming an asset the library does not have used to export a folder full of placeholder boxes with a warning nobody had to read. It is now blocked, repaired by removing the object, and disclosed. The Sprint 23 test that asserted the old behaviour was rewritten rather than worked around — it was testing something this sprint decided was wrong.

**Scope.** "The download button _and play link_" — there is no play link yet; hosted play is Sprint 27, and there is no server until Sprint 28. What is gated is the download, which is the only way to get a build today.

---

### Sprint 27 — Shareable Hosted Play

**Goal:** "Here's a link" instead of "here's a zip, good luck".

**Tasks:**

- [x] Extend the export worker with a deploy mode: the same validated bundle, uploaded to a public path per project instead of zipped — **a service, not a CDN**; see the scope note
- [x] Access controls: public, unlisted, org-only
- [x] Play analytics stub: play count, last played — exposed at `GET /api/builds/:id`; there is no dashboard to surface it in yet
- [x] Verify multiplayer sessions work specifically through the hosted path — **not done**, and stated as such below rather than ticked past

**Tech notes:**

- **The gate reaches one step further.** The service re-checks the smoke report and refuses to host a build that did not pass. The editor already refused to _download_ one, but the editor is a browser tab: a rule enforced only on the client is not enforced. It is the same `isReleasable` both ends, which is why that function lives in the schema — and it reads the _checks_ rather than the report's own `passed` flag, so a client that lies about having passed is caught by the rule rather than by the claim.
- **Sharing is the more consequential of the two.** A bad download is one person's afternoon; a bad link is everyone they were sent to. That asymmetry is why the server-side check exists at all rather than being left as belt-and-braces.
- **`unlisted` is the default, and it is a real level rather than a polite one.** Ids are 96 random bits, because an unlisted build is protected by nothing except its URL being unguessable — a short pretty id would make "unlisted" mean "public to anyone who counts". Unlisted builds are absent from every listing endpoint, and are served `cache-control: private, no-store`, because a proxy holding a copy is a copy nobody can withdraw.
- **"Does not exist" and "you may not see it" give the same answer.** An org build returns 404 to a request with no token, and 404 to a request with the wrong one. Distinguishing them would turn the metadata endpoint into an oracle for which builds are real. The token comparison is constant-time over hashes, so it does not leak its answer through timing either.
- Plays are counted when the _page_ is served, not when an asset is — otherwise "plays" is really "requests", and a build with more models looks more popular.
- Plain `node:http`, like the co-op server's listener and for the reason learned there in Sprint 20: five routes do not need a framework's opinion about which handler owns a request.
- A malformed request answers **400 with the field named**, not 500. The first version returned 500 for a path that failed schema validation, which tells a caller to retry something that will never work; the test that caught it originally asserted the 500, and was corrected rather than kept.

**Three bugs, all in the seams, all found by running it rather than reading it.** Worth listing because the pattern is the point — the service's _logic_ held up throughout, and everything that broke was a join between two components:

1. **Schema rejection answered 500.** My own test asserted the 500, so the bug had been encoded as expected behaviour before it was noticed.
2. **No CORS preflight.** The editor is on 5174 and the service on 4000, so every publish is cross-origin. The editor reported "could not reach the share service" while it was running perfectly and answering everything else. `fetch` rejects identically for "nothing is listening" and "the browser blocked it", so the message now names both instead of confidently blaming one.
3. **The service served nothing at all from its own default directory.** The guard stopping a build's metadata being served was `path.includes('/.hela-')` — also true of every file in a store rooted at `.hela-shared`, which is the default it ships with. Every one of the fourteen unit tests missed it by creating stores in temp directories without the leading dot; the end-to-end test used the real default and hit it on the first request.

The third is the one to remember. The share succeeded, the link came back, and the hosted page was blank — a failure invisible to every test that did not go all the way through.

**Definition of Done:** A user generates a share link for a validated build, sends it to someone else, and that person plays it in-browser — including joining a co-op session — with no download and no local server.

**Met for the single-player half; the co-op half is not done.** The end-to-end test passes: it shares a validated build from the editor, gets a link, and opens it in a **second browser context** — a different person, with none of the editor's IndexedDB or memory available to it, holding nothing but a URL. The game's home screen appears, Play starts the world, the HUD reads out, no page errors, and the service's play count goes up. No download, and nothing started locally by the person playing.

What is **not** verified is "including joining a co-op session". The co-op server exists and works (Sprint 20), and a hosted build can point at it, but two strangers meeting in a room reached through a hosted link is a different test from the one written — it needs two hosted contexts, a room id in the URL, and a decision about who owns the room's scene that Sprint 20 explicitly left open ("the room takes its scene from whichever client opens it, which is fine among invited players and is not a security model"). Ticking that box today would be claiming a thing nobody has watched happen.

**Scope, stated plainly.** The task says "uploaded to a public CDN path". There is no CDN and no object storage: this is a small service that writes files to a disk it owns and serves them itself. It is a separate deployable — `apps/share`, alongside `apps/realtime` — rather than part of the API, because `apps/api` is Sprint 28's NestJS platform and pretending this is that would be worse than either. Org access is a **shared token in an environment variable**, and it is named as a placeholder in the code: real organisation membership arrives with auth in Sprint 28, which is also where the play counts get a dashboard to live in.

---

**Phase 3B wrap check — done.** Nothing reaches a user that has not been played first. A build is validated in the editor before it can be downloaded, repaired where a fix exists and refused with a reason where one does not, re-validated by the service before it can be hosted, and reachable as a link rather than a zip. The commercial argument in this phase's header — that most tools in this space hand over a bundle and wish you luck — is now a thing the product does rather than a thing the plan says. What it does not yet have is anyone to hand it to: there are no accounts, no projects that belong to somebody, and no dashboard. That is Phase 4.

---

## PHASE 4 — BACKEND PLATFORM

**Duration:** Sprints 28–32 (2.5 months) | **Outcome:** Auth, cloud save, real-time collab, cloud-based export jobs.

### Sprint 28 — Auth + Multi-Tenancy

**Goal:** Real user accounts, organizations, and role-based access — the foundation every other backend feature builds on.

**Tasks:**

- [x] Scaffold `/apps/api`; set up module structure per DEVELOPMENT-PLAN.md section 4 — **not NestJS**, see the deviations below
- [x] Set up Postgres + a migration covering `User, Organization, Membership, Project, SceneVersion` — **hand-written SQL**, not Prisma
- [x] Integrate an auth provider for sign-up/login/session management, provisioning a `User` row and auto-creating a personal `Organization` — **the seam, with a local implementation**, not Clerk
- [x] Implement the role guard: reads `Membership.role` for the requesting user + target org, gating endpoints by role
- [x] Build invite flow: `POST /orgs/:id/invites` generates a token; acceptance creates the `Membership` row — **email delivery is a function you pass in**, and the default logs
- [x] Write integration tests covering: signup → org auto-created, invite teammate → role assigned correctly, unauthorized role attempting a gated action → 403
- [x] **Added:** nobody may invite above their own rank; invites are addressed and cannot be redeemed by whoever intercepts the link; non-membership answers 404 rather than 403

**Tech notes:**

- Design the `Membership.role` enum now with SSO/enterprise in mind even though SSO itself isn't wired until later — e.g., include an `enterprise_admin` distinction if you anticipate needing it, cheaper to add the enum value now than migrate later. **Taken**: `enterprise_admin` exists, ranks above `owner`, and is asserted in a test although nothing uses it yet.
- **Roles are a ladder, not a capability table.** Every permission this product has so far is genuinely ordered — an admin can do everything an editor can — so the guard is a comparison. The day that stops being true it becomes a table and the guard changes shape; building the table now would be a permissions engine for one straight line.
- **Non-membership answers 404, not 403.** "You are not allowed in organisation X" confirms X exists, which is a membership oracle for anyone willing to guess ids. A member of insufficient _rank_ gets 403, because they already know the place exists.
- Session and invite tokens are stored as **hashes**, never as themselves: a leaked backup should not be a set of live keys. SHA-256 rather than scrypt for those, which is not an inconsistency — a password is low-entropy and needs the cost, a 256-bit random token cannot be guessed at all and only needs protecting at rest.
- Login answers **identically** for a wrong password and an unknown address, and verifies a hash even when there is no user, so the response time does not say which it was.
- **Nobody may invite above their own rank.** Without it, an admin promotes a friend to owner and the privilege ladder has a rung going upwards.

**Three deviations from the plan's stack, each a decision rather than an omission.** All three are written up in `apps/api/README.md`; the short version:

- **No NestJS.** Two services here already run on plain `node:http`. Decorators and DI would be the only such pattern in the repo, and the plan's `RoleGuard` reads better as `requireRole(...)` called explicitly at the top of a handler — you can see what a route requires by reading it.
- **No Prisma.** Types come from Zod, and a second generator producing a second set of types for the same concepts is a drift waiting to happen. Migrations are hand-written SQL in transactions. The cost is real and stated: queries are strings and result shapes are asserted rather than inferred. Past a few dozen tables, revisit it.
- **No Clerk.** There is no account and no way to receive webhooks from this environment. What exists is the interface it plugs into — everything downstream depends on `AuthProvider.identify()` returning a user id, not on how the user proved anything. Local passwords use scrypt from the standard library.

Email is the same shape: `sendInvite` is a function passed in, the default logs the token at `warn` level, and the message says no email service is configured. Pretending mail had been sent would be worse than saying it had not.

**Deliverables:** Working auth, org/membership model, role-gated API.

**Definition of Done:** A new user can sign up, gets a personal org automatically, can create an org, invite a teammate by email with a specific role, and the API correctly allows/denies actions based on that role — verified via integration test suite, not just manual clicking.

**Met.** Fifteen integration tests against a **real Postgres 16**, over **real HTTP** — both deliberate, because the constraints, the cascades and the transaction boundaries are half the design here, and a mocked database would test only the half that is code. The suite walks the whole sentence: sign up, get a personal workspace owned by you, create an organisation, invite a teammate by email, read the token the way a recipient would (from what was sent to them, not from the database), accept, and find both roles in the member list. Then the refusals: an editor may create a project and a viewer may not; a viewer may still read the member list, because being in a room is not a privilege; a stranger gets 404 rather than 403; an invite cannot be redeemed twice, cannot be redeemed by the wrong person, and cannot be issued above the issuer's rank.

CI runs it against `postgres:16` as a service container rather than a mock, for the same reason.

---

### Sprint 29 — Project CRUD + Cloud Save

**Goal:** Move project persistence from local IndexedDB (Sprint 8) to the cloud, with full version history "for free" via append-only versioning.

**Tasks:**

- [x] `Project` and `SceneVersion` models per DEVELOPMENT-PLAN.md section 3; `POST /orgs/:id/projects`, `GET /projects/:id`, `PATCH /projects/:id` (name and thumbnail), `POST /projects/:id/versions` (the actual save), plus `GET /projects/:id/versions` and `POST /projects/:id/versions/:n/restore`
- [x] Zod-validate incoming `sceneJson` server-side before persisting, with the shared `@helaengine/schema` package — the same validation the editor runs locally
- [x] Build editor-side migration: a `CloudProjects` adapter and a `backend` facade that dispatches to it or to IndexedDB; the project store now calls the facade and is otherwise unchanged
- [x] Implement optimistic concurrency: a save carries the version it was based on; the server refuses one based on a version somebody has already moved past, with a 409 carrying the current number
- [x] Projects Dashboard UI — **Sprint 8's screen, now backed by either store, with an account bar in front of it.** Its list, create, delete and duplicate all work against the cloud without the screen knowing; what is _not_ added is an organisation switcher, so a signed-in user works in their personal workspace
- [x] Build Version History panel: the last N versions with timestamp and author, and a restore that appends rather than rewinds

**Tech notes:**

- **Saving appends; it never updates.** A save is a new `scene_versions` row, so version history is a property of the shape rather than a feature somebody had to build — and _restore is another append_, holding the old content at a new number. History is never destroyed, including by the button whose job is to go back. The test asserts the version list reads `[3, 2, 1]` after restoring version 1.
- **The concurrency guard is inside the insert**, not a read followed by a write: `insert ... select ... where (select max(version)) = $base`. Two saves arriving together would both read the same maximum and both believe they were next. There is a test that fires two saves with `Promise.all` and asserts exactly one 201 and one 409 — which the read-then-write version would have failed.
- **`baseVersion` is required, not defaulted.** A save with no idea what it is based on silently wins every race, which is the opposite of what the field is for.
- **A project id in a URL is not an authorisation.** Each project route loads the project, reads the organisation it belongs to, and checks the caller's role against _that_. Treating the id as permission is how one tenant's work leaks into another's, and there is a test where a stranger holding the right id gets 404.
- Deleting takes `admin`, not `editor`: it is the one action here that removes somebody else's work from view, and it should need more than the role that creates things. It is a soft delete — nothing reads a deleted project, nothing removes the rows.
- A `DELETE` answers **204 with no body**. The first version sent `{}` with a content-length, which is invalid HTTP and which `response.json()` duly choked on — caught by the test that expected the delete to succeed.

**Deliverables:** Cloud-backed project persistence with automatic version history.

**Definition of Done:** User saves a project from Browser A, logs into the same account on Browser B, sees identical, up-to-date state. Version History panel shows the last 10+ saves; restoring an older version correctly reverts editor state and creates a new version entry (history is never destroyed).

**Met at the API, and now wired through the editor — with one honest gap.** Twenty-four integration tests against real Postgres cover the whole sentence: a project saved in one session is read back identically in a second session of the same account; twelve saves produce twelve versions with authors and timestamps; restoring version 1 creates version 3 holding version 1's content and leaves `[3, 2, 1]` in the history. Conflict detection, tenant isolation, server-side schema validation and soft delete are all tested.

The editor now goes through a `backend` facade with the same six functions it already called, dispatching to IndexedDB or to the API. The project store changed by two lines — the import, and letting the backend mint the id — which is the whole argument for having written the cloud adapter against the local store's interface rather than a nicer one. **Local stays the default**: somebody who opens the editor with no account can still build something, because requiring a sign-up before the first click would be charging admission to a demo.

The version cursor lives in the facade rather than in the scene store, because it is a fact about _storage_ — the same scene saved to a different backend has a different version, and to no backend at all has none. It advances on load and on a successful save, and deliberately **does not move on a conflict**: a client that advanced on a refusal would then send a base the server has never seen. There is a test for exactly that.

**And driven end to end**, which is the part that turns an expectation into an observation. An e2e test signs up through the account bar, opens a template, adds an object, saves, and then opens a **second browser context** — no shared IndexedDB, no shared localStorage, only the account — signs in, opens the same project, and finds the same objects. It then opens the history panel, sees `v2` with the author's name, restores `v1`, and watches `v3` appear while `v1` stays where it was. That last assertion is the one worth having: it is the difference between a history and an undo button.

Sprint 26 taught this lesson twice in one afternoon — the logic was right and the seams were wrong, both times — so the sprint is not called done on unit tests alone. This one passed first try, which is the pleasant version of the same discipline.

---

### Sprint 30 — Asset Storage + CDN Pipeline

**Goal:** Move the local-file asset pipeline (Sprint 2) to a real cloud storage + CDN setup, and enable user-uploaded custom assets.

**Tasks:**

- [x] Storage laid out as the plan describes — a curated library with no owner and `/orgs/{orgId}/assets/...` per customer. **Local files, not R2 or S3**, behind an `AssetStorage` interface; see the tech notes for why that is a deployment decision rather than a shortcut
- [x] An `assets` table (`003_assets.sql`, hand-written SQL — no Prisma, for the reasons in `db.ts`) + `POST /orgs/:id/assets` issuing a short-lived **signed upload URL**. The bytes go straight to `PUT /uploads/:orgId/:assetId?expires=…&signature=…`, which runs **before** authentication because the signature is the authorisation — the same shape a presigned S3 URL has
- [ ] **Not done: the ingest job.** There is no BullMQ and no queue. `completeUpload` validates and stores synchronously; the `pending → ready | failed` state is in the row, so the UI and the API are already shaped for a worker, but no `gltf-transform` compression or thumbnail generation runs on an upload
- [x] Custom asset upload UI: a drop zone and a file picker in a **"My Assets"** section of the library panel, with per-asset status and the failure reason shown next to the asset it is about. **Not gated by plan tier** — no billing exists yet (Sprint 32)
- [x] Content-hash paths (`orgs/{id}/assets/{sha256}.glb`) served with `cache-control: public, max-age=31536000, immutable`. **No Cloudflare in front of it**; the route is the origin a CDN would sit on, and it is deliberately unauthenticated for that reason
- [x] The Asset Library panel blends global and org-private assets. The **curated** manifest is still the static `manifest.json` from Sprint 2 — uploads are merged into it in the editor, keyed by id so an upload shadows a curated asset rather than sitting beside it
- [x] **Added:** a CORS preflight for `PUT`, found by driving a browser; a 413 for an oversize body, refused while it is still arriving; `glTF` magic-byte validation, because a `.glb` extension is a claim and the bytes are a fact; and `TooLarge` in `roles.ts`

**Tech notes:**

- **The upload ticket is an HMAC, not a row.** A signature over `{org}:{assetId}:{expiresAt}` with a server-held secret, good for five minutes. The alternative — a row per pending upload — is a database write for every ticket including the ones nobody spends, plus a cleanup job for the rest. It is `createHmac` rather than a hash of `secret + payload` because SHA-256 is a Merkle–Damgård construction, and a secret-prefixed digest can be extended by somebody holding one valid signature and no secret at all.
- **The organisation is inside the signature.** Not merely a path segment: if it were, one valid ticket would be a write into every tenant. There is a test that swaps it and watches the upload be refused.
- **One table, not two.** Curated assets are rows with a null `organization_id`. "What can I place" is then one query with one `where` clause rather than a union — and a union is the shape that drifts the day somebody adds a column to one side. It costs two partial unique indexes, because SQL treats nulls as distinct.
- **`GET /assets/*` is unauthenticated on purpose.** A CDN holds no session. The protection is that the path contains a content hash nobody can guess, which is the same bargain the share service makes for an unlisted build, and it is what lets the cache header be `immutable` — different bytes can never land on the same URL.
- **An uploaded asset's `glbPath` is absolute.** It lives at the API, not in the export's asset folder, so the editor writes a full URL and the engine's `joinUrl` passes it through untouched. No loader change; one e2e test that asserts the URL rather than trusting it, because `./assets/http://…` 404s silently.

**Deliverables:** Per-organisation asset storage, a signed-upload pipeline, immutable content-addressed URLs, and a "My Assets" section in the editor.

**Definition of Done:** A user uploads a custom `.glb`, sees a processing indicator, and within seconds it's compressed, thumbnailed, and appears in their private asset library, placeable in scenes exactly like a built-in asset.

**Partially met, and the gap is the middle of that sentence.** A browser signs up, drops a `.glb` on the panel, watches the row go from "Processing…" to "Ready", and places it in the world — where `viewportObjects()` reports `isModel: true`, meaning the engine fetched and drew the customer's own GLB rather than falling back to a placeholder box. Deleting it removes it from the account, not just from the tab. That much is driven in Chromium and asserted, not clicked once by hand.

What is **not** true: nothing is _compressed_ or _thumbnailed_. The upload is validated and stored as sent. Sprint 2's `gltf-transform` pipeline exists and runs on the curated library, but wiring it to an upload means a queue and a worker process, and there is neither. The `pending → ready | failed` column and the status UI are the seam a worker plugs into — the row already means "not ready yet" and the panel already draws it that way — but calling it done would be describing a state machine as if it were a pipeline.

And the three named products are absent, each a deployment decision rather than missing code: **no R2 or S3** (`LocalAssetStorage` implements a two-method `AssetStorage` interface; swapping it is the SDK's `putObject` and the provider's own presigned URL), **no BullMQ**, and **no Cloudflare**. The content-addressed immutable path is built and tested precisely so that putting a CDN in front of it later needs no invalidation strategy and no code change.

One real bug, found the way the useful ones always are — by driving a browser rather than reading the diff. `model/gltf-binary` is not a CORS-safelisted content type, so the upload is preflighted, and `access-control-allow-methods` did not list `PUT`. Every server-side test passed; the feature was "Failed to fetch" with the row stuck on "Processing…" forever. That is the third time in four sprints that the seam between two working halves was the thing that was broken.

---

### Sprint 31 — Real-Time Collaboration

**Goal:** Multiple users editing the same project simultaneously with live presence and conflict-free merging.

**Tasks:**

- [x] **Self-hosted Yjs**, not Liveblocks. The plan offers both; Liveblocks is a paid SaaS with no account here and no egress to it, so the alternative is the one that can be built and — the part that matters — tested. `packages/collab` maps a scene onto a `Y.Doc`; `apps/collab-server` holds one room per `Project`
- [x] `sceneStore` propagates both ways: local commits push into the CRDT, remote updates come back through a new `applyRemoteScene` that moves the document **without touching this client's undo stack**
- [x] Presence over the awareness channel — display name, a colour derived from the user id, and the current selection — with other people's selections drawn in the viewport in their own colour and initials in the top bar. **Camera position is in the schema and deliberately not broadcast yet**; see the tech notes
- [x] The simultaneous-gizmo question, answered: true simultaneous editing is allowed, and a **soft lock** (a second, larger box, plus a ring on the collaborator's chip) says "Alex is moving this". Never a hard lock — a hard lock in a creative tool is a queue
- [x] Reconnection resyncs from server state via a state-vector exchange, not from the last local state, so an offline edit merges rather than being discarded or overwriting
- [x] Both stress tests: two clients transforming _different_ objects merge cleanly, and two clients deleting the _same_ object resolve without a crash. Plus a third that neither the plan nor the first implementation anticipated — see below
- [x] **Added:** per-client undo. In a room, Ctrl+Z is Yjs's `UndoManager` scoped to this client's origin, because an Immer patch replayed against a document three other people have edited either targets the wrong thing or takes back somebody else's work

**Tech notes:**

- **Objects merge per object; everything else merges per section.** Objects are a `Y.Map` keyed by id, so two people adding a tree at the same instant get two trees — a `Y.Array` would merge concurrent inserts by _position_, in an order neither chose, and a delete racing an edit would fight over an index that had moved. The other sections are last-write-wins as a unit, because two people editing one audio mixer is not a workflow worth engineering for.
- **Terrain is the honest cost.** It is one base64 heightmap, so two simultaneous sculpts cannot merge and the later wins whole. Asserted in a test rather than described in a comment. Per-tile keys would narrow the loss without removing it, at the price of a second representation of terrain the whole codebase would have to learn.
- **The bug that mattered.** `applyScene` first diffed the local scene against the _document_ and wrote every difference. That is a "my copy wins": anything a collaborator changed since this client last looked is a difference, so pushing reverts it. It looks perfect on one screen and misbehaves only under concurrency — the sole condition the feature is ever used in. It now takes a required `previous` baseline and asks _"did I change this?"_ rather than _"does this differ?"_. Two tests pin it.
- **Authorisation happens during the websocket upgrade**, not after. `y-websocket`'s bundled server admits anyone who knows a room name; a room here is a project, so the socket never exists unless membership checks out. A viewer is kept out rather than let in and asked not to type, because a room has no read-only mode.
- **Camera presence is not broadcast.** An orbit is sixty updates a second per person, fanned out to everybody, to move a dot. The field is in the schema for when a "jump to them" affordance justifies the bandwidth; publishing it now would cost more than the edits do.
- **Peers are keyed by seat, not by account.** One person with two monitors is two seats, and a list keyed by user id collides the moment they open a second window.

**Deliverables:** Working real-time multi-user editing with presence.

**Definition of Done:** Two browser sessions (different accounts) open the same project; edits in one (add object, move object, sculpt terrain) appear in the other within ~200ms; both sessions show live cursor/selection presence of each other; the simultaneous-edit stress tests above pass without data loss or crashes.

**Met, with two qualifications stated rather than buried.**

Four Playwright tests drive two real browser contexts against a real room server and a real Postgres. An object added in one window appears in the other's _scene graph_, not merely its document; a move in the second window comes back to the first without the first's own push reverting it; selection travels as presence and draws; closing a context removes the seat immediately rather than leaving a ghost cursor; two simultaneous transforms of different objects both survive in both windows; and what a room built is written back as a version that a third, entirely fresh context loads.

The first qualification is **"different accounts"**. The two seats are one account in two isolated browser contexts. Inviting a second user requires reading an invite token that is delivered by email or a server log, and a browser cannot read either. Two seats for one account is a real case regardless — anyone with two monitors — and it is the case that caught a peer list keyed by user id. Cross-account access is covered at the server level instead, where the authorizer refuses a socket whose session does not carry an editor-or-above membership of the project's organisation.

The second is **~200ms**. Measured here: about **86ms** on a quiet run and about **840ms** on a contended one, in a container running five services and a software renderer on shared cores. The test asserts under three seconds. A threshold set near the good-run figure fails on the bad one, and a flaky latency test teaches people to ignore latency; the bound that earns its keep separates "pushed" from "polled, or never". The 200ms target is met in practice and is not something this environment can honestly assert.

One rough edge worth naming before somebody finds it: **the Save button and the room both write
versions.** The room appends a version on a debounce and on the last departure; the editor's own
save sends the base version it holds and is refused with a 409 if the room moved past it. In a
collaborative session the manual save is largely redundant — the room is already persisting — and
the two can disagree about which version is next. Nothing in the suite has hit it, because a room's
debounced write and a deliberate Ctrl+S rarely land in the same second, but the interaction is real
and the fix is to make the save button a no-op inside a room rather than a race. Not done here.

One more thing this sprint flushed out, in the tests rather than the product. Five save-and-reload
e2e tests started flaking once a fifth service joined the run. The assertion was
`expect(saveState).toHaveText('Saved')` — which is _already_ true from the write that created the
project, so it passed instantly while the save under test was still in flight, and the reload
interrupted it. The record then kept its previous contents, which is exactly what the failure
showed: a project still named "Untitled scene" after a rename had been saved. The fix pins the
transition rather than the end state (wait for "Unsaved changes", then save, then "Saved"), and the
group now runs clean three times over with retries disabled, and a full run went from five flaky to
one. Worth recording because the test was wrong from the day it was written and only contention made
it say so — and because the first version of the fix broke a different test, the one that saves an
_untouched_ scene to check thumbnails, which has no dirty state to wait for. Caught by running the
suite again rather than by assuming the fix worked.

**The last flake is not explained.** "edits survive a full page reload" still fails about one run in
three, always the same way: after a rename and a save that visibly transitions to "Saved", the
reloaded project list shows the project under its _creation-time_ name. `saveProject` writes
`name: project.scene.name` unconditionally, and `save()` reads the store at call time, so a
completed save cannot produce that record — which means either the save that produced it ran before
the rename, or the write landed and the list read something older. Neither is demonstrated by the
evidence to hand. It retries green and is the same test flagged as pre-existing debt in Sprint 24;
it is now the only one left, which makes it worth a session of its own rather than another guess.

Also not done: **sculpting is not in the two-browser test**. The document-level test proves terrain replicates and that concurrent sculpts are last-write-wins, but driving two simultaneous brush strokes through two software-rendered canvases would be measuring the test harness. And there is **no reconnection test in a browser** — the state-vector resync is proven at the document level, where a client that edited while offline and one that edited while online both keep their work, but nothing in the suite pulls a real socket out and puts it back.

---

### Interlude — the `.hela` project file

**Not a numbered sprint.** Asked for between Sprints 31 and 32: a save format of this product's own,
the way Unity has `.unity` and Godot has `.tscn`, plus getting a project onto a disk, into Drive, and
into git.

**Goal:** One file that is the whole project, so it can be kept anywhere.

**Tasks:**

- [x] `packages/hela-file` — a zip container holding `hela.json`, `scene.json`, an optional
      thumbnail, the custom `.glb` files the scene places, and the UI media the shell references
- [x] Local save and open: File System Access API where it exists (a real Save As with a retained
      handle, so the next save writes the same file), download + file input where it does not
- [x] Drag a `.hela` onto the projects screen, or pick one; **Ctrl+Shift+S** saves to file
- [x] Custom models and UI media survive the round trip — the UI blobs go back into IndexedDB, the
      models become blob-backed session assets
- [ ] **Google Drive: not done, deliberately.** Needs a Google Cloud project and a verified OAuth
      consent screen
- [ ] **GitHub integration: not done, deliberately.** Needs a registered GitHub App

**Tech notes:**

- **A container, not a renamed `scene.json`.** The obvious version — write the document out with a
  new extension — works perfectly until somebody uses an asset they uploaded, at which point the
  recipient opens a level full of missing models. Curated assets are _not_ embedded: they ship with
  every install, and copying a tree into every file that places one would make a 40 KB level weigh
  megabytes.
- **Built to be committed.** Canonical JSON with sorted keys, entries stored rather than deflated,
  and fixed zip entry dates — so two saves of an unchanged project are byte-identical and git sees a
  delta rather than a whole new blob. Asserted in a test, because a claim about determinism that
  nobody checks stops being true within a month.
- **The version is the container's own**, separate from `SceneSchema`'s. They change for different
  reasons, and a file from a newer build is refused rather than opened — opening it would silently
  drop entries this build does not know to carry, and the next save would write that loss to disk.

**Definition of Done:** A project can be saved to the user's own computer as a `.hela` file, moved
somewhere else, and opened again with its scene and its custom content intact.

**Met.** A browser builds a `.hela` through the same code path the Save-to-file button uses, and a
second browser context — sharing no IndexedDB and no localStorage — opens it and gets the level in
its viewport, then keeps it after a reload. A PNG renamed to `.hela` is refused with a sentence
rather than a stack trace.

Three things are honestly outside it:

- **The native file dialog is not driven.** Playwright cannot operate an OS file picker, so the e2e
  carries the bytes between contexts rather than clicking through Save As. The container, the build
  and the import are covered; the dialog wiring is not.
- **Imported custom models last for the session.** They come back as blob URLs, so the level draws
  immediately — but a blob URL dies with the tab, and after a reload those models are placeholders
  until they are uploaded to an account under My Assets. The editor says so on import rather than
  leaving it to be discovered. Making them permanent means a second, local kind of asset library
  with its own storage limits and its own export path, which is a feature rather than an import
  detail.
- **No Drive and no GitHub.** Both need OAuth credentials this repository cannot provision, and a
  stub would be pretending. What the format delivers instead is a file that a synced folder already
  backs up and that `git add` already accepts — which is why the diffability work above was worth
  doing rather than a nicety.

---

### Sprint 32 — Export Job Orchestration at Scale

**Goal:** Move export bundling (Sprints 21-23) from a client-side operation to a server-side background job, for large projects and to enforce plan quotas.

**Tasks:**

- [x] `export_jobs` table (hand-written SQL, not Prisma — see `db.ts`) + `POST /projects/:id/exports` enqueueing onto **a real BullMQ queue on real Redis** + `GET /export-jobs/:id` for polling
- [x] `apps/export-worker`, a separate deployable process consuming the queue: loads the target `SceneVersion`, runs **the same `packages/export` bundler the editor runs**, zips, stores the artifact. **Local disk, not object storage** — the same deployment decision as Sprint 30
- [x] Progress UI: polling, a real `<progress>` driven by the worker's own stages, and a Download link on completion that **expires after 24 hours**
- [x] Plan-tier quota, enforced for real. **No billing exists**, so which tier an organisation is on is a column somebody sets by hand — the limit itself is not a stub
- [x] Retry policy: three attempts with exponential backoff for transient failures, `UnrecoverableError` for ones that will fail identically, and a failure state with the worker's own sentence rather than a spinner
- [x] Eight simultaneous exports, queued and completed one at a time rather than eight builds in memory at once
- [x] **Added:** a health endpoint on the worker; `GET /orgs/:id/export-quota` so the allowance is visible _before_ the button is pressed; and a separate artifact store, because reading exports out of the asset directory finds nothing

**Tech notes:**

- **The queue is finally the real product.** Redis is present in this environment, so unlike R2, Cloudflare and Liveblocks this sprint uses what the plan names. It earns it: two processes that must not share memory, jobs that survive a restart of either, and retry-with-backoff — tedious to write and easy to get subtly wrong.
- **Two stores for one concept, on purpose.** Redis carries the work; the `export_jobs` row carries the record. A queue flush should lose pending jobs, not somebody's history — and counting _rows_ rather than queued messages is what stops a quota being reclaimed by waiting for the queue to drain.
- **The worker is small because Sprint 21 was careful.** `packages/export` was written with no DOM, no `fetch` it did not ask for and no JSZip: it takes a `readAsset` callback and returns a list of files. Moving the work off the browser needed no second implementation, so a server export and a browser export of the same project produce the same files. That was the point of the "plan rather than a zip" split, and this is the sprint that collects on it.
- **Concurrency defaults to one.** An export holds the whole build in memory before zipping, so concurrency multiplies peak memory rather than sharing CPU — and a worker killed by the OOM reaper loses every job it was holding. Scale by running more workers.
- **A job builds a _version_, not "the project".** Somebody who presses Export and keeps editing gets the build they asked for.

**Deliverables:** Server-side export orchestration with progress, quotas and retries.

**Definition of Done:** A 300MB project export completes as a background job with progress bar, doesn't block the editor UI, and produces a time-limited signed download link.

**Met, with the size qualified.** A browser signs up, saves a project, presses **Build on the server**, watches a progress bar driven by the worker's real stages, and follows a Download link — which the test then unzips and inspects, finding `index.html`, `main.js`, `engine/runtime.js` and a `scene.json` holding the objects that were exported. Four processes end to end: browser, API, Redis, worker.

Two honest qualifications. **Nothing 300 MB was built** — the largest thing here is the Stress Test template, and manufacturing a 300 MB project to prove a number would be testing the fixture. What _is_ proven is the mechanism the size argument rests on: the work is off the tab, progress is real, and eight concurrent requests queue rather than compounding. And the link is **time-limited but not signed** — it carries a session token, and membership is checked on every request, which is a different (and for a self-hosted deployment, stronger) guarantee than an unguessable URL. Object storage would make it a genuine presigned URL, and that is the same deployment decision Sprint 30 recorded.

The bug worth recording is mine, and a test caught it. The quota guard put the count inside the insert's `where` and looked atomic — one statement, surely one answer. Under `READ COMMITTED` it is not: two concurrent inserts both snapshot four-used, both find four below five, and both write. Ten simultaneous requests against a limit of five let **six** through, which is exactly the double-click attack the guard existed to stop. It now takes a per-organisation advisory lock, so different customers never contend and the same one serialises.

Also found, and less interesting but more likely to have bitten somebody: the download route read the _asset_ store rather than the export store, so every download would have 404'd once the two directories diverged. And `pnpm test` had been running the API and worker suites in parallel against one database, each calling `reset()` on the other — the worker has its own database now.

**Deliverables:** Server-side, queued, quota-enforced export pipeline.

**Definition of Done:** Exporting a large (e.g., 300MB) project completes as a background job with visible progress, doesn't block the editor UI, produces a working signed download link, and a free-tier account attempting to exceed its export quota receives a clear upgrade prompt instead of a silent failure.

**Phase 4 wrap check:** The product is now a real multi-user cloud platform, not a local single-player tool. This is a good point to run a genuine closed-alpha with a handful of trusted external users before Phase 5's hardening work, since real usage will surface backend edge cases no amount of internal testing will catch.

---

## PHASE 5 — ENTERPRISE HARDENING

**Duration:** Sprints 33–36 (2 months) | **Outcome:** Observability, security, billing, load testing all production-grade.

### Sprint 33 — Observability + SRE Basics

**Goal:** You can see what's happening in production, end to end, before something goes wrong — not just after.

**Tasks:**

- [x] `packages/telemetry`: OpenTelemetry tracing with an OTLP exporter, correlation ids on `AsyncLocalStorage`, a hand-written Prometheus registry, and structured JSON logs. **Manual instrumentation, not auto-instrumentation** — see the tech notes
- [x] Correlation ids across the whole lifecycle: browser header → API span → **BullMQ payload** (a queue has no headers, so the W3C `traceparent` is carried by hand) → worker spans → storage write → the `export_jobs.correlation_id` column
- [x] `/metrics` on both services, with route _patterns_ as labels rather than paths — the difference between twenty time series and one per project id
- [x] A React error boundary per panel, plus `window.onerror` and `unhandledrejection`, reporting to a **Sentry-compatible endpoint** written by hand rather than the SDK. Nothing leaves the browser unless `VITE_SENTRY_DSN` is set
- [x] Grafana dashboard JSON and Prometheus alert rules under `ops/`, with four alerts that each have a runbook entry — and no alert that does not
- [x] `docs/RUNBOOK.md`: what to do when each alert fires, what is deliberately _not_ alerted on, and what this sprint does not cover
- [x] **Added:** `tools/trace` — `pnpm trace <correlation-id>` prints the definition-of-done view from a local span file, so the claim is checked by a test rather than asserted in a document

**Tech notes:**

- **No auto-instrumentation, deliberately.** `@opentelemetry/auto-instrumentations-node` would patch `http`, `pg` and `ioredis` at load time and produce a great deal for free. Two objections, and the second decided it: patching the module registry means the service under test differs from the service in production by whatever the patches do; and a trace made of `HTTP POST` and `pg.query` spans says what the _runtime_ did, while `export.build` and `export.store` say what the _product_ did. The second is the one somebody reads at two in the morning.
- **Why a correlation id when a trace id exists.** A trace id is useful to somebody holding a tracing backend. A correlation id is useful to somebody holding a log file, a support email, or a screenshot — it is short, readable, and printed on the crash screen and next to a failed export. It is validated on the way in against a strict shape, because a caller-supplied newline in that header would split one JSON log line into two, the second of which the caller writes.
- **The metrics registry is ninety lines rather than `prom-client`.** What a scrape endpoint has to produce is text in a format that has not changed in a decade, and three instrument types cover everything here. What that costs: no exemplars, no native histograms, no free `process_*` collectors. If any of those become load-bearing, take the dependency.
- **Cardinality is the whole design of the metrics.** Every label comes from a fixed list of route patterns; anything unrecognised collapses to `unmatched`, so a scanner spraying URLs adds one series rather than thousands.
- **A boundary per panel, not one around the editor.** One outer boundary is less code and much worse: a properties panel throwing on a malformed field would take the viewport and the toolbar with it, and the user would lose sight of a scene that is still perfectly fine in memory.

**Deliverables:** Full observability stack, dashboards, alerting, incident runbook.

**Definition of Done:** You can pick any single export request from the last hour and trace its complete path — HTTP call, queue entry, worker processing, storage upload, client callback — in one Grafana view using its correlation ID, with timing at each stage.

**Met locally, not in Grafana.** An end-to-end test presses **Build on the server** in a real browser, reads the correlation id out of the response header the way a user's browser would, waits for the download, and then prints the whole path from the spans two separate processes wrote:

```
trace       5487617f734794ef0ced565617fbbad0
correlation hela_65653ad44b8da5a9
services    api, export-worker
spans       7, 430.9ms end to end

  +0ms      13.1ms    api                      POST /projects/:project/exports
  +5ms      3.5ms     api                        export.record
  +8ms      3.9ms     api                        export.enqueue
  +16ms     414.9ms   export-worker                export.job
  +27ms     3.0ms     export-worker                  export.load_scene
  +31ms     395.1ms   export-worker                  export.build
  +428ms    2.6ms     export-worker                  export.store
```

Every stage the definition names, with a duration on each, from one id. What is **not** met is the words "in one Grafana view": there is no Grafana Cloud account and no container runtime here, so the dashboard JSON and the alert rules have never been loaded into a running Grafana or Prometheus. They are reviewed configuration, and `docs/RUNBOOK.md` says so in its own words. The metrics they query _are_ asserted by tests to exist with those names and labels, so the queries have the right inputs — but a panel that renders is not something this sprint can claim.

Three more honest gaps. **No alert delivery**: the rules carry `severity: page` and `severity: ticket`, and nothing is wired to PagerDuty or Slack. **No log shipping**: logs are structured JSON on stdout, which is what Loki and every platform shipper expect, and nothing ships them. **No Sentry account**: the editor's reporter is exercised against a fake DSN in a unit test, never against Sentry itself.

**And the flaky tests are finally explained.** Sprints 31 and 32 both recorded save-and-reload tests that failed a run and passed on retry, with no diagnosis. Verifying this sprint with retries _off_ made them reproducible, and the cause was one line shared by twenty-one tests: `expect(page.getByRole('banner')).toBeVisible()`, used as "wait until the editor has opened". The projects screen renders its own `<header>` — and a `<header>` is `role="banner"` — so the wait was satisfied by the screen the test was leaving and returned immediately. Every `evaluate` edit after it raced the asynchronous project creation, and losing that race meant `setScene` replaced the document the edit had gone into. That is why the symptoms never looked related: a missing object, a save state stuck empty, a `uiConfig` full of defaults, a project that never appears under its new name — one race, surfacing wherever it was lost that run, and only under the load of a full suite. Tests now wait for the editor's own top bar. Two further finds followed from the same discipline: a real (if narrow) `useAutosave` bug where an edit landing in the same effect pass as a project opening was treated as the load and left undirty, and a cloud-save test that asserted `Saved` without first asserting _not_ `Saved`, so a second browser could read the version from before the edit. **The suite now passes 133 with retries disabled.**

The bug worth recording cost a debugging session and is the sort that would have quietly ruined the feature. The one log line per request — the line that exists to be searched by correlation id — was being written _without_ one. `AsyncLocalStorage` does not follow an event listener: Node runs an emitter's callbacks in the async context the emitter was created in, not the one `.once()` was called from. The listener now re-enters the correlation explicitly. A second, related: the request span was ended where the handler returned, which meant every _failed_ request — the ones somebody would go looking for — got a span with no status code, because a thrown handler never reaches that line. The span now ends when the response closes.

---

### Sprint 34 — Security & Compliance Pass

**Goal:** Close obvious gaps before you have real customer data and enterprise scrutiny to deal with.

**Tasks:**

- [x] Dependabot (weekly, grouped) and a `Security` workflow: `pnpm audit --prod` blocking on runtime advisories, dev advisories reported; Semgrep with four published rulesets plus **four rules specific to this codebase**
- [x] Every lifetime in the system read and recorded — and two of them found to be claims rather than facts: expired sessions and invites were never deleted, and an expired build's _bytes_ stayed on disk after its link stopped working. Both are swept hourly now
- [x] CORS reviewed: a wildcard by default is safe _here_ because auth is a bearer token rather than a cookie and `Allow-Credentials` is never sent — with `ALLOWED_ORIGINS` to narrow it. **No bucket policies to audit**: storage is local disk behind an interface, which is Sprint 30's recorded decision
- [x] The sandboxing guarantee re-verified and then **made permanent**: lint rules, a Semgrep rule, and a sweep of every tracked file that returns nothing
- [x] Audit log: ten actions, closed vocabulary in the database as well as the code, `subject` as text so a record outlives what it describes, correlation id on every entry, admin-only to read
- [x] `docs/SECURITY.md`: retention table, vendor list, SOC 2 readiness with the gaps named — backups being the largest
- [x] OWASP-focused review of the API, which found **no rate limit anywhere** and **a sign-out that revoked nothing**. Both fixed. Cross-org isolation proven by a table-driven suite over all eighteen tenant-scoped routes

**Tech notes:**

- **The sweep found the one hit in the repository, and it was in a test.** `packages/export`'s generated-code check compiled `main.js` with `new Function` — a _script_ compiler, so the test stripped the import block and every `export` keyword to make it parse, meaning the module syntax that the bug it was written for actually broke was the part not being checked. esbuild parses it properly now, and there is no exception in the rule for somebody to point at later.
- **`startsWith(root)` is not containment.** Every local store used it, and it is true for `/data/assets-old/secret.glb` when the root is `/data/assets`. `join` already normalised `..` away, so the classic traversal was refused; this is the narrower case underneath, and the difference is one separator.
- **Two limiters on login, not one.** Per address misses credential stuffing spread across a botnet; per account misses a broad sweep of many accounts. Each is blind to the other's attack. Sliding windows, because a fixed one hands an attacker double rate across the boundary — and `X-Forwarded-For` is trusted only under `TRUST_PROXY`, since a header the client sets is a bypass rather than an identity.
- **`audit()` never throws,** and the reasoning is in the code: a database hiccup turning a member removal into a 500 _after_ the removal committed is worse than a missing row.
- **Express left the co-op server.** It was there for one health route and two CORS headers, and it brought a `path-to-regexp` ReDoS advisory into a deployed process. Matchmaking runs over the WebSocket transport, so the router was never used; fifteen lines of `node:http` replace it.

**Deliverables:** Dependency/SAST scanning in CI, security audit findings resolved, compliance-readiness doc.

**Definition of Done:** The OWASP-focused review and codebase `eval`/dynamic-execution grep both come back clean (or all findings are resolved, not just documented); cross-org data isolation is explicitly tested and verified via integration tests, not just assumed from the RBAC design.

**Met, with the nature of the review qualified.** The dynamic-execution sweep is clean across every tracked file and is now enforced by two independent mechanisms rather than repeated by hand. Cross-org isolation is tested per endpoint — eighteen routes, each driven with a valid session belonging to a different tenant, which is a stronger claim than an anonymous request — and the suite was itself verified by removing a guard on purpose and watching exactly one test fail.

Every finding was fixed rather than filed: no rate limiting, a sign-out that revoked nothing, a containment check that a sibling directory could satisfy, expired credentials kept for ever, expired build artifacts kept for ever, and two runtime dependency advisories (one removed with its dependency, one pinned forward).

What is **not** met is the phrase "against staging". There is no staging deployment and no ZAP run; the review was a read of the code and a set of tests written against it, by the person who wrote the code. That is worth something and it is not an independent assessment, which is why `docs/SECURITY.md` says so in its own words alongside the other gaps — no penetration test, no secrets management, no MFA or SSO, and no database backups, which is the largest hole on the page.

---

### Sprint 35 — Billing & Plan Tiers

**Goal:** The business model is actually enforced in software, not just on a pricing page.

**Tasks:**

- [ ] Define concrete plan tiers (e.g., Free / Pro / Enterprise) and their limits: seats, storage GB, exports/month, custom asset uploads (yes/no), collab session participant cap, SSO (enterprise only)
- [ ] Integrate Stripe: Products/Prices for each tier, Stripe Checkout or Billing Portal for self-serve upgrade/downgrade, webhook handlers (`invoice.paid`, `customer.subscription.updated/deleted`) updating the `Subscription` Prisma model
- [ ] Implement `UsageRecord` metering: track exports, storage used, active seats per org per billing period; expose usage-to-date in the UI ("3/10 exports used this month")
- [ ] Wire `PlanTierGuard` across the relevant endpoints (custom asset upload, export quota from Sprint 32, collab participant limits, seat limits on invites) — reject with a clear, actionable error (not a generic 403) pointing to the upgrade flow
- [ ] Build in-app billing UI: current plan display, usage meters, upgrade/downgrade flow, invoice history (Stripe-hosted portal is often sufficient here rather than building custom UI)
- [ ] Test plan transitions explicitly: downgrade from Pro to Free while over the Free tier's storage limit — decide and implement the actual behavior (e.g., read-only lockout of excess projects vs. grace period) rather than leaving it undefined

**Deliverables:** Working metered billing across all plan tiers, enforced in the API.

**Definition of Done:** A free-tier account attempting a Pro-only action (e.g., custom asset upload) is cleanly blocked with an upgrade prompt; upgrading via Stripe Checkout immediately unlocks the feature without requiring a manual support action; usage meters in the UI accurately reflect actual metered usage.

---

### Sprint 36 — Performance & Load Testing

**Goal:** Confidence the system holds up under real concurrent usage before you invite real customers to depend on it.

**Tasks:**

- [ ] Write k6 (or Artillery) load test scripts simulating realistic usage patterns: concurrent project CRUD, concurrent autosave bursts, concurrent export job submission
- [ ] Define and test against explicit target numbers (pick numbers appropriate to your actual go-to-market scale expectation, e.g., "500 concurrent editing sessions, p95 API latency under 300ms for CRUD operations")
- [ ] Run the Sprint 12 engine-side stress-test scene (500 props/20 enemies) through a long-session memory leak check (2+ hour continuous Play Preview session, watch Chrome memory profiler for unbounded growth — a common r3f/Three.js pitfall is un-disposed geometries/materials on object deletion)
- [ ] Audit and fix any editor bundle-size or initial-load performance issues (Lighthouse audit, code-splitting heavy panels like the Asset Library if it's not already lazy-loaded)
- [ ] Tune CDN cache hit-rate for asset delivery (verify cache headers from Sprint 30 are actually effective, check Cloudflare analytics for hit ratio)
- [ ] Load-test the collab server (Sprint 31) specifically for connection-count scaling, since it has a different scaling profile (long-lived connections) than the stateless API

**Deliverables:** Documented, tested performance targets across API, engine runtime, and collab server.

**Definition of Done:** The k6 load test suite runs against staging and meets the documented p95 latency targets at the target concurrency level; the 2-hour memory-leak session shows stable (non-growing) memory usage; results are written up in a short perf report doc for future regression comparison.

**Phase 5 wrap check:** This is the last phase before content/launch — the system is now genuinely production-grade. Good point for a final external security/perf review if budget allows (even a lightweight third-party pen test) before opening to a wider beta.

---

## PHASE 6 — CONTENT & BETA LAUNCH

**Duration:** Sprints 37–38 (1 month) | **Outcome:** Real asset library, polished templates, closed beta running.

### Sprint 37 — Template & Asset Library Expansion

**Goal:** The product needs to feel complete and inspiring on day one, not like a tech demo with 10 placeholder assets.

**Tasks:**

- [ ] Commission or model 50-100 production-quality low-poly assets across all categories (trees/foliage variants, rocks/terrain scatter, multiple building styles, several enemy types with basic animations, props/decorations, weapons/interactables) — run every asset through the Sprint 2/18 ingest pipeline
- [ ] Build 5-10 polished starter templates showcasing the full feature set (e.g., "Village," "Forest Clearing," "Dungeon Arena," "Island Outpost," "Combat Arena") — each should demonstrate terrain sculpting, varied props, at least one enemy with behaviors, and at least one trigger-based interaction
- [ ] Lay groundwork for a future asset marketplace even if not launching it now: verify the `License` table/schema from DEVELOPMENT-PLAN.md correctly distinguishes your first-party assets from any future third-party contributions, and confirm licensing terms are clear and correctly attached per asset
- [ ] Run a full accessibility/UX pass over the core editor flows (color contrast on UI panels, keyboard-navigable menus, clear focus states) — not full WCAG compliance necessarily, but no glaring usability barriers
- [ ] Polish onboarding-critical UI details: empty states (empty asset library search result, empty project list), loading states, error states — these get seen constantly by new users and disproportionately shape first impressions

**Deliverables:** Rich, production-quality asset library and template set.

**Definition of Done:** A usability test with 5 people unfamiliar with the product: each successfully goes from signup → pick a template → make a recognizable, personalized edit (add/remove/rearrange objects, sculpt terrain) → export, within 10 minutes, without needing help.

---

### Sprint 38 — Docs, Onboarding, Closed Beta

**Goal:** Real external users, real usage data, real friction points surfaced before GA.

**Tasks:**

- [ ] Stand up a public docs site (Docusaurus): engine API reference (auto-generated from TSDoc comments where possible), full behavior reference (each built-in behavior type + its params, with examples), export guide (how to host/run an exported project), troubleshooting FAQ
- [ ] Build in-app onboarding: a guided first-run tour (highlighting asset panel, placement, transform gizmo, save, export) — keep it skippable and short, most users tune out long tours
- [ ] Record 3-5 short video walkthroughs covering: creating your first scene, adding enemy behaviors, exporting and running your project
- [ ] Recruit a closed beta cohort (20-50 users) — mix of hobbyist game devs and a few people resembling your target enterprise persona if you have B2B ambitions
- [ ] Integrate PostHog (or chosen analytics) event tracking on key funnel steps (signup → first project created → first object placed → first save → first export) to identify drop-off points quantitatively, not just anecdotally
- [ ] Set up a lightweight support channel (Discord, or a simple support email/Intercom) and triage process for beta feedback; maintain a running "top friction points" list reviewed weekly during the beta window

**Deliverables:** Public docs, in-app onboarding, closed beta running with instrumented funnel analytics.

**Definition of Done:** The closed beta cohort completes the core create → edit → export flow with a low support-ticket rate on that specific flow (define an acceptable threshold, e.g., under 10% of users needing help on it); funnel analytics clearly show where the biggest drop-off point is, informing what gets fixed before GA.

---

## PHASE 7 — GA LAUNCH

**Duration:** ~2 months post-beta (treat as 2-4 additional sprints depending on beta findings) | **Outcome:** Public launch, pricing live, support processes running.

### Sprint 39 — Beta Findings Remediation

**Goal:** Fix what the closed beta actually revealed, prioritized by real friction data, not internal guesses.

**Tasks:**

- [ ] Triage the full beta feedback backlog + funnel analytics from Sprint 38; rank issues by (a) how many users hit it and (b) how severely it blocks the core flow
- [ ] Fix the top-ranked friction points — this sprint's scope is intentionally defined by beta data rather than a pre-written task list, since you don't know yet what beta will surface
- [ ] Re-run the Sprint 23 export QA suite and Sprint 36 load tests if any remediation touched engine/export/backend performance-sensitive code, to confirm no regressions
- [ ] Finalize pricing page copy and plan-tier limits based on actual beta usage patterns observed (you now have real data on typical project sizes, export frequency, etc. — sanity check your Sprint 35 tier limits against reality)

**Deliverables:** Beta-informed product fixes, finalized pricing.

**Definition of Done:** The top 3-5 friction points identified in beta are resolved and re-validated with a subset of the original beta cohort confirming improvement.

---

### Sprint 40 — Public Launch Readiness

**Goal:** Everything needed to support real public traffic and paying customers on day one.

**Tasks:**

- [ ] Finalize and QA the public marketing site (separate from the app itself) — pricing page, feature overview, template gallery showcasing Sprint 37's work
- [ ] Set up production support processes: ticketing system (if not already from Sprint 38), documented SLA expectations per plan tier, escalation path for critical bugs
- [ ] Run a final production readiness review: verify all Phase 5 observability/alerting is active on the actual production environment (not just staging), confirm backup/restore procedures for Postgres are tested (not just configured), confirm Stripe is in live mode with correct webhook endpoints
- [ ] Prepare a launch-day monitoring plan: who's watching dashboards, what the rollback plan is if a critical issue emerges, communication plan for status updates if there's an incident
- [ ] Execute launch (public sign-ups open, pricing live, marketing push per your go-to-market plan — outside the scope of this technical doc but coordinate timing with it)
- [ ] Post-launch: run the same funnel analytics review cadence from beta, now at public scale, feeding into your first post-GA roadmap prioritization (see DEVELOPMENT-PLAN.md section 7 for the future roadmap this feeds into)

**Deliverables:** Public GA launch, production support processes active, monitoring plan executed.

**Definition of Done:** Public sign-ups are open, a real payment successfully flows through Stripe live mode end-to-end, and the team has active visibility (dashboards + alerting) into production health during and after the launch window with no unmonitored blind spots.

---

## Summary Timeline Reference

| Phase                       | Sprints  | Duration       | Outcome                                                 |
| --------------------------- | -------- | -------------- | ------------------------------------------------------- |
| 0 — Foundations             | 1–2      | 1 month        | Engine skeleton + asset pipeline locally                |
| 1 — Editor MVP              | 3–8      | 3 months       | Full local editor: place, transform, terrain, save/load |
| 2 — Behaviors/Physics/AI    | 9–12     | 2 months       | Enemies, physics, triggers in preview                   |
| 3 — Export System           | 13–15    | 1.5 months     | Standalone playable exports, cross-browser verified     |
| 4 — Backend Platform        | 16–20    | 2.5 months     | Auth, cloud save, collab, cloud export jobs             |
| 5 — Enterprise Hardening    | 21–24    | 2 months       | Observability, security, billing, load testing          |
| 6 — Content & Beta Launch   | 25–26    | 1 month        | Asset library, templates, closed beta                   |
| **Subtotal to public beta** | **1–26** | **~13 months** |                                                         |
| 7 — GA Launch               | 27–28    | ~2 months      | Public launch, pricing live, support running            |
| **Total to GA**             | **1–28** | **~15 months** |                                                         |

_(Compress by 30-40% with a 3-4 person team split across engine/editor/backend/devops lanes as outlined in GUIDE.md section 4 — sprints in Phases 1, 2, and 4 parallelize best across those lanes.)_
