# SPRINT.md — Full Sprint-by-Sprint Execution Plan (Phase 0 → GA Launch)

### Companion to GUIDE.md (architecture overview) and DEVELOPMENT-PLAN.md (stack/infra rationale). This file is the actual day-to-day backlog — every sprint has: Goal, Detailed Tasks, Tech Notes, Deliverables, Definition of Done (DoD), and Watch-outs.

**Sprint length:** 2 weeks. **Total:** 26 sprints to public beta (~13 months) + Phase 7 GA (2 sprints, ~2 months).

**Progress:** Sprints 1–21 complete. Phase 2B is done; **Phase 3 (Export) has begun.** Phases 1 (Editor MVP) and 2 (Behaviours, Physics, AI) done; **Phase 2B (Gameplay Runtime & UI, Sprints 13–20) is under way** — it was inserted ahead of the export system because exporting a world with no menus, HUD, combat or sound would be shipping a viewer rather than a game. Everything from the old Sprint 13 onward has been renumbered accordingly; see `GAMEPLAY-RUNTIME-AND-QA-PLAN.md`. Checkboxes below are ticked as each sprint lands — this file is the live backlog, not a snapshot of the original plan.

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
- A `revealArea` action is *why* its objects start hidden — the runtime hides everything named by an unfired reveal at startup rather than making the author maintain a separate "hidden" flag that could disagree with the list. Hiding takes the collider with it, because an invisible wall the player still walks into is the most confusing possible reading of a secret area.
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
- **A save holds state, never structure.** Health, weapons, checkpoint, secrets found. Nothing in it names an object, an asset or a behaviour, so no save — however edited — can change what a scene *contains*.
- The reset rules travel with the checkpoint request rather than being looked up at respawn time, so a checkpoint reached before its rules were edited keeps the rules it was reached under. A save records what happened, not what the document says now.
- Restoring a save does **not** re-run the unlock actions: a teleport on load would drop the player somewhere they did not ask to be, and a granted weapon is already in the restored inventory. Only `revealArea` has a lasting world effect, and that is applied directly.
- Saving happens on the checkpoint rather than on a timer. A checkpoint *is* the author saying "this moment is worth keeping"; a periodic autosave would second-guess them.

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
- [x] **Added:** a combat *hold* so the track does not flicker every time an enemy blinks; per-binding rate limiting; a stand-in audio generator (`pnpm generate-assets` now writes ten synthesised WAVs); and audio excluded from the placement library, because a sound is not something you drag onto the terrain

**Tech notes:**

- **No gameplay code knows that any of this makes a noise.** Behaviours already raise `pickup`, `checkpoint` and `enemyDied`; a scene binds a name to a clip and that is the whole integration. It is also why an author can put a sound on an event the engine has never heard of, from a pickup's `sfxEvent` or a trigger's `emit`.
- The music player takes its track factory as an option, so the crossfade is unit-tested without a sound card — which matters, because neither CI nor headless Chromium has one.
- Two audio graphs are in play and it is worth being honest: Howler owns one `AudioContext`, and positional sources would own another. The same master gain is applied to both. One shared context would be tidier and is not worth reimplementing Howler to get.
- The player's mixer settings live in `localStorage`, deliberately **not** in `scene.json`: how loud somebody likes their music is a property of that person, and writing it into the document would carry one player's preference to everyone the project is exported to. Validated on read like every other stored blob — a tampered value would otherwise produce a volume of 40.

**Definition of Done:** A scene has distinct menu and gameplay music with a clean crossfade, correct SFX on damage/pickup/checkpoint, and a working in-game mixer that persists for the session.

**Met, with one limitation that has to be stated plainly: nothing here has been _heard_.** Headless Chromium has no output device and this container has no sound card, so every audio claim in this sprint is a claim about wiring, not about acoustics. What *is* verified, in a real browser: the music state machine moves menu → explore → combat as the game does, pausing switches to menu music without ending the fight, the mixer takes a value and keeps it across a reload without touching the document, and the ingested WAVs are served as real RIFF/WAVE files rather than 404s. The crossfade itself — old track falling while the new one rises, over the configured duration — is asserted against a recording test double, which pins the sequence and the timings but not the sound.

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
- `colyseus.js` lives in the *editor*, behind a `CoopTransport` interface the engine defines. A hard networking dependency in `packages/engine` would put a socket client in the bundle of every single-player game anybody ever makes; there is a test asserting the import is absent.

