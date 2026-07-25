# SPRINT.md — Full Sprint-by-Sprint Execution Plan (Phase 0 → GA Launch)

### Companion to GUIDE.md (architecture overview) and DEVELOPMENT-PLAN.md (stack/infra rationale). This file is the actual day-to-day backlog — every sprint has: Goal, Detailed Tasks, Tech Notes, Deliverables, Definition of Done (DoD), and Watch-outs.

**Sprint length:** 2 weeks. **Total:** 26 sprints to public beta (~13 months) + Phase 7 GA (2 sprints, ~2 months).

---

## PHASE 0 — FOUNDATIONS

**Duration:** Sprints 1–2 (1 month) | **Outcome:** Engine skeleton + asset pipeline working locally, zero React involved yet.

### Sprint 1 — Repo, Schema, Engine Skeleton

**Goal:** Prove the core architectural bet (schema-driven, framework-free engine) before building any UI.

**Tasks:**

- [ ] Set up monorepo with Turborepo or Nx: `/apps/editor` (empty for now), `/packages/engine`, `/packages/schema`, `/apps/api` (empty for now)
- [ ] Configure shared TypeScript config, ESLint, Prettier across packages
- [ ] Install and configure `eslint-plugin-boundaries` (or similar) with a rule: `/packages/engine` must never import from `/apps/editor` or any React package — enforce this from commit #1
- [ ] Define the scene schema in `/packages/schema` using Zod: `SceneSchema`, `ObjectSchema`, `TransformSchema`, `TerrainSchema`, `EnvironmentSchema` (start minimal — position/rotation/scale + assetId only, expand in later sprints)
- [ ] Generate TypeScript types from Zod schemas (`z.infer<>`) — single source of truth for types across engine, editor, and future backend
- [ ] `/packages/engine`: build `SceneLoader` class — takes parsed scene.json, instantiates a Three.js `Scene`, `PerspectiveCamera`, basic `WebGLRenderer`, adds a ground plane, iterates `objects[]` and places placeholder meshes (boxes) at correct transform
- [ ] Write a hardcoded `demo-scene.json` (3-5 objects) by hand
- [ ] Build a bare `index.html` + `main.js` in a `/apps/demo` folder that imports the engine package and renders `demo-scene.json` with zero build tooling beyond a simple dev server (Vite in library mode, or plain ES modules + import maps)
- [ ] Set up GitHub Actions CI: install deps, typecheck, lint, run unit tests on every PR
- [ ] Write initial unit tests for `SceneLoader` (Vitest) — does it place objects at correct world coordinates given a schema

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

- [ ] Write the Blender export convention doc: unit scale (1 unit = 1 meter), pivot at object base/origin, max poly budget per asset tier (e.g., <2k tris for props, <8k for buildings), naming convention (`category_name_variant.glb`), texture atlas guidance for low-poly style
- [ ] Source or model 10 starter assets: 3 tree variants, 2 rocks, 1 building, 1 enemy (rigged if animated, static if not), 1 terrain texture set, 2 misc props
- [ ] Install and script `gltf-transform` CLI pipeline: `gltf-transform optimize` with Draco geometry compression + KTX2/Basis texture compression as a Node script (`scripts/ingest-assets.ts`)
- [ ] Define `AssetManifestEntry` schema in Zod: `{ id, category, tags[], glbPath, thumbnailPath, defaultScale, colliderType, polyCount }`
- [ ] Write a headless thumbnail generator: spin up Three.js + `WebGLRenderer` in a headless/offscreen context (e.g., via `node-canvas` + `gl`, or Puppeteer screenshot of a local render page) to produce a PNG thumbnail per asset automatically
- [ ] Script `pnpm ingest-assets ./raw-assets ./public/assets` that: reads raw GLBs → compresses → writes thumbnail → appends manifest.json entry
- [ ] Extend `SceneLoader` (from Sprint 1) to actually load real GLBs via `GLTFLoader` + `DRACOLoader`/`KTX2Loader`, replacing the placeholder boxes, using `assetId` to look up manifest entries
- [ ] Add loading state handling (promise-based async load, basic loading spinner in demo page)

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

- [ ] Scaffold `/apps/editor`: React + Vite + TypeScript
- [ ] Install react-three-fiber + drei; set up `<Canvas>` with `OrbitControls`, `Grid` helper, basic three-point lighting rig (key/fill/ambient)
- [ ] Set up Zustand `sceneStore` mirroring the Zod scene schema exactly (start with `objects[]`, `terrain`, `environment`)
- [ ] Build a thin r3f wrapper component `<EngineBridge>` that reads `sceneStore` state and calls into `/packages/engine`'s `SceneLoader`/object-spawning logic — critical: the _logic_ for instantiating objects lives in the engine package, r3f is just the render-loop host
- [ ] Verify: mutate `sceneStore` from Redux DevTools (Zustand supports devtools middleware) and confirm viewport updates live without manual refresh
- [ ] Basic top bar UI shell (logo, project name placeholder, save button placeholder) and empty side panel containers (asset library, inspector — populated in later sprints)
- [ ] Set up Vitest + React Testing Library for component tests; Playwright scaffold for e2e (even if only 1 smoke test exists so far)

**Tech notes:**

- Resist putting object-spawning logic directly in a React component via `useEffect` + raw Three.js calls — route everything through the shared engine package's classes/functions so editor and export stay in sync architecturally from the start.

**Deliverables:** Editor app renders empty scene; state-driven rendering proven.

**Definition of Done:** Opening `/apps/editor` shows an empty grid/ground viewport with working orbit camera; manually dispatching an "add object" action via devtools makes a real GLB asset (from Sprint 2's manifest) appear correctly positioned in the viewport.

---

### Sprint 4 — Asset Library Panel + Drag-Drop Placement

**Goal:** User can browse assets and place them in the world by dragging.

**Tasks:**

- [ ] Build Asset Library side panel: category tabs (Trees, Rocks, Buildings, Enemies, Props), search input, virtualized grid (react-window or react-virtuoso) showing thumbnail + name per manifest entry
- [ ] Implement native HTML5 drag events (`dragstart` on asset card, `dragover`/`drop` on canvas) OR pointer-based drag (recommend pointer-based for consistency with the transform gizmos coming in Sprint 5 — avoids mixing two different interaction paradigms)
- [ ] On drag-over-canvas: raycast from pointer through camera against the terrain mesh; show a semi-transparent "ghost" preview mesh at the hit point, oriented to surface normal
- [ ] On drop: generate a new object ID (uuid), push a new entry into `sceneStore.objects[]` with position = hit point, rotation aligned to normal (or locked to Y-up if you prefer non-tilted placement — decide and document)
- [ ] Add a "snap to grid" toggle (rounds position to nearest 0.5m/1m) and a "random rotation on place" toggle (useful for scattering foliage naturally)
- [ ] Handle edge case: drop with no terrain hit (e.g., dropped in open sky) — either reject the drop or place at a default ground Y

**Tech notes:**

- Use `THREE.Raycaster` against a dedicated invisible collision proxy for terrain if your visual terrain mesh is high-poly — cheaper raycasting target.

**Deliverables:** Working asset panel + drag-drop-to-place flow.

**Definition of Done:** User can drag each of the 5+ asset categories from the panel onto the terrain and see them appear, correctly grounded and oriented, with snap-to-grid and random-rotation toggles both functioning.

---

### Sprint 5 — Transform Gizmos + Inspector

**Goal:** Full select/move/rotate/scale/duplicate/delete workflow.

**Tasks:**

- [ ] Wire up drei's `<TransformControls>` to the currently-selected object; support translate/rotate/scale modes
- [ ] Decide and implement keybind scheme (document choice: Blender-style G/R/S or Unity-style W/E/R) — add a keybind reference panel/modal in the UI
- [ ] Build click-to-select (raycast against object meshes, not just terrain) with visual selection outline/highlight (e.g., outline post-processing pass or simple bounding-box helper)
- [ ] Build Inspector panel: numeric X/Y/Z fields for position/rotation/scale bound two-way to `sceneStore`, with drag-to-scrub number inputs (common editor UX pattern)
- [ ] Implement multi-select: shift-click to add to selection, marquee/box-select (drag on empty canvas draws a selection rectangle, raycasts/projects all objects inside it)
- [ ] Group transform: when multiple objects selected, gizmo operates on the group's pivot, applying deltas to all selected objects' transforms
- [ ] Implement Duplicate (Ctrl+D — offsets position slightly) and Delete (Del key, with confirmation for multi-select of 5+ objects to prevent accidental mass-delete)

**Tech notes:**

- Keep the "snap to grid" toggle from Sprint 4 also applicable during gizmo drags, not just initial placement.

**Deliverables:** Full manipulation toolkit.

**Definition of Done:** User can select single or multiple objects, move/rotate/scale via gizmo or numeric inspector fields, duplicate, and delete — tested against at least 20 objects in a scene without gizmo lag or selection bugs.

---

### Sprint 6 — Undo/Redo + Scene Graph Tree

**Goal:** Non-destructive editing confidence + hierarchical organization.

**Tasks:**

- [ ] Implement command-pattern middleware wrapping every `sceneStore` mutation: each command has `do()` and `undo()` — NOT full-state snapshots (snapshots get expensive/memory-heavy past a few hundred objects)
- [ ] Wire Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) to a command history stack with a reasonable depth limit (e.g., 100 steps)
- [ ] Build Scene Graph tree panel: hierarchical list view of all objects, supporting drag-to-reparent (e.g., attach a lamp prop as a child of a building object)
- [ ] Update schema to support `parentId` on objects; ensure transforms are applied in parent-local space when nested, world space when root-level
- [ ] Sync selection state bidirectionally between viewport clicks and scene graph tree clicks/highlights
- [ ] Add rename-in-place for objects in the tree (double-click to edit label, stored as `metadata.label`, distinct from `assetId`)