**Definition of Done:** Two browser clients join the same session and see each other move in real time, server-authoritative, with no obvious desync under normal network conditions.

**Met.** Two *separate Playwright browser contexts* — not two tabs sharing a process, which would prove far less than it appears to — connect to a real Colyseus server, see each other in the player list, and one walks while the other watches the position change. The position the second browser reads came off the wire from a server that computed it. Leaving removes the player from the other browser's view, and an unreachable server drops to single player rather than refusing to start.

What is **not** verified: behaviour under real network conditions. Everything here runs over loopback, so latency is microseconds and there is no packet loss, no jitter and no reordering in practice. "No obvious desync under normal network conditions" is therefore asserted against the best possible conditions, and the interpolation that would hide a 100 ms round trip has never had one to hide. Two further scope lines worth stating: enemies and triggers are still simulated **per client** rather than by the server — only players and destroyed objects are shared, so two people will see the same goblin in slightly different places — and the room takes its scene document from whichever client opens it, which is fine among invited players and is not a security model. Sprint 27's hosted play, where the server fetches a scene by id, is where that becomes one.

---

**Phase 2B wrap check — done.** The runtime is now a complete playable game: home screen, menus, HUD, first/third/top-down cameras, weapons and combat, pickups, secrets, checkpoints with progress that survives a reload, music and sound, and optional co-op. What it is *not* yet is exportable — everything above runs in the editor's Play Preview, which is the same code an export will run but is not itself an export. Phase 3 is what turns it into something a user can be handed.

---

## PHASE 3 — EXPORT SYSTEM

**Duration:** Sprints 21–23 (1.5 months) | **Outcome:** Standalone playable exports, cross-browser verified.

### Sprint 21 — Static Export (No Behaviors Yet)

**Goal:** Prove the fundamental export mechanism works before layering in the harder behavior/physics export case.

**Tasks:**

- [x] Build Export Wizard UI: project name, include-source toggle, minify toggle, and a summary of what will ship *before* it ships
- [x] Write the **bundler**: a pre-built self-contained engine bundle, only the assets this scene references, `scene.json`, and a generated `index.html` + `main.js`
- [x] Integrate JSZip client-side to package it into a downloadable `.zip`
- [x] Handle relative path correctness — verified by extracting the archive with `unzip`, serving it over real HTTP and opening it, not by inspecting the plan
- [x] Add a README.md inside the export explaining how to run it and what each file is for
- [x] **Added:** the Draco decoder is shipped alongside the models (without it every model silently fails to appear); audio assets are followed too, since they are referenced from `audioConfig` rather than placed; and the project name is slugified so `../../etc` cannot write outside the extracted folder

**Tech notes:**

- **The editor cannot build the engine — it is a browser tab.** So `packages/engine` now produces *two* builds: `index.js` with `three` external, for the editor and the co-op server, and `runtime.js` with everything inlined, for exports. An exported project is a folder somebody unzips; it has no package manager, no bundler and no import map, so every dependency has to already be in the file. The editor serves that bundle as a static asset and an export copies it verbatim, which is also what makes an export reproducible.
- Rapier stays *out* of the runtime bundle. A static export never presses Play, and two megabytes of physics WASM in every one of them would be a poor trade. Sprint 22, which exports behaviours, is where it starts being worth paying for.
- `buildExport` is a pure function from a scene and a manifest to a list of files — no JSZip, no `fetch`, no DOM. That is what makes the interesting half of the exporter testable without unzipping anything.

**Deliverables:** Working static export pipeline.

**Definition of Done:** Export a scene with terrain + 10+ static props (no behaviors), unzip, run `npx serve` on the folder, and the browser renders an identical scene to the editor's preview.

**Met, and verified the hard way.** The e2e test exports the Village Outpost, saves the archive Playwright receives, extracts it with `unzip` (a different tool than the one that wrote it), serves the folder over a real HTTP server and opens it in a second page. It asserts a WebGL context, the scene's own name in the title — proof it read `scene.json` rather than a hardcoded page — and that nothing 404'd.