**Tech notes:**

- Test with rapid consecutive actions (drag gizmo generates many small deltas) — consider debouncing/batching drag-in-progress into a single undo command on drag-end, not one command per mouse-move frame.

**Deliverables:** Robust undo/redo, hierarchical scene graph.

**Definition of Done:** 50+ consecutive undo/redo operations complete without state corruption or visual desync; dragging an object onto another in the scene tree correctly nests it and preserves its world-space visual position (compensating the local transform).

---

### Sprint 7 — Terrain Tools

**Goal:** Sculptable, paintable terrain — the "base" the user builds on.

**Tasks:**

- [ ] Implement heightmap-based terrain: a plane geometry with vertex displacement driven by a heightmap texture (canvas-based, editable)
- [ ] Build sculpt brush tool: raise/lower/smooth/flatten modes, adjustable brush radius + strength, applied via raycast-hit-point painting onto the heightmap canvas, re-uploaded to GPU each stroke (throttled/debounced for performance)
- [ ] Build texture painting: splat-map approach (a second canvas/texture storing per-pixel blend weights for up to 4 texture layers — grass/rock/sand/dirt), custom shader (or `MeshStandardMaterial` with a custom `onBeforeCompile` injection) blending textures by splat weights
- [ ] Add terrain configuration on new-project creation: size (e.g., 128x128, 256x256), resolution/subdivision count
- [ ] Persist heightmap + splatmap as data in `scene.json` (base64-encoded PNG or a compact float array — decide based on size tradeoffs; likely store as an uploaded/generated texture asset reference rather than inline for large terrains)
- [ ] Performance check: ensure sculpting at expected brush sizes doesn't drop frame rate below acceptable threshold on target hardware

**Tech notes:**

- This is one of the more technically involved sprints — budget extra buffer. If timeline is tight, a v0 fallback is "flat terrain only, texture painting only, no sculpting" and defer height sculpting to a later sprint — document this as a deliberate scope cut if taken.

**Deliverables:** Sculptable + paintable terrain system.

**Definition of Done:** User can raise a hill, smooth it, and paint a grass/rock blend across it; terrain data round-trips correctly through save/serialize (verify by exporting scene.json, reloading, terrain looks identical).

---

### Sprint 8 — Save/Load (Local-First)

**Goal:** Persistence without needing the backend yet — proves the schema is solid before more features pile on.

**Tasks:**

- [ ] Integrate Dexie.js (IndexedDB wrapper) for local project storage
- [ ] Build save flow: serialize `sceneStore` → validate against Zod schema → write to IndexedDB keyed by project ID
- [ ] Build load flow: read from IndexedDB → Zod-validate → hydrate `sceneStore`; handle validation failure gracefully (surface error, don't silently corrupt state)
- [ ] Add a schema `version` field and a stub migration registry (`migrations/v1-to-v2.ts` etc.) even if empty right now — establishes the pattern before real migrations are needed
- [ ] Build "New Project" flow: blank template vs. pick-from-starter-template (hand-build 2-3 starter `scene.json` files representing different scenarios — e.g., "empty field," "small village layout," "forest clearing")
- [ ] Build a basic Projects list/home screen (local-only for now) showing saved projects with thumbnail (can be a simple canvas screenshot capture of the viewport at save time) and last-modified date
- [ ] Add autosave (debounced, e.g., every 30-60 seconds of inactivity, or on major actions) to reduce risk of data loss during long sessions

**Deliverables:** Full local persistence loop, template picker.

**Definition of Done:** Close the browser tab mid-edit, reopen, project state auto-restores correctly including terrain, all objects, and their behaviors-to-be (schema slot reserved even if behaviors aren't implemented until Phase 2). Starter template picker loads a real, non-trivial starter scene correctly.

**Phase 1 wrap check:** At this point you should be able to demo a genuinely usable (if behavior-less) world editor end-to-end. This is a good internal milestone to pause and get outside eyes (even 2-3 informal testers) on basic usability before piling on Phase 2 complexity.

---

## PHASE 2 — BEHAVIORS, PHYSICS, AI

**Duration:** Sprints 9–12 (2 months) | **Outcome:** Enemies, physics, triggers working in live preview.

### Sprint 9 — Behavior System Architecture

**Goal:** Build the plugin system that keeps "code generation" honest — behaviors are a closed, registered vocabulary, not free-form scripts.

**Tasks:**

- [ ] Design the `Behavior` base interface in `/packages/engine`: `onInit(gameObject, params)`, `onUpdate(gameObject, deltaTime)`, `onEvent(gameObject, eventName, payload)`, `onDestroy(gameObject)`
- [ ] Build a `BehaviorRegistry` (simple `Map<string, BehaviorClass>`) with a `registerBehavior(typeName, class)` function
- [ ] Implement first behavior: `PatrolBehavior` (moves object along a list of waypoints, looping or ping-pong mode, configurable speed)
- [ ] Extend scene schema: `objects[].behaviors[]` array, each entry `{ type: string, params: Record<string, unknown> }`
- [ ] Define a **per-behavior params schema** (Zod) so the editor can auto-generate a property form (e.g., `PatrolParamsSchema = z.object({ waypoints: z.array(Vec3Schema), speed: z.number() })`) — this is what lets you add new behaviors later without hand-writing custom UI each time
- [ ] Build editor UI: "Add Behavior" dropdown on Inspector panel (lists registered behavior types), dynamically renders the property form from the behavior's Zod schema (use a simple schema-to-form renderer — write a small one or evaluate `react-jsonschema-form` adapted for Zod via `zod-to-json-schema`)
- [ ] Build waypoint-editing UX specifically for Patrol: click-to-add waypoint markers directly in the 3D viewport (a common "path editing" interaction pattern)

**Tech notes:**

- This sprint sets the ceiling for how safe/sandboxed your export ever is — do not let any behavior's `params` contain executable code strings (no `eval`, no `new Function()`). If you eventually want a "custom script" power-user feature, that's a deliberate, separately-sandboxed future feature (see DEVELOPMENT-PLAN.md future roadmap), not something to sneak in here.

**Deliverables:** Behavior plugin architecture + first working behavior (Patrol) with auto-generated UI.

**Definition of Done:** Attaching "Patrol" to an object via the Inspector, defining 3 waypoints by clicking in the viewport, produces correct looping movement in the live preview — and the exact same `PatrolBehavior` class (unmodified) is what will later run in exported projects.

---

### Sprint 10 — Physics Integration (Rapier)

**Goal:** Real collision and gravity so objects/characters interact believably with terrain and each other.

**Tasks:**

- [ ] Integrate `@dimforge/rapier3d-compat` (WASM); build a `PhysicsWorld` wrapper class in `/packages/engine` that steps the Rapier world in sync with the Three.js render loop
- [ ] Add `colliderType` handling from asset manifest (box/capsule/mesh/none) — auto-generate Rapier colliders when objects are instantiated based on their manifest default, with per-instance override option in Inspector
- [ ] Implement static vs. dynamic vs. kinematic body types; terrain itself should be a static trimesh (or heightfield) collider matching the sculpted terrain from Sprint 7
- [ ] Build a basic character controller (using Rapier's `KinematicCharacterController`) for a "player" template object — WASD movement + gravity + slope handling, used for the "test play" mode in the editor (a play-in-editor button that lets you walk around your world)
- [ ] Sync Rapier rigid body transforms back to Three.js object transforms each frame (position/rotation)
- [ ] Add a "Play Preview" mode toggle in the editor UI: switches from edit-camera to first/third-person player-controlled camera, runs the physics/behavior simulation live, Escape to exit back to edit mode

**Tech notes:**

- Rapier's WASM module needs async initialization — handle this cleanly at engine bootstrap (loading screen) rather than scattering readiness checks through the codebase.

**Deliverables:** Working physics world + playable test-preview mode.

**Definition of Done:** Entering Play Preview mode lets the user walk a character around the terrain, collide correctly with static props/buildings, and not fall through terrain or floating objects — verified across at least one hilly terrain scene from Sprint 7.

---

### Sprint 11 — Enemy AI (Yuka.js) + Triggers

**Goal:** Enemies that sense and react, and event-driven world logic (doors, spawns, scene transitions).

**Tasks:**

- [ ] Integrate Yuka.js steering behaviors (seek, flee, pursue, wander, arrive) into the engine's per-frame update loop, driving Rapier kinematic bodies (not raw mesh transforms, so physics/collision stays consistent)
- [ ] Build a simple FSM (finite state machine) wrapper for enemy AI states: `idle → patrol → chase → attack → dead`, using Yuka's built-in `StateMachine` utility or a lightweight custom one
- [ ] Implement `ChaseOnSightBehavior`: uses a distance/line-of-sight check (raycast against terrain/obstacles to detect if the player is actually visible, not just in range) to trigger state transition from patrol to chase
- [ ] Implement basic combat stub: `attack` state deals damage to player on proximity/timer, player has a `health` stat, `dead` state on enemy triggers a despawn/ragdoll-stub/loot-drop event
- [ ] Build Trigger Volumes: new object type (box/sphere gizmo, non-rendering in play mode) with `onEnter`/`onExit`/`onEvent` schema fields; wire a simple in-engine event bus (`EventEmitter`-style) so triggers can fire named events (`spawnWave`, `openDoor`, `loadScene`, custom)
- [ ] Editor UI: place trigger volumes like any other object (via a dedicated "Logic" category in the asset panel, even though triggers aren't visual assets), configure their event bindings via Inspector (dropdown of available event types + target object picker)

**Tech notes:**

- Line-of-sight raycasting every frame for every enemy can get expensive — throttle checks (e.g., every 100-200ms per enemy, not every frame) once you have dozens of active enemies; revisit in Sprint 12's perf pass if needed.

**Deliverables:** Working enemy AI FSM + trigger volume system.

**Definition of Done:** Placing an enemy with Patrol + ChaseOnSight behaviors, plus a trigger volume wired to "spawn additional enemy on enter," produces the expected behavior in Play Preview: enemy patrols until player is seen, then chases; entering the trigger volume spawns a new enemy.

---

### Sprint 12 — Behavior QA + Performance Pass

**Goal:** Make sure the system holds up with realistic scene density before moving to export.

**Tasks:**

- [ ] Convert repeated static assets (trees, rocks, generic props) to `InstancedMesh` rendering — write an instancing manager in the engine that batches identical `assetId` static (non-animated, non-physics-dynamic) objects into single draw calls
- [ ] Implement object pooling for anything spawned/destroyed at runtime (projectiles, particle effects, loot pickups) to avoid GC churn from frequent allocation
- [ ] Implement frustum culling verification (Three.js does this by default per-object, but verify it's actually effective with your scene structure — nested groups can sometimes defeat automatic culling) and add distance-based LOD swapping for high-poly assets if any exceed budget
- [ ] Build a stress-test scene: 500+ static props (using instancing), 20+ active enemies with AI/physics, sculpted terrain — establish this as a recurring perf benchmark scene used in every future sprint's regression check
- [ ] Profile in Chrome DevTools (Performance + Memory tabs): identify and fix any obvious bottlenecks (excessive re-renders in r3f, unnecessary Rapier collider recalculation, redundant raycasts)
- [ ] Document target performance bar (e.g., "60fps sustained on [reference hardware] with the 500-prop/20-enemy stress scene") — this becomes the acceptance bar for Phase 2 sign-off

**Deliverables:** Instancing, pooling, culling/LOD, documented perf benchmark scene + target.

**Definition of Done:** The stress-test scene holds the documented target frame rate on reference hardware, verified and recorded (screenshot/video of Chrome perf profile) as a baseline for future regression comparisons.

**Phase 2 wrap check:** This is your last checkpoint before building the export system — any behavior/physics/AI code that still has React or Zustand imports anywhere in its call chain must be refactored out now. Audit the `/packages/engine` import graph explicitly before Sprint 13.

---

## PHASE 3 — EXPORT SYSTEM

**Duration:** Sprints 13–15 (1.5 months) | **Outcome:** Standalone playable exports, cross-browser verified.

### Sprint 13 — Static Export (No Behaviors Yet)

**Goal:** Prove the fundamental export mechanism works before layering in the harder behavior/physics export case.

**Tasks:**

- [ ] Build Export Wizard UI: modal/panel with options — asset compression level, include-source-scene.json toggle, minify toggle, project name (used for the zip filename)
- [ ] Write the **bundler**: given a `sceneStore` state, (1) build the built/minified `/packages/engine` output, (2) copy only the assets actually referenced by `assetId` in this scene (tree-shake unused manifest entries — don't ship the whole asset library), (3) write out `scene.json`, (4) generate a minimal `index.html` + `main.js` that imports the engine and calls `new SceneLoader().load('./scene.json')`
- [ ] Integrate JSZip client-side to package the above into a downloadable `.zip`
- [ ] Handle relative path correctness inside the exported bundle (assets must resolve correctly when the zip is extracted and opened via a local static server — test with `npx serve` on the extracted output, not just `file://`, since ES modules often require a real HTTP server)
- [ ] Add a basic README.md template inside the export explaining how to run it (`npx serve .` or similar) and what's inside the folder structure

**Deliverables:** Working static export pipeline.

**Definition of Done:** Export a scene with terrain + 10+ static props (no behaviors), unzip, run `npx serve` on the folder, and the browser renders an identical scene to the editor's preview.

---

### Sprint 14 — Full Behavior Export + Readability Layer

**Goal:** Extend export to cover the harder cases — behaviors, physics, AI — and add a "human-readable" option for power users.

**Tasks:**

- [ ] Extend the bundler's engine-build step to tree-shake behavior code too — only include the `BehaviorRegistry` entries actually used in this specific scene (via static analysis of `scene.json`'s `behaviors[].type` values, or simply include the full registry if tree-shaking proves too fragile — measure the size cost either way and decide)
- [ ] Verify Rapier's WASM asset is correctly included/referenced in the exported bundle (WASM files need correct MIME type handling by whatever static server the end user uses — document this clearly in the export README)
- [ ] Build the optional **"readable code" export mode**: an EJS (or similar) templating pass that, instead of a generic `SceneLoader.load('scene.json')` call, emits an explicit `main.js` with literal calls per object (e.g., `engine.spawn('tree_pine_02', { position: [10,0,-4], rotation: [0,45,0] })`, `engine.attachBehavior(obj, 'patrol', {...})`) — this is cosmetic/educational code-gen layered on top of the real data-driven system, for users who want to hand-edit after export
- [ ] Auto-generate a `CREDITS.md`/`LICENSE.md` in the export: engine license (decide: MIT? proprietary-with-export-rights?), per-asset attribution pulled from each `Asset.licenseType` in the manifest, and a placeholder for the user's own project license
- [ ] Test a scene combining terrain + static props + patrol enemy + chase behavior + trigger volume + physics character controller, fully exported and run standalone

**Deliverables:** Full-feature export (behaviors/physics/AI included), optional readable-code mode, licensing file generation.

**Definition of Done:** A scene with active enemy AI, physics, and a trigger-based scene event, once exported and served standalone, behaves identically to the in-editor Play Preview — verified by side-by-side manual comparison, and later automated in Sprint 15.

---

### Sprint 15 — Export Hardening + Cross-Browser QA

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

## PHASE 4 — BACKEND PLATFORM

**Duration:** Sprints 16–20 (2.5 months) | **Outcome:** Auth, cloud save, real-time collab, cloud-based export jobs.

### Sprint 16 — Auth + Multi-Tenancy

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

### Sprint 17 — Project CRUD + Cloud Save

**Goal:** Move project persistence from local IndexedDB (Sprint 8) to the cloud, with full version history "for free" via append-only versioning.

**Tasks:**

- [ ] Implement `Project` and `SceneVersion` Prisma models per the schema in DEVELOPMENT-PLAN.md section 3; build `POST /projects`, `GET /projects/:id`, `PUT /projects/:id` (metadata only — name, thumbnail), `POST /projects/:id/versions` (append a new SceneVersion — this is the actual "save")
- [ ] Zod-validate incoming `sceneJson` server-side before persisting (reuse the shared `/packages/schema` package — same validation logic as the editor uses locally)
- [ ] Build editor-side migration: replace Dexie/IndexedDB calls from Sprint 8 with API calls; implement autosave as a debounced `POST /projects/:id/versions` call (e.g., every 30-60s of activity, plus explicit manual save button)
- [ ] Implement optimistic concurrency: `SceneVersion` has a `versionNumber`; if a save request's base version doesn't match the project's current latest version, reject with a conflict response (409) — editor surfaces a "someone else saved, reload?" prompt (full collab merge comes in Sprint 19, this is just conflict _detection_ for now)
- [ ] Build Projects Dashboard UI: list of projects (thumbnail, name, last modified, org), create-new, delete (soft-delete with confirmation), duplicate
- [ ] Build Version History panel: list last N `SceneVersion` rows with timestamp/author, "restore this version" action (creates a _new_ version copying the old one's content — never deletes/rewrites history)

**Deliverables:** Cloud-backed project persistence with automatic version history.

**Definition of Done:** User saves a project from Browser A, logs into the same account on Browser B, sees identical, up-to-date state. Version History panel shows the last 10+ saves; restoring an older version correctly reverts editor state and creates a new version entry (history is never destroyed).

---

### Sprint 18 — Asset Storage + CDN Pipeline

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

### Sprint 19 — Real-Time Collaboration

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

### Sprint 20 — Export Job Orchestration at Scale

**Goal:** Move export bundling (Sprints 13-15) from a client-side operation to a server-side background job, for large projects and to enforce plan quotas.

**Tasks:**

- [ ] Build `ExportJob` Prisma model + `POST /projects/:id/export` (enqueues a BullMQ job) + `GET /export-jobs/:id` (status polling: queued/processing/done/failed)
- [ ] Build the Export Worker as a separate deployable process (per DEVELOPMENT-PLAN.md topology) consuming the BullMQ queue: fetches the target `SceneVersion`, runs the same bundler logic from Sprint 13-14 (now server-side, with access to the full cloud asset storage rather than local files), zips the result, uploads to a temporary signed-URL location in object storage
- [ ] Build client-side progress UI: polling or WebSocket-based job status updates, progress bar, "Download" button appearing on completion with the signed URL (auto-expiring, e.g., 24h)
- [ ] Implement plan-tier quota enforcement: rate-limit exports per billing period based on `Subscription.planTier` (via a `PlanTierGuard`), return a clear "upgrade to export more" response when exceeded
- [ ] Add job retry/failure handling: BullMQ retry policy for transient failures (e.g., temporary storage timeout), and a clear failure state surfaced to the user (not a silent hang) for permanent failures (e.g., corrupted scene data)
- [ ] Load-test the export worker with a batch of large concurrent export requests to verify it scales/queues sanely rather than falling over

**Deliverables:** Server-side, queued, quota-enforced export pipeline.

**Definition of Done:** Exporting a large (e.g., 300MB) project completes as a background job with visible progress, doesn't block the editor UI, produces a working signed download link, and a free-tier account attempting to exceed its export quota receives a clear upgrade prompt instead of a silent failure.

**Phase 4 wrap check:** The product is now a real multi-user cloud platform, not a local single-player tool. This is a good point to run a genuine closed-alpha with a handful of trusted external users before Phase 5's hardening work, since real usage will surface backend edge cases no amount of internal testing will catch.

---

## PHASE 5 — ENTERPRISE HARDENING

**Duration:** Sprints 21–24 (2 months) | **Outcome:** Observability, security, billing, load testing all production-grade.

### Sprint 21 — Observability + SRE Basics

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

### Sprint 22 — Security & Compliance Pass

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

### Sprint 23 — Billing & Plan Tiers

**Goal:** The business model is actually enforced in software, not just on a pricing page.

**Tasks:**

- [ ] Define concrete plan tiers (e.g., Free / Pro / Enterprise) and their limits: seats, storage GB, exports/month, custom asset uploads (yes/no), collab session participant cap, SSO (enterprise only)
- [ ] Integrate Stripe: Products/Prices for each tier, Stripe Checkout or Billing Portal for self-serve upgrade/downgrade, webhook handlers (`invoice.paid`, `customer.subscription.updated/deleted`) updating the `Subscription` Prisma model
- [ ] Implement `UsageRecord` metering: track exports, storage used, active seats per org per billing period; expose usage-to-date in the UI ("3/10 exports used this month")
- [ ] Wire `PlanTierGuard` across the relevant endpoints (custom asset upload, export quota from Sprint 20, collab participant limits, seat limits on invites) — reject with a clear, actionable error (not a generic 403) pointing to the upgrade flow
- [ ] Build in-app billing UI: current plan display, usage meters, upgrade/downgrade flow, invoice history (Stripe-hosted portal is often sufficient here rather than building custom UI)
- [ ] Test plan transitions explicitly: downgrade from Pro to Free while over the Free tier's storage limit — decide and implement the actual behavior (e.g., read-only lockout of excess projects vs. grace period) rather than leaving it undefined

**Deliverables:** Working metered billing across all plan tiers, enforced in the API.

**Definition of Done:** A free-tier account attempting a Pro-only action (e.g., custom asset upload) is cleanly blocked with an upgrade prompt; upgrading via Stripe Checkout immediately unlocks the feature without requiring a manual support action; usage meters in the UI accurately reflect actual metered usage.

---

### Sprint 24 — Performance & Load Testing

**Goal:** Confidence the system holds up under real concurrent usage before you invite real customers to depend on it.

**Tasks:**

- [ ] Write k6 (or Artillery) load test scripts simulating realistic usage patterns: concurrent project CRUD, concurrent autosave bursts, concurrent export job submission
- [ ] Define and test against explicit target numbers (pick numbers appropriate to your actual go-to-market scale expectation, e.g., "500 concurrent editing sessions, p95 API latency under 300ms for CRUD operations")
- [ ] Run the Sprint 12 engine-side stress-test scene (500 props/20 enemies) through a long-session memory leak check (2+ hour continuous Play Preview session, watch Chrome memory profiler for unbounded growth — a common r3f/Three.js pitfall is un-disposed geometries/materials on object deletion)
- [ ] Audit and fix any editor bundle-size or initial-load performance issues (Lighthouse audit, code-splitting heavy panels like the Asset Library if it's not already lazy-loaded)
- [ ] Tune CDN cache hit-rate for asset delivery (verify cache headers from Sprint 18 are actually effective, check Cloudflare analytics for hit ratio)
- [ ] Load-test the collab server (Sprint 19) specifically for connection-count scaling, since it has a different scaling profile (long-lived connections) than the stateless API

**Deliverables:** Documented, tested performance targets across API, engine runtime, and collab server.

**Definition of Done:** The k6 load test suite runs against staging and meets the documented p95 latency targets at the target concurrency level; the 2-hour memory-leak session shows stable (non-growing) memory usage; results are written up in a short perf report doc for future regression comparison.

**Phase 5 wrap check:** This is the last phase before content/launch — the system is now genuinely production-grade. Good point for a final external security/perf review if budget allows (even a lightweight third-party pen test) before opening to a wider beta.

---

## PHASE 6 — CONTENT & BETA LAUNCH

**Duration:** Sprints 25–26 (1 month) | **Outcome:** Real asset library, polished templates, closed beta running.

### Sprint 25 — Template & Asset Library Expansion

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

### Sprint 26 — Docs, Onboarding, Closed Beta

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

### Sprint 27 — Beta Findings Remediation

**Goal:** Fix what the closed beta actually revealed, prioritized by real friction data, not internal guesses.

**Tasks:**

- [ ] Triage the full beta feedback backlog + funnel analytics from Sprint 26; rank issues by (a) how many users hit it and (b) how severely it blocks the core flow
- [ ] Fix the top-ranked friction points — this sprint's scope is intentionally defined by beta data rather than a pre-written task list, since you don't know yet what beta will surface
- [ ] Re-run the Sprint 15 export QA suite and Sprint 24 load tests if any remediation touched engine/export/backend performance-sensitive code, to confirm no regressions
- [ ] Finalize pricing page copy and plan-tier limits based on actual beta usage patterns observed (you now have real data on typical project sizes, export frequency, etc. — sanity check your Sprint 23 tier limits against reality)

**Deliverables:** Beta-informed product fixes, finalized pricing.

**Definition of Done:** The top 3-5 friction points identified in beta are resolved and re-validated with a subset of the original beta cohort confirming improvement.

---

### Sprint 28 — Public Launch Readiness

**Goal:** Everything needed to support real public traffic and paying customers on day one.

**Tasks:**

- [ ] Finalize and QA the public marketing site (separate from the app itself) — pricing page, feature overview, template gallery showcasing Sprint 25's work
- [ ] Set up production support processes: ticketing system (if not already from Sprint 26), documented SLA expectations per plan tier, escalation path for critical bugs
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