Two real bugs, both caught by looking rather than by asserting. The first: the hand-rolled "minify" stripped `*`-prefixed lines *before* removing block comments, which deleted the `*/` terminators and left an unclosed `/**` that swallowed the import list. The export still built, still zipped, and shipped a `main.js` with no imports. There is now a test that parses the minified output rather than pattern-matching it. The second was only visible in a screenshot: everything rendered as **placeholder boxes**. `load()` is synchronous and takes whatever is in the model cache at that moment, so preloading afterwards filled a cache nothing ever read. The generated `main.js` now builds twice — once immediately from the manifest's bounds so the world is there while models download, once after they arrive.

**Scope, stated:** this is a *static* export. It renders the world; it does not start behaviours, physics, the menu shell or sound. The README inside every export says so. Sprint 22 is the one that makes an export a game.

---

### Sprint 22 — Full Behavior Export + Readability Layer

**Goal:** Extend export to cover the harder cases — behaviors, physics, AI — and add a "human-readable" option for power users.

**Tasks:**

- [ ] Extend the bundler's engine-build step to tree-shake behavior code too — only include the `BehaviorRegistry` entries actually used in this specific scene (via static analysis of `scene.json`'s `behaviors[].type` values, or simply include the full registry if tree-shaking proves too fragile — measure the size cost either way and decide)
- [ ] Verify Rapier's WASM asset is correctly included/referenced in the exported bundle (WASM files need correct MIME type handling by whatever static server the end user uses — document this clearly in the export README)
- [ ] Build the optional **"readable code" export mode**: an EJS (or similar) templating pass that, instead of a generic `SceneLoader.load('scene.json')` call, emits an explicit `main.js` with literal calls per object (e.g., `engine.spawn('tree_pine_02', { position: [10,0,-4], rotation: [0,45,0] })`, `engine.attachBehavior(obj, 'patrol', {...})`) — this is cosmetic/educational code-gen layered on top of the real data-driven system, for users who want to hand-edit after export
- [ ] Auto-generate a `CREDITS.md`/`LICENSE.md` in the export: engine license (decide: MIT? proprietary-with-export-rights?), per-asset attribution pulled from each `Asset.licenseType` in the manifest, and a placeholder for the user's own project license
- [ ] Test a scene combining terrain + static props + patrol enemy + chase behavior + trigger volume + physics character controller, fully exported and run standalone

**Deliverables:** Full-feature export (behaviors/physics/AI included), optional readable-code mode, licensing file generation.

**Definition of Done:** A scene with active enemy AI, physics, and a trigger-based scene event, once exported and served standalone, behaves identically to the in-editor Play Preview — verified by side-by-side manual comparison, and later automated in Sprint 23.

---

### Sprint 23 — Export Hardening + Cross-Browser QA

**Goal:** Make export trustworthy enough to be a core product promise, not a fragile demo feature.

**Tasks:**

- [ ] Build a Playwright-based automated pipeline: (1) programmatically construct or load a known test scene, (2) trigger export, (3) serve the resulting export folder locally, (4) screenshot it, (5) compare against a screenshot of the same scene in editor Play Preview — flag any pixel-diff beyond a tolerance threshold (visual regression, e.g., via `pixelmatch` or Chromatic if wired in)
- [ ] Run this pipeline across Chrome, Firefox, Safari (via WebKit in Playwright), and Edge for at least 5 representative template scenes
- [ ] Test on a throttled network profile (Playwright supports this) — verify loading states/spinners behave reasonably and nothing breaks with slow asset loads
- [ ] Add export size budgeting: warn the user pre-export if total bundle size exceeds a threshold (e.g., >150MB), suggest compression setting adjustments
- [ ] Handle and test edge cases explicitly: scene with zero objects, scene with a missing/broken asset reference (should fail gracefully with a clear error, not silently produce a broken export), extremely large heightmap terrain export size
- [ ] Write export troubleshooting docs (common issues: WASM MIME type on certain static hosts, CORS issues if assets reference external URLs instead of bundled local paths)

**Deliverables:** Automated export QA suite, documented edge-case handling, size budgeting.

**Definition of Done:** The Playwright visual-regression suite runs in CI on every PR touching engine/export code, passes on all 5 template scenes across all 4 browsers, and catches at least one real regression during this sprint's own development (proving the suite has teeth, not just green-checkmark theater).

**Phase 3 wrap check:** At this point, the product's core promise — "build a world visually, get real runnable code" — is proven end-to-end without any backend. This is a strong internal demo milestone.

---

## PHASE 3B — PRE-DELIVERY VALIDATION & SHAREABLE DEPLOY

**Duration:** Sprints 24–27 (2 months) | **Outcome:** Nothing reaches a user until it has been proved to run, and a build can be shared as a link rather than a zip.

**Why this matters commercially:** most tools in this space hand over a bundle and wish you luck. Auto-testing every export, repairing what it can, and disclosing what it changed is a genuine differentiator — and it is only safe because every repair goes through the same closed-vocabulary, schema-validated discipline as the rest of the product. Full detail in `GAMEPLAY-RUNTIME-AND-QA-PLAN.md` §4.

---

### Sprint 24 — Headless Smoke Test Harness

**Goal:** A deterministic robot that plays every build before a human can.

**Tasks:**

- [ ] Playwright-based sandbox runner: loads a staged, non-public export and captures console errors and failed network requests
- [ ] Implement the scripted checklist — deliberately deterministic checks, **not** "an AI plays it and judges":
  - page loads with zero uncaught JS errors
  - every asset request resolves (no 404s on GLB, texture or audio)
  - the engine reports "scene loaded" within a timeout (catches hangs)
  - synthetic WASD and look input for N seconds actually moves the player (catches spawning stuck or falling through the world — the most common export-breaking bug)
  - player health does not hit zero while idle (catches damage triggers misplaced at spawn)
  - Rapier's WASM actually initialises (catches the MIME-type hosting problem flagged in Sprint 23)
  - memory does not climb without bound over a short window
- [ ] Wire it as a required step: the export worker writes to a private staging path first, never straight to a download or a public deploy

**Definition of Done:** Five known-good templates pass cleanly; three deliberately broken scenes (spawn inside terrain, missing asset reference, broken WASM path) each fail with specific, identifiable output.

---

### Sprint 25 — AI Diagnosis + Auto-Repair Loop

**Goal:** Fix what can be fixed, automatically, without ever running model-authored code.

**Tasks:**

- [ ] Error-context extraction: given a failure, isolate the _relevant slice_ of `scene.json` — spawn position and terrain collider for a fall-through, not the whole object list
- [ ] Request a targeted patch through the shared `ModelRouter` (same routing layer as AI-PROTOTYPE-PLAN.md), in structured form
- [ ] Zod-validate every proposed patch before applying it; bounded retry loop, max 3 attempts, re-running the Sprint 24 harness after each
- [ ] Auto-repair audit log: what changed, why, on which attempt

**Tech notes:**

- The safety argument is the same one behaviours make: the model proposes into a schema it cannot escape, the patch is narrow, the result is re-verified by a deterministic test, and the whole thing is logged. At no point does model output become executable code.

**Definition of Done:** All three deliberately broken scenes from Sprint 24 are detected and repaired within the retry budget, verified by the harness passing afterwards.

---

### Sprint 26 — Release Gating + User-Facing Reporting

**Goal:** The gate, and being honest about it.

**Tasks:**

- [ ] Gate access on the pipeline outcome: the download button and play link appear only after a pass
- [ ] Build the report UI — auto-fixes applied, stated plainly ("we moved your spawn point up 1.2 m so the player would not fall through the terrain"), or a specific human-readable failure with a suggested manual fix
- [ ] Handle unrecoverable failure explicitly: never a spinner that never resolves

**Definition of Done:** A good scene shows a brief validating state and then the download; a broken one either shows a transparent auto-fix notice with working output or a clear, specific failure — never a silent hang or an unexplained rejection.

---

### Sprint 27 — Shareable Hosted Play

**Goal:** "Here's a link" instead of "here's a zip, good luck".

**Tasks:**

- [ ] Extend the export worker with a deploy mode: the same validated bundle, uploaded to a public CDN path per project instead of zipped
- [ ] Access controls: public, unlisted, org-only
- [ ] Play analytics stub: play count, last played, surfaced in the dashboard
- [ ] Verify multiplayer sessions work specifically through the hosted path — that is how co-op will actually be used

**Definition of Done:** A user generates a share link for a validated build, sends it to someone else, and that person plays it in-browser — including joining a co-op session — with no download and no local server.

---

## PHASE 4 — BACKEND PLATFORM

**Duration:** Sprints 28–32 (2.5 months) | **Outcome:** Auth, cloud save, real-time collab, cloud-based export jobs.

### Sprint 28 — Auth + Multi-Tenancy

**Goal:** Real user accounts, organizations, and role-based access — the foundation every other backend feature builds on.

**Tasks:**

- [ ] Scaffold `/apps/api` with NestJS; set up module structure per DEVELOPMENT-PLAN.md section 4 (`auth`, `orgs`, `projects`, `assets`, `exports`, `billing`, `collab`, `audit`)
- [ ] Set up Postgres (local Docker for dev; Neon/Supabase/Fly Postgres for hosted dev+staging) + Prisma; write initial schema migration covering `User, Organization, Membership, Project, SceneVersion` (start with these 5, expand in later sprints as each feature needs its table)
- [ ] Integrate Clerk (or chosen auth provider) for sign-up/login/session management; build a webhook handler so Clerk user-created events provision a corresponding `User` row (and auto-create a personal `Organization` for solo users, matching a "personal workspace + team workspace" model)
- [ ] Implement `RoleGuard`: NestJS guard reading `Membership.role` for the requesting user + target org/project, gating endpoints by role (owner/admin/editor/viewer)
- [ ] Build invite flow: `POST /orgs/:id/invites` (email-based invite, generates a token, sends email — use a transactional email service like Resend or Postmark), invite acceptance creates the `Membership` row
- [ ] Write integration tests (Vitest + supertest or NestJS's testing utilities) covering: signup → org auto-created, invite teammate → role assigned correctly, unauthorized role attempting a gated action → 403

**Tech notes:**

- Design the `Membership.role` enum now with SSO/enterprise in mind even though SSO itself isn't wired until later — e.g., include an `enterprise_admin` distinction if you anticipate needing it, cheaper to add the enum value now than migrate later.

**Deliverables:** Working auth, org/membership model, role-gated API.

**Definition of Done:** A new user can sign up, gets a personal org automatically, can create an org, invite a teammate by email with a specific role, and the API correctly allows/denies actions based on that role — verified via integration test suite, not just manual clicking.

---

### Sprint 29 — Project CRUD + Cloud Save

**Goal:** Move project persistence from local IndexedDB (Sprint 8) to the cloud, with full version history "for free" via append-only versioning.

**Tasks:**

- [ ] Implement `Project` and `SceneVersion` Prisma models per the schema in DEVELOPMENT-PLAN.md section 3; build `POST /projects`, `GET /projects/:id`, `PUT /projects/:id` (metadata only — name, thumbnail), `POST /projects/:id/versions` (append a new SceneVersion — this is the actual "save")
- [ ] Zod-validate incoming `sceneJson` server-side before persisting (reuse the shared `/packages/schema` package — same validation logic as the editor uses locally)
- [ ] Build editor-side migration: replace Dexie/IndexedDB calls from Sprint 8 with API calls; implement autosave as a debounced `POST /projects/:id/versions` call (e.g., every 30-60s of activity, plus explicit manual save button)
- [ ] Implement optimistic concurrency: `SceneVersion` has a `versionNumber`; if a save request's base version doesn't match the project's current latest version, reject with a conflict response (409) — editor surfaces a "someone else saved, reload?" prompt (full collab merge comes in Sprint 31, this is just conflict _detection_ for now)
- [ ] Build Projects Dashboard UI: list of projects (thumbnail, name, last modified, org), create-new, delete (soft-delete with confirmation), duplicate
- [ ] Build Version History panel: list last N `SceneVersion` rows with timestamp/author, "restore this version" action (creates a _new_ version copying the old one's content — never deletes/rewrites history)

**Deliverables:** Cloud-backed project persistence with automatic version history.

**Definition of Done:** User saves a project from Browser A, logs into the same account on Browser B, sees identical, up-to-date state. Version History panel shows the last 10+ saves; restoring an older version correctly reverts editor state and creates a new version entry (history is never destroyed).

---

### Sprint 30 — Asset Storage + CDN Pipeline

**Goal:** Move the local-file asset pipeline (Sprint 2) to a real cloud storage + CDN setup, and enable user-uploaded custom assets.

**Tasks:**

- [ ] Provision R2 (or S3) bucket(s): structure `/global-assets/...` (your curated library) and `/orgs/{orgId}/assets/...` (customer-uploaded)
- [ ] Build `Asset` Prisma model + `POST /assets/upload-url` endpoint issuing a short-lived signed upload URL (direct browser-to-storage upload, not proxied through your API, to avoid unnecessary server load)
- [ ] Move the Sprint 2 ingest script (`gltf-transform` compression + thumbnail generation) into a BullMQ background job, triggered after a signed upload completes (via a client-confirms-upload callback endpoint, or storage-event webhook if your provider supports it)
- [ ] Build custom asset upload UI (gated by plan tier per DEVELOPMENT-PLAN.md — free tier may not get this): drag a `.glb` file, upload, see processing status, appears in a private "My Assets" library section once done
- [ ] Set up CDN (Cloudflare) in front of the asset bucket; use immutable/versioned asset URLs (e.g., content-hash in path) so cache headers can be aggressive (`max-age=31536000, immutable`)
- [ ] Update the editor's Asset Library panel to fetch the manifest from the API (`GET /assets?category=...`) instead of the static local `manifest.json` from Sprint 2, blending global + org-private assets in the same UI

**Deliverables:** Cloud asset storage, custom upload pipeline, CDN delivery.

**Definition of Done:** A user uploads a custom `.glb`, sees a processing indicator, and within seconds it's compressed, thumbnailed, and appears in their private asset library, placeable in scenes exactly like a built-in asset.

---

### Sprint 31 — Real-Time Collaboration

**Goal:** Multiple users editing the same project simultaneously with live presence and conflict-free merging.

**Tasks:**

- [ ] Integrate Liveblocks (recommended per DEVELOPMENT-PLAN.md to save infra time) or self-hosted Yjs/y-websocket: set up a "room" per `Project`, with the room's shared document mirroring the scene schema structure
- [ ] Wire `sceneStore` mutations to also propagate through the CRDT document (Yjs types: `Y.Map`/`Y.Array` mapped to your objects array) so local edits sync to other connected clients and remote edits flow back into `sceneStore`
- [ ] Implement presence: broadcast each connected user's cursor/camera position and current selection; render other users' selection highlights and simple avatar/cursor indicators in the viewport
- [ ] Handle the "who can edit transform gizmos simultaneously" UX question explicitly — decide: allow true simultaneous editing of different objects (CRDT handles this natively), but consider a soft-lock indicator ("Alex is editing this object") to avoid two people fighting over the same gizmo, even though the underlying CRDT would technically resolve it
- [ ] Build reconnection handling: if a client disconnects (network blip), on reconnect it should resync cleanly from the CRDT server state, not from its last local state
- [ ] Test explicitly: two clients both drag-transform _different_ objects simultaneously (should merge cleanly), and both attempt to delete the _same_ object simultaneously (verify no crash, graceful resolution)

**Deliverables:** Working real-time multi-user editing with presence.

**Definition of Done:** Two browser sessions (different accounts) open the same project; edits in one (add object, move object, sculpt terrain) appear in the other within ~200ms; both sessions show live cursor/selection presence of each other; the simultaneous-edit stress tests above pass without data loss or crashes.

---

### Sprint 32 — Export Job Orchestration at Scale

**Goal:** Move export bundling (Sprints 21-23) from a client-side operation to a server-side background job, for large projects and to enforce plan quotas.

**Tasks:**

- [ ] Build `ExportJob` Prisma model + `POST /projects/:id/export` (enqueues a BullMQ job) + `GET /export-jobs/:id` (status polling: queued/processing/done/failed)
- [ ] Build the Export Worker as a separate deployable process (per DEVELOPMENT-PLAN.md topology) consuming the BullMQ queue: fetches the target `SceneVersion`, runs the same bundler logic from Sprint 21-14 (now server-side, with access to the full cloud asset storage rather than local files), zips the result, uploads to a temporary signed-URL location in object storage
- [ ] Build client-side progress UI: polling or WebSocket-based job status updates, progress bar, "Download" button appearing on completion with the signed URL (auto-expiring, e.g., 24h)
- [ ] Implement plan-tier quota enforcement: rate-limit exports per billing period based on `Subscription.planTier` (via a `PlanTierGuard`), return a clear "upgrade to export more" response when exceeded
- [ ] Add job retry/failure handling: BullMQ retry policy for transient failures (e.g., temporary storage timeout), and a clear failure state surfaced to the user (not a silent hang) for permanent failures (e.g., corrupted scene data)
- [ ] Load-test the export worker with a batch of large concurrent export requests to verify it scales/queues sanely rather than falling over

**Deliverables:** Server-side, queued, quota-enforced export pipeline.

**Definition of Done:** Exporting a large (e.g., 300MB) project completes as a background job with visible progress, doesn't block the editor UI, produces a working signed download link, and a free-tier account attempting to exceed its export quota receives a clear upgrade prompt instead of a silent failure.

**Phase 4 wrap check:** The product is now a real multi-user cloud platform, not a local single-player tool. This is a good point to run a genuine closed-alpha with a handful of trusted external users before Phase 5's hardening work, since real usage will surface backend edge cases no amount of internal testing will catch.

---

## PHASE 5 — ENTERPRISE HARDENING

**Duration:** Sprints 33–36 (2 months) | **Outcome:** Observability, security, billing, load testing all production-grade.

### Sprint 33 — Observability + SRE Basics

**Goal:** You can see what's happening in production, end to end, before something goes wrong — not just after.

**Tasks:**

- [ ] Instrument the NestJS API and Export Worker with OpenTelemetry (traces + metrics); set up Grafana Cloud (managed, per DEVELOPMENT-PLAN.md) as the backend, or self-hosted Grafana/Loki/Tempo if cost/control demands it
- [ ] Add correlation IDs propagated across the full lifecycle of a request: HTTP call → BullMQ job → worker processing → storage upload → client notification — so a single trace can be followed end to end in Grafana/Tempo
- [ ] Integrate Sentry on both the editor client (React error boundary + source maps) and the API/worker (unhandled exception capture)
- [ ] Build core Grafana dashboards: API request latency (p50/p95/p99), error rate by endpoint, BullMQ queue depth + job processing time, Postgres connection pool utilization
- [ ] Set up basic alerting (e.g., via Grafana Alerting or a simple PagerDuty/Slack webhook integration) for: error rate spike, queue depth sustained above threshold, API latency SLA breach
- [ ] Write a basic on-call/incident response runbook doc (even if you're the only responder right now — the habit matters more than the audience size)

**Deliverables:** Full observability stack, dashboards, alerting, incident runbook.

**Definition of Done:** You can pick any single export request from the last hour and trace its complete path — HTTP call, queue entry, worker processing, storage upload, client callback — in one Grafana view using its correlation ID, with timing at each stage.

---

### Sprint 34 — Security & Compliance Pass

**Goal:** Close obvious gaps before you have real customer data and enterprise scrutiny to deal with.

**Tasks:**

- [ ] Set up Dependabot (or Snyk) for automated dependency vulnerability scanning across all packages; set up a SAST tool (e.g., Semgrep) in CI
- [ ] Audit all signed URL expiry times (uploads, downloads) — ensure they're as short as practically usable, not left at generous defaults
- [ ] Audit S3/R2 bucket policies and CORS configuration explicitly — verify no bucket is publicly listable/writable beyond intended signed-URL flows
- [ ] Re-verify the behavior sandboxing guarantee from Sprint 9: grep the entire codebase for `eval(`, `new Function(`, or any dynamic code execution path reachable from user-controlled scene data — this should return zero hits; if it doesn't, fix immediately, this is a critical finding
- [ ] Implement/verify audit logging (the `AuditLog` table from DEVELOPMENT-PLAN.md) is actually being written on sensitive actions: project access, membership changes, billing changes, asset deletion
- [ ] Write a basic SOC2-readiness checklist doc: data retention policy, access control review process, incident response process, vendor list (Clerk/Stripe/R2/etc. and their own compliance posture) — you likely won't pursue formal SOC2 certification yet, but having this doc ready dramatically shortens future enterprise security questionnaires
- [ ] Run an OWASP Top 10-focused review against staging (manually, or with a tool like OWASP ZAP) — auth bypass attempts, injection, broken access control between orgs (critical: verify Org A can never read/write Org B's projects/assets under any endpoint)

**Deliverables:** Dependency/SAST scanning in CI, security audit findings resolved, compliance-readiness doc.

**Definition of Done:** The OWASP-focused review and codebase `eval`/dynamic-execution grep both come back clean (or all findings are resolved, not just documented); cross-org data isolation is explicitly tested and verified via integration tests, not just assumed from the RBAC design.

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
